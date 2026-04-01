import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { listStyles, resolveStyle, validateStyle, DEFAULT_STYLE_NAME, STYLES_DIR, PACKAGE_ROOT } from "../src/style.mjs";
import { createTempDir } from "./helpers.mjs";

describe("style resolution", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-style-");
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves default style when called with no arguments", async () => {
    const config = await resolveStyle();
    assert.equal(config.name, DEFAULT_STYLE_NAME);
    assert.ok(config.style.endsWith("style.md"));
    assert.ok(config.qa.endsWith("qa.md"));
    assert.ok(config.qaFinal.endsWith("qa-final.md"));
  });

  it("resolves a built-in style by name", async () => {
    const config = await resolveStyle("game-day");
    assert.equal(config.name, "game-day");
    assert.ok(config.style.includes(path.join("styles", "game-day")));
  });

  it("resolves an absolute path to a custom style directory", async () => {
    const customDir = path.join(tmpDir, "custom-style");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "style.md"), "# Test prompt");

    const config = await resolveStyle(customDir);
    assert.equal(config.name, "custom-style");
    assert.equal(config.style, path.join(customDir, "style.md"));
  });

  it("resolves a relative path to a custom style directory", async () => {
    const customDir = path.join(tmpDir, "relative-style");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "style.md"), "# Test prompt");

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const config = await resolveStyle("./relative-style");
      assert.equal(config.name, "relative-style");
      assert.ok(config.style.endsWith(path.join("relative-style", "style.md")));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("falls back to shared QA prompts when custom style omits them", async () => {
    const customDir = path.join(tmpDir, "style-only");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "style.md"), "# Test prompt");

    const config = await resolveStyle(customDir);
    assert.ok(config.qa.includes(path.join("src", "prompts", "qa-stage1.md")));
    assert.ok(config.qaFinal.includes(path.join("src", "prompts", "qa-final.md")));
  });

  it("uses custom QA prompts when provided", async () => {
    const customDir = path.join(tmpDir, "full-style");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "style.md"), "# Test prompt");
    await fsp.writeFile(path.join(customDir, "qa.md"), "# Custom QA");
    await fsp.writeFile(path.join(customDir, "qa-final.md"), "# Custom Final");

    const config = await resolveStyle(customDir);
    assert.equal(config.qa, path.join(customDir, "qa.md"));
    assert.equal(config.qaFinal, path.join(customDir, "qa-final.md"));
  });

  it("throws when style directory does not exist", async () => {
    await assert.rejects(
      () => resolveStyle("nonexistent-style-xyz"),
      /not found/i
    );
  });

  it("throws when style directory lacks style.md", async () => {
    const emptyDir = path.join(tmpDir, "empty-style");
    await fsp.mkdir(emptyDir, { recursive: true });

    await assert.rejects(
      () => resolveStyle(emptyDir),
      /missing style\.md/i
    );
  });
});

describe("listStyles", () => {
  it("lists built-in styles", async () => {
    const styles = await listStyles();
    assert.ok(styles.length >= 2);
    const names = styles.map((s) => s.name);
    assert.ok(names.includes("game-day"));
    assert.ok(names.includes("studio"));
  });

  it("returns sorted results with metadata", async () => {
    const styles = await listStyles();
    for (const s of styles) {
      assert.ok(typeof s.name === "string");
      assert.ok(typeof s.hasQa === "boolean");
      assert.ok(typeof s.hasQaFinal === "boolean");
    }
    const names = styles.map((s) => s.name);
    assert.deepEqual(names, [...names].sort());
  });
});

describe("validateStyle", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-validate-style-");
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates a built-in style as valid", async () => {
    const result = await validateStyle("game-day");
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("reports missing required variables", async () => {
    const customDir = path.join(tmpDir, "bad-vars");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "style.md"), "# No variables here");

    const result = await validateStyle(customDir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("${SUBJECT_TYPE}")));
    assert.ok(result.errors.some((e) => e.includes("${OUTFIT_DESCRIPTOR}")));
  });

  it("warns when custom qa.md is missing", async () => {
    const customDir = path.join(tmpDir, "no-qa");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "style.md"), "Use ${SUBJECT_TYPE} and ${OUTFIT_DESCRIPTOR}");

    const result = await validateStyle(customDir);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((w) => w.includes("qa.md")));
  });

  it("returns invalid for nonexistent style", async () => {
    const result = await validateStyle("nonexistent-style-xyz-123");
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});

describe("user-local style resolution", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-local-style-");
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves a local style by name via cwd option", async () => {
    const styleDir = path.join(tmpDir, "styles", "anime");
    await fsp.mkdir(styleDir, { recursive: true });
    await fsp.writeFile(path.join(styleDir, "style.md"), "# Anime prompt");

    const config = await resolveStyle("anime", { cwd: tmpDir });
    assert.equal(config.name, "anime");
    assert.equal(config.source, "local");
    assert.equal(config.style, path.join(styleDir, "style.md"));
  });

  it("local style takes precedence over built-in with same name", async () => {
    const styleDir = path.join(tmpDir, "styles", "game-day");
    await fsp.mkdir(styleDir, { recursive: true });
    await fsp.writeFile(path.join(styleDir, "style.md"), "# Local override");

    const config = await resolveStyle("game-day", { cwd: tmpDir });
    assert.equal(config.source, "local");
    assert.ok(config.style.startsWith(tmpDir));
  });

  it("falls back to built-in when local style does not exist", async () => {
    const config = await resolveStyle("studio", { cwd: tmpDir });
    assert.equal(config.source, "built-in");
    assert.equal(config.name, "studio");
  });

  it("path-based override bypasses local lookup", async () => {
    const customDir = path.join(tmpDir, "external-style");
    await fsp.mkdir(customDir, { recursive: true });
    await fsp.writeFile(path.join(customDir, "style.md"), "# External");

    const config = await resolveStyle(customDir);
    assert.equal(config.source, "external");
  });

  it("built-in styles have source built-in", async () => {
    const config = await resolveStyle("studio");
    assert.equal(config.source, "built-in");
  });

  it("error message mentions both search locations", async () => {
    await assert.rejects(
      () => resolveStyle("nonexistent-xyz", { cwd: tmpDir }),
      (err) => {
        assert.ok(err.message.includes("not found"));
        assert.ok(err.message.includes(tmpDir));
        return true;
      }
    );
  });
});

describe("listStyles with local styles", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-list-local-");
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns only built-in styles when cwd has no styles dir", async () => {
    const styles = await listStyles({ cwd: tmpDir });
    assert.ok(styles.length >= 2);
    assert.ok(styles.every((s) => s.source === "built-in"));
  });

  it("merges local styles with built-in styles", async () => {
    const styleDir = path.join(tmpDir, "styles", "anime");
    await fsp.mkdir(styleDir, { recursive: true });
    await fsp.writeFile(path.join(styleDir, "style.md"), "# Anime");

    const styles = await listStyles({ cwd: tmpDir });
    const anime = styles.find((s) => s.name === "anime");
    assert.ok(anime);
    assert.equal(anime.source, "local");

    const studio = styles.find((s) => s.name === "studio");
    assert.ok(studio);
    assert.equal(studio.source, "built-in");
  });

  it("local style overrides built-in in listing", async () => {
    const styleDir = path.join(tmpDir, "styles", "studio");
    await fsp.mkdir(styleDir, { recursive: true });
    await fsp.writeFile(path.join(styleDir, "style.md"), "# Local studio");

    const styles = await listStyles({ cwd: tmpDir });
    const studios = styles.filter((s) => s.name === "studio");
    assert.equal(studios.length, 1);
    assert.equal(studios[0].source, "local");
  });

  it("does not duplicate when cwd is package root", async () => {
    const styles = await listStyles({ cwd: PACKAGE_ROOT });
    const names = styles.map((s) => s.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size);
    assert.ok(styles.every((s) => s.source === "built-in"));
  });

  it("results include source field", async () => {
    const styles = await listStyles({ cwd: tmpDir });
    for (const s of styles) {
      assert.ok(["local", "built-in"].includes(s.source));
    }
  });
});

describe("validateStyle with cwd", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-validate-local-");
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates a local style", async () => {
    const styleDir = path.join(tmpDir, "styles", "test-local");
    await fsp.mkdir(styleDir, { recursive: true });
    await fsp.writeFile(path.join(styleDir, "style.md"), "Use ${SUBJECT_TYPE} and ${OUTFIT_DESCRIPTOR}");

    const result = await validateStyle("test-local", { cwd: tmpDir });
    assert.equal(result.valid, true);
    assert.equal(result.name, "test-local");
  });

  it("does not warn about external for local styles", async () => {
    const styleDir = path.join(tmpDir, "styles", "no-ext-warn");
    await fsp.mkdir(styleDir, { recursive: true });
    await fsp.writeFile(path.join(styleDir, "style.md"), "Use ${SUBJECT_TYPE} and ${OUTFIT_DESCRIPTOR}");
    await fsp.writeFile(path.join(styleDir, "qa.md"), "# QA");

    const result = await validateStyle("no-ext-warn", { cwd: tmpDir });
    assert.ok(!result.warnings.some((w) => w.includes("external")));
  });
});
