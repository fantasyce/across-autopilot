# Across Autopilot

Across Autopilot is the controlled autonomous iteration controller for the
Across ecosystem.

It does not replace Across Agents Assistant, Across Orchestrator, or Across
Context:

- Across Agents Assistant remains the user-facing control plane.
- Across Orchestrator remains the durable task and Agent Loop execution engine.
- Across Context remains the memory and policy layer.
- Across Autopilot owns recurring review, candidate planning, A/B promotion
  policy, and release-readiness evidence for autonomous iteration.

## Safety Model

Autopilot uses stable/candidate slots:

- `stable` is the trusted released controller.
- `candidate` is an isolated proposal created from stable policy.
- Candidate work must produce evidence before it can be promoted.
- A candidate cannot approve itself.
- The previous stable remains the rollback target after promotion.

Autopilot v0.1 is intentionally conservative. It can generate reports,
candidate plans, candidate records, and promotion reports. It does not merge,
tag, publish, change secrets, or release software automatically.

## Quick Start

```bash
npm test
node src/cli.js status --json
node src/cli.js review --json
node src/cli.js candidate-plan --goal "Improve release workflow" --target-product across-agents-assistant --json
```

Install as an Across managed host plugin:

```bash
node src/cli.js install host-plugin --across-home "$HOME/.across"
```

## Product Boundaries

Autopilot is a fourth Across product. It should be consumed through CLI, MCP,
plugin manifest, or host APIs. AAA should not import Autopilot implementation
files from a source checkout in product mode.

## Autonomy Levels

| Level | Meaning |
| --- | --- |
| 0 | Report artifact only |
| 1 | Create/update review issue or backlog proposal |
| 2 | Open draft PR for docs/tests/tooling |
| 3 | Open ready PR for low-risk work after local validation |
| 4 | Merge/release low-risk patch work with release evidence |
| 5 | Protocol/runtime/release automation after explicit policy approval |

v0.1 defaults to level 1.

