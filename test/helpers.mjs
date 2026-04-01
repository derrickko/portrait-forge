import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axfXxQAAAAASUVORK5CYII=";

export function pngBuffer() {
  return Buffer.from(PNG_BASE64, "base64");
}

export async function createTempDir(prefix = "portrait-forge-") {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writePng(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, pngBuffer());
  return filePath;
}
