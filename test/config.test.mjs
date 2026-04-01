import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { createTempDir } from "./helpers.mjs";

describe("loadConfig", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await createTempDir("portrait-forge-config-");
  });

  after(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty object when no config file exists", async () => {
    const config = await loadConfig(null, tmpDir);
    assert.deepEqual(config, {});
  });

  it("loads portrait-forge.config.json from cwd", async () => {
    const configData = { models: { forge: "gemini-2.0-flash" } };
    await fsp.writeFile(path.join(tmpDir, "portrait-forge.config.json"), JSON.stringify(configData));

    const config = await loadConfig(null, tmpDir);
    assert.deepEqual(config, configData);
  });

  it("loads from a custom path", async () => {
    const customPath = path.join(tmpDir, "custom.json");
    const configData = { verification: { baseThreshold: 0.95 } };
    await fsp.writeFile(customPath, JSON.stringify(configData));

    const config = await loadConfig(customPath, tmpDir);
    assert.deepEqual(config, configData);
  });

  it("throws on malformed JSON", async () => {
    const badPath = path.join(tmpDir, "bad.json");
    await fsp.writeFile(badPath, "{ not valid json }}}");

    await assert.rejects(
      () => loadConfig(badPath, tmpDir),
      /Invalid JSON in config file/
    );
  });

  it("returns empty object for missing custom path", async () => {
    const config = await loadConfig(path.join(tmpDir, "nonexistent.json"), tmpDir);
    assert.deepEqual(config, {});
  });
});
