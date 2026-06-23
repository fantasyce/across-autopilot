# Across Autopilot RFC

Status note: this RFC is a short product summary. The authoritative current
architecture is AAA's `LOOP_ENGINEERING_REFERENCE_ARCHITECTURE.md`. When this
RFC is less specific, follow the reference architecture.

## Objective

Build a local-first autonomous iteration controller that can help the Across
ecosystem improve itself without allowing a running controller to modify or
approve itself directly.

The platform is not limited to fixed candidate plans. Fixed targets are allowed
only for conformance tests. Production autonomous loops must be able to start
from fuzzy external ecosystem topics, such as current AI agent and LLM
application architecture signals, then generate or select work from artifacts,
loop contracts, global timeline entries, source signals, Tool Pack evidence,
recalled memory, and model-backed backlog ranking. Generated targets are
admitted by Autopilot policy before any B candidate workspace is mutated. Host
fallback targets and host-authored code templates are allowed only for
conformance fixtures, not production autonomous self-iteration.

## Architecture

```text
AAA UI
  -> AAA backend Autopilot API
    -> Across Autopilot CLI/MCP
      -> review reports
      -> candidate plans
      -> promotion reports
    -> Across Orchestrator for execution
    -> Across Context for durable memory
```

Reference architecture layers:

```text
Trigger Layer
  -> Contract Layer
  -> Memory and State Layer
  -> Tool Layer
  -> Agent Orchestration Layer
  -> Verification and Promotion Layer
```

Autopilot must reuse AAA/plugin/MCP capabilities through Tool Packs. It must
not become a second plugin manager, and it must not ask models to recreate
known deterministic workflows such as Git inspection or validation harnesses.
All trigger sources must enter Autopilot's durable trigger queue first, where
payload hashes, idempotency keys, due times, claim state, completion state, and
replay metadata are recorded before a LoopSpec run starts.

Tool Packs must expose reusable input/output schemas. Models may choose a Tool
Pack and interpret the result, but deterministic adapters own the mechanics of
fetching, cloning, diffing, validating, reviewing, scoring, and packaging
evidence.
If no fixed tool or target catalog fits the request, a model-generated fallback
plan is allowed only as an admitted plan: the model may propose candidate
targets, but Autopilot must still enforce repository/path policy, validation
commands, semantic review, and distinct-model acceptance before promotion
readiness can pass.

Validation/runtime artifacts such as `__pycache__` and `.pyc` are not
reviewable candidate changes and must be filtered out of candidate diff
evidence. Independent review must reject destructive documentation rewrites by
default unless a selected target explicitly justifies them. It must also reject
obvious generated-code artifacts such as constant false branches and placeholder
implementations. It must also reject test-only candidates and generated
candidate tests that depend on pytest unless that dependency is explicitly
provisioned. Those review failures can feed a bounded B-only model repair loop.

Promotion packages must be reviewable without rerunning the loop: candidate
manifest path, B diff summary, changed files, model decision hash, validation
results, reviewer scores, known risks, recommended draft PR title/body, source-A
immutability signal, and human approval requirement all belong in evidence.
When the LoopSpec requires distinct-model acceptance, evidence must include the
builder and reviewer model identities, and the reviewer model must differ from
the builder model before promotion readiness can pass.
Hosts may supply role-specific model overrides at run time, for example from
AAA's selected builder and reviewer agent/model controls. Those overrides must
not weaken the independent reviewer or human-approval gates.
Candidate runtimes must receive model access only through a non-secret Candidate
Model Capability Lease. Candidate App lifecycle evidence must prove that the
candidate reports `/api/llm/status` availability from `candidate_model_lease`,
not from copied or symlinked provider credentials.

Evidence envelopes must include integrity metadata: section hashes, audit-chain
tip, and explicit role evidence for planner, builder, validator, reviewer,
supervisor, and release gate surfaces where those roles participate.

## Stable/Candidate Promotion

1. Stable Autopilot generates a candidate plan.
2. A candidate workspace is created in an isolated branch or worktree.
3. Orchestrator executes the candidate implementation tasks.
4. Candidate evidence is collected from tests, E2E, CI, and release gates.
5. Stable evaluates promotion readiness.
6. Passing candidates can be promoted through normal PR/release mechanics.
7. The old stable remains the rollback target.

## Non-Goals

- No automatic merge.
- No automatic release.
- No secret creation or modification.
- No signing or notarization changes.
- No protocol/runtime changes without a separate RFC.

## Required Evidence

Promotion reports must include:

- branch or workspace identity
- changed products
- local test results
- E2E evidence
- CI evidence when available
- risk level
- rollback target
- explicit promotion recommendation
