export async function buildTelemetry(store) {
  const runs = await store.listRuns();
  const metrics = {
    schema_version: "across-loop-telemetry/1.0",
    generated_at: new Date().toISOString(),
    run_count: runs.length,
    by_spec: {},
    by_status: {},
    adapter_failures: {},
    gate_failures: {},
    pending_memory_by_spec: {},
    selected_targets: {},
    validation_failures: {},
    repair_counts: {},
    reviewer_recommendations: {},
    promotion_ready_by_spec: {},
    candidate_quality_findings: {},
    unresolved_risks: {},
    approval_requests: 0,
    kill_switch_activations: 0
  };
  for (const run of runs) {
    metrics.by_status[run.status] = (metrics.by_status[run.status] || 0) + 1;
    const spec = metrics.by_spec[run.spec_id] || { run_count: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0, durations_ms: [] };
    spec.run_count += 1;
    if (run.status === "completed") spec.completed += 1;
    if (run.status === "failed") spec.failed += 1;
    if (run.status === "cancelled") spec.cancelled += 1;
    if (run.status === "blocked") spec.blocked += 1;
    if (run.started_at && run.completed_at) spec.durations_ms.push(Date.parse(run.completed_at) - Date.parse(run.started_at));
    metrics.by_spec[run.spec_id] = spec;
    try {
      const evidence = await store.loadEvidence(run.run_id);
      for (const action of evidence.actions || []) {
        if (action.status === "failed") metrics.adapter_failures[action.adapter] = (metrics.adapter_failures[action.adapter] || 0) + 1;
      }
      for (const gate of evidence.gates || []) {
        if (gate.status !== "passed") metrics.gate_failures[gate.id] = (metrics.gate_failures[gate.id] || 0) + 1;
      }
      const pending = (evidence.memory?.written || []).filter((item) => item.status === "accepted_pending" || item.status === "redacted_pending" || item.status === "pending").length;
      metrics.pending_memory_by_spec[run.spec_id] = (metrics.pending_memory_by_spec[run.spec_id] || 0) + pending;
      const target = evidence.candidate?.research_strategy?.selected_target_id;
      if (target) metrics.selected_targets[target] = (metrics.selected_targets[target] || 0) + 1;
      if (evidence.candidate?.promotion_ready === true) {
        metrics.promotion_ready_by_spec[run.spec_id] = (metrics.promotion_ready_by_spec[run.spec_id] || 0) + 1;
      }
      const recommendation = evidence.candidate?.independent_reviewer?.merge_recommendation
        || evidence.candidate?.independent_reviewer?.recommendation;
      if (recommendation) metrics.reviewer_recommendations[recommendation] = (metrics.reviewer_recommendations[recommendation] || 0) + 1;
      for (const command of evidence.candidate?.validation?.commands || []) {
        if (command.status !== "passed") {
          const key = [command.repo || "unknown", command.command || "unknown"].join(":");
          metrics.validation_failures[key] = (metrics.validation_failures[key] || 0) + 1;
        }
      }
      for (const finding of evidence.candidate?.quality_findings || []) {
        metrics.candidate_quality_findings[finding.id] = (metrics.candidate_quality_findings[finding.id] || 0) + 1;
      }
      for (const action of evidence.actions || []) {
        if (action.result?.host_validation_repair_fallback || action.result?.repaired_json || action.result?.validation_repair) {
          metrics.repair_counts[action.adapter] = (metrics.repair_counts[action.adapter] || 0) + 1;
        }
      }
      for (const risk of evidence.risks || []) {
        const key = risk.source || risk.severity || "unknown";
        metrics.unresolved_risks[key] = (metrics.unresolved_risks[key] || 0) + 1;
      }
    } catch {
      continue;
    }
    const events = await store.events(run.run_id);
    metrics.approval_requests += events.filter((event) => event.type === "approval_requested").length;
    metrics.kill_switch_activations += events.filter((event) => event.type === "kill_switch_activated").length;
  }
  for (const spec of Object.values(metrics.by_spec)) {
    spec.duration_p50_ms = percentile(spec.durations_ms, 0.5);
    spec.duration_p95_ms = percentile(spec.durations_ms, 0.95);
    delete spec.durations_ms;
  }
  return metrics;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
