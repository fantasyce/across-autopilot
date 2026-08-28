import test from "node:test";
import assert from "node:assert/strict";
import {
  criterionId,
  normalizeGoalChangeProposal,
  normalizeGoalContract,
  stableGoalHash
} from "../src/goal-contract.js";


function simpleGoalContract() {
  return {
    schema_version: "across-goal-contract/1.0",
    goal_id: "goal-task-001",
    revision: 1,
    task_id: "task-001",
    statement: "Ship a verifiable change",
    success_outcome: "The user can verify the change.",
    scope: { includes: ["implementation", "tests"], excludes: ["release", "promotion"] },
    acceptance_criteria: [
      {
        criterion_id: "criterion-36bc8486dd50ddc0",
        description: "All required tests pass.",
        required: true,
        validator_kind: "test_suite",
        review_policy: "automatic",
        source: "user_confirmed"
      },
      {
        criterion_id: "criterion-5691b86a398c721e",
        description: "Installed application exposes the result.",
        required: true,
        validator_kind: "installed_user_journey",
        review_policy: "human",
        source: "user_confirmed"
      }
    ],
    dependencies: [],
    execution_profile: "orchestrated",
    source: "user",
    confirmed_by: "human:user",
    confirmed_at: "2026-08-28T00:00:00Z",
    created_at: "2026-08-28T00:00:00Z"
  };
}


test("goal contract normalization is byte-compatible with the host fixture", () => {
  const fixture = simpleGoalContract();
  assert.deepEqual(normalizeGoalContract(fixture), fixture);
  assert.equal(criterionId("All required tests pass.", "test_suite"), "criterion-36bc8486dd50ddc0");
  assert.equal(stableGoalHash(fixture), "2d6996c43ab0104c3b94f87a2b6030d2d6bab0df1fca777bebba894b21fe83a8");
});


test("goal contract validation rejects stale schemas, zero revisions, and duplicate criteria", () => {
  const mutations = [
    (value) => { value.schema_version = "across-goal-contract/2.0"; },
    (value) => { value.revision = 0; },
    (value) => { delete value.statement; },
    (value) => { value.acceptance_criteria.push({ ...value.acceptance_criteria[0] }); }
  ];
  for (const mutate of mutations) {
    const fixture = simpleGoalContract();
    mutate(fixture);
    assert.throws(() => normalizeGoalContract(fixture));
  }
});


test("autopilot proposals cannot perform management operations", () => {
  const proposal = {
    schema_version: "across-goal-change-proposal/1.0",
    proposal_id: "proposal-1",
    goal_id: "goal-task-001",
    base_goal_revision: 1,
    proposed_by: "autopilot",
    reason: "Add review coverage.",
    operations: [{ op: "confirm", path: "/confirmed_by", value: "autopilot" }],
    impact_summary: { goal_ids: ["goal-task-001"], criterion_ids: [], evidence_ids: [], requires_revalidation: true },
    risk_summary: { level: "medium", reasons: ["scope_change"] },
    estimated_cost: { unit: "agent_turns", value: 1 },
    alternatives: [],
    decision_state: "pending",
    created_at: "2026-08-28T00:05:00Z"
  };

  assert.throws(() => normalizeGoalChangeProposal(proposal), /operation/);
});
