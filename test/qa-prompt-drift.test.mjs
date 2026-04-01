import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { STYLES_DIR, PROMPTS_DIR, listStyles } from "../src/style.mjs";

describe("style QA file structure", () => {
  const REQUIRED_HEADINGS = [
    "Style Consistency",
    "Identity Preservation",
    "Outfit Integration",
    "Framing",
    "Verdict Rules"
  ];

  test("every built-in style has qa.md with required sections", async () => {
    const styles = await listStyles();
    assert.ok(styles.length >= 2, "expected at least 2 built-in styles");

    for (const style of styles) {
      assert.ok(style.hasQa, `${style.name} is missing qa.md`);
      const content = await fsp.readFile(path.join(STYLES_DIR, style.name, "qa.md"), "utf8");
      for (const heading of REQUIRED_HEADINGS) {
        assert.ok(
          content.includes(heading),
          `${style.name}/qa.md missing required section: ${heading}`
        );
      }
    }
  });

  test("fallback qa-stage1.md has required sections and no unresolved placeholders", async () => {
    const content = await fsp.readFile(path.join(PROMPTS_DIR, "qa-stage1.md"), "utf8");
    for (const heading of REQUIRED_HEADINGS) {
      assert.ok(
        content.includes(heading),
        `qa-stage1.md missing required section: ${heading}`
      );
    }
    assert.ok(
      !content.match(/\$\{[A-Z_]+\}/),
      "qa-stage1.md must not contain unresolved ${...} placeholders"
    );
  });

  test("fallback qa-final.md exists", async () => {
    await assert.doesNotReject(
      fsp.access(path.join(PROMPTS_DIR, "qa-final.md")),
      "qa-final.md must exist"
    );
  });
});
