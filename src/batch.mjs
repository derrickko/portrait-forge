import fsp from "node:fs/promises";
import path from "node:path";
import * as defaultPipeline from "./pipeline.mjs";
import { resolveStyle } from "./style.mjs";
import {
  buildOutputPath,
  deriveSubjectId,
  ensureDir,
  fileExists,
  readJson,
  sanitizeSubjectId,
  sanitizeSubjectName,
  scrubSensitiveData,
  validatePathInput,
  writeJsonAtomic
} from "./utils.mjs";

const TERMINAL_FAILURE_STATES = new Set(["FAILED", "CANCELLED", "EXPIRED"]);
const SUCCESS_STATES = new Set(["SUCCEEDED"]);

function resolveUserRoot(options = {}) {
  return path.resolve(options.userRoot || process.cwd());
}

function resolveInputPath(value, baseDir) {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function toStoredPath(filePath, userRoot) {
  const relative = path.relative(userRoot, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function toStoredOutputs(outputs, userRoot) {
  return Object.fromEntries(
    Object.entries(outputs || {}).map(([size, outputPath]) => [size, toStoredPath(outputPath, userRoot)])
  );
}

function simplifyBatchState(rawState) {
  if (!rawState) {
    return "UNKNOWN";
  }
  const value = String(rawState).toUpperCase();
  return value
    .replace(/^JOB_STATE_/, "")
    .replace(/^BATCH_STATE_/, "")
    .replace(/^STATE_/, "");
}

function getStatePath(batchName, userRoot) {
  return path.join(userRoot, "batches", `${batchName}.json`);
}

export async function listBatches(options = {}) {
  const userRoot = resolveUserRoot(options);
  const batchesDir = path.join(userRoot, "batches");

  let entries;
  try {
    entries = await fsp.readdir(batchesDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));

  const results = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const state = await readJson(path.join(batchesDir, file));
        const subjects = state.subjects || [];
        let succeeded = 0, failed = 0, pending = 0;
        for (const s of subjects) {
          if (s.status === "complete") succeeded++;
          else if (s.status === "failed") failed++;
          else if (s.status !== "skipped") pending++;
        }
        return {
          batchName: state.batchName || file.replace(/\.json$/, ""),
          subjectCount: subjects.length,
          succeeded,
          failed,
          pending,
          createdAt: state.createdAt || null
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter(Boolean).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

export async function loadState(batchName, options = {}) {
  const userRoot = resolveUserRoot(options);
  const statePath = getStatePath(batchName, userRoot);
  if (!(await fileExists(statePath))) {
    throw new Error(`State file not found at ./batches/${batchName}.json — run this command from the same directory where you submitted the batch.`);
  }

  try {
    return await readJson(statePath);
  } catch (error) {
    throw new Error(`Failed to parse state file ./batches/${batchName}.json: ${scrubSensitiveData(error?.message || String(error))}`);
  }
}

export async function saveState(batchName, state, options = {}) {
  const userRoot = resolveUserRoot(options);
  const statePath = getStatePath(batchName, userRoot);
  await writeJsonAtomic(statePath, state);
  return statePath;
}

export function updateSubjectStatus(state, subjectId, status, error = null, details = {}) {
  const subject = state.subjects.find((entry) => entry.subjectId === subjectId);
  if (!subject) {
    throw new Error(`Unknown subject in state: ${subjectId}`);
  }
  subject.status = status;
  if (error) {
    subject.error = error;
  } else {
    delete subject.error;
  }
  if (details.outputs) {
    subject.outputs = details.outputs;
  } else if (status !== "complete") {
    subject.outputs = {};
  }
  return subject;
}

function parseCsvFallback(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      current = "";
      if (row.some((entry) => entry !== "")) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    current += char;
  }

  if (current !== "" || row.length) {
    row.push(current);
    rows.push(row);
  }

  if (!rows.length) {
    return [];
  }

  const [header, ...dataRows] = rows;
  return dataRows.map((dataRow) => Object.fromEntries(
    header.map((column, index) => [column.trim(), (dataRow[index] || "").trim()])
  ));
}

async function parseCsvFile(csvPath) {
  const raw = await fsp.readFile(csvPath, "utf8");
  try {
    const mod = await import("csv-parse/sync");
    return mod.parse(raw, { columns: true, trim: true, skip_empty_lines: true });
  } catch {
    return parseCsvFallback(raw);
  }
}

export async function readCsvSubjects(csvPath) {
  const resolvedCsvPath = path.resolve(String(csvPath));
  const csvDir = path.dirname(resolvedCsvPath);
  const records = await parseCsvFile(resolvedCsvPath);
  const subjects = [];
  const seenIds = new Set();

  for (const record of records) {
    const subjectName = record.name || record.subject_name || record.subjectName;
    if (!subjectName) {
      throw new Error("CSV row missing name.");
    }

    const safeName = sanitizeSubjectName(subjectName);
    const rawId = record.id || record.subject_id || record.subjectId || null;
    const subjectId = rawId ? sanitizeSubjectId(rawId) : deriveSubjectId(safeName);
    if (seenIds.has(subjectId)) {
      throw new Error(`Duplicate subject id: ${subjectId}`);
    }
    seenIds.add(subjectId);

    const refPath = record.ref_path || record.refPath || null;
    const outfitPath = record.outfit_path || record.outfitPath || null;
    if (refPath) validatePathInput(refPath, "ref_path");
    if (outfitPath) validatePathInput(outfitPath, "outfit_path");

    subjects.push({
      subjectId,
      name: safeName,
      refPath: refPath ? resolveInputPath(refPath, csvDir) : null,
      outfitPath: outfitPath ? resolveInputPath(outfitPath, csvDir) : null,
      subjectType: record.subject_type || record.subjectType || null
    });
  }

  return {
    csvPath: resolvedCsvPath,
    csvDir,
    subjects
  };
}

async function getGeminiClient(options = {}) {
  if (options.geminiClient) {
    return options.geminiClient;
  }
  return defaultPipeline.getGeminiClient(options);
}

async function createBatch(ai, { model, requests, displayName }) {
  if (typeof ai.createBatch === "function") {
    return ai.createBatch({ model, requests, displayName });
  }
  if (ai.batches?.create) {
    return ai.batches.create({
      model,
      src: { inlinedRequests: requests },
      config: { displayName }
    });
  }
  throw new Error("Gemini batch client does not implement batch creation.");
}

async function getBatch(ai, batchName) {
  if (typeof ai.getBatch === "function") {
    return ai.getBatch(batchName);
  }
  if (ai.batches?.get) {
    return ai.batches.get({ name: batchName });
  }
  throw new Error("Gemini batch client does not implement batch lookup.");
}

async function downloadBatchFile(ai, fileName) {
  if (typeof ai.downloadFile === "function") {
    return ai.downloadFile(fileName);
  }
  if (ai.files?.download) {
    return ai.files.download({ file: fileName });
  }
  throw new Error("Gemini batch client does not implement file download.");
}

export async function submit(csvPath, options = {}) {
  const pipeline = options.pipeline || defaultPipeline;
  const userRoot = resolveUserRoot(options);
  const promptConfig = await resolveStyle(options.style, { cwd: userRoot });
  const { subjects, csvPath: resolvedCsvPath } = await readCsvSubjects(csvPath);
  const refsDir = path.resolve(userRoot, options.refsDir || "refs");
  const defaultOutfit = options.defaultOutfit
    ? resolveInputPath(options.defaultOutfit, userRoot)
    : null;

  if (defaultOutfit && !(await fileExists(defaultOutfit))) {
    throw new Error(`Default outfit image not found: ${defaultOutfit}`);
  }

  const validSubjects = [];
  const requests = [];
  let skipped = 0;

  for (const subject of subjects) {
    const resolvedRef = await pipeline.resolveReferenceImage(subject, refsDir, {
      userRoot,
      baseDir: userRoot
    });
    const resolvedOutfit = subject.outfitPath || defaultOutfit;

    if (!resolvedRef.path) {
      validSubjects.push({
        subjectId: subject.subjectId,
        name: subject.name,
        refPath: subject.refPath ? toStoredPath(subject.refPath, userRoot) : null,
        outfitPath: resolvedOutfit ? toStoredPath(resolvedOutfit, userRoot) : null,
        status: "skipped",
        error: "Reference image not found."
      });
      skipped += 1;
      continue;
    }

    if (resolvedOutfit && !(await fileExists(resolvedOutfit))) {
      validSubjects.push({
        subjectId: subject.subjectId,
        name: subject.name,
        refPath: toStoredPath(resolvedRef.path, userRoot),
        outfitPath: toStoredPath(resolvedOutfit, userRoot),
        status: "skipped",
        error: "Outfit image not found."
      });
      skipped += 1;
      continue;
    }

    const resolvedSubject = {
      ...subject,
      refPath: resolvedRef.path,
      outfitPath: resolvedOutfit,
      subjectType: subject.subjectType || options.subjectType || defaultPipeline.DEFAULT_SUBJECT_TYPE
    };

    requests.push(await pipeline.buildInlineRequest(resolvedSubject, { ...options, promptConfig }));
    validSubjects.push({
      subjectId: subject.subjectId,
      name: subject.name,
      refPath: toStoredPath(resolvedRef.path, userRoot),
      outfitPath: resolvedOutfit ? toStoredPath(resolvedOutfit, userRoot) : null,
      status: "pending"
    });
  }

  if (options.dryRun) {
    return {
      subjectCount: requests.length,
      skipped
    };
  }

  if (!requests.length) {
    throw new Error("No valid subjects available for batch submission.");
  }

  const ai = await getGeminiClient(options);
  const displayName = `portrait-forge-batch-${Date.now()}`;
  const batchJob = await createBatch(ai, {
    model: options.model || defaultPipeline.DEFAULT_MODEL,
    requests,
    displayName
  });
  const batchName = batchJob.name || displayName;

  const state = {
    batchName,
    displayName,
    status: "submitted",
    submittedAt: new Date().toISOString(),
    completedAt: null,
    subjectCount: requests.length,
    csvPath: toStoredPath(resolvedCsvPath, userRoot),
    options: {
      outputDir: options.outputDir ?? "./outputs",
      concurrency: Number(options.concurrency ?? 2),
      subjectType: options.subjectType || defaultPipeline.DEFAULT_SUBJECT_TYPE,
      style: promptConfig.name,
      sizes: Array.isArray(options.sizes) ? options.sizes : null,
      manifest: Boolean(options.manifest)
    },
    subjects: validSubjects
  };

  await saveState(batchName, state, options);
  return {
    batchName,
    subjectCount: requests.length,
    skipped
  };
}

function buildLocalProgress(subjects) {
  const progress = {
    pending: 0,
    complete: 0,
    failed: 0,
    skipped: 0
  };

  for (const subject of subjects) {
    const status = subject.status || "pending";
    if (status === "complete") progress.complete += 1;
    else if (status === "failed") progress.failed += 1;
    else if (status === "skipped") progress.skipped += 1;
    else progress.pending += 1;
  }

  return progress;
}

function applyEmitterEventToState(state, event, userRoot) {
  if (!event || (event.type !== "complete" && event.type !== "failed")) {
    return null;
  }

  const status = event.type === "complete" ? "complete" : "failed";
  const details = {
    outputs: event.outputs ? toStoredOutputs(event.outputs, userRoot) : {},
  };

  const subject = updateSubjectStatus(
    state,
    event.subjectId,
    status,
    status === "failed" ? (event.error || "Processing failed.") : null,
    details
  );

  if (status === "complete") {
    delete subject.error;
  }
  return subject;
}

export async function status(batchName, options = {}) {
  const state = await loadState(batchName, options);
  const ai = await getGeminiClient(options);
  const batch = await getBatch(ai, state.batchName || batchName);
  const batchState = simplifyBatchState(batch?.state || batch?.status);

  if (TERMINAL_FAILURE_STATES.has(batchState)) {
    throw new Error(`Batch ${batchName} is ${batchState}.`);
  }

  return {
    batchName,
    batchState,
    localProgress: buildLocalProgress(state.subjects)
  };
}

export async function extractBatchResponses(batchStatus, options = {}) {
  const ai = await getGeminiClient(options);
  const output = batchStatus?.output || batchStatus?.dest || {};
  const results = new Map();

  const inlinedResponses = (
    output?.inlinedResponses?.inlinedResponses ||
    output?.inlinedResponses ||
    batchStatus?.dest?.inlinedResponses ||
    []
  );
  if (Array.isArray(inlinedResponses) && inlinedResponses.length) {
    for (const entry of inlinedResponses) {
      const outputId = entry?.metadata?.outputId || entry?.metadata?.subjectId || entry?.key;
      if (!outputId) {
        continue;
      }
      results.set(outputId, {
        success: !entry.error,
        error: entry.error || null,
        response: entry.response || entry
      });
    }
    return results;
  }

  const fileName = output?.responsesFile || output?.fileName || batchStatus?.dest?.fileName;
  if (!fileName) {
    return results;
  }

  const fileContent = await downloadBatchFile(ai, fileName);
  const text = Buffer.isBuffer(fileContent)
    ? fileContent.toString("utf8")
    : Buffer.from(fileContent).toString("utf8");
  const lines = text.split("\n").filter((line) => line.trim());
  for (const line of lines) {
    const entry = JSON.parse(line);
    const outputId = entry?.metadata?.outputId || entry?.metadata?.subjectId || entry?.key;
    if (!outputId) {
      continue;
    }
    results.set(outputId, {
      success: !entry.error,
      error: entry.error || null,
      response: entry.response || entry
    });
  }
  return results;
}

function extractImagePayload(response) {
  const payload = defaultPipeline.getImagePayloadFromResponse(response?.response || response);
  return payload;
}

export async function process(batchName, options = {}) {
  const startedAt = Date.now();
  const pipeline = options.pipeline || defaultPipeline;
  const userRoot = resolveUserRoot(options);
  const state = await loadState(batchName, options);
  const ai = await getGeminiClient(options);
  const batch = await getBatch(ai, state.batchName || batchName);
  const batchState = simplifyBatchState(batch?.state || batch?.status);

  if (!SUCCESS_STATES.has(batchState)) {
    throw new Error(`Batch ${batchName} is ${batchState}; run --process only after SUCCEEDED.`);
  }

  const effectiveOptions = {
    baseOnly: Boolean(options.baseOnly),
    outputDir: options.outputDir ?? state.options?.outputDir ?? "./outputs",
    concurrency: Number(options.concurrency ?? state.options?.concurrency ?? 2),
    style: options.style ?? state.options?.style ?? null,
    sizes: Array.isArray(options.sizes) ? options.sizes : (Array.isArray(state.options?.sizes) ? state.options.sizes : null),
    manifest: Boolean(options.manifest ?? state.options?.manifest ?? false)
  };
  state.options = {
    ...(state.options || {}),
    ...effectiveOptions
  };
  await saveState(batchName, state, options);

  const responses = await extractBatchResponses(batch, options);
  const outputDir = path.resolve(userRoot, effectiveOptions.outputDir);
  const tmpDir = path.join(outputDir, ".tmp");
  await ensureDir(outputDir);
  await ensureDir(tmpDir);

  const workItems = [];
  for (const subject of state.subjects) {
    if (subject.status === "skipped") {
      continue;
    }

    const outputPath = buildOutputPath(outputDir, subject.subjectId);
    if (await fileExists(outputPath)) {
      workItems.push({
        subjectId: subject.subjectId,
        name: subject.name,
        refPath: subject.refPath ? resolveInputPath(subject.refPath, userRoot) : null,
        outfitPath: subject.outfitPath ? resolveInputPath(subject.outfitPath, userRoot) : null,
        outputPath
      });
      continue;
    }

    const outputId = pipeline.getOutputId(subject.subjectId);
    const response = responses.get(outputId);
    if (!response || !response.success) {
      updateSubjectStatus(state, subject.subjectId, "failed", response?.error ? JSON.stringify(response.error) : "Batch response missing.");
      await saveState(batchName, state, options);
      continue;
    }

    const payload = extractImagePayload(response);
    if (!payload?.buffer) {
      updateSubjectStatus(state, subject.subjectId, "failed", "No image data in batch response.");
      await saveState(batchName, state, options);
      continue;
    }

    const basePath = path.join(tmpDir, `${sanitizeSubjectId(subject.subjectId)}-base.png`);
    await fsp.writeFile(basePath, payload.buffer);
    workItems.push({
      subjectId: subject.subjectId,
      name: subject.name,
      refPath: subject.refPath ? resolveInputPath(subject.refPath, userRoot) : null,
      outfitPath: subject.outfitPath ? resolveInputPath(subject.outfitPath, userRoot) : null,
      basePath,
      outputPath
    });
  }

  const emitter = options.emitter || pipeline.createEmitter?.();
  if (emitter) {
    emitter.on(async (event) => {
      applyEmitterEventToState(state, event, userRoot);
      await saveState(batchName, state, options);
    });
  }

  await pipeline.processBaseImages(workItems, {
    ...options,
    userRoot,
    outputDir,
    baseOnly: effectiveOptions.baseOnly,
    style: effectiveOptions.style,
    concurrency: effectiveOptions.concurrency,
    sizes: effectiveOptions.sizes,
    manifest: effectiveOptions.manifest,
    tmpDir,
    emitter
  });

  let manifestPath;
  if (effectiveOptions.manifest) {
    manifestPath = await pipeline.writeManifest(
      state.subjects.filter((subject) => subject.status === "complete" || subject.status === "failed"),
      {
      ...options,
      userRoot,
      outputDir,
      style: effectiveOptions.style,
      sizes: effectiveOptions.sizes
      }
    );
  }

  state.status = "processed";
  state.completedAt = new Date().toISOString();
  await saveState(batchName, state, options);

  const progress = buildLocalProgress(state.subjects);
  return {
    batchName,
    processed: progress.complete + progress.failed,
    succeeded: progress.complete,
    failed: progress.failed,
    manifestPath: manifestPath ? toStoredPath(manifestPath, userRoot) : undefined,
    durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1))
  };
}
