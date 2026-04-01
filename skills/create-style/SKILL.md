---
name: create-style
description: Scaffold a new portrait-forge style. Use when creating a custom portrait style.
allowed-tools:
  - Read
  - Write
  - Glob
  - Bash
---

# Create Style

Generate a complete portrait-forge style from a description.

## Triggers

Use when the user asks to:
- create a new style
- add a style
- make a custom style

## Workflow

### 1. Gather input

Ask the user for:
- **Style name** (kebab-case, e.g. `anime-portrait`)
- **Art direction** (what should the output look like?)

### 2. Read references

Read these to understand the required structure:

- `src/prompts/generation.md` — structural template for the generation prompt
- `src/prompts/qa-stage1.md` — structural template for QA
- `styles/studio/style.md` — example generation prompt
- `styles/game-day/style.md` — example generation prompt
- `styles/studio/qa.md` — example QA prompt

### 3. Generate `style.md`

Write a complete, self-contained generation prompt following the section order from `src/prompts/generation.md`. Replace the `${STYLE}` placeholder region with style-specific sections. Keep all other sections (Subject, Outfit, Identity, Constraints) verbatim from the template. The output file should NOT contain `${STYLE}` — it is the fully expanded prompt.

Style-specific sections to insert in place of `${STYLE}`:

- `## Expression` — facial expression guidance (optional — omit if the style has no specific expression)
- `## Art Style` — rendering style, detail level, texture
- `## Lighting & Camera` — lens, lighting setup, background

Append any style-specific constraints to the Constraints section, after the shared bullets from `src/prompts/generation.md`.

Keep `${SUBJECT_TYPE}`, `${OUTFIT_DESCRIPTOR}`, and `${OUTFIT_PATH}` as-is — they are runtime variables.

### 4. Generate `qa.md`

Take `src/prompts/qa-stage1.md` as the structural base. Replace the Style Consistency section content with style-specific criteria:

- A one-line description of what to check
- `Approve when:` (3 bullets)
- `Reject when:` (3 bullets)

If the style has a custom expression, update section 2's expression line to match.

### 5. Write files

Write to `./styles/<name>/` in the user's current working directory:
- `style.md` — complete generation prompt
- `qa.md` — complete QA stage 1 prompt

User-local styles in `./styles/` are discoverable by name (e.g. `--style <name>`) and persist across plugin updates. They take precedence over built-in styles with the same name.

## Important rules

- `style.md` MUST follow the exact section order from `src/prompts/generation.md`
- `qa.md` MUST follow the exact section structure from `src/prompts/qa-stage1.md`
- `${SUBJECT_TYPE}`, `${OUTFIT_DESCRIPTOR}`, `${OUTFIT_PATH}` are runtime variables — do NOT replace them
- The shared QA sections (Identity, Outfit, Framing, Verdict) must match `src/prompts/qa-stage1.md` exactly

## Notes

- `qa-final.md` is style-agnostic and lives at `src/prompts/qa-final.md`. Styles do not need their own copy unless they have specific final QA needs.
- Users can test with: `portrait-forge --ref <photo> --style <name> --qa`
