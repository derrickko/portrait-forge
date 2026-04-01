import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG_FILENAME = "portrait-forge.config.json";

export async function loadConfig(configPath, cwd = process.cwd()) {
  const resolved = configPath
    ? path.resolve(cwd, configPath)
    : path.join(cwd, DEFAULT_CONFIG_FILENAME);

  let raw;
  try {
    raw = await fsp.readFile(resolved, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in config file: ${resolved}`);
  }
}
