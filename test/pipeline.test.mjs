import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "../src/style.mjs";
import {
  buildInlineRequest,
  createEmitter,
  generateBaseImage,
  loadPrompt,
  processImmediate,
  processBaseImages,
  resolveReferenceImage,
  writeManifest
} from "../src/pipeline.mjs";
import { resolveStyle } from "../src/style.mjs";
import { createTempDir, pngBuffer, writePng } from "./helpers.mjs";

function createSharpStub() {
  return () => ({
    png() {
      return {
        async toBuffer() {
          return pngBuffer();
        }
      };
    },
    clone() {
      return this;
    },
    resize() {
      return this;
    }
  });
}

describe("pipeline", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir();
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("builds inline Gemini requests with metadata and image parts", async () => {
    const refPath = await writePng(path.join(tmpDir, "ref.png"));
    const outfitPath = await writePng(path.join(tmpDir, "outfit.png"));

    const request = await buildInlineRequest({
      subjectId: "jane-doe",
      name: "Jane Doe",
      refPath,
      outfitPath,
      subjectType: "corporate professional"
    });

    assert.equal(request.metadata.outputId, "jane-doe-stage1");
    assert.equal(request.contents[0].parts.length, 3);
    assert.equal(request.model, "gemini-3.1-flash-image-preview");
  });

  it("loads prompt templates and resolves package paths", async () => {
    const styleConfig = await resolveStyle();
    const prompt = await loadPrompt(styleConfig.style, {
      SUBJECT_TYPE: "athlete",
      OUTFIT_DESCRIPTOR: "outfit",
      OUTFIT_PATH: "outfit.png"
    });

    assert.equal(path.basename(PACKAGE_ROOT), "portrait-forge");
    assert.equal(typeof prompt, "string");
    assert.match(prompt, /athlete/);
    assert.match(prompt, /outfit/);
  });

  it("processes a single image with injected clients", async () => {
    const refPath = await writePng(path.join(tmpDir, "single-ref.png"));
    const outfitPath = await writePng(path.join(tmpDir, "single-outfit.png"));
    const outputPath = path.join(tmpDir, "outputs", "single.png");

    const geminiClient = {
      models: {
        generateContent: async () => ({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: "image/png",
                  data: pngBuffer().toString("base64")
                }
              }]
            }
          }]
        })
      }
    };
    const replicateClient = {
      removeBackground: async () => pngBuffer()
    };

    const result = await processImmediate({
      ref: refPath,
      outfit: outfitPath,
      output: outputPath,
      skipBaseVerification: true,
      skipTransparentVerification: true,
      userRoot: tmpDir,
      geminiClient,
      replicateClient,
    });

    assert.equal(result.output, path.join("outputs", "single.png"));
    assert.deepEqual(result.outputs, { "1024": path.join("outputs", "single.png") });
    assert.equal(result.baseOnly, false);
    assert.ok(await fsp.stat(outputPath));
  });

  it("stops after base generation with --base-only", async () => {
    const refPath = await writePng(path.join(tmpDir, "baseonly-ref.png"));
    const outfitPath = await writePng(path.join(tmpDir, "baseonly-outfit.png"));

    const geminiClient = {
      models: {
        generateContent: async () => ({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: "image/png",
                  data: pngBuffer().toString("base64")
                }
              }]
            }
          }]
        })
      }
    };

    const result = await processImmediate({
      ref: refPath,
      outfit: outfitPath,
      baseOnly: true,
      skipBaseVerification: true,
      userRoot: tmpDir,
      geminiClient,
    });

    assert.equal(result.baseOnly, true);
    assert.ok(result.basePath, "should include basePath");
    assert.ok(result.styleName, "should include styleName");
    assert.ok(result.qaPath, "should include qaPath");
    assert.equal(result.output, undefined, "should not have output when base-only");
  });

  it("converts non-PNG Gemini payloads with injected sharp", async () => {
    const refPath = await writePng(path.join(tmpDir, "jpeg-ref.png"));
    const outfitPath = await writePng(path.join(tmpDir, "jpeg-outfit.png"));
    const basePath = path.join(tmpDir, "outputs", "jpeg-base.png");

    await generateBaseImage({
      subjectId: "jpeg-subject",
      name: "JPEG Subject",
      refPath,
      outfitPath
    }, {
      basePath,
      sharp: createSharpStub(),
      geminiClient: {
        models: {
          generateContent: async () => ({
            candidates: [{
              content: {
                parts: [{
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: Buffer.from("jpeg-payload").toString("base64")
                  }
                }]
              }
            }]
          })
        }
      }
    });

    await assert.doesNotReject(() => fsp.access(basePath));
  });

  it("supports async emitter listeners", async () => {
    const emitter = createEmitter();
    const seen = [];
    emitter.on(async (event) => {
      seen.push(event.type);
    });
    await emitter.emit({ type: "complete" });
    assert.deepEqual(seen, ["complete"]);
  });

  it("processes base images without touching batch state", async () => {
    const basePath = await writePng(path.join(tmpDir, "outputs", ".tmp", "queued-base.png"));
    const outputPath = path.join(tmpDir, "outputs", "queued.png");
    const results = await processBaseImages([{
      subjectId: "queued",
      basePath,
      outputPath,
      refPath: null,
      outfitPath: null,
    }], {
      skipBaseVerification: true,
      skipTransparentVerification: true,
      replicateClient: {
        removeBackground: async () => pngBuffer()
      }
    });

    assert.deepEqual(results[0].status, "complete");
    assert.deepEqual(results[0].outputs, {
      "1024": outputPath
    });
    assert.ok(await fsp.stat(outputPath));
  });

  it("writes sized variants and returns a shared outputs map", async () => {
    const basePath = await writePng(path.join(tmpDir, "outputs", ".tmp", "sized-base.png"));
    const outputPath = path.join(tmpDir, "outputs", "sized.png");

    const [result] = await processBaseImages([{
      subjectId: "sized",
      basePath,
      outputPath,
      refPath: null,
      outfitPath: null,
    }], {
      sizes: [512, 256],
      skipBaseVerification: true,
      skipTransparentVerification: true,
      sharp: createSharpStub(),
      replicateClient: {
        removeBackground: async () => pngBuffer()
      }
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(result.outputs, {
      "1024": outputPath,
      "512": path.join(tmpDir, "outputs", "sized-512.png"),
      "256": path.join(tmpDir, "outputs", "sized-256.png")
    });
    await assert.doesNotReject(() => fsp.access(result.outputs["512"]));
    await assert.doesNotReject(() => fsp.access(result.outputs["256"]));
  });

  it("reuses an existing 1024 output to backfill missing variants", async () => {
    const outputPath = await writePng(path.join(tmpDir, "outputs", "existing-variants.png"));

    const [result] = await processBaseImages([{
      subjectId: "existing-variants",
      outputPath
    }], {
      sizes: [512],
      sharp: createSharpStub()
    });

    assert.equal(result.status, "complete");
    assert.equal(result.skippedExisting, false);
    await assert.doesNotReject(() => fsp.access(path.join(tmpDir, "outputs", "existing-variants-512.png")));
  });

  it("writes manifests with relative output paths", async () => {
    const outputDir = path.join(tmpDir, "manifest-out");
    const original = await writePng(path.join(outputDir, "jane.png"));
    const variant = await writePng(path.join(outputDir, "jane-512.png"));

    const manifestPath = await writeManifest([
      {
        subjectId: "jane",
        status: "complete",
        outputPath: original,
        outputs: {
          "1024": original,
          "512": variant
        },
      },
      {
        subjectId: "john",
        status: "failed",
        error: "Processing failed.",
      }
    ], {
      userRoot: tmpDir,
      outputDir,
      promptConfig: { name: "game-day" }
    });

    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    assert.equal(manifest.style, "game-day");
    assert.deepEqual(manifest.subjects[0].outputs, {
      "1024": "jane.png",
      "512": "jane-512.png"
    });
    assert.equal(manifest.subjects[1].status, "failed");
    assert.equal(manifest.subjects[1].error, "Processing failed.");
  });

  it("ignores unsupported auto-discovered reference files when a supported match exists", async () => {
    const refsDir = path.join(tmpDir, "auto-refs");
    await fsp.mkdir(refsDir, { recursive: true });
    await writePng(path.join(refsDir, "jane-doe.png"));
    await fsp.writeFile(path.join(refsDir, "jane-doe.avif"), "unsupported");

    const resolved = await resolveReferenceImage({ subjectId: "jane-doe" }, refsDir, {
      userRoot: tmpDir
    });

    assert.equal(path.extname(resolved.path), ".png");
  });
});
