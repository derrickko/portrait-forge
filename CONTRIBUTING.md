# Contributing to portrait-forge

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

```bash
git clone https://github.com/derrick/portrait-forge.git
cd portrait-forge
npm install
```

No API keys are needed to run the test suite.

## Running Tests

Tests use Node's built-in test runner with fully mocked API clients:

```bash
npm test
```

All external services (Gemini, Replicate, Claude CLI) are mocked. Tests run offline and complete in seconds.

## Running Locally

```bash
node bin/portrait-forge.mjs --ref photo.png --outfit blazer.png --json
```

You'll need `GEMINI_API_KEY` and `REPLICATE_API_TOKEN` set for real API calls. Copy `.env.example` to `.env` to get started.

## Project Structure

```
portrait-forge/
  bin/               CLI entry point
  src/               Core modules (pipeline, batch, config, style, replicate-client, utils)
  src/prompts/       Shared prompt templates and QA criteria
  test/              Tests (mirrors src/)
  styles/            Built-in style profiles (style.md + qa.md per style)
  skills/            Claude Code skill definitions
  samples/           Example inputs and CSV
  .claude-plugin/    Plugin marketplace metadata
```

## Writing Tests

- Every source module in `src/` has a corresponding `test/*.test.mjs` file
- Use dependency injection (all API clients are injectable) rather than monkey-patching
- Tests should run without network access or API keys
- Follow existing test patterns — `test/helpers.mjs` provides shared utilities

## Creating Styles

You can create new styles with the Claude Code plugin:

```
/create-style
```

Or manually: copy an existing `styles/<name>/` directory and edit `style.md` (generation prompt) and `qa.md` (QA criteria). See `src/prompts/generation.md` for the structural reference.

## Pull Request Guidelines

- **Include tests** for any new functionality or bug fix
- **Keep PRs focused** — one feature or fix per PR
- **Run `npm test`** before submitting and ensure all tests pass
- **Follow existing code style** — no linter is enforced, but match the patterns in surrounding code

## Reporting Issues

- **Bugs:** [open an issue](https://github.com/derrick/portrait-forge/issues/new?labels=bug) with steps to reproduce, expected behavior, and actual behavior
- **Features:** [open an issue](https://github.com/derrick/portrait-forge/issues/new?labels=enhancement) describing the use case and proposed solution
- **Security:** report privately via [GitHub Security Advisories](https://github.com/derrick/portrait-forge/security/advisories)
