# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-03-30

### Added

- Single-image portrait generation with Gemini and Replicate
- Batch mode with Gemini Batch API, resumable state, and NDJSON output
- Two-stage visual QA prompt templates (Stage 1 + Final) for Claude Code skill orchestration
- Multi-resolution output (`--sizes`)
- Manifest export (`--manifest`)
- Two built-in styles: game-day, studio
- Custom style support with user-local `styles/` directory
- Configuration file support (`portrait-forge.config.json`)
- Inspect commands: `--list-styles`, `--list-batches`, `--show-config`, `--validate-style`
- Claude Code plugin with `/portrait-forge` skill and QA agents
- Path security (traversal, null byte, URL scheme validation)
- Sensitive data scrubbing in error output
- Atomic writes for crash-safe state persistence

[0.1.0]: https://github.com/derrick/portrait-forge/releases/tag/v0.1.0
