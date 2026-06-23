import { FAILURE_CODES, LoopFailure } from "./failures.js";
import { resolveCommand, runJsonCommand } from "./process-client.js";

export class ContextClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.command = resolveCommand(options.command || this.env.ACROSS_CONTEXT_COMMAND, ["across-context"], this.env);
    this.cwd = options.cwd || process.cwd();
  }

  async capabilities() {
    return {
      provider: "across-context",
      memory: ["pending_summary", "recall_loop", "loop_history", "loop_memory_diff"]
    };
  }

  async recall({ spec, limit = 10 }) {
    try {
      return await runJsonCommand(this.command, [
        "recall-loop",
        "--spec-id",
        spec.id,
        "--limit",
        String(limit),
        "--json"
      ], { env: this.env, cwd: this.cwd });
    } catch (error) {
      return {
        schema_version: "across-context-recall/1.0",
        provider: "across-context",
        spec_id: spec.id,
        result_count: 0,
        results: [],
        mode: "context-unavailable",
        warning: String(error.message || error)
      };
    }
  }

  async rememberLoop({ spec, run, text, actions, gates }) {
    try {
      return await runJsonCommand(this.command, [
        "remember-loop",
        "--spec-id",
        spec.id,
        "--run-id",
        run.run_id,
        "--text",
        text,
        "--summary-json",
        JSON.stringify({
          actions: actions.map((action) => ({ id: action.id, status: action.status })),
          gates: gates.map((gate) => ({ id: gate.id, status: gate.status })),
          model_decision: modelDecisionSummary(actions),
          research_strategy: researchStrategySummary(actions),
          candidate: candidateSummary(actions)
        }),
        "--json"
      ], { env: this.env, cwd: this.cwd });
    } catch (error) {
      throw new LoopFailure({
        code: FAILURE_CODES.CONTEXT_UNAVAILABLE,
        failedState: "remembering",
        message: `Context memory write failed: ${error.message || error}`,
        causedBy: [{ command: error.command, stderr: String(error.stderr || "").slice(0, 1000) }]
      });
    }
  }
}

function researchStrategySummary(actions) {
  const strategy = actions.find((action) => action.adapter === "product_iteration_strategy")?.result;
  if (!strategy?.selected_iteration) return null;
  return {
    selected_target_id: strategy.selected_target_id || strategy.selected_iteration.target_id || null,
    generated: Boolean(strategy.admission?.generated),
    generated_from: strategy.selected_iteration.generated_from || null,
    tool_packs: Array.isArray(strategy.selected_iteration.tool_packs) ? strategy.selected_iteration.tool_packs.slice(0, 12) : [],
    dynamic_backlog_count: Array.isArray(strategy.dynamic_backlog) ? strategy.dynamic_backlog.length : 0,
    admission_status: strategy.admission?.status || null,
    validation_command_count: strategy.admission?.validation_command_count || 0
  };
}

function candidateSummary(actions) {
  const acquire = actions.find((action) => action.adapter === "candidate_ecosystem_acquire")?.result;
  const diff = actions.find((action) => action.adapter === "candidate_ecosystem_diff")?.result;
  const validation = actions.find((action) => action.adapter === "candidate_ecosystem_validation")?.result;
  const probe = actions.find((action) => action.adapter === "candidate_self_hosting_probe")?.result;
  const promotion = actions.find((action) => action.adapter === "promotion_report_generation")?.result;
  if (!acquire && !diff && !validation && !probe && !promotion) return null;
  return {
    candidate_id: acquire?.candidate_id || promotion?.candidate_id || null,
    mode: acquire?.mode || promotion?.mode || null,
    four_repo_manifest: Boolean(acquire?.four_repo_manifest || promotion?.four_repo_manifest),
    changed_file_count: diff?.changed_file_count ?? promotion?.changed_file_count ?? 0,
    validation_status: validation?.status || promotion?.validation_status || null,
    self_hosting_probe_required: Boolean(probe?.required),
    self_hosting_probe_status: probe?.status || null,
    promotion_ready: Boolean(promotion?.promotion_ready)
  };
}

function modelDecisionSummary(actions) {
  const task = actions.find((action) => action.adapter === "orchestrator_task_dispatch")?.result?.task;
  const decision = task?.model_decision;
  if (!decision || typeof decision !== "object") return null;
  const patches = decision.patches || decision.decision?.patches || [];
  return {
    provider: decision.provider || null,
    model: decision.model || null,
    decision_hash: decision.decision_hash || null,
    patch_count: Array.isArray(patches) ? patches.length : 0,
    patch_paths: Array.isArray(patches)
      ? patches.map((item) => item?.path).filter(Boolean).slice(0, 20)
      : []
  };
}
