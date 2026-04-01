import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseCliArgs, runCli, validateCliArgs } from "../bin/portrait-forge.mjs";
import { createTempDir, writePng } from "./helpers.mjs";

function createStream() {
  let data = "";
  return {
    write(chunk) {
      data += chunk;
    },
    read() {
      return data;
    }
  };
}

describe("cli", () => {
  it("parses --cwd flag", () => {
    const parsed = parseCliArgs(["--cwd", "/tmp/project", "--ref", "a.png", "--outfit", "b.png"]);
    assert.equal(parsed.cwd, "/tmp/project");
  });

  it("--cwd overrides runtime cwd for output resolution", async () => {
    const tmpDir = await createTempDir("portrait-forge-cwd-");
    const stdout = createStream();
    const stderr = createStream();
    let seenUserRoot;

    const exitCode = await runCli(["--cwd", tmpDir, "--ref", "ref.png", "--outfit", "outfit.png", "--json"], {
      cwd: "/should/be/ignored",
      env: {
        GEMINI_API_KEY: "test-key",
        REPLICATE_API_TOKEN: "test-token"
      },
      pipelineModule: {
        createEmitter() {
          const listeners = [];
          return {
            on(listener) { listeners.push(listener); },
            async emit(event) { for (const l of listeners) await l(event); }
          };
        },
        processImmediate: async (options) => {
          seenUserRoot = options.userRoot;
          await options.emitter.emit({ type: "complete", subjectId: "test", outputPath: "outputs/test.png", outputs: { "1024": "outputs/test.png" } });
          return { output: "outputs/test.png", outputs: { "1024": "outputs/test.png" }, baseOnly: false, durationSec: 0.1 };
        }
      },
      stdout,
      stderr,
      loadEnv: false
    });

    assert.equal(exitCode, 0);
    assert.equal(seenUserRoot, tmpDir);
  });

  it("parses flags", () => {
    const parsed = parseCliArgs(["--ref", "a.png", "--outfit", "b.png", "--subject-type", "athlete", "--sizes", "512,256", "--base-only", "--manifest"]);
    assert.equal(parsed.ref, "a.png");
    assert.equal(parsed.outfit, "b.png");
    assert.equal(parsed.subjectType, "athlete");
    assert.equal(parsed.sizes, "512,256");
    assert.equal(parsed.baseOnly, true);
    assert.equal(parsed.manifest, true);
  });

  it("rejects mixed modes", () => {
    assert.throws(
      () => validateCliArgs(parseCliArgs(["--ref", "a.png", "--csv", "subjects.csv"])),
      /exactly one mode/i
    );
  });

  it("rejects dry-run with single mode", () => {
    assert.throws(
      () => validateCliArgs(parseCliArgs(["--ref", "a.png", "--outfit", "b.png", "--dry-run"])),
      /only valid with --csv/i
    );
  });

  it("rejects outfit with csv mode", () => {
    assert.throws(
      () => validateCliArgs(parseCliArgs(["--csv", "subjects.csv", "--outfit", "b.png"])),
      /--default-outfit/
    );
  });

  it("reports missing API keys", async () => {
    const tmpDir = await createTempDir("portrait-forge-cli-");
    const refPath = await writePng(path.join(tmpDir, "ref.png"));
    const outfitPath = await writePng(path.join(tmpDir, "outfit.png"));
    const stdout = createStream();
    const stderr = createStream();

    const exitCode = await runCli(["--ref", refPath, "--outfit", outfitPath], {
      cwd: tmpDir,
      env: {},
      stdout,
      stderr,
      loadEnv: false
    });

    assert.equal(exitCode, 1);
    assert.match(stderr.read(), /GEMINI_API_KEY is required/);
  });

  it("parses --style flag", () => {
    const parsed = parseCliArgs(["--ref", "a.png", "--outfit", "b.png", "--style", "anime"]);
    assert.equal(parsed.style, "anime");
  });

  it("validates sizes range", () => {
    assert.throws(
      () => validateCliArgs(parseCliArgs(["--ref", "a.png", "--outfit", "b.png", "--sizes", "2048"])),
      /between 1 and 1024/i
    );
  });

  it("defaults style to null when omitted", () => {
    const parsed = parseCliArgs(["--ref", "a.png", "--outfit", "b.png"]);
    assert.equal(parsed.style, null);
  });

  it("streams NDJSON for single-image mode and writes summary last", async () => {
    const stdout = createStream();
    const stderr = createStream();
    const events = [];

    const exitCode = await runCli(["--ref", "ref.png", "--outfit", "outfit.png", "--json", "--sizes", "512", "--manifest"], {
      cwd: process.cwd(),
      env: {
        GEMINI_API_KEY: "test-key",
        REPLICATE_API_TOKEN: "test-token"
      },
      pipelineModule: {
        createEmitter() {
          const listeners = [];
          return {
            on(listener) {
              listeners.push(listener);
            },
            async emit(event) {
              for (const listener of listeners) {
                await listener(event);
              }
            }
          };
        },
        processImmediate: async (options) => {
          await options.emitter.emit({
            type: "complete",
            subjectId: "jane-doe",
            outputPath: "outputs/jane-doe.png",
            outputs: { "1024": "outputs/jane-doe.png", "512": "outputs/jane-doe-512.png" },
          });
          return {
            output: "outputs/jane-doe.png",
            outputs: { "1024": "outputs/jane-doe.png", "512": "outputs/jane-doe-512.png" },
            baseOnly: false,
            durationSec: 1.2,
            manifestPath: "outputs/manifest.json"
          };
        }
      },
      stdout,
      stderr,
      loadEnv: false
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), "");
    for (const line of stdout.read().trim().split("\n")) {
      events.push(JSON.parse(line));
    }
    assert.equal(events[0].type, "complete");
    assert.equal(events.at(-1).type, "summary");
    assert.equal(events.at(-1).manifestPath, "outputs/manifest.json");
  });

  it("does not force process defaults when override flags are omitted", async () => {
    const stdout = createStream();
    const stderr = createStream();
    let seenOptions;

    const exitCode = await runCli(["--process", "batch-123"], {
      cwd: process.cwd(),
      env: {
        GEMINI_API_KEY: "test-key",
        REPLICATE_API_TOKEN: "test-token"
      },
      batchModule: {
        process: async (_batchName, options) => {
          seenOptions = options;
          return { batchName: "batch-123", succeeded: 0, failed: 0 };
        }
      },
      stdout,
      stderr,
      loadEnv: false
    });

    assert.equal(exitCode, 0);
    assert.equal(seenOptions.baseOnly, false);
    assert.equal(seenOptions.outputDir, null);
    assert.equal(seenOptions.concurrency, undefined);
    assert.equal(seenOptions.sizes, null);
    assert.equal(seenOptions.manifest, undefined);
  });

  it("parses inspect flags", () => {
    const ls = parseCliArgs(["--list-styles"]);
    assert.equal(ls.listStyles, true);
    const lb = parseCliArgs(["--list-batches"]);
    assert.equal(lb.listBatches, true);
    const sc = parseCliArgs(["--show-config"]);
    assert.equal(sc.showConfig, true);
    const vs = parseCliArgs(["--validate-style", "anime"]);
    assert.equal(vs.validateStyle, "anime");
  });

  it("validates inspect flags without requiring a pipeline mode", () => {
    assert.doesNotThrow(() => validateCliArgs(parseCliArgs(["--list-styles"])));
    assert.doesNotThrow(() => validateCliArgs(parseCliArgs(["--list-batches"])));
    assert.doesNotThrow(() => validateCliArgs(parseCliArgs(["--show-config"])));
    assert.doesNotThrow(() => validateCliArgs(parseCliArgs(["--validate-style", "anime"])));
  });

  it("--list-styles returns JSON with styles", async () => {
    const stdout = createStream();
    const exitCode = await runCli(["--list-styles", "--json"], {
      stdout,
      stderr: createStream(),
      loadEnv: false,
      styleModule: {
        listStyles: async () => [{ name: "test-style", hasQa: true, hasQaFinal: false }]
      }
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(stdout.read());
    assert.equal(output.type, "styles");
    assert.equal(output.styles[0].name, "test-style");
  });

  it("--list-batches returns JSON with batches", async () => {
    const stdout = createStream();
    const exitCode = await runCli(["--list-batches", "--json"], {
      cwd: "/tmp",
      stdout,
      stderr: createStream(),
      loadEnv: false,
      batchModule: {
        listBatches: async () => [{ batchName: "b-1", subjectCount: 3, succeeded: 2, failed: 1, pending: 0, createdAt: "2026-03-25" }]
      }
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(stdout.read());
    assert.equal(output.type, "batches");
    assert.equal(output.batches[0].batchName, "b-1");
  });

  it("--show-config returns JSON with config", async () => {
    const stdout = createStream();
    const exitCode = await runCli(["--show-config", "--json"], {
      stdout,
      stderr: createStream(),
      loadEnv: false,
      config: { models: { forge: "gemini-test" } }
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(stdout.read());
    assert.equal(output.type, "config");
    assert.equal(output.config.models.forge, "gemini-test");
  });

  it("--validate-style returns JSON validation result", async () => {
    const stdout = createStream();
    const exitCode = await runCli(["--validate-style", "test-style", "--json"], {
      stdout,
      stderr: createStream(),
      loadEnv: false,
      styleModule: {
        validateStyle: async () => ({ valid: true, name: "test-style", errors: [], warnings: ["no custom qa"] })
      }
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(stdout.read());
    assert.equal(output.type, "validation");
    assert.equal(output.valid, true);
    assert.equal(output.warnings[0], "no custom qa");
  });

  it("emits structured error in --json mode on failure", async () => {
    const stdout = createStream();
    const stderr = createStream();
    const exitCode = await runCli(["--json"], {
      stdout,
      stderr,
      loadEnv: false
    });
    assert.equal(exitCode, 1);
    const output = JSON.parse(stdout.read());
    assert.equal(output.type, "error");
    assert.ok(output.message.length > 0);
    assert.ok(stderr.read().includes("Error:"));
  });

  it("--list-batches shows human-readable output without --json", async () => {
    const stdout = createStream();
    const exitCode = await runCli(["--list-batches"], {
      cwd: "/tmp",
      stdout,
      stderr: createStream(),
      loadEnv: false,
      batchModule: {
        listBatches: async () => [{ batchName: "batch-x", subjectCount: 5, succeeded: 3, failed: 1, pending: 1 }]
      }
    });
    assert.equal(exitCode, 0);
    assert.match(stdout.read(), /batch-x.*3 succeeded.*1 failed.*1 pending/);
  });
});
