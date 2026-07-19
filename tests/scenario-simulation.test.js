import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadLoopSpec, validateLoopSpec } from "../src/loop-spec.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import {
  buildScenarioJobManifest,
  createModelGrantGatewayCall,
  normalizeScenarioInput,
  planScenarioInputFromGoal,
  runScenarioSimulation,
  writeScenarioArtifacts
} from "../src/scenario-simulation.js";
import {
  buildWorkflowExecutionPlan,
  buildWorkflowWorkerJobPlan,
  resolveWorkflowPackForGoal
} from "../src/workflow-packs.js";

function input(overrides = {}) {
  return {
    title: "Supply resilience",
    objective: "Compare bounded strategies.",
    roles: [
      { id: "supplier", label: "Supplier", initial_score: 5, volatility: 1.2, cooperation_weight: 0.3, relationships: { buyer: 0.5 } },
      { id: "buyer", label: "Buyer", initial_score: 3, volatility: 0.8, cooperation_weight: 0.2, relationships: { supplier: 0.4 } }
    ],
    rounds: 8,
    seed: 42,
    assumptions: ["bounded demand"],
    input_sources: ["fixture://supply"],
    mode: "no-key",
    ...overrides
  };
}

test("SIM-001 Scenario Simulation is a valid built-in workflow and emits an editable plan", async () => {
  const spec = await loadLoopSpec("scenario-simulation");
  const validation = validateLoopSpec(spec, new AdapterRegistry());
  assert.equal(validation.valid, true);
  const plan = buildScenarioJobManifest({ runId: "run-sim-one", jobId: "job-sim-one", input: input() });
  assert.equal(plan.manifest.schema_version, "across-job-manifest/1.0");
  assert.deepEqual(plan.manifest.required_capabilities.agents, []);
  assert.equal(plan.input.mode, "no-key");
});

test("generic task intent resolves a workflow without exposing Scenario fields in the host task", () => {
  const goal = "请做一次世界模拟：参与者“小林”和“小周”因为纪念日晚餐临时取消发生争执，推演未来24小时，运行6轮并输出报告。";
  const resolution = resolveWorkflowPackForGoal(goal);
  assert.equal(resolution.selected_workflow.id, "scenario-simulation");
  assert.equal(resolution.selected_workflow.execution.route, "worker");
  assert.ok(resolution.selected_workflow.confidence >= 0.8);

  const ordinary = resolveWorkflowPackForGoal("整理这份会议记录并给出三个行动项");
  assert.equal(ordinary.selected_workflow, null);

  const inputPlan = planScenarioInputFromGoal(goal, { liveModel: true });
  assert.deepEqual(inputPlan.roles.map((role) => role.label), ["小林", "小周"]);
  assert.equal(inputPlan.rounds, 6);
  assert.equal(inputPlan.mode, "live-model");

  const workerPlan = buildWorkflowWorkerJobPlan({
    packId: resolution.selected_workflow.id,
    goal,
    projectId: "project-generic-entry",
    liveModel: true
  });
  assert.equal(workerPlan.schema_version, "across-workflow-worker-job-plan/1.0");
  assert.equal(workerPlan.execution_contract.generated_by, "across-autopilot");
  assert.equal(workerPlan.manifest.budgets.timeout_seconds, 750);
  assert.deepEqual(workerPlan.inputs["input.json"].roles.map((role) => role.label), ["小林", "小周"]);

  const executionPlan = buildWorkflowExecutionPlan({
    packId: resolution.selected_workflow.id,
    goal,
    projectId: "project-generic-entry",
    liveModel: true
  });
  assert.equal(executionPlan.schema_version, "across-workflow-execution-plan/1.0");
  assert.equal(executionPlan.execution_contract.route, "worker");
  assert.equal(executionPlan.adapter.type, "worker");
  assert.equal(executionPlan.worker_job_plan.schema_version, "across-workflow-worker-job-plan/1.0");
  assert.deepEqual(executionPlan.deliverables, executionPlan.worker_job_plan.expected_outputs);
});

test("the universal task entry recognizes the retired visible starter choices", () => {
  const cases = [
    ["检查代码仓库", "repo-quality-copilot"],
    ["检查代码质量", "repo-quality-copilot"],
    ["Review a repository", "repo-quality-copilot"],
    ["检查插件", "plugin-compatibility-lab-v2"],
    ["检查发布", "release-captain"]
  ];
  for (const [goal, expected] of cases) {
    assert.equal(resolveWorkflowPackForGoal(goal).selected_workflow?.id, expected, goal);
  }
  assert.equal(resolveWorkflowPackForGoal("把今天的讨论整理成简短摘要").selected_workflow, null);
});

test("SIM-002/003 no-key mode is deterministic and declares local-plan remote-run local-verify artifacts", async () => {
  const first = await runScenarioSimulation(input(), { runId: "run-sim", jobId: "job-sim" });
  const second = await runScenarioSimulation(input(), { runId: "run-sim", jobId: "job-sim" });
  assert.deepEqual(first.result.roles, second.result.roles);
  assert.deepEqual(first.result.metrics, second.result.metrics);
  assert.equal(first.result.timeline_hash, second.result.timeline_hash);
  assert.equal(first.modelUsage.calls, 0);
  const { manifest } = buildScenarioJobManifest({ runId: "run-sim", jobId: "job-sim", input: input() });
  assert.deepEqual(manifest.command_argv, ["across-scenario-simulation", "run"]);
  assert.ok(manifest.evidence_requirements.includes("node"));
  assert.ok(manifest.quality_gates.includes("artifact_hashes_match"));
});

test("SIM-004/005 live-model mode uses the grant-shaped callback and enforces budgets", async () => {
  const calls = [];
  const configured = input({ mode: "live-model", rounds: 3, model_policy: { policy: "host-default", max_calls: 2, max_tokens: 10, max_concurrency: 1, max_cost_usd: 1, timeout_seconds: 5 } });
  const result = await runScenarioSimulation(configured, {
    runId: "run-model",
    jobId: "job-model",
    modelCall: async (request) => {
      calls.push(request);
      return {
        annotation: JSON.stringify({
          summary: `Round ${request.round} stayed bounded.`,
          turning_point: request.round === 1 ? "escalation" : "de-escalation",
          role_states: [{ role: "supplier", emotion: "concerned", action: "asks for clarity" }],
          likely_next: "A repair attempt remains possible.",
          recommendation: "State the unmet need without blame."
        }),
        usage: { input_tokens: 2, output_tokens: 1, cost_usd: 0.1 }
      };
    }
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.run_id === "run-model" && call.job_id === "job-model" && call.purpose === "scenario_round_annotation"));
  assert.equal(result.modelUsage.calls, 2);
  assert.equal(result.result.narrative_timeline[0].turning_point, "escalation");
  assert.match(result.result.narrative_timeline[0].summary, /stayed bounded/);
  assert.equal(result.result.conclusion, "A repair attempt remains possible.");
  await assert.rejects(
    runScenarioSimulation(input({ mode: "live-model", rounds: 1, model_policy: { max_calls: 1, max_tokens: 1, max_concurrency: 1, max_cost_usd: 0, timeout_seconds: 5 } }), {
      modelCall: async () => ({ annotation: JSON.stringify({ summary: "bounded" }), usage: { input_tokens: 2, output_tokens: 2, cost_usd: 0 } })
    }),
    /budget exceeded/
  );
});

test("SIM-005 truncated fenced model JSON recovers completed narrative fields", async () => {
  const result = await runScenarioSimulation(input({
    mode: "live-model",
    rounds: 1,
    model_policy: { policy: "host-default", max_calls: 1, max_tokens: 2048, max_concurrency: 1, max_cost_usd: 1, timeout_seconds: 5 }
  }), {
    modelCall: async () => ({
      annotation: '```json {"summary":"双方暂停争执并约定稍后沟通。","turning_point":"de-escalation","role_states":[{"role":"supplier","emotion":"calm"',
      usage: { input_tokens: 3, output_tokens: 2 }
    })
  });
  assert.equal(result.result.narrative_timeline[0].summary, "双方暂停争执并约定稍后沟通。");
  assert.equal(result.result.narrative_timeline[0].turning_point, "de-escalation");
  assert.doesNotMatch(result.result.narrative_timeline[0].summary, /```|\"summary\"/);
});

test("SIM-004 live-model runtime calls only the task-bound host gateway without provider keys", async () => {
  let captured = null;
  const gateway = createModelGrantGatewayCall(
    {
      ACROSS_MODEL_GATEWAY_URL: "http://127.0.0.1:9191/api/worker-control/model-gateway/invoke",
      ACROSS_MODEL_GRANT_ID: "grant-test",
      ACROSS_RUN_ID: "run-model",
      ACROSS_JOB_ID: "job-model",
      ACROSS_NODE_ID: "node-remote",
      ACROSS_MODEL_MAX_TOKENS: "256",
      ACROSS_MODEL_TIMEOUT_SECONDS: "5"
    },
    async (_url, request) => {
      captured = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({
          text: JSON.stringify({ summary: "bounded annotation", turning_point: "stable", role_states: [], likely_next: "continue carefully", recommendation: "verify assumptions" }),
          provider: "host-provider",
          model: "host-model",
          provider_key_exposed: false,
          usage: { input_tokens: 3, output_tokens: 2 },
          grant_usage: { cost_usd: 0 }
        })
      };
    }
  );
  const response = await gateway({
    run_id: "run-model",
    job_id: "job-model",
    purpose: "scenario_round_annotation",
    round: 1,
    state: [{ role_id: "buyer", score: 4 }]
  });
  assert.match(response.annotation, /bounded annotation/);
  assert.equal(response.provider_key_exposed, false);
  assert.equal(captured.grant_id, "grant-test");
  assert.equal(captured.token_budget, 256);
  assert.equal(captured.max_tokens, 16);
  assert.equal(captured.timeout_seconds, 5);
  assert.equal("api_key" in captured, false);
  assert.equal("provider_key" in captured, false);
});

test("SIM-004 Worker Python runtime bypasses inherited proxies for its loopback grant gateway", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "across-scenario-python-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputDirectory = join(directory, "input");
  const outputDirectory = join(directory, "output");
  await mkdir(inputDirectory);
  await mkdir(outputDirectory);
  await writeFile(join(inputDirectory, "input.json"), JSON.stringify(input({
    mode: "live-model",
    rounds: 1,
    model_policy: { policy: "host-default", max_calls: 1, max_tokens: 256, max_concurrency: 1, max_cost_usd: 1, timeout_seconds: 5 }
  })));
  let received = null;
  const gateway = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const body = JSON.stringify({
        text: '```json {"summary":"The participants pause before responding.","turning_point":"de-escalation","likely_next":"A bounded repair attempt is likely.","recommendation":"Acknowledge impact before explaining intent.","role_states":[{"role":"supplier","emotion":"cautious"',
        provider_key_exposed: false,
        usage: { input_tokens: 3, output_tokens: 2 }
      });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = gateway.address().port;
  const result = await new Promise((resolve) => {
    const child = spawn("python3", ["src/scenario_simulation.py", "run"], {
      env: {
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        http_proxy: "http://127.0.0.1:1",
        https_proxy: "http://127.0.0.1:1",
        NO_PROXY: "",
        no_proxy: "",
        ACROSS_INPUT_DIR: inputDirectory,
        ACROSS_OUTPUT_DIR: outputDirectory,
        ACROSS_MODEL_GATEWAY_URL: `http://127.0.0.1:${port}/invoke`,
        ACROSS_MODEL_GRANT_ID: "grant-python-test",
        ACROSS_RUN_ID: "run-python-test",
        ACROSS_JOB_ID: "job-python-test",
        ACROSS_NODE_ID: "node-python-test",
        ACROSS_MODEL_MAX_TOKENS: "256",
        ACROSS_MODEL_TIMEOUT_SECONDS: "5",
        ACROSS_TRANSPORT: "direct"
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  await new Promise((resolve) => gateway.close(resolve));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(received.grant_id, "grant-python-test");
  assert.equal(JSON.parse(await readFile(join(outputDirectory, "model-usage.json"), "utf8")).calls, 1);
  const report = await readFile(join(outputDirectory, "report.md"), "utf8");
  assert.match(report, /The participants pause before responding/);
  assert.match(report, /Acknowledge impact before explaining intent/);
});

test("SIM-005 Worker Python runtime preserves a partially annotated run when one provider call fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "across-scenario-python-fallback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputDirectory = join(directory, "input");
  const outputDirectory = join(directory, "output");
  await mkdir(inputDirectory);
  await mkdir(outputDirectory);
  await writeFile(join(inputDirectory, "input.json"), JSON.stringify(input({
    mode: "live-model",
    rounds: 2,
    model_policy: { policy: "host-default", max_calls: 2, max_tokens: 512, max_concurrency: 1, max_cost_usd: 1, timeout_seconds: 5 }
  })));
  let callCount = 0;
  const gateway = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      callCount += 1;
      if (callCount === 2) {
        const body = JSON.stringify({ detail: { category: "provider" } });
        response.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      const body = JSON.stringify({
        text: JSON.stringify({ summary: "Round one used the host model.", turning_point: "stable" }),
        provider: "host-provider",
        model: "host-model",
        provider_key_exposed: false,
        usage: { input_tokens: 3, output_tokens: 2 }
      });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = gateway.address().port;
  const result = await new Promise((resolve) => {
    const child = spawn("python3", ["src/scenario_simulation.py", "run"], {
      env: {
        ...process.env,
        ACROSS_INPUT_DIR: inputDirectory,
        ACROSS_OUTPUT_DIR: outputDirectory,
        ACROSS_MODEL_GATEWAY_URL: `http://127.0.0.1:${port}/invoke`,
        ACROSS_MODEL_GRANT_ID: "grant-python-fallback",
        ACROSS_RUN_ID: "run-python-fallback",
        ACROSS_JOB_ID: "job-python-fallback",
        ACROSS_NODE_ID: "node-python-fallback",
        ACROSS_MODEL_MAX_TOKENS: "256",
        ACROSS_MODEL_TIMEOUT_SECONDS: "5",
        ACROSS_TRANSPORT: "direct"
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  await new Promise((resolve) => gateway.close(resolve));
  assert.equal(result.code, 0, result.stderr);
  const usage = JSON.parse(await readFile(join(outputDirectory, "model-usage.json"), "utf8"));
  assert.equal(usage.calls, 1);
  assert.equal(usage.failed_calls, 1);
  assert.equal(usage.degraded, true);
  assert.deepEqual(usage.fallback_rounds, [2]);
  const report = await readFile(join(outputDirectory, "report.md"), "utf8");
  assert.match(report, /Model status: degraded with deterministic fallback/);
  assert.match(report, /Model fallback rounds: 2/);
});

test("SIM-005 live-model mode discloses a partial provider fallback without losing the task", async () => {
  const result = await runScenarioSimulation(input({
    mode: "live-model",
    rounds: 2,
    model_policy: { policy: "host-default", max_calls: 2, max_tokens: 1024, max_concurrency: 1, max_cost_usd: 1, timeout_seconds: 5 }
  }), {
    modelCall: async ({ round }) => round === 1
      ? { annotation: JSON.stringify({ summary: "Round one used the host model.", turning_point: "stable" }), usage: { input_tokens: 3, output_tokens: 2 } }
      : { annotation: "", usage: { input_tokens: 3, output_tokens: 2 } }
  });
  assert.equal(result.result.status, "completed");
  assert.equal(result.modelUsage.calls, 1);
  assert.equal(result.modelUsage.failed_calls, 1);
  assert.equal(result.modelUsage.degraded, true);
  assert.deepEqual(result.modelUsage.fallback_rounds, [2]);
  assert.equal(result.result.narrative_timeline[1].summary.startsWith("Round 2:"), true);

  await assert.rejects(
    runScenarioSimulation(input({
      mode: "live-model",
      rounds: 1,
      model_policy: { policy: "host-default", max_calls: 1, max_tokens: 512, max_concurrency: 1, max_cost_usd: 1, timeout_seconds: 5 }
    }), {
      modelCall: async () => ({ annotation: "", usage: { input_tokens: 3, output_tokens: 2 } })
    }),
    /unavailable for every planned annotation/
  );
});

test("SIM-006 cancellation stops between rounds without producing an optimistic result", async () => {
  const controller = new AbortController();
  await assert.rejects(
    runScenarioSimulation(input({ rounds: 20 }), {
      signal: controller.signal,
      onRound: async ({ round }) => { if (round === 2) controller.abort(); }
    }),
    (error) => error.code === "SCENARIO_CANCELLED"
  );
});

test("SIM-007 temporary Worker loss uses bounded retry and preserves the same durable Job", () => {
  const { manifest } = buildScenarioJobManifest({
    runId: "run-recovery",
    jobId: "job-recovery",
    input: input()
  });
  assert.deepEqual(manifest.retry_policy, {
    max_attempts: 2,
    retry_safe: true,
    external_side_effects: false
  });
  assert.equal(manifest.idempotency_key, "run-recovery:job-recovery");
  assert.equal(manifest.cancellation_policy.cleanup_on_cancel, true);
});

test("SIM-008/009 artifacts are complete, truthful, and hash-verifiable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "across-scenario-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = buildScenarioJobManifest({ runId: "run-artifacts", jobId: "job-artifacts", input: input() });
  const execution = await runScenarioSimulation(plan.input, { runId: "run-artifacts", jobId: "job-artifacts" });
  await writeScenarioArtifacts({
    directory,
    manifest: plan.manifest,
    execution,
    node: { node_id: "node-remote", display_name: "Remote Worker", platform: "linux/arm64", worker_version: "0.10.0" },
    transport: "relay",
    cleanupStatus: "complete"
  });
  const names = (await readdir(directory)).sort();
  assert.deepEqual(names, ["artifact-manifest.json", "evidence.json", "job-manifest.json", "model-usage.json", "report.md", "result.json"]);
  const artifactManifest = JSON.parse(await readFile(join(directory, "artifact-manifest.json"), "utf8"));
  for (const artifact of artifactManifest.artifacts) {
    const body = await readFile(join(directory, artifact.logical_name));
    assert.equal(body.length, artifact.size);
    assert.equal(createHash("sha256").update(body).digest("hex"), artifact.sha256);
  }
  const report = await readFile(join(directory, "report.md"), "utf8");
  assert.match(report, /not a prediction of the real world/);
  assert.match(report, /Execution location: Remote Worker/);
  assert.match(report, /Transport: relay/);
  assert.match(report, /Cleanup: complete/);
});

test("SIM-010/011 result contract has one verdict and repeat runs keep independent identities", async () => {
  const firstPlan = buildScenarioJobManifest({ runId: "run-repeat-one", input: input() });
  const secondPlan = buildScenarioJobManifest({ runId: "run-repeat-two", input: input() });
  assert.notEqual(firstPlan.manifest.job_id, secondPlan.manifest.job_id);
  assert.notEqual(firstPlan.manifest.idempotency_key, secondPlan.manifest.idempotency_key);
  const result = await runScenarioSimulation(input(), { runId: "run-repeat-one", jobId: firstPlan.manifest.job_id });
  assert.equal(result.result.status, "completed");
  assert.equal(Object.keys(result.result).filter((key) => key === "status").length, 1);
});

test("SIM-012 remote intermediates declare zero retention and worker-managed dry-run cleanup", () => {
  const { manifest } = buildScenarioJobManifest({
    runId: "run-cleanup",
    jobId: "job-cleanup",
    input: input()
  });
  assert.deepEqual(manifest.cleanup_policy, {
    retention_seconds: 0,
    dry_run_required: true
  });
  assert.ok(manifest.evidence_requirements.includes("cleanup_status"));
});

test("scenario input validation prevents unbounded work and unsafe implicit model use", () => {
  assert.throws(() => normalizeScenarioInput(input({ rounds: 10001 })), /rounds/);
  assert.throws(() => normalizeScenarioInput(input({ roles: [{ id: "only" }] })), /between 2 and 64/);
  const noKey = normalizeScenarioInput(input({ model_policy: { max_calls: 99 } }));
  assert.equal(noKey.model_policy.max_calls, 0);
  assert.equal(noKey.model_policy.enabled, false);
});
