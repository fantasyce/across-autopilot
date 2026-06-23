const ROLE_BY_ADAPTER = Object.freeze({
  candidate_ecosystem_acquire: "supervisor",
  product_iteration_strategy: "planner",
  host_code_iteration: "builder",
  candidate_workspace_patch: "builder",
  candidate_ecosystem_diff: "inspector",
  candidate_diff_summary: "inspector",
  candidate_ecosystem_validation: "validator",
  candidate_validation: "validator",
  candidate_app_lifecycle: "validator",
  candidate_self_hosting_probe: "validator",
  semantic_alignment_review: "reviewer",
  quality_gate_evaluation: "supervisor",
  promotion_report_generation: "release_gate",
  report_generation: "reporter",
  memory_write_candidate: "memory_curator",
  orchestrator_task_dispatch: "executor"
});

export function roleForAdapter(adapter) {
  return ROLE_BY_ADAPTER[adapter] || "tool";
}

export function buildRoleEvidence(actions = []) {
  const roles = new Map();
  for (const action of actions) {
    const role = action.role || roleForAdapter(action.adapter);
    const record = roles.get(role) || {
      role,
      status: "not_run",
      terminal_status: "not_run",
      historical_status: "not_run",
      action_ids: [],
      adapters: [],
      decision_hashes: [],
      model_backed: false,
      terminal_by_adapter: new Map()
    };
    record.action_ids.push(action.id || action.adapter);
    if (action.adapter && !record.adapters.includes(action.adapter)) {
      record.adapters.push(action.adapter);
    }
    const result = action.result || {};
    const decisionHash = result.decision_hash || result.model_decision_hash;
    if (decisionHash && !record.decision_hashes.includes(decisionHash)) {
      record.decision_hashes.push(decisionHash);
    }
    record.model_backed = record.model_backed || Boolean(result.model_backed || result.provider || result.model_provider);
    record.historical_status = combineRoleStatus(record.historical_status, action.status || "unknown");
    record.terminal_by_adapter.set(actionTerminalKey(action), action.status || "unknown");
    roles.set(role, record);
  }

  for (const record of roles.values()) {
    record.terminal_status = [...record.terminal_by_adapter.values()]
      .reduce((status, next) => combineRoleStatus(status, next), "not_run");
    record.status = record.terminal_status;
    record.history_contains_attention = record.historical_status !== record.terminal_status;
    delete record.terminal_by_adapter;
  }

  const builder = roles.get("builder");
  const reviewer = roles.get("reviewer");
  const reviewerIndependent = reviewer
    ? Boolean(lastActionForRole(actions, "reviewer")?.result?.reviewer_independent)
    : false;

  return {
    schema_version: "across-autopilot-role-evidence/1.0",
    roles: [...roles.values()].sort((a, b) => a.role.localeCompare(b.role)),
    separation: {
      builder_present: Boolean(builder),
      reviewer_present: Boolean(reviewer),
      reviewer_independent: reviewer ? reviewerIndependent : null,
      status: reviewer
        ? (reviewerIndependent ? "passed" : "failed")
        : "not_required"
    }
  };
}

function lastActionForRole(actions, role) {
  return [...actions].reverse().find((action) => (action.role || roleForAdapter(action.adapter)) === role);
}

function actionTerminalKey(action) {
  if (action.adapter) {
    return action.adapter;
  }
  const id = action.id || "unknown";
  return id.endsWith("_repair") ? id.slice(0, -"_repair".length) : id;
}

function combineRoleStatus(previous, next) {
  const order = {
    failed: 5,
    attention: 4,
    running: 3,
    unknown: 2,
    passed: 1,
    not_run: 0
  };
  return (order[next] ?? 2) > (order[previous] ?? 0) ? next : previous;
}
