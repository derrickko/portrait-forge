---
name: portrait-forge
description: Orchestrates portrait-forge batch runs and single portrait generation. Use for portrait generation, stylized portraits, or portrait batch processing.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Write
---

# portrait-forge orchestration

`portrait-forge` does the deterministic work. You decide when to submit, poll, and process.

**Important:** Always pass `--cwd` with the user's working directory. This ensures outputs, batch state, and config resolve relative to the user's project — not the plugin install directory.

Determine the user's working directory before running any commands:

```bash
USER_CWD=$(pwd)
```

Then pass `--cwd "$USER_CWD"` to every `portrait-forge` invocation.

## Triggers

Use this skill when the user asks to:
- generate a portrait
- generate a stylized portrait
- run a portrait batch
- use portrait-forge

## Prerequisites

Required:
- `GEMINI_API_KEY`
- `REPLICATE_API_TOKEN`

## Inspect Commands

These require no API keys and return instantly. Use them to understand state before running pipelines.

```bash
portrait-forge --cwd "$USER_CWD" --list-styles --json       # available style profiles
portrait-forge --cwd "$USER_CWD" --list-batches --json      # existing batch runs in ./batches/
portrait-forge --cwd "$USER_CWD" --show-config --json       # resolved configuration
portrait-forge --cwd "$USER_CWD" --validate-style <name> --json  # check a style for errors
```

## Single Image

Run:

```bash
portrait-forge --cwd "$USER_CWD" --ref <ref> --outfit <outfit> --json
```

Optional flags:
- `--style <name-or-path>` — style profile (default: game-day). Use `--list-styles` to see options.
- `--subject-type <value>` — prompt descriptor (default: "person")
- `--output <path>` — output file path (default: ./outputs/<id>.png)
- `--base-only` — stop after generation + verification (skip bg-removal). Returns base image path and QA context.
- `--sizes <list>` — additional output sizes, e.g. "512,256"
- `--config <path>` — config file path (default: portrait-forge.config.json in cwd)
- `--manifest` — write manifest.json beside output
- `--verbose` — extra logging

## Single Image with QA

When the user wants quality checks:

1. Generate the base:
   ```bash
   portrait-forge --cwd "$USER_CWD" --ref <ref> --outfit <outfit> --base-only --style <style> --json
   ```
   Parse from the output:
   ```json
   { "type": "complete", "basePath": "...", "qaPath": "...", "refPath": "...", "outfitPath": "..." }
   ```

2. Stage 1 QA:
   - Read the base image at `basePath`
   - Read QA criteria at `qaPath` (the CLI resolved style-specific vs fallback for you)
   - Apply all criteria sections: Style Consistency, Identity Preservation,
     Outfit Integration, Framing, Artifacts
   - If the image fails: re-run step 1 (up to ~3 attempts; adjust based on time/cost constraints)

3. Finish the pipeline (bg-removal + resize):
   ```bash
   portrait-forge --cwd "$USER_CWD" --ref <ref> --outfit <outfit> --sizes <sizes> --json
   ```
   The base already exists on disk — the pipeline skips generation and proceeds
   to bg-removal. Parse `outputPath` from the output.

4. Final QA:
   - Read the final transparent image at `outputPath`
   - Read the style QA criteria at `qaPath` (same file used in Stage 1)
   - Also read `src/prompts/qa-final.md` for bg-removal specific checks
     (transparency edges, hair artifacts, edge quality)
   - Apply both sets of criteria
   - If the image fails: re-run from step 1 (up to ~3 attempts; adjust based on time/cost constraints)

## Batch Lifecycle

### 1. Submit

Run:

```bash
portrait-forge --cwd "$USER_CWD" --csv <csv> --json
```

Optional flags:
- `--default-outfit <path>` — fallback outfit when CSV column is empty
- `--output-dir <path>` — output directory (default: ./outputs)
- `--concurrency <n>` — parallel workers (default: 2)
- `--style <name-or-path>` — style profile
- `--subject-type <value>` — default subject type
- `--dry-run` — validate CSV and report count without submitting
- `--verbose` — extra logging

Parse:
```json
{ "batchName": "batch-...", "subjectCount": 42, "skipped": 1 }
```

### 2. Poll

Use `/loop` instead of inventing your own wait loop:

```text
/loop 5m portrait-forge --cwd "$USER_CWD" --status <batch-name> --json
```

If `/loop` is not available, poll manually by running `portrait-forge --cwd "$USER_CWD" --status <batch-name> --json` at ~5 minute intervals and checking `batchState`.

Decision rules:
- if `batchState` is `SUCCEEDED`, stop polling and move to processing
- if `batchState` is `FAILED`, `CANCELLED`, or `EXPIRED`, stop and report the failure
- otherwise keep polling

### 3. Process

Run:

```bash
portrait-forge --cwd "$USER_CWD" --process <batch-name> --json
```

Optional flags:
- `--base-only` — extract base images only (skip bg-removal). Use for staged QA.
- `--style <name-or-path>` — style profile
- `--output-dir <path>` — output directory
- `--concurrency <n>` — parallel workers
- `--sizes <list>` — additional output sizes
- `--manifest` — write manifest.json
- `--verbose` — extra logging

Parse NDJSON — one line per subject, then a summary:
```json
{ "type": "complete", "subjectId": "jane-doe", "outputPath": "...", "durationSec": 4.2 }
{ "type": "failed", "subjectId": "john-smith", "error": "..." }
{ "type": "summary", "processed": 41, "succeeded": 40, "failed": 1, "manifestPath": "..." }
```

If failures are non-zero, report the count and the likely next step rather than silently retrying forever.

### 4. Batch with QA

1. Submit: `portrait-forge --cwd "$USER_CWD" --csv <csv> --json`
2. Poll: `/loop 5m portrait-forge --cwd "$USER_CWD" --status <batch> --json`
3. Extract bases:
   ```bash
   portrait-forge --cwd "$USER_CWD" --process <batch> --base-only --json
   ```
   NDJSON per subject:
   ```json
   { "type": "complete", "subjectId": "jane-doe", "basePath": "...", "qaPath": "...", "refPath": "...", "outfitPath": "..." }
   ```

4. Stage 1 QA (in groups of ~5 subjects to bound context; adjust based on context budget):
   For each group, read the base images and apply QA criteria from `qaPath`.
   Flag subjects that need re-generation.

5. Re-generate flagged subjects:
   ```bash
   portrait-forge --cwd "$USER_CWD" --ref <ref> --outfit <outfit> --base-only --json
   ```
   Re-QA the new base. Up to ~3 attempts per subject (adjust based on time/cost constraints).

6. Process finals:
   ```bash
   portrait-forge --cwd "$USER_CWD" --process <batch> --json
   ```
   Bg-remove + resize for subjects with bases but no finals (skip-existing logic).

7. Final QA (in groups of ~5):
   Read the final images. Apply both the style's `qa.md` and `src/prompts/qa-final.md`.
   Re-generate from step 5 if needed.

## Error Handling

When `--json` is active, errors are emitted as `{"type":"error","message":"..."}` to stdout in addition to stderr. Parse the `type` field to detect errors programmatically.

## Notes

- Always prefer `--json` when you need to parse results. For `--process`, this is NDJSON rather than a single JSON blob.
- Batch state files live under `./batches/`, so status and process should run from the same working directory as submit.
- Use the reference doc at `references/batch-lifecycle.md` if you need the state machine details.
