# Batch Lifecycle

## State Files

Each submit creates `./batches/<batch-name>.json`.

The file records:
- batch metadata
- batch options
- one entry per subject

## Remote Batch States

- `RUNNING`: Gemini is still working
- `SUCCEEDED`: results are ready for local processing
- `FAILED`: Gemini failed the batch
- `CANCELLED`: batch was cancelled
- `EXPIRED`: batch expired before completion

## Local Subject States

- `pending`: submitted to Gemini and not yet completed locally
- `skipped`: excluded before submit because input validation failed
- `complete`: final transparent PNG exists
- `failed`: local processing failed or Gemini returned a per-subject error

## Processing Rules

- `--process` only runs on a `SUCCEEDED` remote batch
- existing final output files make processing idempotent
- if the 1024 PNG exists but requested size variants are missing, `--process --sizes ...` backfills only the missing variants
- `--max-retries` retries only QA failures; retry state is not persisted between runs
- per-subject failures do not invalidate successful subjects
- state writes are atomic via `*.tmp` + rename
- `--json` during `--process` emits NDJSON `complete` / `failed` events and ends with a `summary`
- `--manifest` writes `<output-dir>/manifest.json` from the final local state
