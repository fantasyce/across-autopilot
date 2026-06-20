# Across Autopilot RFC

## Objective

Build a local-first autonomous iteration controller that can help the Across
ecosystem improve itself without allowing a running controller to modify or
approve itself directly.

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

## Stable/Candidate Promotion

1. Stable Autopilot generates a candidate plan.
2. A candidate workspace is created in an isolated branch or worktree.
3. Orchestrator executes the candidate implementation tasks.
4. Candidate evidence is collected from tests, E2E, CI, and release gates.
5. Stable evaluates promotion readiness.
6. Passing candidates can be promoted through normal PR/release mechanics.
7. The old stable remains the rollback target.

## Non-Goals For v0.1

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

