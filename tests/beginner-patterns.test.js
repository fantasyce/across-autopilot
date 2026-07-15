import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildNoKeyDemo,
  getBeginnerWorkflowPattern,
  listBeginnerWorkflowPatterns,
  renderNoKeyDemoResult
} from "../src/beginner-patterns.js";
import { loadLoopSpec, normalizeRuntimePolicy } from "../src/loop-spec.js";

test("all built-in beginner patterns and their real LoopSpecs are no-key, read-only, and valid", async () => {
  const registry = listBeginnerWorkflowPatterns();
  assert.equal(registry.schema_version, "across-beginner-workflow-pattern-registry/1.0");
  assert.equal(registry.status, "ready");
  assert.equal(registry.patterns.length, 3);
  for (const pattern of registry.patterns) {
    assert.equal(pattern.valid, true, JSON.stringify(pattern.errors));
    assert.equal(pattern.safe_defaults.network_policy, "none");
    assert.equal(pattern.safe_defaults.filesystem_policy, "read_only");
    assert.equal(pattern.safe_defaults.max_model_calls, 0);
    assert.equal(pattern.safe_defaults.external_side_effects_blocked, true);
    assert.deepEqual(
      pattern.input_contract.questions.map((question) => question.id),
      ["goal", "project_folder"]
    );
    const spec = await loadLoopSpec(pattern.loop_spec_id);
    const policy = normalizeRuntimePolicy(spec);
    assert.equal(policy.network_policy.mode, "none");
    assert.equal(policy.filesystem_policy.mode, "read_only");
    assert.equal(policy.budget.max_model_calls, 0);
    assert.equal(policy.budget.max_candidate_repairs, 0);
    assert.equal(policy.promotion.human_approval_required, true);
    assert.equal(policy.promotion.merge_release_signing_blocked, true);
  }
});

test("no-key demo contract is deterministic and contains no credential requirement", () => {
  const first = buildNoKeyDemo();
  const second = buildNoKeyDemo("first-verified-task");
  assert.deepEqual(first, second);
  assert.equal(first.schema_version, "across-no-key-demo/1.0");
  assert.equal(first.requirements.provider_key, false);
  assert.equal(first.requirements.goal, true);
  assert.equal(first.requirements.network, false);
  assert.equal(first.requirements.model_calls, 0);
  assert.equal(first.requirements.external_side_effects, false);
  assert.equal(first.contract_sha256.length, 64);
});

test("fresh-profile CLI runs every beginner mission without provider keys", async () => {
  const project = await mkdtemp(join(tmpdir(), "across-no-key-demo-project-"));
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "beginner-demo", version: "1.0.0", license: "MIT" }));
  await writeFile(join(project, "LICENSE"), "MIT License\n");
  await writeFile(join(project, "README.md"), "# Beginner demo\n");
  const root = new URL("..", import.meta.url).pathname;
  const contextCli = join(project, "context-fixture.mjs");
  await writeFile(contextCli, `
const command = process.argv[2];
if (command === "recall-loop") {
  console.log(JSON.stringify({
    schema_version: "across-context-recall/1.0",
    provider: "across-context",
    result_count: 0,
    results: []
  }));
} else if (command === "remember-loop") {
  console.log(JSON.stringify({
    schema_version: "across-context-loop-memory/1.0",
    status: "accepted_pending",
    memory_id: "mem-fixture"
  }));
} else {
  console.error("unsupported context fixture command");
  process.exitCode = 64;
}
`);
  for (const pattern of listBeginnerWorkflowPatterns().patterns) {
    const home = await mkdtemp(join(tmpdir(), `across-no-key-${pattern.id}-`));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      ACROSS_HOME: join(home, ".across"),
      ACROSS_AUTOPILOT_HOME: join(home, ".across", "data", "across-autopilot"),
      ACROSS_CONTEXT_HOME: join(home, ".across", "plugins", "across-context"),
      ACROSS_CONTEXT_COMMAND: JSON.stringify([process.execPath, contextCli])
    };
    const goal = `Understand ${pattern.id} safely`;
    const run = spawnSync(
      process.execPath,
      [join(root, "src", "cli.js"), "beginner-pattern", "run", "--pattern", pattern.id, "--goal", goal, "--json"],
      { cwd: project, env, encoding: "utf8" }
    );
    assert.equal(run.status, 0, `${pattern.id}: ${run.stderr}`);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.schema_version, "across-no-key-demo-result/1.0");
    assert.equal(payload.pattern_id, pattern.id);
    assert.equal(payload.status, "completed");
    assert.ok(["verified", "needs_attention"].includes(payload.verdict));
    assert.match(payload.evidence_route, /^run:\/\/[A-Za-z0-9._:-]+\/evidence$/);
    assert.equal(payload.policy.provider_key_used, false);
    assert.equal(payload.policy.network_used, false);
    assert.equal(payload.policy.model_calls, 0);
    assert.equal(payload.policy.external_side_effects_performed, false);
    assert.equal(payload.evidence_sha256.length, 64);
    assert.equal(payload.goal_sha256, createHash("sha256").update(goal).digest("hex"));
    assert.ok(["inspect_evidence", "resolve_first_blocker"].includes(payload.next_action_id));
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(goal, "i"));
  }
});

test("result projection stays compact and does not expose local paths", () => {
  getBeginnerWorkflowPattern("first-verified-task");
  const result = renderNoKeyDemoResult("first-verified-task", {
    run: { run_id: "run-1", status: "completed", sandbox: "/Users/example/private" },
    evidence: {
      status: "completed",
      gates: [{ id: "manifest_readable", status: "passed", required: true, detail: "/Users/example/private" }],
      runtime_budget: { usage: { model_calls: 0 } },
      integrity: { root_hash: "a".repeat(64) }
    }
  }, { goal: "Inspect my private project safely" });
  assert.doesNotMatch(JSON.stringify(result), /\/Users\/example/);
  assert.equal(result.evidence_route, "run://run-1/evidence");
  assert.equal(result.next_action_id, "inspect_evidence");
  assert.match(result.goal_sha256, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /Inspect my private project safely/);
  assert.deepEqual(result.gates, [{ id: "manifest_readable", status: "passed", required: true }]);
});

test("goal binding trims only the boundary and preserves the user's internal wording", () => {
  const goal = "  inspect   the project\nwithout changing it  ";
  const result = renderNoKeyDemoResult("first-verified-task", {
    run: { run_id: "run-goal-whitespace", status: "completed" },
    evidence: {
      status: "completed",
      gates: [],
      runtime_budget: { usage: { model_calls: 0 } },
      integrity: { root_hash: "a".repeat(64) }
    }
  }, { goal });
  assert.equal(
    result.goal_sha256,
    createHash("sha256").update(goal.trim()).digest("hex")
  );
  assert.doesNotMatch(JSON.stringify(result), /inspect   the project/);
});
