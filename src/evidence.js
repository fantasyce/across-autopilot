import { createHash } from "node:crypto";
import { EVIDENCE_SCHEMA, normalizeRuntimePolicy } from "./loop-spec.js";
import { stableJson } from "./json-utils.js";
import { buildRoleEvidence } from "./roles.js";

export function buildEvidenceEnvelope({ spec, run, sources = [], actions = [], gates = [], outputs = [], memory = {}, risks = [], audit = [], failure = null }) {
  const orchestratorTasks = actions
    .filter((action) => action.adapter === "orchestrator_task_dispatch")
    .flatMap((action) => action.result?.task ? [action.result.task] : []);
  const candidate = candidateEvidence(actions);
  const runtimePolicy = normalizeRuntimePolicy(spec);
  const runtimeBudget = buildRuntimeBudgetEvidence({ policy: runtimePolicy, actions, run, failure });
  const envelope = {
    schema_version: EVIDENCE_SCHEMA,
    run_id: run.run_id,
    spec_id: spec.id,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    sources,
    actions,
    orchestrator: {
      primary_task_id: orchestratorTasks[0]?.task_id || orchestratorTasks[0]?.loop_id || null,
      aggregate_quality_status: aggregateQuality(orchestratorTasks),
      tasks: orchestratorTasks.map((task) => ({
        task_id: task.task_id || task.loop_id,
        loop_id: task.loop_id || task.task_id,
        status: task.status || "unknown",
        quality_status: task.quality_status || "unknown",
        metadata_reflected: Boolean(task.metadata_reflected),
        model_backed: Boolean(task.model_backed),
        model_decision: task.model_decision || null,
        event_count: Number(task.event_count || 0),
        evidence_refs: task.evidence_refs || []
      }))
    },
    runtime_policy: runtimePolicy,
    runtime_budget: runtimeBudget,
    candidate,
    roles: buildRoleEvidence(actions),
    gates,
    outputs,
    memory: {
      recalled: memory.recalled || [],
      written: memory.written || []
    },
    risks,
    failure,
    audit
  };
  return {
    ...envelope,
    integrity: buildEvidenceIntegrity(envelope)
  };
}

function candidateEvidence(actions) {
  const acquire = lastActionResult(actions, "candidate_ecosystem_acquire");
  const mutation = lastActionResult(actions, "host_code_iteration")
    || lastActionResult(actions, "candidate_workspace_patch");
  const diff = lastActionResult(actions, "candidate_ecosystem_diff")
    || lastActionResult(actions, "candidate_diff_summary");
  const validation = lastActionResult(actions, "candidate_ecosystem_validation")
    || lastActionResult(actions, "candidate_validation");
  const appLifecycle = lastActionResult(actions, "candidate_app_lifecycle");
  const probe = lastActionResult(actions, "candidate_self_hosting_probe");
  const semantic = lastActionResult(actions, "semantic_alignment_review");
  const strategy = lastActionResult(actions, "product_iteration_strategy");
  const promotion = lastActionResult(actions, "promotion_report_generation");
  if (!acquire && !strategy && !mutation && !diff && !validation && !appLifecycle && !probe && !semantic && !promotion) return null;
  return {
    schema_version: "across-autopilot-candidate-evidence/1.0",
    candidate_id: acquire?.candidate_id || mutation?.candidate_id || promotion?.candidate_id || null,
    mode: acquire?.mode || promotion?.mode || null,
    candidate_root: acquire?.base_dir || promotion?.candidate_root || null,
    workspace_root: mutation?.workspace || promotion?.workspace || targetRepoPath(acquire, mutation?.target_repo || promotion?.target_repo || strategy?.selected_iteration?.target_repo),
    manifest_path: acquire?.manifest_path || promotion?.manifest_path || null,
    runtime_home: acquire?.runtime_home || validation?.runtime_home || promotion?.runtime_home || null,
    app_home: acquire?.app_home || promotion?.app_home || null,
    app_dir: acquire?.app_dir || promotion?.app_dir || null,
    candidate_app_lifecycle: appLifecycle
      ? {
        status: appLifecycle.status || null,
        required: Boolean(appLifecycle.required),
        skipped: Boolean(appLifecycle.skipped),
        app_path: appLifecycle.app_path || null,
        bundle_id: appLifecycle.bundle_id || null,
        output_path: appLifecycle.output_path || null,
        cleaned_up: appLifecycle.cleaned_up ?? null,
        crash_report_count: Array.isArray(appLifecycle.crash_reports) ? appLifecycle.crash_reports.length : null,
        socket_path_bytes: appLifecycle.socket_path_bytes ?? null,
        llm_status: appLifecycle.llm_status || null
      }
      : promotion?.candidate_app_lifecycle || null,
    runtime_preflight: acquire?.runtime_preflight || validation?.runtime_preflight || promotion?.runtime_preflight || null,
    four_repo_manifest: Boolean(acquire?.four_repo_manifest || promotion?.four_repo_manifest),
    changed_files: diff?.changed_files || mutation?.changed_files || promotion?.changed_files || [],
    changed_file_count: diff?.changed_file_count ?? promotion?.changed_file_count ?? 0,
    validation_status: validation?.status || promotion?.validation_status || null,
    model: {
      backed: Boolean(mutation?.model_backed || promotion?.model_backed),
      provider: mutation?.provider || promotion?.model_provider || null,
      name: mutation?.model || promotion?.model || null,
      decision_hash: mutation?.decision_hash || promotion?.decision_hash || null
    },
    repos: candidateRepoEvidence(diff),
    quality_findings: candidateQualityFindings(diff),
    ignored_generated_artifacts: candidateIgnoredGeneratedArtifacts(diff),
    validation: validation
      ? {
        status: validation.status || promotion?.validation_status || null,
        command_count: Array.isArray(validation.commands) ? validation.commands.length : 0,
        commands: validationCommands(validation)
      }
      : null,
    semantic_alignment_status: semantic?.status || promotion?.semantic_alignment_status || null,
    semantic_alignment_recommendation: semantic?.promotion_recommendation || promotion?.semantic_alignment_recommendation || null,
    research_strategy: strategy?.selected_iteration
      ? {
        status: strategy.status || null,
        selected_target_id: strategy.selected_target_id || strategy.selected_iteration.target_id || null,
        summary: strategy.summary || null,
        autonomous: Boolean(strategy.autonomous),
        dynamic_backlog_count: Array.isArray(strategy.dynamic_backlog) ? strategy.dynamic_backlog.length : 0,
        tool_packs: strategy.selected_iteration.tool_packs || [],
        generated_from: strategy.selected_iteration.generated_from || null,
        candidate_comparison: strategy.candidate_comparison || null,
        admission: strategy.admission || null,
        tool_pack_evidence_count: Array.isArray(strategy.tool_pack_evidence?.packs) ? strategy.tool_pack_evidence.packs.length : 0,
        model_backed: Boolean(strategy.model_backed),
        provider: strategy.provider || null,
        name: strategy.model || null,
        decision_hash: strategy.decision_hash || null,
        repaired_json: Boolean(strategy.repaired_json),
        text_fallback: Boolean(strategy.text_fallback)
      }
      : promotion?.research_strategy || null,
    independent_reviewer: semantic
      ? {
        status: semantic.status || null,
        builder_role: semantic.builder_role || null,
        reviewer_role: semantic.reviewer_role || null,
        independent: Boolean(semantic.reviewer_independent),
        recommendation: semantic.promotion_recommendation || null,
        product_value_score: semantic.product_value_score ?? null,
        maintainability_score: semantic.maintainability_score ?? null,
        risk_score: semantic.risk_score ?? null,
        merge_recommendation: semantic.merge_recommendation || null,
        human_review_notes: semantic.human_review_notes || [],
        model_backed: Boolean(semantic.reviewer_model_backed),
        provider: semantic.reviewer_provider || null,
        model: semantic.reviewer_model || null,
        decision_hash: semantic.reviewer_decision_hash || null,
        model_separation: semantic.model_separation || null
      }
      : promotion?.independent_reviewer || null,
    self_hosting_probe: probe
      ? {
        required: Boolean(probe.required),
        status: probe.status,
        probe_id: probe.probe_id || null
      }
      : null,
    promotion_ready: Boolean(promotion?.promotion_ready),
    promotion_package: promotion?.promotion_package || null
  };
}

function targetRepoPath(acquire, repoId) {
  if (!repoId || !Array.isArray(acquire?.repos)) return null;
  return acquire.repos.find((repo) => repo.id === repoId)?.target || null;
}

function candidateRepoEvidence(diff) {
  if (!Array.isArray(diff?.repos)) return [];
  return diff.repos.map((repo) => ({
    id: repo.id || null,
    path: repo.path || null,
    changed_file_count: repo.changed_file_count || 0,
    changed_files: repo.changed_files || [],
    quality_findings: repo.quality_findings || [],
    ignored_generated_artifacts: repo.ignored_generated_artifacts || [],
    doc_churn: repo.doc_churn || []
  }));
}

function candidateQualityFindings(diff) {
  if (!Array.isArray(diff?.repos)) return [];
  return diff.repos.flatMap((repo) => (repo.quality_findings || []).map((finding) => ({
    ...finding,
    repo: repo.id || finding.repo || null
  })));
}

function candidateIgnoredGeneratedArtifacts(diff) {
  if (!Array.isArray(diff?.repos)) return [];
  return diff.repos.flatMap((repo) => (repo.ignored_generated_artifacts || []).map((artifact) => ({
    repo: repo.id || null,
    path: artifact
  })));
}

function validationCommands(validation) {
  if (!Array.isArray(validation?.commands)) return [];
  return validation.commands.map((item) => ({
    repo: item.repo || null,
    command: [item.command, ...(Array.isArray(item.args) ? item.args : [])].filter(Boolean).join(" "),
    status: item.status || null,
    exit_code: item.exit_code ?? null
  }));
}

function lastActionResult(actions, adapter) {
  return [...actions].reverse().find((action) => action.adapter === adapter && action.result)?.result;
}

function aggregateQuality(tasks) {
  if (!tasks.length) return "not_run";
  if (tasks.some((task) => task.quality_status === "failed" || task.status === "failed")) return "failed";
  if (tasks.some((task) => task.quality_status === "unknown")) return "attention";
  return "passed";
}

export function gateFromFailure(failure) {
  return {
    id: failure.code,
    status: "failed",
    required: true,
    reason: failure.message,
    evidence_refs: failure.evidence_refs || []
  };
}

function buildEvidenceIntegrity(envelope) {
  const sections = {
    sources: envelope.sources,
    actions: envelope.actions,
    orchestrator: envelope.orchestrator,
    runtime_policy: envelope.runtime_policy,
    runtime_budget: envelope.runtime_budget,
    candidate: envelope.candidate,
    roles: envelope.roles,
    gates: envelope.gates,
    outputs: envelope.outputs,
    memory: envelope.memory,
    risks: envelope.risks,
    failure: envelope.failure
  };
  const sectionHashes = Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [key, sha256(stableJson(value ?? null))])
  );
  const auditChain = buildAuditChain(envelope.audit || []);
  return {
    schema_version: "across-autopilot-evidence-integrity/1.0",
    algorithm: "sha256",
    section_hashes: sectionHashes,
    audit_chain: auditChain,
    root_hash: sha256(stableJson({
      run_id: envelope.run_id,
      spec_id: envelope.spec_id,
      status: envelope.status,
      section_hashes: sectionHashes,
      audit_chain_tip: auditChain.chain_tip
    }))
  };
}

export function runtimeBudgetUsage(actions = []) {
  const candidateRepairAttempts = new Set();
  let modelCalls = 0;
  for (const action of actions || []) {
    if (actionUsesModel(action)) modelCalls += 1;
    const id = String(action?.id || "");
    if (id === "host_code_iteration_repair" || id === "host_code_iteration_semantic_repair") {
      const attempt = action?.result?.repair_attempt ?? action?.repair_attempt ?? candidateRepairAttempts.size + 1;
      candidateRepairAttempts.add(`${id}:${attempt}`);
    }
  }
  return {
    model_calls: modelCalls,
    candidate_repairs: candidateRepairAttempts.size,
    estimated_usd: null
  };
}

function buildRuntimeBudgetEvidence({ policy, actions, run, failure }) {
  const usage = runtimeBudgetUsage(actions);
  const elapsedMs = elapsedMillis(run?.started_at, run?.completed_at);
  const exceeded = [];
  if (usage.model_calls > policy.budget.max_model_calls) {
    exceeded.push("max_model_calls");
  }
  if (usage.candidate_repairs > policy.budget.max_candidate_repairs) {
    exceeded.push("max_candidate_repairs");
  }
  if (elapsedMs !== null && elapsedMs > policy.timeouts.total_run_timeout_ms) {
    exceeded.push("total_run_timeout_ms");
  }
  if (failure?.code === "runtime.budget_exceeded" && !exceeded.includes("runtime_guard")) {
    exceeded.push("runtime_guard");
  }
  const terminal = ["completed", "failed", "blocked", "cancelled"].includes(String(run?.status || ""));
  return {
    schema_version: "across-loop-runtime-budget/1.0",
    status: failure?.code === "runtime.budget_exceeded" || exceeded.length
      ? "failed"
      : terminal
        ? "passed"
        : "running",
    enforcement: "hard",
    limits: {
      max_model_calls: policy.budget.max_model_calls,
      max_candidate_repairs: policy.budget.max_candidate_repairs,
      max_usd: policy.budget.max_usd,
      total_run_timeout_ms: policy.timeouts.total_run_timeout_ms,
      adapter_timeout_ms: policy.timeouts.adapter_timeout_ms,
      model_timeout_ms: policy.timeouts.model_timeout_ms
    },
    usage: {
      ...usage,
      elapsed_ms: elapsedMs
    },
    exceeded
  };
}

function actionUsesModel(action) {
  const result = action?.result || {};
  const task = result.task || {};
  return Boolean(
    result.model_backed
      || result.reviewer_model_backed
      || result.model_decision
      || task.model_backed
      || task.model_decision
  );
}

function elapsedMillis(startedAt, completedAt) {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const completed = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(completed)) return null;
  return Math.max(0, completed - started);
}

function buildAuditChain(audit) {
  let previous = "0".repeat(64);
  let count = 0;
  for (const event of audit) {
    previous = sha256(stableJson({ previous, event }));
    count += 1;
  }
  return {
    event_count: count,
    chain_tip: previous
  };
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}
