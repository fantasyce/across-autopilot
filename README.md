# Across Autopilot

Across Autopilot is the controlled autonomous iteration controller for the
Across ecosystem.

It does not replace Across Agents Assistant, Across Orchestrator, or Across
Context:

- Across Agents Assistant remains the user-facing control plane.
- Across Orchestrator remains the durable task and Agent Loop execution engine.
- Across Context remains the memory and policy layer.
- Across Autopilot owns LoopSpec validation, adapter negotiation, recurring
  review, candidate planning, run supervision, A/B promotion policy, evidence
  aggregation, and release-readiness evidence for autonomous iteration.

## Current Loop Engineering Platform

The current release is `v0.2.0`. It is source-first and GitHub-first: hosts can
install it from the `v0.2.0` tag as a managed Across plugin, and the npm package
metadata is ready for local development and future registry publication.

Across Autopilot now provides the reusable Loop Engineering supervisor used by
the Across ecosystem:

- `across-loop-spec/1.0` validation and migration.
- Built-in LoopSpec packs for AAA autonomous self-iteration, AAA release
  readiness, GitHub plugin radar, and daily news/video-draft workflows.
- Source, action, and output adapter registry.
- Durable run store, audit log, cancel/retry/quarantine controls, kill switches,
  and aggregate telemetry.
- Durable trigger queue for manual, cron, webhook, daemon, file-change, memory,
  and orchestrator-event wakeups. Triggers are normalized with payload hashes,
  idempotency keys, claim state, completion state, and replay metadata before
  any LoopSpec executes.
- Delegation to Across Orchestrator for task and Agent Loop execution.
- Model-backed loops through a host model decision boundary: Autopilot declares
  `model_policy`, Orchestrator requests the decision, and Autopilot applies only
  returned candidate-workspace patches.
- Recall and pending memory writes through Across Context.
- CLI and MCP tools that can be embedded by AAA or any other host.
- Evidence envelopes include section hashes, an audit-chain tip, and explicit
  planner/builder/validator/reviewer/supervisor role evidence.

Architecture baseline: AAA's
`LOOP_ENGINEERING_REFERENCE_ARCHITECTURE.md` is the current reference for the
Across Loop Engineering platform. Autopilot implements that architecture as the
Loop platform layer, but it does not replace AAA's host capability registry or
plugin management.

Important distinction:

- Conformance LoopSpecs may use fixed targets and fixed patch paths for
  deterministic E2E and regression tests.
- Autonomous product LoopSpecs must select work dynamically from artifacts,
  loop contracts, global timeline entries, source signals, and backlog ranking.
- `aaa-self-iteration-product` remains a fixed conformance fixture.
- `aaa-autonomous-self-iteration` is the production self-iteration pack: it
  asks the host model to research current AI agent and LLM application architecture signals,
  compare them with the Across product ecosystem, and generate candidate targets
  from artifacts, loop contracts, global timeline entries, source signals, Tool Pack evidence,
  and recalled memory; Autopilot admits only policy-safe B-candidate targets,
  validates B, runs the B-to-C self-hosting probe, and
  requires an independent reviewer gate before promotion evidence is considered
  ready.
- Host fallback targets and host-authored code templates are conformance-only.
  Production autonomous loops preserve openness by failing with evidence when
  model target generation or model patch generation cannot be repaired.

Tool policy:

- AAA, managed plugins, and MCP servers remain the canonical capability source.
- Autopilot owns a Tool Pack Registry that wraps those capabilities as
  LoopSpec adapters.
- Tool Packs declare reusable input/output schemas so models choose and
  interpret tools while deterministic adapters own the execution mechanics.
- Autopilot must not become a second plugin manager.
- Repeatable workflows such as Git repository inspection, source digesting,
  license/dependency checks, candidate workspace setup, validation harnesses,
  candidate diff quality review, packaged Candidate App lifecycle, and promotion
  report generation should be deterministic Tool Packs instead of
  model-generated one-off scripts.
- Models decide what to inspect and how to interpret the result; Tool Packs own
  how the inspection is performed and how structured evidence is returned.
- When no fixed tool or target catalog fits a run, the
  `model_generated_fallback_plan` Tool Pack lets the host model prepare a
  bounded candidate plan. Autopilot still admits repos, paths, validation
  commands, and review gates before B can be mutated.
- Candidate diff evidence filters validation/runtime artifacts such as
  `__pycache__`, `.pyc`, and test caches before promotion review.
- Independent review rejects destructive documentation rewrites by default and
  suspicious generated-code artifacts such as constant false branches or
  placeholder implementations, rejects test-only candidates and pytest-dependent
  generated candidate tests, scores product value/maintainability/risk, then
  sends semantic feedback back into a bounded B-only model repair loop.
- Production acceptance can require distinct-model review. When
  `reviewer_model_policy.require_distinct_from_builder=true`, the AAA host
  reviewer command must return a model identity different from the builder
  model, and Autopilot blocks promotion evidence if the identities match.
- Hosts may pass role-specific model overrides at run time, including
  user-selected builder and reviewer models from AAA's agent/model list.
  Autopilot merges those overrides into the role policies and keeps the
  distinct reviewer gate active.
- Promotion evidence includes a structured package with validation results,
  reviewer scores, known risks, a recommended draft PR title/body, and an
  explicit human approval requirement.

## Safety Model

Autopilot uses stable/candidate slots:

- `stable` is the trusted released controller.
- `candidate` is an isolated proposal created from stable policy.
- Candidate work must produce evidence before it can be promoted.
- A candidate cannot approve itself.
- The previous stable remains the rollback target after promotion.

Autopilot remains conservative. It can run LoopSpec workflows and write bounded
reports, JSON artifacts, storyboards, video-draft manifests, evidence
envelopes, and pending memory candidates. It does not merge, tag, publish,
change secrets, sign artifacts, or release software automatically.

Autopilot does not own model credentials. Hosts provide model execution through
an explicit JSON command boundary. When a LoopSpec sets
`model_policy.required=true`, `candidate_workspace_patch` must consume
model-decision patches from Orchestrator evidence; static
`pack_config.iteration_plan.patches` are ignored for that run.

Candidate runtimes get model access through a non-secret Candidate Model
Capability Lease. The lease lists allowed model scopes and the stable host
boundary, but it never contains provider API keys and must not be implemented as
a copy or symlink of host credential files. Packaged Candidate App lifecycle
verification probes the candidate `/api/llm/status` endpoint and fails unless
model availability is reported from `candidate_model_lease` with credential-safe
flags. The lease may target the installed stable AAA Unix socket or a local
host HTTP URL for CLI/E2E runs; both remain host-control-plane transports.

## Quick Start

```bash
npm test
node src/cli.js status --json
node src/cli.js loop validate --spec aaa-autonomous-self-iteration --json
node src/cli.js loop dry-run --spec aaa-autonomous-self-iteration --json
node src/cli.js loop validate --spec daily-news-brief --json
node src/cli.js loop dry-run --spec daily-news-brief --json
node src/cli.js loop enqueue-trigger --spec daily-news-brief --type cron --payload-json '{"reason":"smoke"}' --json
node src/cli.js loop trigger-queue --json
node src/cli.js loop run-trigger --json
node src/cli.js loop run --spec daily-news-brief --json
node src/cli.js loop telemetry --json
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

`v0.2.0` defaults to level 1. Higher autonomy levels remain policy-gated and
must be enabled by a host or operator that owns the merge/release decision.
