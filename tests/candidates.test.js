import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidatePlan, buildPromotionReport, createCandidate, evaluateCandidate } from "../src/candidates.js";
import { defaultState } from "../src/state.js";
import { AUTOPILOT_VERSION } from "../src/version.js";

test("default state stable slot uses package version", () => {
  const stableSlot = defaultState(new Date("2026-06-19T00:00:00Z")).stable_slot;

  assert.equal(stableSlot.version, AUTOPILOT_VERSION);
});

test("candidate plan delegates execution to Orchestrator and memory to Context", () => {
  const plan = buildCandidatePlan({
    goal: "Add Autopilot read-only radar",
    targetProduct: "across-autopilot"
  });

  assert.equal(plan.schema_version, "across-autopilot-candidate-plan/1.0");
  assert.equal(plan.execution.engine, "across-orchestrator");
  assert.equal(plan.execution.isolated_workspace_required, true);
  assert.equal(plan.memory_policy.provider, "across-context");
  assert.equal(plan.promotion_policy.stable_controls_promotion, true);
  assert.ok(plan.validation_gates.includes("e2e"));
});

test("promotion report blocks missing required gates and allows complete evidence", () => {
  const candidate = createCandidate({
    goal: "Improve docs",
    targetProduct: "across-agents-assistant",
    targetVersion: "0.9.0",
    now: new Date("2026-06-20T00:00:00Z")
  });
  const partial = evaluateCandidate(candidate, [{ id: "unit_tests", status: "passed" }]);

  assert.equal(partial.promotion.readiness, "attention");
  assert.ok(partial.promotion.required_missing.includes("e2e"));

  const complete = evaluateCandidate(candidate, [
    { id: "unit_tests", status: "passed" },
    { id: "integration_tests", status: "passed" },
    { id: "e2e", status: "passed" },
    { id: "release_evidence", status: "passed" }
  ]);
  const stableSlot = defaultState(new Date("2026-06-19T00:00:00Z")).stable_slot;
  const report = buildPromotionReport(complete, stableSlot);

  assert.equal(report.readiness, "ready");
  assert.equal(report.rollback_target, stableSlot.version);
  assert.equal(report.safety.candidate_cannot_self_approve, true);
  assert.equal(report.safety.auto_release_allowed, false);
});
