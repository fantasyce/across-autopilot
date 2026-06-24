import { buildToolPackRegistry } from "./tool-packs.js";
import { buildAgentPluginRunPlan } from "./agent-plugin-contract.js";

export const AUTOPILOT_ECOSYSTEM_SCHEMA = "across-autopilot-ecosystem-roadmap/1.0";

export function buildAutopilotEcosystemRoadmap({ registry = null, telemetry = null, agentPlugins = [] } = {}) {
  const toolPackRegistry = buildToolPackRegistry(registry);
  const packs = toolPackRegistry.packs || [];
  const readyPacks = packs.filter((pack) => pack.available);
  const runCount = Number(telemetry?.run_count ?? telemetry?.runs?.total ?? 0);
  const failedCount = Number(telemetry?.by_status?.failed ?? telemetry?.runs?.failed ?? 0);
  const promotionReadyCount = Object.values(telemetry?.promotion_ready_by_spec || {}).reduce((total, value) => total + Number(value || 0), 0);
  const agentPluginPlans = agentPlugins.map((manifest) => buildAgentPluginRunPlan({ manifest, goal: "AAA generic external agent dry-run" }));
  const readyAgentPlugins = agentPluginPlans.filter((plan) => plan.status === "passed");
  const sections = {
    tool_pack_registry: {
      id: "tool_pack_registry",
      title: "Tool Pack Registry",
      status: readyPacks.length >= 10 ? "passed" : "attention",
      summary: {
        tool_pack_count: packs.length,
        ready_tool_pack_count: readyPacks.length,
        required_floor: 10
      },
      items: packs.slice(0, 12).map((pack) => ({
        id: pack.id,
        title: pack.title,
        status: pack.available ? "passed" : "attention",
        boundary: pack.boundary,
        missing_capabilities: pack.missing_capabilities || []
      }))
    },
    trust_sandbox: {
      id: "trust_sandbox",
      title: "Trust And Sandbox",
      status: "passed",
      summary: {
        candidate_only_mutation: true,
        promotion_human_approval_required: true,
        merge_release_blocked_by_default: true
      },
      items: [
        { id: "candidate_workspace", status: "passed", boundary: "candidate_only_mutation" },
        { id: "promotion_attestation", status: "passed", boundary: "review_only_until_human_approval" },
        { id: "evidence_integrity", status: "passed", boundary: "read_only_evidence" }
      ]
    },
    evaluation_telemetry: {
      id: "evaluation_telemetry",
      title: "Eval And Telemetry",
      status: failedCount > 0 || promotionReadyCount > 0 ? "attention" : "passed",
      summary: {
        run_count: runCount,
        failed_run_count: failedCount,
        promotion_ready_count: promotionReadyCount
      },
      items: [
        { id: "telemetry_rollup", status: "passed", run_count: runCount },
        { id: "promotion_review", status: promotionReadyCount ? "attention" : "passed", promotion_ready_count: promotionReadyCount }
      ]
    },
    agent_plugin_runtime: {
      id: "agent_plugin_runtime",
      title: "Generic Agent Plugin Runtime",
      status: agentPluginPlans.length === 0 ? "unavailable" : readyAgentPlugins.length === agentPluginPlans.length ? "passed" : "attention",
      summary: {
        agent_plugin_count: agentPluginPlans.length,
        ready_agent_plugin_count: readyAgentPlugins.length,
        generic_schema: "across-agent-plugin/1.0",
        dry_run_only: true
      },
      items: agentPluginPlans.slice(0, 12).map((plan) => ({
        id: plan.agent_plugin.plugin_id,
        agent_id: plan.agent_plugin.agent_id,
        status: plan.status,
        mutation_boundary: plan.execution.mutation_boundary,
        human_approval_required: plan.execution.human_approval_required,
        context_pack_id: plan.context.pack_id
      }))
    }
  };
  const statuses = Object.values(sections).map((section) => section.status);
  return {
    schema_version: AUTOPILOT_ECOSYSTEM_SCHEMA,
    owner: "across-autopilot",
    status: statuses.includes("failed") ? "failed" : statuses.some((status) => ["attention", "unavailable", "unknown"].includes(status)) ? "attention" : "passed",
    summary: {
      route_count: Object.keys(sections).length,
      ready_route_count: statuses.filter((status) => status === "passed").length,
      tool_pack_count: packs.length,
      ready_tool_pack_count: readyPacks.length,
      agent_plugin_count: agentPluginPlans.length,
      ready_agent_plugin_count: readyAgentPlugins.length
    },
    sections
  };
}
