import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { buildAutopilotEcosystemRoadmap } from "../src/ecosystem-roadmap.js";
import { buildAgentPluginRunPlan, normalizeAgentPluginManifest } from "../src/agent-plugin-contract.js";

test("autopilot ecosystem roadmap summarizes tool packs, trust, and telemetry", () => {
  const roadmap = buildAutopilotEcosystemRoadmap({
    registry: new AdapterRegistry(),
    telemetry: {
      run_count: 2,
      by_status: { completed: 2 },
      promotion_ready_by_spec: {}
    }
  });

  assert.equal(roadmap.schema_version, "across-autopilot-ecosystem-roadmap/1.0");
  assert.equal(roadmap.owner, "across-autopilot");
  assert.equal(roadmap.summary.route_count, 4);
  assert.ok(roadmap.summary.tool_pack_count >= 10);
  assert.ok(roadmap.sections.tool_pack_registry.summary.ready_tool_pack_count >= 10);
  assert.equal(roadmap.sections.trust_sandbox.summary.candidate_only_mutation, true);
  assert.equal(roadmap.sections.evaluation_telemetry.summary.run_count, 2);
});

test("autopilot agent plugin plan enforces generic trust boundaries", () => {
  const plan = buildAgentPluginRunPlan({
    manifest: agentPluginManifest(),
    goal: "Run a read-only echo agent"
  });

  assert.equal(plan.schema_version, "across-autopilot-agent-plugin-plan/1.0");
  assert.equal(plan.status, "passed");
  assert.equal(plan.agent_plugin.agent_id, "demo.echo");
  assert.equal(plan.execution.dry_run, true);
  assert.equal(plan.execution.credentials_stay_with_host, true);
  assert.equal(plan.context.pack_id, "demo.echo");
});

test("autopilot agent plugin plan blocks unsafe mutation without approval", () => {
  const manifest = agentPluginManifest({
    trust: {
      mutation_boundary: "host_approved_mutation",
      requires_human_approval: false,
      secrets_included: false
    }
  });
  const plan = buildAgentPluginRunPlan({ manifest, goal: "Mutate host files" });

  assert.equal(plan.status, "failed");
  assert.ok(plan.trust_policy.failures.some((item) => item.includes("human approval")));
});

test("autopilot agent plugin validation rejects incomplete entrypoints", () => {
  const manifest = agentPluginManifest({
    entrypoints: {
      run: { transport: "stdio" }
    }
  });

  assert.throws(
    () => normalizeAgentPluginManifest(manifest),
    /entrypoint run must define command or url/
  );
});

test("autopilot ecosystem roadmap includes ready agent plugin runtime", () => {
  const roadmap = buildAutopilotEcosystemRoadmap({
    registry: new AdapterRegistry(),
    telemetry: { run_count: 0, by_status: {}, promotion_ready_by_spec: {} },
    agentPlugins: [agentPluginManifest()]
  });

  assert.equal(roadmap.sections.agent_plugin_runtime.status, "passed");
  assert.equal(roadmap.summary.agent_plugin_count, 1);
  assert.equal(roadmap.summary.ready_agent_plugin_count, 1);
});

function agentPluginManifest(overrides = {}) {
  return {
    schema_version: "across-agent-plugin/1.0",
    plugin_id: "demo.echo-agent",
    display_name: "Demo Echo Agent",
    version: "1.0.0",
    agent: { id: "demo.echo", name: "Demo Echo", vendor: "local" },
    protocols: ["stdio"],
    capabilities: [{ id: "message.echo", kind: "tool", risk: "low" }],
    entrypoints: {
      run: { command: ["node", "--version"], transport: "stdio" }
    },
    trust: {
      mutation_boundary: "read_only",
      requires_human_approval: false,
      secrets_included: false
    },
    context: { pack_id: "demo.echo" },
    health: { status: "passed" },
    ...overrides
  };
}

test("autopilot ecosystem roadmap flags promotion-ready telemetry for review", () => {
  const roadmap = buildAutopilotEcosystemRoadmap({
    registry: new AdapterRegistry(),
    telemetry: {
      run_count: 1,
      by_status: { completed: 1 },
      promotion_ready_by_spec: { "aaa-autonomous-self-iteration": 1 }
    }
  });

  assert.equal(roadmap.status, "attention");
  assert.equal(roadmap.sections.evaluation_telemetry.items[1].status, "attention");
  assert.equal(roadmap.sections.evaluation_telemetry.summary.promotion_ready_count, 1);
});
