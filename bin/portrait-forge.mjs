#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as pipeline from "../src/pipeline.mjs";
import * as batch from "../src/batch.mjs";
import { loadConfig } from "../src/config.mjs";
import { listStyles, validateStyle } from "../src/style.mjs";
import { parseSizes, scrubSensitiveData } from "../src/utils.mjs";

const VERSION = "0.2.0";

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export function printHelp(stdout = process.stdout) {
  stdout.write(`portrait-forge

Usage:
  portrait-forge --ref <path> --outfit <path> [options]
  portrait-forge --csv <path> [--dry-run] [options]
  portrait-forge --status <batch-name> [--json]
  portrait-forge --process <batch-name> [options]
  portrait-forge --list-styles [--json]
  portrait-forge --list-batches [--json]
  portrait-forge --show-config [--json]
  portrait-forge --validate-style <name-or-path> [--json]

Single image:
  --ref <path>                Reference image path
  --outfit <path>             Outfit overlay image path
  --subject-type <value>      Prompt override (default: person)
  --output <path>             Final PNG path

Batch:
  --csv <path>                CSV input
  --default-outfit <path>     Fallback outfit image
  --output-dir <path>         Output directory (default: ./outputs)
  --concurrency <n>           Parallel BG removal / QA workers (default: 2)
  --dry-run                   Validate CSV and report count
  --status <batch-name>       Poll Gemini batch state and local progress
  --process <batch-name>      Download batch results and finish processing

Inspect:
  --list-styles               List available style profiles
  --list-batches              List batch runs in ./batches/
  --show-config               Show resolved configuration
  --validate-style <name>     Validate a style profile

Shared:
  --cwd <path>                Working directory for inputs/outputs (default: cwd)
  --config <path>             Config file path (default: portrait-forge.config.json)
  --style <name-or-path>      Style profile (default: game-day)
  --base-only                 Stop after generation + verification (skip bg-removal)
  --sizes <list>              Additional output sizes, e.g. 512,256
  --manifest                  Write <output-dir>/manifest.json
  --json                      Emit structured NDJSON to stdout
  --verbose                   Extra logging
  --help                      Show help
  --version                   Show version
`);
}

async function loadDotenvIfPresent(cwd) {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: path.join(cwd, ".env") });
  } catch {
    return false;
  }
  return true;
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      cwd: { type: "string" },
      ref: { type: "string" },
      outfit: { type: "string" },
      csv: { type: "string" },
      status: { type: "string" },
      process: { type: "string" },
      config: { type: "string" },
      subjectType: { type: "string" },
      "subject-type": { type: "string" },
      output: { type: "string" },
      outputDir: { type: "string" },
      "output-dir": { type: "string" },
      defaultOutfit: { type: "string" },
      "default-outfit": { type: "string" },
      concurrency: { type: "string" },
      dryRun: { type: "boolean" },
      "dry-run": { type: "boolean" },
      style: { type: "string" },
      baseOnly: { type: "boolean" },
      "base-only": { type: "boolean" },
      qa: { type: "boolean" },
      maxRetries: { type: "string" },
      "max-retries": { type: "string" },
      sizes: { type: "string" },
      manifest: { type: "boolean" },
      listStyles: { type: "boolean" },
      "list-styles": { type: "boolean" },
      listBatches: { type: "boolean" },
      "list-batches": { type: "boolean" },
      showConfig: { type: "boolean" },
      "show-config": { type: "boolean" },
      validateStyle: { type: "string" },
      "validate-style": { type: "string" },
      json: { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" }
    }
  });

  return {
    cwd: values.cwd || null,
    ref: values.ref || null,
    outfit: values.outfit || null,
    csv: values.csv || null,
    status: values.status || null,
    process: values.process || null,
    config: values.config || null,
    subjectType: values.subjectType || values["subject-type"] || null,
    output: values.output || null,
    outputDir: values.outputDir || values["output-dir"] || null,
    defaultOutfit: values.defaultOutfit || values["default-outfit"] || null,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
    dryRun: Boolean(values.dryRun || values["dry-run"]),
    style: values.style || null,
    baseOnly: Boolean(values.baseOnly || values["base-only"]),
    qa: values.qa || undefined,
    maxRetries: values.maxRetries || values["max-retries"] || undefined,
    sizes: values.sizes || null,
    manifest: values.manifest ? true : undefined,
    listStyles: Boolean(values.listStyles || values["list-styles"]),
    listBatches: Boolean(values.listBatches || values["list-batches"]),
    showConfig: Boolean(values.showConfig || values["show-config"]),
    validateStyle: values.validateStyle || values["validate-style"] || null,
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
    help: Boolean(values.help),
    version: Boolean(values.version)
  };
}

export function validateCliArgs(values) {
  if (values.help || values.version) {
    return values;
  }

  const inspectMode = values.listStyles || values.listBatches || values.showConfig || values.validateStyle;
  if (inspectMode) {
    return values;
  }

  if (values.qa || values.maxRetries != null) {
    throw new Error("--qa and --max-retries have been removed. Use --base-only for staged QA. See SKILL.md for orchestration instructions.");
  }

  if (values.csv && values.outfit) {
    throw new Error("--outfit cannot be used with --csv. Use --default-outfit instead.");
  }

  const singleMode = Boolean(values.ref || values.outfit);
  const batchMode = Boolean(values.csv);
  const statusMode = Boolean(values.status);
  const processMode = Boolean(values.process);
  const activeModes = [singleMode, batchMode, statusMode, processMode].filter(Boolean).length;

  if (activeModes !== 1) {
    throw new Error("Choose exactly one mode: --ref/--outfit, --csv, --status, or --process.");
  }

  if (singleMode && (!values.ref || !values.outfit)) {
    throw new Error("Single-image mode requires both --ref and --outfit.");
  }

  if (batchMode && values.output) {
    throw new Error("--output cannot be used with --csv. Use --output-dir instead.");
  }

  if (!batchMode && values.defaultOutfit) {
    throw new Error("--default-outfit is only valid with --csv.");
  }

  if (values.dryRun && !batchMode) {
    throw new Error("--dry-run is only valid with --csv.");
  }

  if (values.concurrency != null && (Number.isNaN(values.concurrency) || values.concurrency < 1)) {
    throw new Error("--concurrency must be a positive integer.");
  }

  if (values.sizes != null) {
    parseSizes(values.sizes);
    if (!(singleMode || processMode)) {
      throw new Error("--sizes is only valid with single-image mode or --process.");
    }
  }

  if (values.baseOnly && !(singleMode || processMode)) {
    throw new Error("--base-only is only valid with single-image mode or --process.");
  }

  if (values.manifest && !(singleMode || processMode)) {
    throw new Error("--manifest is only valid with single-image mode or --process.");
  }

  return values;
}

async function hasDotEnvFile(cwd) {
  try {
    await fsp.access(path.join(cwd, ".env"));
    return true;
  } catch {
    return false;
  }
}

function buildEnvError(name) {
  return `${name} is required. Create .env from .env.example or export it directly.`;
}

async function validateRuntime(values, runtime = {}, cwd) {
  const env = runtime.env || process.env;

  if (values.help || values.version || values.dryRun) {
    return;
  }

  const needsGemini = Boolean(values.ref || values.csv || values.status || values.process);
  const needsReplicate = Boolean((values.ref || values.process) && !values.baseOnly);

  if (needsGemini && !(env.GEMINI_API_KEY || env.GOOGLE_API_KEY)) {
    const hasEnvFile = await hasDotEnvFile(cwd);
    throw new Error(`${buildEnvError("GEMINI_API_KEY")}${hasEnvFile ? "" : " See .env.example."}`);
  }

  if (needsReplicate && !env.REPLICATE_API_TOKEN) {
    const hasEnvFile = await hasDotEnvFile(cwd);
    throw new Error(`${buildEnvError("REPLICATE_API_TOKEN")}${hasEnvFile ? "" : " See .env.example."}`);
  }
}

function writeJson(stdout, payload) {
  stdout.write(`${JSON.stringify(payload)}\n`);
}

function createProgressWriter(stderr, total) {
  let completed = 0;
  return async (event) => {
    if (event.type !== "complete" && event.type !== "failed") {
      return;
    }

    completed += 1;
    const prefix = total ? `[${completed}/${total}]` : `[${completed}]`;
    const durationSuffix = Number.isFinite(event.durationSec) ? ` (${event.durationSec.toFixed(1)}s)` : "";
    if (event.type === "complete") {
      const skipSuffix = event.skippedExisting ? " [skipped-existing]" : "";
      stderr.write(`${prefix} ${event.subjectId}: complete${skipSuffix}${durationSuffix}\n`);
      return;
    }

    stderr.write(`${prefix} ${event.subjectId}: failed - ${event.error}${durationSuffix}\n`);
  };
}

function writeSummaryEvent(stdout, payload) {
  writeJson(stdout, {
    type: "summary",
    ...payload
  });
}

function resolveSizes(values) {
  return values.sizes != null ? parseSizes(values.sizes) : null;
}

export async function runCli(argv, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const stderr = runtime.stderr || process.stderr;

  let jsonMode = false;
  try {
    const values = parseCliArgs(argv);
    jsonMode = values.json;
    validateCliArgs(values);

    const cwd = values.cwd ? path.resolve(values.cwd) : (runtime.cwd || process.cwd());

    if (runtime.loadEnv !== false) {
      await loadDotenvIfPresent(cwd);
    }

    if (values.help) {
      printHelp(stdout);
      return 0;
    }

    if (values.version) {
      stdout.write(`${VERSION}\n`);
      return 0;
    }

    if (values.listStyles) {
      const styles = await (runtime.styleModule || { listStyles }).listStyles({ cwd });
      if (values.json) {
        writeJson(stdout, { type: "styles", styles });
      } else {
        for (const s of styles) {
          const sourceTag = s.source === "local" ? " (local)" : "";
          stdout.write(`${s.name}${sourceTag}${s.hasQa ? "" : " (no custom qa)"}${s.hasQaFinal ? " +qa-final" : ""}\n`);
        }
      }
      return 0;
    }

    if (values.listBatches) {
      const batchModule = runtime.batchModule || batch;
      const batches = await batchModule.listBatches({ userRoot: cwd });
      if (values.json) {
        writeJson(stdout, { type: "batches", batches });
      } else if (batches.length === 0) {
        stdout.write("No batches found in ./batches/\n");
      } else {
        for (const b of batches) {
          stdout.write(`${b.batchName}: ${b.succeeded} succeeded, ${b.failed} failed, ${b.pending} pending (${b.subjectCount} total)\n`);
        }
      }
      return 0;
    }

    if (values.showConfig) {
      const config = runtime.config || await loadConfig(values.config, cwd);
      if (values.json) {
        writeJson(stdout, { type: "config", config });
      } else {
        stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      }
      return 0;
    }

    if (values.validateStyle) {
      const result = await (runtime.styleModule || { validateStyle }).validateStyle(values.validateStyle, { cwd });
      if (values.json) {
        writeJson(stdout, { type: "validation", ...result });
      } else {
        stdout.write(`${result.name}: ${result.valid ? "valid" : "invalid"}\n`);
        for (const e of result.errors) stdout.write(`  error: ${e}\n`);
        for (const w of result.warnings) stdout.write(`  warning: ${w}\n`);
      }
      return 0;
    }

    await validateRuntime(values, runtime, cwd);

    const config = runtime.config || await loadConfig(values.config, cwd);
    const resolvedSizes = resolveSizes(values);

    if (values.ref) {
      const pipelineModule = runtime.pipelineModule || pipeline;
      const emitter = (pipelineModule.createEmitter || pipeline.createEmitter)();
      if (values.json) {
        emitter.on((event) => writeJson(stdout, event));
      } else {
        emitter.on(createProgressWriter(stderr, 1));
      }

      const result = await pipelineModule.processImmediate({
        ref: values.ref,
        outfit: values.outfit,
        subjectType: values.subjectType,
        output: values.output,
        style: values.style,
        baseOnly: values.baseOnly,
        sizes: resolvedSizes,
        manifest: values.manifest,
        userRoot: cwd,
        env: runtime.env,
        config,
        fetchImpl: runtime.fetchImpl,
        geminiClient: runtime.geminiClient,
        replicateClient: runtime.replicateClient,
        emitter
      });
      if (values.json) {
        writeSummaryEvent(stdout, {
          processed: 1,
          succeeded: 1,
          failed: 0,
          durationSec: result.durationSec,
          ...(result.manifestPath ? { manifestPath: result.manifestPath } : {})
        });
      } else {
        stdout.write(`${result.baseOnly ? result.basePath : result.output}\n`);
      }
      return 0;
    }

    if (values.csv) {
      const result = await (runtime.batchModule || batch).submit(values.csv, {
        json: values.json,
        dryRun: values.dryRun,
        outputDir: values.outputDir ?? "./outputs",
        defaultOutfit: values.defaultOutfit,
        concurrency: values.concurrency ?? 2,
        subjectType: values.subjectType,
        style: values.style,
        userRoot: cwd,
        env: runtime.env,
        config,
        geminiClient: runtime.geminiClient,
        pipeline: runtime.pipelineModule
      });
      if (values.json) {
        writeJson(stdout, result);
      } else if (values.dryRun) {
        stdout.write(`Validated ${result.subjectCount} subjects (${result.skipped} skipped)\n`);
      } else {
        stdout.write(`Submitted ${result.subjectCount} subjects as ${result.batchName} (${result.skipped} skipped)\n`);
      }
      return 0;
    }

    if (values.status) {
      const result = await (runtime.batchModule || batch).status(values.status, {
        userRoot: cwd,
        env: runtime.env,
        config,
        geminiClient: runtime.geminiClient
      });
      if (values.json) {
        writeJson(stdout, result);
      } else {
        stdout.write(`${result.batchName}: ${result.batchState}\n`);
      }
      return 0;
    }

    if (values.process) {
      const batchModule = runtime.batchModule || batch;
      const pipelineModule = runtime.pipelineModule || pipeline;
      const emitter = (pipelineModule.createEmitter || pipeline.createEmitter)();
      if (values.json) {
        emitter.on((event) => writeJson(stdout, event));
      } else {
        const state = typeof batchModule.loadState === "function"
          ? await batchModule.loadState(values.process, { userRoot: cwd })
          : null;
        const total = state ? state.subjects.filter((subject) => subject.status !== "skipped").length : null;
        emitter.on(createProgressWriter(stderr, total));
      }

      const result = await batchModule.process(values.process, {
        baseOnly: values.baseOnly,
        style: values.style,
        outputDir: values.outputDir,
        concurrency: values.concurrency,
        sizes: resolvedSizes,
        manifest: values.manifest,
        userRoot: cwd,
        env: runtime.env,
        config,
        fetchImpl: runtime.fetchImpl,
        geminiClient: runtime.geminiClient,
        replicateClient: runtime.replicateClient,
        pipeline: pipelineModule,
        emitter
      });
      if (values.json) {
        writeSummaryEvent(stdout, {
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
          durationSec: result.durationSec,
          ...(result.manifestPath ? { manifestPath: result.manifestPath } : {})
        });
      } else {
        stdout.write(`Processed ${result.batchName}: ${result.succeeded} succeeded, ${result.failed} failed\n`);
      }
      return 0;
    }

    throw new Error("No mode selected.");
  } catch (error) {
    const message = scrubSensitiveData(error?.message || String(error));
    if (jsonMode) {
      writeJson(stdout, { type: "error", message });
    }
    stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

async function main() {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

if (isMain()) {
  await main();
}
