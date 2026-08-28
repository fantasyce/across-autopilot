import test from "node:test";
import assert from "node:assert/strict";

import { buildEvidenceEnvelope } from "../src/evidence.js";
import { buildGoalChangeProposal } from "../src/goal-proposals.js";
import { AutopilotSupervisor } from "../src/supervisor.js";
import { buildWorkflowExecutionPlan } from "../src/workflow-packs.js";
import { buildCandidatePlan, buildPromotionReport, createCandidate } from "../src/candidates.js";


function goalContract() {
  return {
    schema_version: "across-goal-contract/1.0",
    goal_id: "goal-task-001",
    revision: 4,
    task_id: "task-001",
    statement: "Ship a verifiable change",
    success_outcome: "The user can verify the change.",
    scope: { includes: ["implementation", "tests"], excludes: ["release", "promotion"] },
    acceptance_criteria: [
      {
        criterion_id: "criterion-tests",
        description: "All required tests pass.",
        required: true,
        validator_kind: "test_suite",
        review_policy: "automatic",
        source: "user_confirmed"
      },
      {
        criterion_id: "criterion-review",
        description: "A human accepts the installed journey.",
        required: true,
        validator_kind: "installed_user_journey",
        review_policy: "human",
        source: "user_confirmed"
      },
      {
        criterion_id: "criterion-note",
        description: "Optional notes are retained.",
        required: false,
        validator_kind: "document_review",
        review_policy: "automatic",
        source: "user_confirmed"
      }
    ],
    dependencies: [],
    execution_profile: "workflow-pack",
    source: "user",
    confirmed_by: "human:user",
    confirmed_at: "2026-08-28T00:00:00Z",
    created_at: "2026-08-28T00:00:00Z"
  };
}


test("goal-aware plans bind every required criterion without changing the contract", () => {
  const supervisor = new AutopilotSupervisor();
  const contract = goalContract();
  const before = structuredClone(contract);
  const plan = supervisor.buildPlan({
    id: "goal-aware",
    used_adapters: { actions: ["manifest_inspection", "quality_gate_evaluation"] },
    outputs: [{ id: "report" }]
  }, [], [], contract);

  assert.equal(plan.goal_id, contract.goal_id);
  assert.equal(plan.goal_revision, 4);
  assert.match(plan.input_fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(contract, before);
  const covered = new Set([
    ...plan.actions.flatMap((action) => action.criterion_ids),
    ...plan.host_decisions.flatMap((decision) => decision.criterion_ids)
  ]);
  assert.ok(covered.has("criterion-tests"));
  assert.ok(covered.has("criterion-review"));
  assert.ok(plan.host_decisions.some((decision) => decision.criterion_ids.includes("criterion-review")));
});


test("ordinary plans remain generic when no Goal Contract is supplied", () => {
  const plan = new AutopilotSupervisor().buildPlan({
    id: "ordinary",
    used_adapters: { actions: ["manifest_inspection"] },
    outputs: []
  }, [], []);

  assert.deepEqual(plan.actions, ["manifest_inspection"]);
  assert.equal("goal_id" in plan, false);
  assert.equal("criterion_ids" in plan, false);
});


test("Autopilot creates an immutable pending proposal and never confirms the goal", () => {
  const contract = goalContract();
  const before = structuredClone(contract);
  const proposal = buildGoalChangeProposal({
    baseContract: contract,
    operations: [{ op: "add", path: "/scope/includes/-", value: "accessibility" }],
    reason: "The installed journey needs accessibility coverage.",
    impact: { criterion_ids: ["criterion-review"], evidence_ids: [] },
    now: new Date("2026-08-28T01:00:00Z"),
    proposalId: "proposal-accessibility"
  });

  assert.deepEqual(contract, before);
  assert.equal(proposal.base_goal_revision, 4);
  assert.equal(proposal.decision_state, "pending");
  assert.equal(proposal.proposed_by, "autopilot");
  assert.equal("confirmed_by" in proposal, false);
  assert.equal("confirmed_at" in proposal, false);
  assert.equal("accepted_by" in proposal, false);
});


test("Workflow Pack plans use only generic goal and criterion bindings", () => {
  const contract = goalContract();
  const plan = buildWorkflowExecutionPlan({
    packId: "repo-quality-copilot",
    goal: contract.statement,
    projectId: "project-goal",
    goalContract: contract
  });

  assert.equal(plan.goal_id, contract.goal_id);
  assert.equal(plan.goal_revision, contract.revision);
  assert.ok(plan.subtasks.every((subtask) => Array.isArray(subtask.criterion_ids)));
  assert.equal("scenario" in plan, false);
  assert.equal("simulation" in plan, false);
});


test("evidence envelopes expose claims but never assign trusted goal verdicts", () => {
  const contract = goalContract();
  const evidence = buildEvidenceEnvelope({
    spec: { id: "goal-evidence", runtime_policy: {} },
    run: { run_id: "run-goal", status: "completed" },
    goalContract: contract,
    actions: [{
      id: "quality",
      adapter: "quality_gate_evaluation",
      status: "passed",
      criterion_ids: ["criterion-tests"],
      result: { verified: true, passed: true, verdict: "trusted" }
    }]
  });

  assert.equal(evidence.goal_claims.goal_id, contract.goal_id);
  assert.equal(evidence.goal_claims.goal_revision, 4);
  assert.deepEqual(evidence.goal_claims.criterion_claims[0].criterion_ids, ["criterion-tests"]);
  assert.equal("verified" in evidence.goal_claims, false);
  assert.equal("passed" in evidence.goal_claims, false);
  assert.equal("verdict" in evidence.goal_claims, false);
  assert.equal("trusted" in evidence.goal_claims.criterion_claims[0], false);
});


test("candidate planning and promotion reports preserve goal bindings without self-approval", () => {
  const contract = goalContract();
  const plan = buildCandidatePlan({ goal: contract.statement, goalContract: contract });
  assert.equal(plan.goal_id, contract.goal_id);
  assert.equal(plan.goal_revision, contract.revision);
  const candidate = createCandidate({ goal: contract.statement, goalContract: contract, candidateId: "candidate-goal" });
  const report = buildPromotionReport(candidate);
  assert.equal(report.goal_id, contract.goal_id);
  assert.equal(report.goal_revision, contract.revision);
  assert.equal(report.safety.candidate_cannot_self_approve, true);
  assert.equal(report.safety.auto_release_allowed, false);
});
