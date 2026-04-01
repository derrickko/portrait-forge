import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  extractBatchResponses,
  listBatches,
  loadState,
  process,
  readCsvSubjects,
  saveState,
  status,
  submit
} from "../src/batch.mjs";
import { createTempDir, pngBuffer, writePng } from "./helpers.mjs";

describe("batch", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-batch-");
    await writePng(path.join(tmpDir, "refs", "jane-doe.png"));
    await writePng(path.join(tmpDir, "outfits", "blazer.png"));
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses CSV subjects and derives ids", async () => {
    const csvPath = path.join(tmpDir, "subjects.csv");
    await fsp.writeFile(csvPath, [
      "name,ref_path,outfit_path",
      "Jane Doe,refs/jane-doe.png,outfits/blazer.png",
      "山田 太郎,refs/jane-doe.png,outfits/blazer.png"
    ].join("\n"));

    const parsed = await readCsvSubjects(csvPath);
    assert.equal(parsed.subjects.length, 2);
    assert.equal(parsed.subjects[0].subjectId, "jane-doe");
    assert.equal(parsed.subjects[1].subjectId, "山田-太郎");
  });

  it("writes state with skipped subjects on submit", async () => {
    const csvPath = path.join(tmpDir, "submit.csv");
    await fsp.writeFile(csvPath, [
      "name,ref_path,outfit_path",
      "Jane Doe,refs/jane-doe.png,outfits/blazer.png",
      "Missing Ref,refs/missing.png,outfits/blazer.png"
    ].join("\n"));

    const geminiClient = {
      batches: {
        create: async () => ({ name: "batch-test-1", state: "RUNNING" })
      }
    };

    const result = await submit(csvPath, {
      userRoot: tmpDir,
      geminiClient
    });

    assert.equal(result.batchName, "batch-test-1");
    const saved = await loadState("batch-test-1", { userRoot: tmpDir });
    assert.equal(saved.subjects.length, 2);
    assert.equal(saved.subjects[1].status, "skipped");
    assert.equal(saved.options.style, "game-day");
  });

  it("supports dry-run without API calls", async () => {
    const csvPath = path.join(tmpDir, "dry-run.csv");
    await fsp.writeFile(csvPath, "name,ref_path\nJane Doe,refs/jane-doe.png\n");

    let called = false;
    const result = await submit(csvPath, {
      userRoot: tmpDir,
      dryRun: true,
      geminiClient: {
        batches: {
          create: async () => {
            called = true;
            return { name: "should-not-run" };
          }
        }
      }
    });

    assert.equal(result.subjectCount, 1);
    assert.equal(called, false);
  });

  it("reports remote state and local progress", async () => {
    await saveState("batch-status", {
      batchName: "batch-status",
      subjects: [
        { subjectId: "one", status: "pending" },
        { subjectId: "two", status: "complete" },
        { subjectId: "three", status: "failed" }
      ]
    }, { userRoot: tmpDir });

    const summary = await status("batch-status", {
      userRoot: tmpDir,
      geminiClient: {
        batches: {
          get: async () => ({ state: "BATCH_STATE_SUCCEEDED" })
        }
      }
    });

    assert.equal(summary.batchState, "SUCCEEDED");
    assert.deepEqual(summary.localProgress, {
      pending: 1,
      complete: 1,
      failed: 1,
      skipped: 0
    });
  });

  it("surfaces failed terminal states", async () => {
    await saveState("batch-failed", {
      batchName: "batch-failed",
      subjects: []
    }, { userRoot: tmpDir });

    await assert.rejects(
      () => status("batch-failed", {
        userRoot: tmpDir,
        geminiClient: {
          batches: {
            get: async () => ({ state: "BATCH_STATE_FAILED" })
          }
        }
      }),
      /FAILED/
    );
  });

  it("extracts inline and file-based responses", async () => {
    const inline = await extractBatchResponses({
      output: {
        inlinedResponses: {
          inlinedResponses: [
            {
              metadata: { outputId: "one-stage1" },
              response: { ok: true }
            }
          ]
        }
      }
    }, {
      geminiClient: {}
    });
    assert.equal(inline.get("one-stage1").success, true);

    const fileBased = await extractBatchResponses({
      output: { responsesFile: "file-1" }
    }, {
      geminiClient: {
        files: {
          download: async () => Buffer.from(JSON.stringify({
            metadata: { outputId: "two-stage1" },
            response: { ok: true }
          }))
        }
      }
    });
    assert.equal(fileBased.get("two-stage1").success, true);
  });

  it("processes successful batch responses and marks per-subject failures", async () => {
    await saveState("batch-process", {
      batchName: "batch-process",
      options: { outputDir: "./outputs", concurrency: 2 },
      subjects: [
        { subjectId: "jane-doe", name: "Jane Doe", refPath: "refs/jane-doe.png", outfitPath: "outfits/blazer.png", status: "pending" },
        { subjectId: "broken", name: "Broken", refPath: "refs/jane-doe.png", outfitPath: "outfits/blazer.png", status: "pending" }
      ]
    }, { userRoot: tmpDir });

    const realPipeline = await import("../src/pipeline.mjs");
    const summary = await process("batch-process", {
      userRoot: tmpDir,
      geminiClient: {
        batches: {
          get: async () => ({
            state: "BATCH_STATE_SUCCEEDED",
            output: {
              inlinedResponses: {
                inlinedResponses: [
                  {
                    metadata: { outputId: "jane-doe-stage1" },
                    response: {
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
                    }
                  },
                  {
                    metadata: { outputId: "broken-stage1" },
                    error: { message: "generation failed" }
                  }
                ]
              }
            }
          })
        }
      },
      pipeline: {
        ...realPipeline,
        processBaseImages: async (subjects, options) => {
          const [subject] = subjects;
          await fsp.mkdir(path.dirname(subject.outputPath), { recursive: true });
          await fsp.writeFile(subject.outputPath, pngBuffer());
          const event = {
            type: "complete",
            subjectId: subject.subjectId,
            outputPath: subject.outputPath,
            outputs: { "1024": subject.outputPath },
          };
          await options.emitter.emit(event);
          const result = { subjectId: subject.subjectId, status: "complete", outputPath: subject.outputPath, outputs: { "1024": subject.outputPath } };
          return [result];
        }
      }
    });

    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    const saved = await loadState("batch-process", { userRoot: tmpDir });
    assert.equal(saved.subjects.find((entry) => entry.subjectId === "jane-doe").status, "complete");
    assert.equal(saved.subjects.find((entry) => entry.subjectId === "broken").status, "failed");
  });

  it("honors explicit process overrides over saved state", async () => {
    await saveState("batch-overrides", {
      batchName: "batch-overrides",
      options: { outputDir: "./outputs", concurrency: 2 },
      subjects: [
        { subjectId: "jane-doe", name: "Jane Doe", refPath: "refs/jane-doe.png", outfitPath: "outfits/blazer.png", status: "pending" }
      ]
    }, { userRoot: tmpDir });

    let seenOptions;
    const realPipeline = await import("../src/pipeline.mjs");
    const summary = await process("batch-overrides", {
      userRoot: tmpDir,
      outputDir: "./custom-out",
      concurrency: 7,
      sizes: [512],
      manifest: true,
      geminiClient: {
        batches: {
          get: async () => ({
            state: "BATCH_STATE_SUCCEEDED",
            output: {
              inlinedResponses: {
                inlinedResponses: [
                  {
                    metadata: { outputId: "jane-doe-stage1" },
                    response: {
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
                    }
                  }
                ]
              }
            }
          })
        }
      },
      pipeline: {
        ...realPipeline,
        processBaseImages: async (subjects, options) => {
          seenOptions = {
            baseOnly: options.baseOnly,
            outputDir: options.outputDir,
            concurrency: options.concurrency,
            sizes: options.sizes,
            manifest: options.manifest,
            outputPath: subjects[0].outputPath
          };
          await fsp.mkdir(path.dirname(subjects[0].outputPath), { recursive: true });
          await fsp.writeFile(subjects[0].outputPath, pngBuffer());
          await options.emitter.emit({
            type: "complete",
            subjectId: subjects[0].subjectId,
            outputPath: subjects[0].outputPath,
            outputs: { "1024": subjects[0].outputPath, "512": path.join(tmpDir, "custom-out", "jane-doe-512.png") },
          });
          const result = {
            subjectId: subjects[0].subjectId,
            status: "complete",
            outputPath: subjects[0].outputPath,
            outputs: { "1024": subjects[0].outputPath, "512": path.join(tmpDir, "custom-out", "jane-doe-512.png") }
          };
          return [result];
        }
      }
    });

    assert.equal(summary.succeeded, 1);
    assert.deepEqual(seenOptions, {
      baseOnly: false,
      outputDir: path.join(tmpDir, "custom-out"),
      concurrency: 7,
      sizes: [512],
      manifest: true,
      outputPath: path.join(tmpDir, "custom-out", "jane-doe.png")
    });

    const saved = await loadState("batch-overrides", { userRoot: tmpDir });
    assert.deepEqual(saved.options, {
      baseOnly: false,
      outputDir: "./custom-out",
      concurrency: 7,
      style: null,
      sizes: [512],
      manifest: true
    });
  });

  it("is idempotent when final output already exists", async () => {
    const outputPath = path.join(tmpDir, "outputs", "existing.png");
    await writePng(outputPath);
    await saveState("batch-existing", {
      batchName: "batch-existing",
      options: { outputDir: "./outputs", concurrency: 2 },
      subjects: [
        { subjectId: "existing", name: "Existing", refPath: "refs/jane-doe.png", outfitPath: "outfits/blazer.png", status: "pending" }
      ]
    }, { userRoot: tmpDir });

    const summary = await process("batch-existing", {
      userRoot: tmpDir,
      geminiClient: {
        batches: {
          get: async () => ({ state: "BATCH_STATE_SUCCEEDED", output: {} })
        }
      }
    });

    assert.equal(summary.succeeded, 1);
    const saved = await loadState("batch-existing", { userRoot: tmpDir });
    assert.equal(saved.subjects[0].status, "complete");
  });

  it("rejects process on non-succeeded batches", async () => {
    await saveState("batch-running", {
      batchName: "batch-running",
      subjects: []
    }, { userRoot: tmpDir });

    await assert.rejects(
      () => process("batch-running", {
        userRoot: tmpDir,
        geminiClient: {
          batches: {
            get: async () => ({ state: "BATCH_STATE_RUNNING" })
          }
        }
      }),
      /SUCCEEDED/
    );
  });

  it("writes state atomically", async () => {
    const statePath = path.join(tmpDir, "batches", "atomic.json");
    await saveState("atomic", { batchName: "atomic", subjects: [] }, { userRoot: tmpDir });
    await assert.doesNotReject(() => fsp.access(statePath));
    const files = await fsp.readdir(path.dirname(statePath));
    assert.equal(files.some((fileName) => fileName.endsWith(".tmp")), false);
  });

  it("supports concurrent writes to the same state file", async () => {
    await assert.doesNotReject(() => Promise.all(
      Array.from({ length: 10 }, (_entry, index) => saveState("atomic-race", {
        batchName: "atomic-race",
        index
      }, { userRoot: tmpDir }))
    ));

    const saved = await loadState("atomic-race", { userRoot: tmpDir });
    assert.equal(saved.batchName, "atomic-race");
    assert.equal(Number.isInteger(saved.index), true);
  });

  it("includes cwd guidance when state file is missing", async () => {
    await assert.rejects(
      () => loadState("does-not-exist", { userRoot: tmpDir }),
      /same directory where you submitted/
    );
  });
});

describe("listBatches", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-list-batches-");
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when batches dir does not exist", async () => {
    const result = await listBatches({ userRoot: tmpDir });
    assert.deepEqual(result, []);
  });

  it("lists batches with summary metadata", async () => {
    const batchesDir = path.join(tmpDir, "batches");
    await fsp.mkdir(batchesDir, { recursive: true });

    await fsp.writeFile(path.join(batchesDir, "batch-a.json"), JSON.stringify({
      batchName: "batch-a",
      createdAt: "2026-03-25T10:00:00Z",
      subjects: [
        { subjectId: "s1", status: "complete" },
        { subjectId: "s2", status: "failed" },
        { subjectId: "s3", status: "pending" }
      ]
    }));

    await fsp.writeFile(path.join(batchesDir, "batch-b.json"), JSON.stringify({
      batchName: "batch-b",
      createdAt: "2026-03-26T10:00:00Z",
      subjects: [
        { subjectId: "s1", status: "complete" },
        { subjectId: "s2", status: "complete" }
      ]
    }));

    const result = await listBatches({ userRoot: tmpDir });
    assert.equal(result.length, 2);
    assert.equal(result[0].batchName, "batch-b");
    assert.equal(result[0].succeeded, 2);
    assert.equal(result[0].failed, 0);
    assert.equal(result[0].pending, 0);
    assert.equal(result[1].batchName, "batch-a");
    assert.equal(result[1].succeeded, 1);
    assert.equal(result[1].failed, 1);
    assert.equal(result[1].pending, 1);
  });

  it("skips malformed JSON files gracefully", async () => {
    const batchesDir = path.join(tmpDir, "batches");
    await fsp.writeFile(path.join(batchesDir, "bad.json"), "not json");

    const result = await listBatches({ userRoot: tmpDir });
    const names = result.map((b) => b.batchName);
    assert.ok(!names.includes("bad"));
  });
});
