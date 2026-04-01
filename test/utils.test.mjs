import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildOutputPath,
  buildSizedOutputPath,
  parseSizes,
  sanitizeSubjectId,
  sanitizeSubjectName,
  scrubSensitiveData,
  slugifySubjectName
} from "../src/utils.mjs";

describe("utils", () => {
  it("accepts safe subject ids", () => {
    assert.equal(sanitizeSubjectId("hero-01"), "hero-01");
    assert.equal(sanitizeSubjectId("山田_01"), "山田_01");
  });

  it("rejects traversal subject ids", () => {
    assert.throws(() => sanitizeSubjectId("../hero"), /path traversal/i);
  });

  it("accepts unicode subject names", () => {
    assert.equal(sanitizeSubjectName("山田 太郎"), "山田 太郎");
    assert.equal(sanitizeSubjectName("ليلى"), "ليلى");
    assert.equal(sanitizeSubjectName("Алексей"), "Алексей");
  });

  it("rejects invalid subject names", () => {
    assert.throws(() => sanitizeSubjectName("bad<script>"), /disallowed/i);
  });

  it("slugifies unicode names", () => {
    assert.equal(slugifySubjectName("Kylian Mbappé"), "kylian-mbappe");
    assert.equal(slugifySubjectName("山田 太郎"), "山田-太郎");
    assert.equal(slugifySubjectName("Лев Яшин"), "лев-яшин");
  });

  it("scrubs replicate tokens", () => {
    assert.equal(scrubSensitiveData("token r8_secret123"), "token [REDACTED]");
  });

  it("blocks output path traversal", () => {
    const outputDir = path.resolve("outputs");
    assert.throws(() => buildOutputPath(outputDir, "../evil"), /path traversal/i);
  });

  it("parses, sorts, and deduplicates sizes", () => {
    assert.deepEqual(parseSizes("256,1024,512,256"), [1024, 512, 256]);
  });

  it("rejects invalid size lists", () => {
    assert.throws(() => parseSizes("abc"), /integers/i);
    assert.throws(() => parseSizes("2048"), /between 1 and 1024/i);
  });

  it("builds sized output paths", () => {
    const outputDir = path.resolve("outputs");
    assert.equal(buildSizedOutputPath(outputDir, "hero", 1024), path.join(outputDir, "hero.png"));
    assert.equal(buildSizedOutputPath(outputDir, "hero", 256), path.join(outputDir, "hero-256.png"));
  });
});
