import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { commandAvailable, resolveCommand, runJsonCommand, sanitizedSubprocessEnv } from "../src/process-client.js";
import { ContextClient } from "../src/context-client.js";
import { OrchestratorClient } from "../src/orchestrator-client.js";
import { AutopilotSupervisor } from "../src/supervisor.js";
import { AUTOPILOT_VERSION } from "../src/version.js";
import {
  BUILT_IN_WORKFLOW_PACKS,
  renderWorkflowPackHostExports,
  validateWorkflowPack
} from "../src/workflow-packs.js";

const exec = promisify(execFile);
const cli = join(process.cwd(), "src", "cli.js");

test("runtime capability preflight reflects real managed plugin availability", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-boundary-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const missingContext = join(home, "missing-context");
  const missingOrchestrator = join(home, "missing-orchestrator");
  const env = { ...process.env, ACROSS_HOME: home, PATH: "" };
  const contextClient = new ContextClient({ command: [missingContext], env });
  const orchestratorClient = new OrchestratorClient({ command: [missingOrchestrator], env });
  const supervisor = new AutopilotSupervisor({ contextClient, orchestratorClient, env });

  assert.equal(commandAvailable([missingContext], ["across-context"], env), false);
  assert.equal(contextClient.available(), false);
  assert.equal(orchestratorClient.available(), false);

  const required = supervisor.capabilityPreflight({
    id: "required-plugin-check",
    required_capabilities: ["memory.pending_summary", "action.orchestrator_task_dispatch"]
  });
  assert.equal(required.status, "failed");
  assert.deepEqual(required.missing_capabilities.sort(), [
    "action.orchestrator_task_dispatch",
    "memory.pending_summary"
  ]);

  const standalone = supervisor.capabilityPreflight({
    id: "standalone-check",
    required_capabilities: ["source.directory", "action.manifest_inspection", "output.markdown_report"]
  });
  assert.equal(standalone.status, "passed");
});

test("repo-quality workflow pack remains exportable and valid without Context", async () => {
  const pack = BUILT_IN_WORKFLOW_PACKS["repo-quality-copilot"];
  const loopSpec = JSON.parse(await readFile(join(process.cwd(), "examples", "repo-quality-copilot.loop.json"), "utf8"));
  const registryWithoutContext = {
    capabilities: () => ({
      sources: ["source.directory"],
      actions: [
        "action.manifest_inspection",
        "action.dependency_risk_check",
        "action.license_check",
        "action.quality_gate_evaluation"
      ],
      outputs: ["output.markdown_report"],
      runtime: [],
      tool_packs: []
    })
  };

  const validation = validateWorkflowPack(pack, { registry: registryWithoutContext, throwOnError: false });
  const exported = renderWorkflowPackHostExports(pack, { registry: registryWithoutContext });

  assert.equal(pack.required_capabilities.includes("memory.pending_summary"), false);
  assert.equal(Object.hasOwn(loopSpec.compatibility, "required_context"), false);
  assert.equal(loopSpec.memory.required, false);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.missing_capabilities, []);
  assert.equal(exported.status, "passed");
  assert.deepEqual(exported.missing_capabilities, []);
});

test("OrchestratorClient uses the AAA private host socket when available", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-host-socket-"));
  const socketPath = join(home, "aaa.sock");
  const requests = [];
  const hostRequest = async (_socketPath, method, path) => {
    requests.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/orchestrator/loops") {
      return { loop_id: "loop-host-1", status: "pending" };
    }
    if (method === "POST" && path === "/api/orchestrator/loops/loop-host-1/run") {
      return { loop_id: "loop-host-1", status: "completed", metadata: { autopilot: { run_id: "run-host-1" } } };
    }
    if (path === "/api/orchestrator/loops/loop-host-1/evidence-summary") {
      return { status: "passed", quality_status: "passed" };
    }
    if (path === "/api/orchestrator/loops/loop-host-1/events") return [{ sequence: 1 }];
    return { loop_id: "loop-host-1", status: "completed", metadata: { autopilot: { run_id: "run-host-1" } } };
  };

  const client = new OrchestratorClient({
    command: [join(home, "must-not-run")],
    env: {
      ACROSS_AAA_CANDIDATE_MODEL_LEASE_JSON: JSON.stringify({ host_socket: socketPath })
    },
    hostRequest,
    hostSocketExists: () => true
  });
  const result = await client.runLoopTask({
    spec: {
      id: "host-socket-check",
      name: "Host socket check",
      description: "Verify host-brokered orchestration.",
      schema_version: "across-loop-spec/1.0",
      execute: { max_turns: 2 },
      evidence_contract: { schema_version: "across-evidence/1.0" }
    },
    run: { run_id: "run-host-1", sandbox: home }
  });

  assert.equal(result.loop_id, "loop-host-1");
  assert.equal(result.quality_status, "passed");
  assert.equal(result.metadata_reflected, true);
  assert.equal(result.event_count, 1);
  assert.deepEqual(requests, [
    "POST /api/orchestrator/loops",
    "POST /api/orchestrator/loops/loop-host-1/run",
    "GET /api/orchestrator/loops/loop-host-1",
    "GET /api/orchestrator/loops/loop-host-1/evidence-summary",
    "GET /api/orchestrator/loops/loop-host-1/events"
  ]);
});

test("plugin manifest exposes Autopilot host contract", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-manifest-"));
  const { stdout } = await exec("node", [cli, "plugin-manifest", "--json", "--across-home", acrossHome]);
  const manifest = JSON.parse(stdout);

  assert.equal(manifest.id, "across-autopilot");
  assert.equal(manifest.kind, "autonomous-workflow");
  assert.equal(manifest.version, AUTOPILOT_VERSION);
  assert.equal(manifest.capabilities.stableCandidatePromotion, true);
  assert.equal(manifest.integrations.executionEngine, "across-orchestrator");
  assert.equal(manifest.integrations.memoryProvider, "across-context");
  assert.equal(manifest.compatibility.requiredHostVersion, ">=0.9.0");
  assert.equal(manifest.paths.data, join(acrossHome, "data", "across-autopilot"));
});

test("runJsonCommand refreshes idle timeout while command is active", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-active-timeout-"));
  const command = join(home, "active-command.js");
  await writeFile(command, `#!/usr/bin/env node
let count = 0;
const timer = setInterval(() => {
  count += 1;
  process.stderr.write(JSON.stringify({ event: "heartbeat", count }) + "\\n");
  if (count === 4) {
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ status: "passed", count }));
  }
}, 250);
`, "utf8");
  await chmod(command, 0o755);

  const result = await runJsonCommand(["node", command], [], {
    idleTimeoutMs: 750,
    maxWallTimeoutMs: 3000
  });

  assert.equal(result.status, "passed");
  assert.equal(result.count, 4);
});

test("runJsonCommand refreshes wall timeout while command is active", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-active-wall-timeout-"));
  const command = join(home, "active-wall-command.js");
  await writeFile(command, `#!/usr/bin/env node
let count = 0;
const timer = setInterval(() => {
  count += 1;
  process.stderr.write(JSON.stringify({ event: "heartbeat", count }) + "\\n");
  if (count === 4) {
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ status: "passed", count }));
  }
}, 250);
`, "utf8");
  await chmod(command, 0o755);

  const result = await runJsonCommand(["node", command], [], {
    idleTimeoutMs: 1500,
    maxWallTimeoutMs: 750
  });

  assert.equal(result.status, "passed");
  assert.equal(result.count, 4);
});

test("runJsonCommand kills silent commands on idle timeout", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-idle-timeout-"));
  const command = join(home, "silent-command.js");
  await writeFile(command, `#!/usr/bin/env node
setTimeout(() => process.stdout.write(JSON.stringify({ status: "passed" })), 1200);
`, "utf8");
  await chmod(command, 0o755);

  await assert.rejects(
    () => runJsonCommand(["node", command], [], {
      idleTimeoutMs: 500,
      maxWallTimeoutMs: 3000
    }),
    (error) => error.code === "adapter.timeout" && error.timeout_kind === "idle_timeout"
  );
});

test("AAA self-iteration specs use locally validated Codex model candidates", async () => {
  const specNames = [
    "aaa-autonomous-self-iteration.loop.json",
    "aaa-platform-self-repair.loop.json",
    "aaa-research-driven-self-iteration.loop.json",
    "aaa-self-iteration-product.loop.json"
  ];
  const supported = new Set(["codex", "gpt-5.5"]);
  const unsupported = new Set(["gpt-5", "gpt-5-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"]);

  for (const name of specNames) {
    const spec = JSON.parse(await readFile(join(process.cwd(), "examples", name), "utf8"));
    const policies = [
      spec.model_policy,
      spec.pack_config?.model_policy,
      spec.pack_config?.research_model_policy,
      spec.pack_config?.builder_model_policy,
      spec.pack_config?.reviewer_model_policy
    ].filter(Boolean);
    for (const policy of policies) {
      if (policy.agent_id !== "codex") continue;
      const models = [policy.model, ...(policy.fallback_models || [])].filter(Boolean);
      assert.ok(models.length > 0, `${name} must declare Codex model candidates`);
      assert.ok(policy.idle_timeout_ms > 0, `${name} must declare idle_timeout_ms`);
      assert.ok(policy.max_wall_timeout_ms > 0, `${name} must declare max_wall_timeout_ms`);
      for (const model of models) {
        assert.equal(unsupported.has(model), false, `${name} contains unsupported model ${model}`);
        assert.equal(supported.has(model), true, `${name} contains unknown Codex model ${model}`);
      }
    }
  }
});

test("AAA self-iteration specs do not use codex-auto-review as a model candidate", async () => {
  const specNames = [
    "aaa-autonomous-self-iteration.loop.json",
    "aaa-platform-self-repair.loop.json",
    "aaa-research-driven-self-iteration.loop.json",
    "aaa-self-iteration-product.loop.json"
  ];

  for (const name of specNames) {
    const spec = JSON.parse(await readFile(join(process.cwd(), "examples", name), "utf8"));
    const policies = [
      spec.model_policy,
      spec.pack_config?.model_policy,
      spec.pack_config?.research_model_policy,
      spec.pack_config?.builder_model_policy,
      spec.pack_config?.reviewer_model_policy
    ].filter(Boolean);
    for (const policy of policies) {
      if (policy.agent_id !== "codex") continue;
      const models = [policy.model, ...(policy.fallback_models || [])].filter(Boolean);
      assert.equal(models.includes("codex-auto-review"), false, `${name} must not use codex-auto-review`);
    }
  }
});

test("AAA self-iteration specs allow long silent Codex code generation", async () => {
  const specNames = [
    "aaa-autonomous-self-iteration.loop.json",
    "aaa-research-driven-self-iteration.loop.json"
  ];

  for (const name of specNames) {
    const spec = JSON.parse(await readFile(join(process.cwd(), "examples", name), "utf8"));
    const timeouts = spec.runtime_policy?.timeouts || {};
    const codeIteration = spec.pack_config?.code_iteration || {};
    const builder = spec.pack_config?.builder_model_policy || spec.pack_config?.model_policy || {};
    const research = spec.pack_config?.research_model_policy || spec.pack_config?.model_policy || {};

    assert.ok(timeouts.total_run_timeout_ms >= 7_200_000, `${name} must budget complex self-iteration end to end`);
    assert.ok(codeIteration.idle_timeout_ms >= 900_000, `${name} code iteration idle timeout must allow silent Codex work`);
    assert.ok(codeIteration.max_wall_timeout_ms >= 2_400_000, `${name} code iteration needs a bounded wall-clock budget`);
    assert.ok(builder.idle_timeout_ms >= 900_000, `${name} builder model policy must inherit the long code idle window`);
    assert.ok(research.idle_timeout_ms >= 900_000, `${name} research policy must allow silent Codex reasoning`);
    assert.equal(research.model, "gpt-5.5", `${name} research should use the smoke-tested Codex model first`);
    assert.equal(builder.model, "gpt-5.5", `${name} builder should use the smoke-tested Codex code model first`);
  }
});

test("host-plugin install writes wrapper and manifest", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-install-"));
  const env = { ...process.env, ACROSS_HOME: acrossHome };

  const before = JSON.parse((await exec("node", [cli, "plugin-status", "--json"], { env })).stdout);
  assert.equal(before.installed, false);

  await exec("node", [cli, "install", "host-plugin", "--across-home", acrossHome], { env });
  const command = join(acrossHome, "bin", "across-autopilot");
  const after = JSON.parse((await exec(command, ["plugin-status", "--json"], { env })).stdout);
  const manifest = JSON.parse(await readFile(join(acrossHome, "plugins", "across-autopilot", "manifest.json"), "utf8"));
  const wrapper = await readFile(command, "utf8");

  assert.equal(after.installed, true);
  assert.equal(after.available, true);
  assert.equal(after.candidateSlot, null);
  assert.equal(manifest.entrypoints.review.args[0], "review");
  assert.match(wrapper, /\$SCRIPT_DIR/);
  assert.match(wrapper, /\.\.\/plugins\/across-autopilot\/src\/cli\.js/);
  assert.doesNotMatch(wrapper, new RegExp(acrossHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await exec(command, ["uninstall", "host-plugin", "--across-home", acrossHome], { env });
  const uninstalled = JSON.parse((await exec("node", [cli, "plugin-status", "--json"], { env })).stdout);
  assert.equal(uninstalled.installed, false);
});

test("install command prepares generic host MCP registrations", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-host-install-"));
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-host-across-home-"));
  const env = { ...process.env, ACROSS_HOME: acrossHome };
  const claudeConfig = join(home, "claude_desktop_config.json");
  await writeFile(claudeConfig, JSON.stringify({ deploymentMode: "default" }), "utf8");

  const claudeCode = (await exec("node", [cli, "install", "claude-code", "--stdout"], { env })).stdout;
  const codex = (await exec("node", [cli, "install", "codex-mcp", "--stdout"], { env })).stdout;
  const codexJson = JSON.parse((await exec("node", [cli, "install", "codex-mcp", "--json"], { env })).stdout);
  await exec("node", [cli, "install", "claude-desktop", "--config-file", claudeConfig], { env });

  assert.match(claudeCode, /claude mcp add -s user across-autopilot -- sh -lc /);
  assert.match(claudeCode, new RegExp(join(acrossHome, "bin", "across-autopilot").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(codex, /codex mcp add across-autopilot -- sh -lc /);
  assert.match(codex, new RegExp(join(acrossHome, "bin", "across-autopilot").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(codexJson.target, "codex-mcp");
  assert.match(codexJson.command, /codex mcp add across-autopilot -- sh -lc /);
  const payload = JSON.parse(await readFile(claudeConfig, "utf8"));
  assert.equal(payload.deploymentMode, "default");
  assert.deepEqual(payload.mcpServers["across-autopilot"], {
    command: "sh",
    args: ["-lc", `exec '${join(acrossHome, "bin", "across-autopilot")}' mcp`]
  });
  assert.equal((await readFile(join(acrossHome, "bin", "across-autopilot"), "utf8")).includes("../plugins/across-autopilot/src/cli.js"), true);
});

test("cli loop validation exposes built-in LoopSpec", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-state-"));
  const env = { ...process.env, ACROSS_HOME: acrossHome };

  const registry = JSON.parse((await exec("node", [
    cli,
    "loop",
    "registry",
    "--json"
  ], { env })).stdout);
  const builtInIds = registry.built_in.map((spec) => spec.id);
  assert.deepEqual(builtInIds.sort(), ["aaa-autonomous-self-iteration", "aaa-platform-self-repair", "aaa-release-readiness-gate", "aaa-research-driven-self-iteration", "aaa-self-iteration-product", "beginner-release-readiness", "daily-news-brief", "external-skills-radar", "github-plugin-radar", "plugin-compatibility-lab-v2", "repo-push-gate", "repo-quality-copilot", "scenario-simulation"]);
  assert.equal(registry.built_in.find((spec) => spec.id === "github-plugin-radar").title, "GitHub Plugin Radar");
  assert.equal(registry.built_in.find((spec) => spec.id === "repo-quality-copilot").title, "Repository Quality Copilot");
  assert.equal(registry.built_in.find((spec) => spec.id === "plugin-compatibility-lab-v2").title, "Plugin Compatibility Lab v2");
  assert.equal(registry.built_in.find((spec) => spec.id === "external-skills-radar").title, "External Skills Radar");
  assert.equal(registry.built_in.some((spec) => spec.spec), false);
  assert.equal(Array.isArray(registry.registered), true);

  const validation = JSON.parse((await exec("node", [
    cli,
    "loop",
    "validate",
    "--spec",
    "github-plugin-radar",
    "--json"
  ], { env })).stdout);

  assert.equal(validation.schema_version, "across-loop-validation/1.0");
  assert.equal(validation.valid, true);
  assert.equal(validation.spec_id, "github-plugin-radar");

  const dryRun = JSON.parse((await exec("node", [
    cli,
    "loop",
    "dry-run",
    "--spec",
    "daily-news-brief",
    "--json"
  ], { env })).stdout);
  assert.equal(dryRun.schema_version, "across-loop-dry-run/1.0");
  assert.ok(dryRun.used_adapters.outputs.includes("video_draft_manifest"));
});

test("cli exports workflow packs for generic agent hosts", async () => {
  const registry = JSON.parse((await exec("node", [cli, "workflow-packs", "--json"])).stdout);
  const pack = registry.packs.find((item) => item.id === "plugin-compatibility-lab-v2");
  assert.equal(registry.schema_version, "across-workflow-pack-registry/1.0");
  assert.equal(pack.status, "passed");
  assert.deepEqual(pack.host_targets, ["codex", "claude_code", "mcp", "a2a", "across"]);

  const exported = JSON.parse((await exec("node", [cli, "workflow-pack", "export", "--pack", "plugin-compatibility-lab-v2", "--json"])).stdout);
  assert.equal(exported.schema_version, "across-workflow-pack-host-exports/1.0");
  assert.equal(exported.product_card.schema_version, "across-workflow-pack-product-card/1.0");
  assert.match(exported.product_card.user_problem, /plugin/i);
  assert.equal(exported.protocol_readiness.schema_version, "across-workflow-pack-protocol-readiness/1.0");
  assert.equal(exported.protocol_readiness.summary.honest_protocol_claims, true);
  assert.equal(exported.trust_receipt.schema_version, "across-agent-team-trust-receipt/1.0");
  assert.equal(exported.trust_receipt.evidence_contract.graph_schema, "across-evidence-graph/1.0");
  assert.equal(exported.trust_receipt.evidence_contract.a2a_delegation_schema, "across-a2a-task-delegation/2.0");
  assert.deepEqual(exported.trust_receipt.evidence_contract.required_projections, ["mcp_tasks", "a2a", "ag_ui", "remote_mcp_oauth", "otel"]);
  assert.equal(exported.frontier_interop.schema_version, "across-workflow-pack-frontier-interop/1.0");
  assert.equal(exported.frontier_interop.remote_mcp.schema_version, "across-remote-mcp-oauth-template/1.0");
  assert.equal(exported.frontier_interop.a2a.schema_version, "across-a2a-task-delegation/2.0");
  assert.equal(exported.frontier_interop.mcp_tasks.schema_version, "across-async-task/1.0");
  assert.equal(exported.frontier_interop.ag_ui.schema_version, "across-agui-projection/1.0");
  assert.equal(exported.frontier_interop.projections.schema_version, "across-external-projection/1.0");
  assert.equal(exported.frontier_interop.projections.dimensions.remote_mcp_oauth.status, "passed");
  assert.equal(exported.frontier_interop.observability.otel_schema, "across-otel-genai-export/1.0");
  assert.equal(exported.frontier_interop.observability.otlp_trace_schema, "otlp-traces-json/1.0");
  assert.equal(exported.hosts.codex.type, "codex-plugin-task");
  assert.equal(exported.hosts.codex.trust_receipt_required, true);
  assert.equal(exported.hosts.claude_code.type, "claude-code-skill-or-mcp-task");
  assert.equal(exported.hosts.mcp.tools.includes("run_loop"), true);
  assert.deepEqual(exported.hosts.mcp.task_states, ["working", "input_required", "completed", "failed", "cancelled"]);
  assert.equal(exported.hosts.mcp.remote_transport_template.transport, "streamable_http");
  assert.equal(exported.hosts.a2a.agent_card_skill, "plugin-compatibility-lab-v2");
  assert.ok(exported.hosts.a2a.artifact_contract.includes("run://plugin-compatibility-lab/evidence.json"));
  assert.equal(exported.hosts.a2a.delegation_contract.schema_version, "across-a2a-task-delegation/2.0");
  assert.equal(exported.trust_boundary.secrets, "not_allowed");

  const productCard = JSON.parse((await exec("node", [cli, "workflow-pack", "product-card", "--pack", "repo-quality-copilot", "--json"])).stdout);
  assert.equal(productCard.schema_version, "across-workflow-pack-product-card/1.0");
  assert.equal(productCard.quickstart.no_model_required, true);

  const trustReceipt = JSON.parse((await exec("node", [cli, "workflow-pack", "trust-receipt", "--pack", "release-captain", "--json"])).stdout);
  assert.equal(trustReceipt.schema_version, "across-agent-team-trust-receipt/1.0");
  assert.ok(trustReceipt.acceptance_checklist.some((item) => item.id === "human_promotion_gate" && item.status === "passed"));

  const frontierInterop = JSON.parse((await exec("node", [cli, "workflow-pack", "frontier-interop", "--pack", "plugin-compatibility-lab-v2", "--json"])).stdout);
  assert.equal(frontierInterop.schema_version, "across-workflow-pack-frontier-interop/1.0");
  assert.equal(frontierInterop.observability.raw_transcripts_included, false);

  for (const packId of [
    "repo-push-gate",
    "repo-quality-copilot",
    "release-captain",
    "plugin-compatibility-lab-v2",
    "autonomous-product-iteration"
  ]) {
    const plan = JSON.parse((await exec("node", [
      cli,
      "workflow-pack",
      "execution-plan",
      "--pack",
      packId,
      "--goal",
      `Run ${packId} for this repository`,
      "--project-id",
      "project-local-plan",
      "--json"
    ])).stdout);
    assert.equal(plan.schema_version, "across-workflow-execution-plan/1.0");
    assert.equal(plan.workflow_id, packId);
    assert.equal(plan.execution_contract.route, "local");
    assert.equal(plan.adapter.type, "autopilot-workflow");
    assert.equal(plan.subtasks.length, 1);
    assert.ok(plan.deliverables[0].endsWith(".md"));
    assert.ok(plan.deliverables.every((path) => path.startsWith(`across-results/${packId}/`)));
  }
});

test("cli async loop task uses run-store as source of truth", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-async-"));
  const env = { ...process.env, ACROSS_HOME: acrossHome };
  const started = JSON.parse((await exec("node", [
    cli,
    "loop",
    "run",
    "--spec",
    "external-skills-radar",
    "--async",
    "--return-task-id",
    "--spawn",
    "false",
    "--json"
  ], { env })).stdout);

  assert.equal(started.schema_version, "across-async-task/1.0");
  assert.equal(started.source_of_truth, "across-autopilot-run-store");
  assert.equal(started.status, "queued");
  assert.equal(started.spawned, false);

  const completed = JSON.parse((await exec("node", [
    cli,
    "loop",
    "run-async-task",
    "--run-id",
    started.run_id,
    "--json"
  ], { env })).stdout);
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.run_id, started.run_id);
  assert.equal(completed.run.run_id, started.run_id);

  const status = JSON.parse((await exec("node", [
    cli,
    "loop",
    "task-status",
    "--task-id",
    started.task_id,
    "--json"
  ], { env })).stdout);
  assert.equal(status.status, "completed");
  assert.equal(status.run_id, started.run_id);
});

test("skills radar and loop memory compaction expose redacted contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "across-autopilot-skills-"));
  const skillDir = join(root, "demo-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# Demo Skill\n\nUse for local review workflows. sk-shouldnotleak1234567890\n", "utf8");

  const radar = JSON.parse((await exec("node", [cli, "skills-radar", "--root", root, "--json"])).stdout);
  assert.equal(radar.schema_version, "across-external-skills-radar/1.0");
  assert.equal(radar.summary.skill_count, 1);
  assert.equal(radar.summary.raw_skill_bodies_included, false);
  assert.doesNotMatch(JSON.stringify(radar), /shouldnotleak/);

  const evidencePath = join(root, "evidence.json");
  await writeFile(evidencePath, JSON.stringify({
    nodes: [
      { id: "gate:projection", kind: "gate", status: "passed", summary: "Projection gate passed" },
      { id: "gate:projection", kind: "gate", status: "passed", summary: "Duplicate projection gate passed" }
    ],
    edges: [{ from: "run", to: "gate:projection" }]
  }), "utf8");
  const compacted = JSON.parse((await exec("node", [cli, "loop-memory-compact", "--evidence", evidencePath, "--json"])).stdout);
  assert.equal(compacted.schema_version, "across-loop-memory-compaction/1.0");
  assert.equal(compacted.strategy, "evidence_graph_node");
  assert.equal(compacted.node_count, 1);
  assert.equal(compacted.retrieval_policy.raw_transcripts_included, false);
});

test("ecosystem commands resolve from ACROSS_HOME bin without shell PATH", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-bin-"));
  const binDir = join(acrossHome, "bin");
  const commandPath = join(binDir, "across-orchestrator");
  await mkdir(binDir, { recursive: true });
  await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(commandPath, 0o755);

  const resolved = resolveCommand(null, ["across-orchestrator"], { ...process.env, ACROSS_HOME: acrossHome, PATH: "/usr/bin" });

  assert.deepEqual(resolved, [commandPath]);
});

test("subprocess environment strips packaged host Python contamination", () => {
  const env = sanitizedSubprocessEnv({
    ACROSS_HOME: "/tmp/across",
    ACROSS_AAA_HOST_MODEL_COMMAND: "[\"backend\", \"autopilot-model-decision\"]",
    ACROSS_AAA_HOST_PYTHONPATH: "/tmp/aaa-host-src",
    MINIMAX_API_KEY: "should-not-reach-candidate",
    OPENAI_API_KEY: "should-not-reach-candidate",
    PATH: "/usr/bin",
    _PYI_ARCHIVE_FILE: "/Applications/Host.app/Contents/Resources/backend/backend",
    PYINSTALLER_RESET_ENVIRONMENT: "1",
    PYTHONHOME: "/Applications/Host.app/Contents/Resources/backend/_internal",
    PYTHONPATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    PYTHONUNBUFFERED: "1",
    __PYVENV_LAUNCHER__: "/Applications/Host.app/Contents/Resources/backend/backend",
    VIRTUAL_ENV: "/Applications/Host.app/Contents/Resources/backend",
    DYLD_LIBRARY_PATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    DYLD_FALLBACK_LIBRARY_PATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    LD_LIBRARY_PATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    UNRELATED_PACKAGED_STATE: "should-not-leak"
  });

  assert.equal(env.ACROSS_HOME, "/tmp/across");
  assert.equal(env.ACROSS_AAA_HOST_MODEL_COMMAND, "[\"backend\", \"autopilot-model-decision\"]");
  assert.equal(env.ACROSS_AAA_HOST_PYTHONPATH, "/tmp/aaa-host-src");
  assert.equal(env.MINIMAX_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env._PYI_ARCHIVE_FILE, undefined);
  assert.equal(env.PYINSTALLER_RESET_ENVIRONMENT, "1");
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONPATH, "/tmp/aaa-host-src");
  assert.equal(env.PYTHONUNBUFFERED, undefined);
  assert.equal(env.__PYVENV_LAUNCHER__, undefined);
  assert.equal(env.VIRTUAL_ENV, undefined);
  assert.equal(env.DYLD_LIBRARY_PATH, undefined);
  assert.equal(env.DYLD_FALLBACK_LIBRARY_PATH, undefined);
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.UNRELATED_PACKAGED_STATE, undefined);
});
