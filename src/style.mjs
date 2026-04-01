import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileExists } from "./utils.mjs";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROMPTS_DIR = path.join(PACKAGE_ROOT, "src", "prompts");
export const STYLES_DIR = path.join(PACKAGE_ROOT, "styles");
export const DEFAULT_STYLE_NAME = "game-day";
export const LOCAL_STYLES_DIRNAME = "styles";

const REQUIRED_VARIABLES = ["${SUBJECT_TYPE}", "${OUTFIT_DESCRIPTOR}"];

async function scanStylesDir(stylesDir, source) {
  let entries;
  try {
    entries = await fsp.readdir(stylesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const results = await Promise.all(
    dirs.map(async (dir) => {
      const styleDir = path.join(stylesDir, dir.name);
      const [hasStyle, hasQa, hasQaFinal] = await Promise.all([
        fileExists(path.join(styleDir, "style.md")),
        fileExists(path.join(styleDir, "qa.md")),
        fileExists(path.join(styleDir, "qa-final.md"))
      ]);
      if (!hasStyle) return null;
      return { name: dir.name, hasQa, hasQaFinal, source };
    })
  );

  return results.filter(Boolean);
}

export async function listStyles(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const localStylesDir = path.join(cwd, LOCAL_STYLES_DIRNAME);
  const isSameDir = localStylesDir === STYLES_DIR;

  const [builtinStyles, localStyles] = await Promise.all([
    scanStylesDir(STYLES_DIR, "built-in"),
    isSameDir ? Promise.resolve([]) : scanStylesDir(localStylesDir, "local"),
  ]);

  const merged = new Map(builtinStyles.map((s) => [s.name, s]));
  for (const s of localStyles) {
    merged.set(s.name, s);
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function validateStyle(nameOrPath, options = {}) {
  const errors = [];
  const warnings = [];

  let resolved;
  try {
    resolved = await resolveStyle(nameOrPath, options);
  } catch (error) {
    return { valid: false, name: nameOrPath || DEFAULT_STYLE_NAME, errors: [error.message], warnings };
  }

  const content = await fsp.readFile(resolved.style, "utf8");

  for (const variable of REQUIRED_VARIABLES) {
    if (!content.includes(variable)) {
      errors.push(`Missing required variable: ${variable}`);
    }
  }

  if (resolved.source === "external") {
    warnings.push("Using an external style directory");
  }

  const styleDir = path.dirname(resolved.style);
  if (!(await fileExists(path.join(styleDir, "qa.md")))) {
    warnings.push("No custom qa.md — using default QA criteria");
  }

  return { valid: errors.length === 0, name: resolved.name, errors, warnings };
}

export async function resolveStyle(nameOrPath, options = {}) {
  const name = nameOrPath || DEFAULT_STYLE_NAME;

  if (name.includes(path.sep) || name.startsWith(".") || path.isAbsolute(name)) {
    const styleDir = path.resolve(name);
    return resolveStyleDir(styleDir, name, "external");
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const localDir = path.join(cwd, LOCAL_STYLES_DIRNAME, name);
  const builtinDir = path.join(STYLES_DIR, name);
  const isSameDir = localDir === builtinDir;

  if (!isSameDir) {
    const local = await resolveStyleDir(localDir, name, "local").catch(() => null);
    if (local) return local;
  }

  const builtin = await resolveStyleDir(builtinDir, name, "built-in").catch(() => null);
  if (builtin) return builtin;

  const searched = isSameDir
    ? builtinDir
    : `${localDir}, ${builtinDir}`;
  throw new Error(
    `Style "${name}" not found. Searched: ${searched}`
  );
}

async function resolveStyleDir(styleDir, name, source) {
  const style = path.join(styleDir, "style.md");
  const qaLocal = path.join(styleDir, "qa.md");
  const qaFinalLocal = path.join(styleDir, "qa-final.md");

  const [hasStyle, hasQa, hasQaFinal] = await Promise.all([
    fileExists(style),
    fileExists(qaLocal),
    fileExists(qaFinalLocal)
  ]);

  if (!hasStyle) {
    throw new Error(
      `Style "${name}" is missing style.md. Expected at: ${style}`
    );
  }

  return {
    style,
    qa: hasQa ? qaLocal : path.join(PROMPTS_DIR, "qa-stage1.md"),
    qaFinal: hasQaFinal ? qaFinalLocal : path.join(PROMPTS_DIR, "qa-final.md"),
    name: path.basename(styleDir),
    source
  };
}
