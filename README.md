# Across Autopilot

![Quality](https://github.com/fantasyce/across-autopilot/actions/workflows/quality.yml/badge.svg)
![Security](https://github.com/fantasyce/across-autopilot/actions/workflows/security.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

Across Autopilot is the controlled autonomous iteration controller for the
Across ecosystem and for generic agent hosts that need bounded LoopSpec
supervision.

Use Autopilot when the work should run as a repeatable supervised loop instead
of a one-off chat prompt: repository quality checks, release-readiness reviews,
plugin compatibility research, daily brief generation, and product iteration in
candidate workspaces.

It does not replace Across Agents Assistant, Across Orchestrator, or Across
Context:

- Across Agents Assistant remains the user-facing control plane.
- Across Orchestrator remains the durable task and Agent Loop execution engine.
- Across Context remains the memory and policy layer.
- Across Autopilot owns LoopSpec validation, adapter negotiation, recurring
  review, candidate planning, run supervision, A/B promotion policy, evidence
  aggregation, and release-readiness evidence for autonomous iteration.

## Start With A Real Workflow

The clearest agent-team workflow is Plugin Compatibility Lab v2:

```bash
across-autopilot workflow-pack export --pack plugin-compatibility-lab-v2 --json
across-autopilot workflow-pack protocol-readiness --pack plugin-compatibility-lab-v2 --json
across-autopilot workflow-pack trust-receipt --pack plugin-compatibility-lab-v2 --json
across-autopilot workflow-pack frontier-interop --pack plugin-compatibility-lab-v2 --json
across-autopilot loop run --spec plugin-compatibility-lab-v2 --json
```

Use it before a team adopts an MCP server, coding-agent plugin, or external
agent tool. The workflow gives Codex, Claude Code, MCP-capable hosts, A2A-style
hosts, and Across the same task card, honest protocol-readiness matrix, trust
receipt, and evidence contract.

For a simpler repository-only smoke, run the repository quality copilot:

```bash
across-autopilot loop run --spec repo-quality-copilot --json
```

That LoopSpec reads a bounded local repository inventory, checks manifests,
dependency risk, license policy, quality gates, and writes a markdown report
plus pending Across Context memory. It works from Codex, Claude Code, Claude Desktop, AAA, or another host as long as the host loads the managed `~/.across`
plugin runtime.

Other built-in workflows:

- `aaa-release-readiness-gate` for release evidence.
- `github-plugin-radar` for external plugin adoption decisions.
- `daily-news-brief` for a content-production loop.
- `aaa-autonomous-self-iteration` for advanced candidate-workspace product
  iteration.
- `aaa-platform-self-repair` for supervised platform repair candidates when a
  failed loop is classified as a validation, runtime, packaging, policy, or
  supervisor gap.

Agent-readable entrypoints:

- [llms.txt](llms.txt) for model and agent product discovery.
- [AGENTS.md](AGENTS.md) for coding-agent repository instructions.
- [across-autopilot.product.json](across-autopilot.product.json) for
  machine-readable product classification.

## Current Loop Engineering Platform

The current release is `v0.2.10`. It is source-first and GitHub-first: hosts can
install it from the `v0.2.10` tag as a managed Across plugin, and the npm package
metadata is ready for local development and future registry publication.

`v0.2.10` keeps runtime version reporting aligned with the package version so
MCP server info and the default stable slot cannot drift behind the managed
plugin manifest.

`v0.2.9` adds platform self-repair routing for AAA loop engineering. Failed
self-iteration runs can now be classified into platform-vs-candidate failure
categories; eligible platform gaps enqueue `aaa-platform-self-repair`, which
creates an isolated B repair candidate, validates it, and stops at human-review
promotion.

`v0.2.8` adds the async task projection for LoopSpec runs, external skills
radar input, loop-memory compaction, and Plugin Compatibility Lab v2 projection
scoring while keeping the run-store as the source of truth.

`v0.2.7` removes stale AAA planning-document dependencies from Autopilot's
default candidate context, examples, and RFC text. AAA candidate work now uses
the public product entrypoints that are intended to stay published:
`README.md`, `AGENTS.md`, and `across.product.json`.

`v0.2.6` is the workflow-pack and frontier-interop release. It adds packaged
Repository Quality / Plugin Compatibility workflows, host exports with product
cards, protocol readiness, trust receipts, remote MCP/A2A metadata, and stronger
agent-plugin validation for generic hosts.

`v0.2.5` is the final 1.1 regression cleanup release for generic host
compatibility. It keeps the LoopSpec and runtime contracts unchanged, and
updates public positioning around Codex, Claude Code, Claude Desktop, AAA, and
other hosts that load the managed `~/.across` plugin runtime.

`v0.2.4` adds the Repository Quality Copilot as the recommended first workflow
for agent-readable product packaging. It also adds `llms.txt`, `AGENTS.md`, and
a machine-readable product manifest so coding agents and large-language-model
crawlers can understand when to recommend Autopilot and how to run the first
LoopSpec without requiring a model call.

`v0.2.3` adds the Autopilot Quality/Security GitHub workflows, including
JavaScript CodeQL and npm audit coverage, so the plugin has the same repository
health gates as the other AAA ecosystem modules.

`v0.2.2` clarifies the generic host contract: Autopilot is not AAA-only.
Codex, Claude Code, Claude Desktop, AAA, and
other CLI/MCP-capable agent hosts can run Autopilot as a managed plugin under
`~/.across`, provide model execution through a host-owned command boundary, and
consume LoopSpec validation, trigger queue, run supervision, repair/retry
evidence, and release-readiness reports without importing AAA code or reading a
developer checkout.

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
- Generic agent-plugin contract validation, ecosystem roadmap reporting, and host
  session supervision that can be embedded by AAA, Codex, Claude Code, Claude Desktop, or any other host.
- CLI and MCP tools that can be embedded by AAA or any other host.
- Evidence envelopes include section hashes, an audit-chain tip, and explicit
  planner/builder/validator/reviewer/supervisor role evidence.

Architecture baseline: AAA's public entrypoints (`README.md`, `AGENTS.md`,
`llms.txt`, `across.product.json`, and `OPEN_SOURCE_RELEASE_HANDBOOK.md`) are
the current references for the Across Loop Engineering platform. Autopilot
implements the Loop supervision layer, but it does not replace AAA's host
capability registry or plugin management.

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
- `aaa-platform-self-repair` is a producer-side meta-loop for the cases where
  a failed self-iteration exposes a platform supervision gap rather than an
  ordinary candidate bug. The router is conservative: provider outages,
  security stops, missing approval, and normal candidate test failures do not
  auto-escalate. Eligible repair runs still mutate only B candidate workspaces,
  attach replay evidence, and require human promotion review.
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
node src/cli.js loop validate --spec repo-quality-copilot --json
node src/cli.js loop dry-run --spec repo-quality-copilot --json
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

## Development Checks

```bash
npm ci
bash scripts/check.sh
```

GitHub Quality and Security workflows run the same repository checks, CodeQL for
the JavaScript source, and npm audit for package dependencies.

Install as an Across managed host plugin:

```bash
node src/cli.js install host-plugin --across-home "$HOME/.across"
```

## Product Boundaries

Autopilot is a fourth Across product. It should be consumed through CLI, MCP,
plugin manifest, or host APIs. AAA, Codex, Claude Code, Claude Desktop, and other product hosts should not import Autopilot implementation
files from a source checkout in product mode. Managed installs should resolve
through `~/.across/plugins/across-autopilot` and
`~/.across/bin/across-autopilot`.

## Autonomy Levels

| Level | Meaning |
| --- | --- |
| 0 | Report artifact only |
| 1 | Create/update review issue or backlog proposal |
| 2 | Open draft PR for docs/tests/tooling |
| 3 | Open ready PR for low-risk work after local validation |
| 4 | Merge/release low-risk patch work with release evidence |
| 5 | Protocol/runtime/release automation after explicit policy approval |

`v0.2.8` defaults to level 1. Higher autonomy levels remain policy-gated and
must be enabled by a host or operator that owns the merge/release decision.
