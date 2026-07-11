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

For a concrete local push boundary, run the Git/PR quality gate:

```bash
across-autopilot gate --repo . --base-ref origin/main --head-ref HEAD --max-repairs 2 --json
```

The gate resolves and records the repository, base ref, head ref, branch, head
commit, dirty state, and committed diff. Executable check commands are loaded
only from `.across/repo-push-gate.json` in the resolved base commit with
`git show`; command strings supplied by a feature branch or CLI are not
accepted. Start from `examples/repo-push-gate.config.json`, review it, and
commit it to the trusted base branch. The result uses
`across-autopilot-gate-result/1.0` and includes normalized findings, check and
policy evidence, bounded repair planning, CI status, a draft-PR plan, a GitHub
Check / PR-comment payload, and the deterministic push-receipt hash. The
default remains local and non-mutating.

`--draft-pr` by itself only plans draft-PR evidence. Remote mutation requires
all of the following: `github_remote.enabled=true` in the trusted base config,
an exact host/repository allowlist, explicit `push_branch` permission, an exact
`refs/heads/...` feature-branch allowlist, draft-only operations,
`network_policy=allow`, `--push-branch --approve-remote`, a matching approval token in the policy-named environment
variable, and a GitHub token in the policy-named environment variable. Token
values are never accepted as CLI arguments and are not written to evidence.
For example:

```bash
export ACROSS_REPO_GATE_APPROVAL_TOKEN='<approval value matching the trusted digest>'
export GH_TOKEN='<GitHub token>'
across-autopilot gate --repo . --base-ref origin/main --head-ref HEAD \
  --push-branch --draft-pr --approve-remote --watch-ci true --json
```

The approved path first pushes the gated commit SHA with a non-force explicit
`<sha>:refs/heads/<feature>` refspec, verifies the remote SHA with `ls-remote`,
and only then creates or resumes one draft PR. `HEAD`, `main`, `master`, tags,
deletes, force pushes, wildcard refs, and refs absent from the trusted exact
allowlist are rejected. A lost push response is reconciled against the remote
SHA before any PR mutation. The path then polls GitHub Actions,
collects bounded failed-log summaries, recalculates normalized findings and
repair candidates, and idempotently creates or updates one verification result
and one marked PR comment. `verification_mode` can be `check_run` for a GitHub
App token, `commit_status` for a user token, or `auto` to fall back only when
GitHub explicitly rejects the token type. CI polling refreshes its idle timer on every successful
GitHub heartbeat and also enforces a separate total wall-clock limit. Rerunning
the same approved command recovers the existing PR, verification result, and comment.

Gate exit codes are exact: `0` means a completed `pass`
verdict, including no-op; `2` means a completed `warn`, `blocked`, `fail`, or
`unknown` verdict, or a denied/failed remote operation; `1` means usage or
runtime failure before a valid gate result was produced.

When CI is required, pass `--ci-path <snapshot.json>`. Add
`--ci-wait-seconds <n>` to poll that bounded local watcher snapshot until all
checks are terminal or the wait budget expires.

Trusted GitHub remote policy example (store only the approval token SHA-256,
never either token value):

```json
{
  "network_policy": "allow",
  "github_remote": {
    "enabled": true,
    "repository": "owner/repository",
    "allowed_hosts": ["github.com"],
    "allowed_operations": ["push_branch", "draft_pr", "ci_watch", "check_run", "pr_comment"],
    "allowed_push_refs": ["refs/heads/feature/exact-branch-name"],
    "verification_mode": "auto",
    "require_draft": true,
    "approval_token_env": "ACROSS_REPO_GATE_APPROVAL_TOKEN",
    "approval_token_sha256": "<64 lowercase hex characters>",
    "auth_token_env": "GH_TOKEN"
  }
}
```

Other built-in workflows:

- `repo-push-gate` for a baseline-trusted local receipt or explicitly approved draft GitHub PR/CI loop.
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

The current release is `v0.3.0`. It is source-first and GitHub-first: hosts can
install it from the `v0.3.0` tag as a managed Across plugin, and the npm package
metadata is ready for local development and future registry publication.

`v0.3.0` adds an approval-controlled GitHub delivery loop: exact non-force
feature-branch push, resumable draft PRs, Actions heartbeats with separate idle
and wall budgets, normalized CI repair evidence, marked comments, and GitHub App
Check Runs or user-token-compatible Commit Status verification. Remote mutation
remains disabled unless the trusted base policy and one-run host approval agree.

`v0.2.30` moves AAA self-iteration Codex policies to the locally visible
`gpt-5.5` model and adds deterministic timeout-recovery evidence for builder
and reviewer host calls, so a stalled local agent no longer turns the full loop
into an opaque terminal failure.

`v0.2.29` removes `codex-auto-review` from AAA self-iteration model candidates
and gives research/review Codex calls a longer silent reasoning window after
live E2E showed `gpt-5.3-codex-spark` could exceed a 300-second idle budget.

`v0.2.28` keeps AAA self-iteration research and review on the smoke-tested
`gpt-5.3-codex-spark` model first after live E2E showed review-model sessions
could hang during research repair.

`v0.2.26` treats active stdout/stderr streaming as progress for host command
wall-timeout windows, so complex agent calls are not killed while they continue
to emit activity.

`v0.2.25` collapses duplicate marker-upsert blocks during candidate repairs and
adds implicit AAA product-entrypoint smoke validation for workbench and
capability-pack changes, so semantic-review failures become validation feedback.

`v0.2.24` updates AAA self-iteration LoopSpecs to use locally smoke-tested Codex
models by role: `codex-auto-review` for research/review and
`gpt-5.3-codex-spark` for code generation.

`v0.2.23` adds explicit hard-deadline races around URL source fetches and body
reads, so source discovery still times out if the underlying fetch or stream
ignores abort signals.

`v0.2.22` hardens source discovery for autonomous self-iteration: URL source
timeouts now cover both response headers and response body reads, so a stalled
body stream cannot leave a run indefinitely parked in `discovering_sources`.

`v0.2.21` makes cancellation and diagnosis reliable for long autonomous runs:
supervised runs record their executor PID, cancel requests terminate the
recorded process tree instead of only updating run state, and cancelled runs
cannot later overwrite their terminal status after a child command returns.

`v0.2.20` hardens AAA autonomous code iteration for complex local Codex runs:
the code-iteration operation timeout now propagates into the builder model
policy, built-in self-iteration specs allow long silent code generation without
removing max-wall guardrails, and end-to-end self-iteration budgets cover
research, build, validation, app lifecycle, and review.

`v0.2.19` hardens AAA self-iteration for long-running local agent work: host
commands refresh idle timeouts on real stdout/stderr activity, keep a max-wall
timeout as the final guardrail, preserve timeout policy through LoopSpec role
model overrides, use locally available Codex model defaults, and route
platform self-repair trigger targets deterministically from replay payloads.

`v0.2.18` makes AAA autonomous self-iteration more resilient to long-running
host model calls by preserving LoopSpec fallback model policy, shortening
per-model local-agent budgets, and routing host local-agent timeouts into
platform self-repair instead of treating them as non-repairable infrastructure
failures.

`v0.2.17` makes autonomous self-iteration source intake more reliable by using
Node-fetchable OpenAI Agents SDK GitHub README sources and by testing that
source and fallback hosts stay covered by each LoopSpec network allowlist.

`v0.2.16` hardens autonomous self-iteration source intake by retrying transient
URL failures, extending default source timeouts, supporting fallback URLs, and
using raw Agent2Agent README content instead of the heavier GitHub repository
page.

`v0.2.15` finishes the Codex migration for AAA self-iteration loops by moving
platform self-repair and older self-iteration LoopSpecs off MiniMax defaults.

`v0.2.14` hardens autonomous self-iteration execution: the AAA self-iteration
spec now routes research, builder, and reviewer roles through the local Codex
agent, candidate app lifecycle validation rejects macOS socket paths before they
can crash startup, empty optional LLM status no longer fails promotion, and loop
state records self-iteration quality snapshots for future review.

`v0.2.13` hardens autonomous self-iteration validation: AAA candidate
workspaces now run an implicit top-level backend name smoke test, candidate
implementation failures stay out of platform self-repair routing, and specs can
finish with explicit rejected-candidate evidence after validation repair
attempts are exhausted.

`v0.2.12` hardens autonomous self-iteration repair: host code iteration now
applies append and marker-upsert patches deterministically, restores destructive
product entrypoint rewrites from the source baseline before repair, records
bounded validation diagnostics, and keeps candidate implementation failures out
of platform self-repair routing unless there is an explicit platform validation
gap signal.

`v0.2.11` tightens platform self-repair routing so ordinary candidate validation
tracebacks are not misclassified as host packaging gaps just because a later
candidate app lifecycle check also failed.

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
node src/cli.js loop validate --spec repo-push-gate --json
node src/cli.js loop dry-run --spec repo-push-gate --json
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
