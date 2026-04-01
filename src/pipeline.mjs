import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ReplicateClient } from "./replicate-client.mjs";
import { resolveStyle, PROMPTS_DIR, DEFAULT_STYLE_NAME } from "./style.mjs";
import {
  buildOutputPath,
  deriveSubjectId,
  ensureDir,
  fileExists,
  inferMimeType,
  sanitizeSubjectId,
  sanitizeSubjectName,
  scrubSensitiveData,
  writeJsonAtomic
} from "./utils.mjs";

export const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
export const DEFAULT_SUBJECT_TYPE = "person";
export const DEFAULT_OUTFIT_DESCRIPTOR = "outfit";
export const EXPECTED_DIMENSION = 1024;
export const BASE_THRESHOLD = 0.8;
export const TRANSPARENCY_THRESHOLD = 0.04;
export const VERIFICATION_MARGIN = 10;
export const SAMPLE_SIZE = 5;
export const PASS_RATIO = 0.5;

async function getPromptConfig(options = {}) {
  return options.promptConfig || await resolveStyle(options.style, {
    cwd: options.userRoot
  });
}

function resolveModel(options = {}) {
  const cfg = options.config?.models;
  return options.model || cfg?.forge || process.env.PORTRAIT_FORGE_MODEL || DEFAULT_MODEL;
}

function getVerificationConfig(options = {}) {
  const cfg = options.config?.verification;
  return {
    expectedDimension: Number(options.expectedDimension || cfg?.expectedDimension || process.env.PORTRAIT_EXPECTED_DIMENSION || EXPECTED_DIMENSION),
    baseThreshold: Number(options.baseThreshold || cfg?.baseThreshold || process.env.PORTRAIT_BASE_THRESHOLD || BASE_THRESHOLD),
    transparencyThreshold: Number(options.transparencyThreshold || cfg?.transparencyThreshold || process.env.PORTRAIT_TRANSPARENCY_THRESHOLD || TRANSPARENCY_THRESHOLD),
    passRatio: Number(options.passRatio || cfg?.passRatio || process.env.PORTRAIT_PASS_RATIO || PASS_RATIO),
    verificationMargin: Number(options.verificationMargin || cfg?.verificationMargin || process.env.PORTRAIT_VERIFICATION_MARGIN || VERIFICATION_MARGIN),
    sampleSize: Number(options.sampleSize || cfg?.sampleSize || process.env.PORTRAIT_SAMPLE_SIZE || SAMPLE_SIZE),
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function importSharp() {
  const mod = await import("sharp");
  return mod.default || mod;
}

async function getSharp(options = {}) {
  if (options.sharp) {
    return options.sharp;
  }
  return importSharp();
}

export async function getGeminiClient(config = {}) {
  if (config.geminiClient) {
    return config.geminiClient;
  }

  const apiKey = (
    config.apiKey ||
    config.env?.GEMINI_API_KEY ||
    config.env?.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY
  );
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required.");
  }

  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey });
}

function interpolateString(text, variables) {
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`\${${key}}`, String(value ?? ""));
  }
  return result;
}

function interpolateValue(value, variables) {
  if (typeof value === "string") {
    return interpolateString(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateValue(entry, variables));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateValue(entry, variables)])
    );
  }
  return value;
}

export async function loadPrompt(templatePath, variables = {}) {
  const promptPath = path.isAbsolute(templatePath)
    ? templatePath
    : path.join(PROMPTS_DIR, templatePath);
  const raw = await fsp.readFile(promptPath, "utf8");

  if (promptPath.endsWith(".json")) {
    return interpolateValue(JSON.parse(raw), variables);
  }
  return interpolateString(raw, variables);
}

function resolveUserRoot(options = {}) {
  return path.resolve(options.userRoot || process.cwd());
}

function resolveInputPath(inputPath, baseDir) {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(baseDir, inputPath);
}

async function findMatchingFile(dirPath, baseName) {
  if (!(await fileExists(dirPath))) {
    return null;
  }
  const files = await fsp.readdir(dirPath);
  const matches = files.filter((fileName) => path.parse(fileName).name === baseName);
  if (!matches.length) {
    return null;
  }
  const preferred = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
  const supportedMatches = matches
    .map((fileName) => ({
      fileName,
      rank: preferred.indexOf(path.extname(fileName).toLowerCase())
    }))
    .filter((entry) => entry.rank !== -1);
  if (!supportedMatches.length) {
    return null;
  }
  supportedMatches.sort((left, right) => left.rank - right.rank || left.fileName.localeCompare(right.fileName));
  return path.join(dirPath, supportedMatches[0].fileName);
}

export async function resolveReferenceImage(subject, refsDir = path.join(process.cwd(), "refs"), options = {}) {
  const userRoot = resolveUserRoot(options);
  const refsRoot = path.isAbsolute(refsDir) ? refsDir : path.resolve(userRoot, refsDir);
  await ensureDir(refsRoot);

  if (subject.refPath) {
    const resolved = resolveInputPath(subject.refPath, options.baseDir || userRoot);
    if (await fileExists(resolved)) {
      return { path: resolved, source: "direct" };
    }
  }

  const safeSubjectId = sanitizeSubjectId(subject.subjectId);
  const discovered = await findMatchingFile(refsRoot, safeSubjectId);
  return { path: discovered, source: discovered ? "auto" : null };
}

export async function loadInlineImageParts(paths = []) {
  const parts = [];
  for (const imagePath of paths.filter(Boolean)) {
    const mimeType = inferMimeType(imagePath);
    if (!mimeType) {
      throw new Error(`Unsupported image type: ${imagePath}`);
    }
    const buffer = await fsp.readFile(imagePath);
    parts.push({
      inlineData: {
        mimeType,
        data: buffer.toString("base64")
      }
    });
  }
  return parts;
}

function getDefaultImageConfig(options = {}) {
  return {
    imageSize: options.imageSize || "1K",
    aspectRatio: options.aspectRatio || "1:1"
  };
}

function extractResponseParts(response) {
  return response?.candidates?.[0]?.content?.parts ?? [];
}

function extractImagePayload(response) {
  const parts = extractResponseParts(response);
  for (const part of parts) {
    const inlineData = part?.inlineData;
    if (!inlineData?.data) {
      continue;
    }
    return {
      buffer: Buffer.from(inlineData.data, "base64"),
      mimeType: inlineData.mimeType || "image/png"
    };
  }
  return null;
}

async function writeImagePayload(payload, outputPath, options = {}) {
  if (!payload?.buffer) {
    throw new Error("No image data returned from Gemini.");
  }

  await ensureDir(path.dirname(outputPath));
  if (payload.mimeType.includes("png")) {
    await fsp.writeFile(outputPath, payload.buffer);
    return;
  }

  const sharp = await getSharp(options);
  const pngBuffer = await sharp(payload.buffer).png().toBuffer();
  await fsp.writeFile(outputPath, pngBuffer);
}

export async function buildInlineRequest(subject, options = {}) {
  const safeSubjectId = sanitizeSubjectId(subject.subjectId);
  const subjectName = sanitizeSubjectName(subject.name);
  const promptConfig = await getPromptConfig(options);
  const prompt = await loadPrompt(promptConfig.style, {
    SUBJECT_TYPE: subject.subjectType || options.subjectType || DEFAULT_SUBJECT_TYPE,
    OUTFIT_DESCRIPTOR: subject.outfitDescriptor || options.outfitDescriptor || DEFAULT_OUTFIT_DESCRIPTOR,
    OUTFIT_PATH: subject.outfitPath ? path.basename(subject.outfitPath) : ""
  });
  const promptText = prompt;
  const imageParts = await loadInlineImageParts([subject.refPath, subject.outfitPath].filter(Boolean));

  return {
    model: resolveModel(options),
    contents: [{ role: "user", parts: [{ text: promptText }, ...imageParts] }],
    metadata: {
      outputId: `${safeSubjectId}-stage1`,
      subjectId: safeSubjectId,
      subjectName
    },
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: getDefaultImageConfig(options)
    }
  };
}

export async function generateBaseImage(subject, options = {}) {
  const ai = await getGeminiClient(options);
  const outputPath = options.basePath;
  if (!outputPath) {
    throw new Error("basePath is required.");
  }

  const request = await buildInlineRequest(subject, options);
  const response = await ai.models.generateContent({
    model: request.model,
    contents: request.contents,
    config: request.config
  });

  await writeImagePayload(extractImagePayload(response), outputPath, options);
  return { basePath: outputPath };
}

async function sampleImage(imagePath, { alpha = false, threshold, passKey, margin: marginOverride, sampleSize: sampleSizeOverride, expectedDimension: dimOverride, sharp: sharpOverride }) {
  const sharp = sharpOverride || await importSharp();
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw new Error("Unable to read image dimensions.");
  }

  const maxOffset = Math.floor((Math.min(width, height) - 1) / 2);
  const margin = Math.min(marginOverride ?? VERIFICATION_MARGIN, Math.max(0, maxOffset));
  const effectiveSampleSize = Math.min(sampleSizeOverride ?? SAMPLE_SIZE, width - margin, height - margin);
  const samplePoints = [
    { x: margin, y: margin, name: "top-left" },
    { x: width - margin - effectiveSampleSize, y: margin, name: "top-right" },
    { x: margin, y: height - margin - effectiveSampleSize, name: "bottom-left" },
    { x: width - margin - effectiveSampleSize, y: height - margin - effectiveSampleSize, name: "bottom-right" }
  ];

  const image = sharp(imagePath);
  const samples = await Promise.all(
    samplePoints.map(async (point) => {
      const safeX = Math.max(0, Math.min(point.x, width - effectiveSampleSize));
      const safeY = Math.max(0, Math.min(point.y, height - effectiveSampleSize));
      const { data } = await image
        .clone()
        .extract({ left: safeX, top: safeY, width: effectiveSampleSize, height: effectiveSampleSize })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const pixelCount = effectiveSampleSize * effectiveSampleSize;
      if (alpha) {
        const alphaValues = [];
        for (let index = 0; index < pixelCount; index += 1) {
          alphaValues.push(data[index * 4 + 3] ?? 255);
        }
        const medianAlpha = median(alphaValues);
        const isTransparent = medianAlpha / 255 < threshold;
        return {
          corner: point.name,
          alpha: Math.round(medianAlpha),
          isTransparent,
          threshold
        };
      }

      const reds = [];
      const greens = [];
      const blues = [];
      for (let index = 0; index < pixelCount; index += 1) {
        const offset = index * 4;
        reds.push(data[offset] ?? 0);
        greens.push(data[offset + 1] ?? 0);
        blues.push(data[offset + 2] ?? 0);
      }
      const medianRed = median(reds);
      const medianGreen = median(greens);
      const medianBlue = median(blues);
      const isBase = (
        medianRed / 255 > threshold &&
        medianGreen / 255 > threshold &&
        medianBlue / 255 > threshold
      );
      return {
        corner: point.name,
        rgb: [Math.round(medianRed), Math.round(medianGreen), Math.round(medianBlue)],
        isBase,
        threshold
      };
    })
  );

  const passingCount = samples.filter((sample) => sample[passKey]).length;
  const passRatio = passingCount / samples.length;
  return {
    width,
    height,
    passRatio,
    samples,
    isSquare: width === height,
    is1K: width === (dimOverride ?? EXPECTED_DIMENSION) && height === (dimOverride ?? EXPECTED_DIMENSION)
  };
}

export async function verifyBaseBackground(imagePath, options = {}) {
  const config = getVerificationConfig(options);
  const result = await sampleImage(imagePath, {
    threshold: config.baseThreshold,
    passKey: "isBase",
    margin: config.verificationMargin,
    sampleSize: config.sampleSize,
    expectedDimension: config.expectedDimension,
    sharp: options.sharp
  });
  return {
    isBase: result.passRatio >= config.passRatio,
    passRatio: result.passRatio,
    requiredPassRatio: config.passRatio,
    dimensions: {
      width: result.width,
      height: result.height,
      isSquare: result.isSquare,
      is1K: result.is1K
    },
    samples: result.samples
  };
}

export async function verifyTransparency(imagePath, options = {}) {
  const config = getVerificationConfig(options);
  const result = await sampleImage(imagePath, {
    alpha: true,
    threshold: config.transparencyThreshold,
    passKey: "isTransparent",
    margin: config.verificationMargin,
    sampleSize: config.sampleSize,
    expectedDimension: config.expectedDimension,
    sharp: options.sharp
  });
  return {
    isTransparent: result.passRatio >= config.passRatio,
    passRatio: result.passRatio,
    requiredPassRatio: config.passRatio,
    dimensions: {
      width: result.width,
      height: result.height,
      isSquare: result.isSquare,
      is1K: result.is1K
    },
    samples: result.samples
  };
}

async function fetchBinary(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available to download background removal output.");
  }

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download background removal output: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function removeBackground(basePath, outputPath, options = {}) {
  const replicateClient = options.replicateClient || new ReplicateClient({
    apiToken: options.replicateApiToken,
    env: options.env,
    fileConfig: options.config
  });

  const imageBuffer = await fsp.readFile(basePath);
  const output = await replicateClient.removeBackground(imageBuffer);
  let buffer = null;

  if (Buffer.isBuffer(output)) {
    buffer = output;
  } else if (output?.[Symbol.asyncIterator]) {
    const chunks = [];
    for await (const chunk of output) {
      chunks.push(chunk);
    }
    buffer = Buffer.concat(chunks);
  } else if (output?.buffer) {
    buffer = output.buffer;
  } else if (Array.isArray(output)) {
    buffer = await fetchBinary(output[0], options);
  } else if (typeof output === "string") {
    buffer = await fetchBinary(output, options);
  }

  if (!buffer) {
    throw new Error("Replicate returned no usable output.");
  }

  await ensureDir(path.dirname(outputPath));
  await fsp.writeFile(outputPath, buffer);
  return { success: true, outputPath };
}

export function createEmitter() {
  const listeners = [];
  return {
    on(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },
    async emit(event) {
      for (const listener of listeners) {
        await listener(event);
      }
    }
  };
}

function getResolvedOutputPath(subject, options = {}) {
  return subject.outputPath || buildOutputPath(
    options.outputDir || path.join(resolveUserRoot(options), "outputs"),
    subject.subjectId
  );
}

function buildSizedPathFromOutput(outputPath, size) {
  if (size === EXPECTED_DIMENSION) {
    return outputPath;
  }
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}-${size}${parsed.ext || ".png"}`);
}

function getRequestedOutputSizes(sizes = null) {
  const requested = Array.isArray(sizes) ? sizes : [];
  return [...new Set([EXPECTED_DIMENSION, ...requested])]
    .filter((size) => Number.isInteger(size) && size > 0 && size <= EXPECTED_DIMENSION)
    .sort((left, right) => right - left);
}

function buildOutputsMap(outputPath, sizes = null) {
  return Object.fromEntries(
    getRequestedOutputSizes(sizes).map((size) => [String(size), buildSizedPathFromOutput(outputPath, size)])
  );
}

async function getMissingOutputs(outputs) {
  const missing = [];
  for (const [size, outputPath] of Object.entries(outputs)) {
    if (!(await fileExists(outputPath))) {
      missing.push([size, outputPath]);
    }
  }
  return missing;
}

async function writeBufferAtomic(outputPath, buffer, partialId) {
  const stagedPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${partialId}.partial`
  );
  await fsp.rm(stagedPath, { force: true });
  await ensureDir(path.dirname(outputPath));
  await fsp.writeFile(stagedPath, buffer);
  await fsp.rename(stagedPath, outputPath);
}

async function ensureSizedOutputsFromOriginal(originalPath, outputs, subjectId, options = {}) {
  const onlyMissing = options.onlyMissing !== false;
  const targets = [];
  for (const [size, outputPath] of Object.entries(outputs)) {
    if (Number(size) === EXPECTED_DIMENSION) {
      continue;
    }
    if (onlyMissing && (await fileExists(outputPath))) {
      continue;
    }
    targets.push([Number(size), outputPath]);
  }

  if (!targets.length) {
    return;
  }

  const sharp = await getSharp(options);
  const image = sharp(originalPath);
  for (const [size, outputPath] of targets) {
    const buffer = await image
      .clone()
      .resize({ width: size, height: size })
      .png()
      .toBuffer();
    await writeBufferAtomic(outputPath, buffer, `${sanitizeSubjectId(subjectId)}.${size}`);
  }
}

function toRelativePath(filePath, baseDir) {
  const resolvedBaseDir = path.resolve(baseDir);
  const relative = path.relative(resolvedBaseDir, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function toRelativeOutputs(outputs, baseDir) {
  return Object.fromEntries(
    Object.entries(outputs || {}).map(([size, outputPath]) => [size, toRelativePath(outputPath, baseDir)])
  );
}

function resolveOutputPathForUserRoot(outputPath, options = {}) {
  if (!outputPath) {
    return outputPath;
  }
  return path.isAbsolute(outputPath)
    ? outputPath
    : path.resolve(resolveUserRoot(options), outputPath);
}

function normalizeOutputsForManifest(outputs, manifestDir, options = {}) {
  return Object.fromEntries(
    Object.entries(outputs || {}).map(([size, outputPath]) => [
      size,
      toRelativePath(resolveOutputPathForUserRoot(outputPath, options), manifestDir)
    ])
  );
}

function buildEventFromResult(result, options = {}) {
  const baseDir = resolveUserRoot(options);
  const baseEvent = {
    type: result.status === "complete" ? "complete" : "failed",
    subjectId: result.subjectId,
    timestamp: new Date().toISOString(),
    durationSec: result.durationSec
  };

  if (result.status === "complete") {
    const event = {
      ...baseEvent,
      basePath: result.basePath ? toRelativePath(result.basePath, baseDir) : undefined,
      skippedExisting: Boolean(result.skippedExisting),
    };
    if (result.baseOnly) {
      event.baseOnly = true;
      event.styleName = result.styleName;
      event.qaPath = result.qaPath;
      event.refPath = result.refPath ? toRelativePath(result.refPath, baseDir) : undefined;
      event.outfitPath = result.outfitPath ? toRelativePath(result.outfitPath, baseDir) : undefined;
    } else {
      event.outputPath = result.outputPath ? toRelativePath(result.outputPath, baseDir) : undefined;
      event.outputs = toRelativeOutputs(result.outputs, baseDir);
    }
    return event;
  }

  return {
    ...baseEvent,
    error: result.error,
  };
}

async function emitSubjectResult(result, options = {}) {
  if (!options.emitter) {
    return;
  }
  await options.emitter.emit(buildEventFromResult(result, options));
}

async function maybeReuseExistingOutputs(subject, outputPath, outputs, options = {}) {
  if (!(await fileExists(outputPath))) {
    return null;
  }

  const missingOutputs = await getMissingOutputs(outputs);
  if (!missingOutputs.length) {
    return {
      subjectId: subject.subjectId,
      status: "complete",
      outputPath,
      outputs,
      skippedExisting: true
    };
  }

  await ensureSizedOutputsFromOriginal(outputPath, outputs, subject.subjectId, {
    ...options,
    onlyMissing: true
  });
  return {
    subjectId: subject.subjectId,
    status: "complete",
    outputPath,
    outputs,
    skippedExisting: false
  };
}

function buildFailureResult(subjectId, overrides = {}) {
  return {
    subjectId,
    status: "failed",
    ...overrides
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, runWorker));
  return results;
}

export async function processSingleSubject(subject, options = {}) {
  const outputPath = getResolvedOutputPath(subject, options);
  const outputs = buildOutputsMap(outputPath, options.sizes);
  const basePath = subject.basePath || path.join(
    options.tmpDir || path.join(path.dirname(outputPath), ".tmp"),
    `${sanitizeSubjectId(subject.subjectId)}-base.png`
  );
  const stagedOutputPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${sanitizeSubjectId(subject.subjectId)}.partial`
  );

  await ensureDir(path.dirname(basePath));

  if (!options.baseOnly) {
    await ensureDir(path.dirname(outputPath));

    const existingResult = await maybeReuseExistingOutputs(subject, outputPath, outputs, options);
    if (existingResult) {
      return {
        ...existingResult,
        basePath
      };
    }
  }

  try {
    const shouldUseExistingBase = subject.basePath && await fileExists(subject.basePath);
    if (!shouldUseExistingBase) {
      if (!subject.refPath) {
        throw new Error(`Reference image not found for ${subject.subjectId}.`);
      }
      if (!subject.outfitPath) {
        throw new Error("An outfit image is required to generate a portrait.");
      }

      await fsp.rm(basePath, { force: true });
      await generateBaseImage({
        ...subject,
        refPath: subject.refPath,
        outfitPath: subject.outfitPath
      }, {
        ...options,
        basePath
      });
    }

    if (!options.skipBaseVerification) {
      const baseVerification = await verifyBaseBackground(basePath, options);
      if (!baseVerification.isBase || !baseVerification.dimensions?.is1K) {
        return buildFailureResult(subject.subjectId, {
          error: "Base background verification failed.",
          verification: baseVerification,
          basePath
        });
      }
    }

    if (options.baseOnly) {
      const promptConfig = await getPromptConfig(options);
      return {
        subjectId: subject.subjectId,
        status: "complete",
        basePath,
        baseOnly: true,
        styleName: promptConfig?.name || options.style || DEFAULT_STYLE_NAME,
        qaPath: promptConfig?.qa,
        refPath: subject.refPath,
        outfitPath: subject.outfitPath,
        skippedExisting: Boolean(shouldUseExistingBase)
      };
    }

    await fsp.rm(stagedOutputPath, { force: true });
    await removeBackground(basePath, stagedOutputPath, options);

    if (!options.skipTransparentVerification) {
      const transparentVerification = await verifyTransparency(stagedOutputPath, options);
      if (!transparentVerification.isTransparent || !transparentVerification.dimensions?.is1K) {
        await fsp.rm(stagedOutputPath, { force: true });
        return buildFailureResult(subject.subjectId, {
          error: "Transparent output verification failed.",
          verification: transparentVerification,
          basePath
        });
      }
    }

    await fsp.rename(stagedOutputPath, outputPath);
    await ensureSizedOutputsFromOriginal(outputPath, outputs, subject.subjectId, {
      ...options,
      onlyMissing: false
    });

    return {
      subjectId: subject.subjectId,
      status: "complete",
      outputPath,
      outputs,
      basePath,
      skippedExisting: false
    };
  } catch (error) {
    await fsp.rm(stagedOutputPath, { force: true });
    return buildFailureResult(subject.subjectId, {
      error: scrubSensitiveData(error?.message || String(error)),
      basePath
    });
  }
}

export async function processBaseImages(subjects, options = {}) {
  const concurrency = Number(options.concurrency || 2);
  return mapWithConcurrency(subjects, concurrency, async (subject) => {
    const startedAt = Date.now();
    const result = await processSingleSubject(subject, options);
    const enriched = {
      ...result,
      durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1))
    };
    await emitSubjectResult(enriched, options);
    return enriched;
  });
}

export async function writeManifest(results, options = {}) {
  const outputDir = path.resolve(
    resolveUserRoot(options),
    options.outputDir || "outputs"
  );
  const manifestPath = path.join(outputDir, "manifest.json");
  const promptConfig = await getPromptConfig(options);
  const manifest = {
    generatedAt: new Date().toISOString(),
    style: promptConfig?.name || options.style || null,
    subjects: results.map((result) => {
      const outputs = result.status === "complete"
        ? normalizeOutputsForManifest(
          result.outputs || buildOutputsMap(getResolvedOutputPath(result, { outputDir }), options.sizes),
          outputDir,
          options
        )
        : {};
      const entry = {
        subjectId: result.subjectId,
        status: result.status,
        outputs,
      };

      if (result.status !== "complete") {
        entry.error = result.error || "Processing failed.";
      }
      return entry;
    })
  };

  await writeJsonAtomic(manifestPath, manifest);
  return manifestPath;
}

export async function processSubject(subject, options = {}) {
  const userRoot = resolveUserRoot(options);
  const outputDir = path.resolve(userRoot, options.outputDir || "outputs");
  const tmpDir = path.join(outputDir, ".tmp");
  await ensureDir(tmpDir);
  await ensureDir(outputDir);

  const resolvedRef = await resolveReferenceImage(subject, path.join(userRoot, "refs"), options);
  if (!resolvedRef.path) {
    throw new Error(`Reference image not found for ${subject.subjectId}.`);
  }

  const resolvedOutfitPath = subject.outfitPath
    ? resolveInputPath(subject.outfitPath, options.baseDir || userRoot)
    : null;
  if (!resolvedOutfitPath) {
    throw new Error("An outfit image is required for single-image mode.");
  }
  if (!(await fileExists(resolvedOutfitPath))) {
    throw new Error(`Outfit image not found: ${resolvedOutfitPath}`);
  }

  const outputPath = options.output
    ? resolveInputPath(options.output, userRoot)
    : buildOutputPath(outputDir, subject.subjectId);

  const [result] = await processBaseImages([{
    subjectId: subject.subjectId,
    name: subject.name,
    refPath: resolvedRef.path,
    outfitPath: resolvedOutfitPath,
    outputPath
  }], {
    ...options,
    userRoot,
    outputDir,
    tmpDir
  });

  if (result.status !== "complete") {
    throw new Error(result.error || "Portrait processing failed.");
  }

  return {
    subjectId: subject.subjectId,
    output: result.outputPath,
    outputs: result.outputs,
    basePath: result.basePath,
    baseOnly: result.baseOnly || false,
    styleName: result.styleName,
    qaPath: result.qaPath,
    refPath: result.refPath,
    outfitPath: result.outfitPath
  };
}

function deriveSubjectNameFromRef(refPath) {
  const candidate = path.parse(refPath).name.replace(/[-_]+/g, " ").trim() || "subject";
  return sanitizeSubjectName(candidate);
}

export async function processImmediate(options = {}) {
  const startedAt = Date.now();
  const userRoot = resolveUserRoot(options);
  const subjectName = options.subjectName
    ? sanitizeSubjectName(options.subjectName)
    : deriveSubjectNameFromRef(options.ref);
  const subjectId = sanitizeSubjectId(options.subjectId || deriveSubjectId(subjectName));

  const result = await processSubject({
    subjectId,
    name: subjectName,
    subjectType: options.subjectType || DEFAULT_SUBJECT_TYPE,
    outfitDescriptor: options.outfitDescriptor || DEFAULT_OUTFIT_DESCRIPTOR,
    refPath: options.ref,
    outfitPath: options.outfit
  }, {
    ...options,
    userRoot,
    baseDir: userRoot,
    outputDir: options.output ? path.dirname(resolveInputPath(options.output, userRoot)) : (options.outputDir || "outputs"),
    output: options.output
  });

  const response = {
    basePath: result.basePath ? toRelativePath(result.basePath, userRoot) : undefined,
    baseOnly: result.baseOnly || false,
    durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1))
  };

  if (result.baseOnly) {
    response.styleName = result.styleName;
    response.qaPath = result.qaPath ? toRelativePath(result.qaPath, userRoot) : undefined;
    response.refPath = result.refPath ? toRelativePath(result.refPath, userRoot) : undefined;
    response.outfitPath = result.outfitPath ? toRelativePath(result.outfitPath, userRoot) : undefined;
  } else {
    response.output = path.relative(userRoot, result.output) || result.output;
    response.outputs = toRelativeOutputs(result.outputs, userRoot);
    if (options.manifest) {
      response.manifestPath = toRelativePath(await writeManifest([{
        subjectId,
        status: "complete",
        outputs: result.outputs,
        outputPath: result.output
      }], {
        ...options,
        userRoot,
        outputDir: path.dirname(result.output)
      }), userRoot);
    }
  }

  return response;
}

export function getOutputId(subjectId) {
  return `${sanitizeSubjectId(subjectId)}-stage1`;
}

export function getImagePayloadFromResponse(response) {
  return extractImagePayload(response);
}
