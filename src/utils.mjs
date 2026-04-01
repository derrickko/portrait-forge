import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const SUBJECT_ID_PATTERN = /^[\p{L}\p{N}\p{M}_-]{1,100}$/u;
const SUBJECT_NAME_PATTERN = /^[\p{L}\p{N}\p{M} '.&()_-]{1,100}$/u;

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function scrubSensitiveData(text) {
  if (!text) {
    return text;
  }

  const patterns = [
    /AIza[0-9A-Za-z_-]{35}/g,
    /\br8_[A-Za-z0-9._-]+\b/g,
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    /AWS_ACCESS_KEY_ID=[^\s]+/gi,
    /AWS_SECRET_ACCESS_KEY=[^\s]+/gi,
    /AWS_SESSION_TOKEN=[^\s]+/gi,
    /AKIA[0-9A-Z]{16}/g
  ];

  let result = String(text);
  for (const pattern of patterns) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function writeJsonAtomic(filePath, data) {
  const dirPath = path.dirname(filePath);
  const tmpPath = path.join(dirPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await ensureDir(dirPath);
  try {
    await fsp.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
    await fsp.rename(tmpPath, filePath);
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export function sanitizeSubjectId(subjectId) {
  const value = String(subjectId).trim();
  if (!value) {
    throw new Error("Invalid subject id: value is required.");
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error("Invalid subject id: path traversal attempt detected.");
  }
  if (!SUBJECT_ID_PATTERN.test(value)) {
    throw new Error("Invalid subject id: use letters, numbers, _ or - only.");
  }
  return value;
}

export function sanitizeSubjectName(name) {
  const cleaned = String(name)
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    throw new Error("Invalid subject name: value is required.");
  }
  if (!SUBJECT_NAME_PATTERN.test(cleaned)) {
    throw new Error("Invalid subject name: contains disallowed characters.");
  }
  return cleaned;
}

export function slugifySubjectName(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!slug) {
    throw new Error("Failed to derive subject id from name.");
  }
  return slug;
}

export function deriveSubjectId(subjectName) {
  return sanitizeSubjectId(slugifySubjectName(subjectName));
}

export function validatePathInput(input, label = "Path") {
  if (!input) {
    return;
  }

  const value = String(input);
  if (value.includes("\0")) {
    throw new Error(`${label} contains a null byte.`);
  }
  if (/^[a-z]+:\/\//i.test(value)) {
    throw new Error(`${label} must be a local file path.`);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    throw new Error(`${label} contains a path traversal sequence.`);
  }
}

export function buildOutputPath(outputDir, subjectId) {
  const safeSubjectId = sanitizeSubjectId(subjectId);
  const resolvedDir = path.resolve(outputDir);
  const resolvedOutput = path.resolve(resolvedDir, `${safeSubjectId}.png`);
  const allowedPrefix = `${resolvedDir}${path.sep}`;
  if (!resolvedOutput.startsWith(allowedPrefix)) {
    throw new Error(`Path traversal blocked: ${subjectId}`);
  }
  return resolvedOutput;
}

export function buildSizedOutputPath(outputDir, subjectId, size) {
  const safeSubjectId = sanitizeSubjectId(subjectId);
  const parsedSize = Number(size);
  if (!Number.isInteger(parsedSize) || parsedSize < 1 || parsedSize > 1024) {
    throw new Error("Image size must be an integer between 1 and 1024.");
  }
  if (parsedSize === 1024) {
    return buildOutputPath(outputDir, safeSubjectId);
  }

  const resolvedDir = path.resolve(outputDir);
  const resolvedOutput = path.resolve(resolvedDir, `${safeSubjectId}-${parsedSize}.png`);
  const allowedPrefix = `${resolvedDir}${path.sep}`;
  if (!resolvedOutput.startsWith(allowedPrefix)) {
    throw new Error(`Path traversal blocked: ${subjectId}`);
  }
  return resolvedOutput;
}

export function parseSizes(sizesString) {
  const normalized = normalizeOptionalString(sizesString);
  if (!normalized) {
    throw new Error("--sizes must be a comma-separated list of integers.");
  }

  const sizes = normalized.split(",").map((entry) => entry.trim());
  const parsed = sizes.map((entry) => {
    if (!/^\d+$/.test(entry)) {
      throw new Error("--sizes must contain only integers.");
    }
    const value = Number(entry);
    if (!Number.isInteger(value) || value < 1 || value > 1024) {
      throw new Error("--sizes entries must be integers between 1 and 1024.");
    }
    return value;
  });

  return [...new Set(parsed)].sort((left, right) => right - left);
}

export function inferMimeType(filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}


