import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildEvidenceEnvelope } from "../src/evidence.js";
import { buildGoalChangeProposal } from "../src/goal-proposals.js";
import { AutopilotSupervisor } from "../src/supervisor.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { buildWorkflowExecutionPlan, buildWorkflowWorkerJobPlan } from "../src/workflow-packs.js";
import { buildCandidatePlan, buildPromotionReport, createCandidate } from "../src/candidates.js";
import { RunStore } from "../src/run-store.js";


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

function verifiedTask(binding, overrides = {}) {
  const receipt = {
    schema_version: "across-worker-evidence/1.0", ...binding,
    job_id: "job-goal", run_id: "run-goal", lease_id: "lease-goal", attempt: 1,
    terminal_state: "completed", artifacts: [], required_evidence: ["test_suite"]
  };
  const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  receipt.receipt_hash = createHash("sha256").update(JSON.stringify(sort(receipt))).digest("hex");
  return {
    task_id: binding.task_id, status: "completed", quality_status: "passed", evidence_receipt: receipt,
    goal_evidence_binding: {
      ...binding, job_id: receipt.job_id, run_id: receipt.run_id, lease_id: receipt.lease_id,
      attempt: receipt.attempt, receipt_hash: receipt.receipt_hash,
      trust_state: "verified", lease_state: "terminal_valid",
      authority: "across-orchestrator-worker-coordinator"
    },
    ...overrides
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
  assert.deepEqual(plan.subtasks[0].criterion_ids.sort(), ["criterion-tests"]);
  assert.ok(plan.host_decisions.some((decision) => decision.criterion_ids.includes("criterion-review")));
  assert.equal("scenario" in plan, false);
  assert.equal("simulation" in plan, false);
});


test("Worker Job plans bind executable criteria before dispatch", () => {
  const contract = goalContract();
  const plan = buildWorkflowWorkerJobPlan({
    packId: "scenario-simulation",
    goal: contract.statement,
    projectId: "project-worker-goal",
    goalContract: contract,
    liveModel: false
  });
  assert.equal(plan.manifest.task_id, contract.task_id);
  assert.equal(plan.manifest.goal_id, contract.goal_id);
  assert.equal(plan.manifest.goal_revision, contract.revision);
  assert.deepEqual(plan.manifest.criterion_ids.sort(), ["criterion-tests"]);
  assert.deepEqual(plan.manifest.required_evidence, ["test_suite"]);
  assert.equal(plan.manifest.criterion_ids.includes("criterion-review"), false);
  assert.ok(plan.host_decisions.some((decision) => decision.criterion_ids.includes("criterion-review")));
});


test("Goal hashes reject fractional and non-finite numbers consistently", async () => {
  const { stableGoalHash } = await import("../src/goal-contract.js");
  assert.throws(() => stableGoalHash({ value: 1e-7 }), /integer/);
  assert.throws(() => stableGoalHash({ value: Number.NaN }), /integer/);
  assert.equal(stableGoalHash({ value: 1.0 }), stableGoalHash({ value: 1 }));
  assert.equal(stableGoalHash({ value: -0 }), stableGoalHash({ value: 0 }));
});


test("Orchestrator dispatch receives and verifies the immutable Goal binding", async () => {
  let dispatched = null;
  const binding = Object.freeze({
    goal_id: "goal-task-001",
    goal_revision: 4,
    task_id: "task-001",
    criterion_ids: Object.freeze(["criterion-tests"]),
    input_fingerprint: "a".repeat(64)
  });
  const orchestratorClient = {
      async runLoopTask(payload) {
        dispatched = payload;
        return verifiedTask(binding);
      }
  };
  const registry = new AdapterRegistry({ orchestratorClient });
  const action = await registry.getAction("orchestrator_task_dispatch").run({
    spec: { id: "goal-dispatch" },
    run: { run_id: "run-goal-dispatch" },
    goalBinding: binding,
    orchestratorClient
  });
  assert.deepEqual(dispatched.goalBinding, binding);
  assert.equal(action.status, "passed");

  const badOrchestratorClient = {
      async runLoopTask() {
        return verifiedTask({ ...binding, goal_revision: 3 });
      }
  };
  const badRegistry = new AdapterRegistry({ orchestratorClient: badOrchestratorClient });
  await assert.rejects(
    () => badRegistry.getAction("orchestrator_task_dispatch").run({
      spec: { id: "goal-dispatch" }, run: { run_id: "run-bad" }, goalBinding: binding,
      orchestratorClient: badOrchestratorClient
    }),
    /Goal binding mismatch/
  );
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


test("installed-style CLI Goal Contract probe returns the shared binding", () => {
  const contract = goalContract();
  const payload = JSON.parse(execFileSync(process.execPath, [
    "src/cli.js",
    "goal-contract",
    "--contract-json",
    JSON.stringify(contract),
    "--json"
  ], { encoding: "utf8" }));
  assert.equal(payload.goal_id, contract.goal_id);
  assert.equal(payload.goal_revision, contract.revision);
  assert.deepEqual(payload.criterion_ids, contract.acceptance_criteria.map((item) => item.criterion_id).sort());
  assert.match(payload.evidence_hash, /^[a-f0-9]{64}$/);
});


test("public CLI and async paths preserve the governed Goal Contract", async () => {
  const contract = goalContract();
  const cliPlan = JSON.parse(execFileSync(process.execPath, [
    "src/cli.js",
    "workflow-pack",
    "worker-job-plan",
    "--pack",
    "scenario-simulation",
    "--goal",
    contract.statement,
    "--live-model",
    "false",
    "--goal-contract-json",
    JSON.stringify(contract),
    "--json"
  ], { encoding: "utf8" }));
  assert.equal(cliPlan.manifest.goal_id, contract.goal_id);
  assert.deepEqual(cliPlan.manifest.criterion_ids.sort(), ["criterion-tests"]);

  const home = await mkdtemp(join(tmpdir(), "across-autopilot-goal-async-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({ store });
  const task = await supervisor.startAsyncTask("repo-quality-copilot", {
    goalContract: contract,
    spawn: false
  });
  const persisted = await store.loadRun(task.run_id);
  assert.deepEqual(persisted.goal_contract, contract);
});
