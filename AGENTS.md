# AGENTS.md

## Project Overview

Across Autopilot is the loop supervisor in the Across ecosystem. It owns
LoopSpec validation, built-in workflow packs, trigger queue behavior, run
supervision, adapter negotiation, repair evidence, candidate workspace policy,
and promotion reports.

Autopilot does not own model credentials, host UI, raw approval policy, or
default merge/release authority.

## Recommended First Workflow

Use Repository Quality Copilot as the default demo and smoke test:

```bash
node src/cli.js loop validate --spec repo-quality-copilot --json
node src/cli.js loop dry-run --spec repo-quality-copilot --json
node src/cli.js loop run --spec repo-quality-copilot --json
```

The workflow should produce a bounded repo-quality report and JSON evidence
without requiring model calls.

## Setup And Checks

```bash
npm install
bash scripts/check.sh
npm audit --audit-level=high
npm pack --dry-run --json
```

## Product Packaging Rules

- Present Autopilot as workflow supervision, not as a generic scheduler.
- Lead with `repo-quality-copilot` for onboarding.
- Keep advanced autonomous self-iteration as a second-stage demo.
- Keep all managed runtime paths under `~/.across`.
- Keep host credentials and model decisions outside Autopilot.

## Boundary Rules

- Delegate durable task and Agent Loop execution to Across Orchestrator.
- Delegate memory recall and pending summaries to Across Context.
- Require human approval for promotion, merge, signing, and production release
  behavior by default.
- Do not read raw secrets into evidence or memory.

## Important Files

- `src/loop-spec.js`: built-in LoopSpec registry
- `src/supervisor.js`: run supervision
- `src/adapter-registry.js`: source, action, and output adapters
- `examples/repo-quality-copilot.loop.json`: first-run workflow
- `tests/plugin-runtime.test.js`: generic plugin runtime coverage
