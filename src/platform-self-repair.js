import { stableJson, asArray } from "./json-utils.js";

export const PLATFORM_SELF_REPAIR_SPEC_ID = "aaa-platform-self-repair";
export const PLATFORM_SELF_REPAIR_SCHEMA = "across-platform-self-repair-diagnosis/1.0";

const PLATFORM_REPAIR_CATEGORIES = new Set([
  "validation_gap",
  "runtime_gap",
  "packaging_gap",
  "policy_gap",
  "supervisor_gap"
]);

const NON_REPAIR_CATEGORIES = new Set([
  "candidate_code_failure",
  "model_output_failure",
  "infrastructure_failure",
  "security_policy_stop",
  "unknown"
]);

const TARGETS = Object.freeze({
  validation_gap: {
    target_id: "autopilot-validation-router-repair",
    target_repo: "across-autopilot",
    allowed_patch_paths: [
      "src/candidate-ecosystem.js",
      "src/platform-self-repair.js",
      "tests/loop-platform.test.js"
    ],
    context_files: [
      "src/candidate-ecosystem.js",
      "src/supervisor.js",
      "tests/loop-platform.test.js"
    ]
  },
  runtime_gap: {
    target_id: "aaa-host-runtime-repair",
    target_repo: "across-agents-assistant",
    allowed_patch_paths: [
      "backend/main.py",
      "backend/src/across_agents_assistant/api_server.py",
      "backend/tests/test_api_autopilot.py",
      "backend/tests/test_live_e2e_infrastructure.py",
      "build_app.sh",
      "scripts/candidate_app_lifecycle.sh"
    ],
    context_files: [
      "backend/main.py",
      "backend/src/across_agents_assistant/api_server.py",
      "build_app.sh"
    ]
  },
  packaging_gap: {
    target_id: "aaa-host-packaging-repair",
    target_repo: "across-agents-assistant",
    allowed_patch_paths: [
      "backend/main.py",
      "build_app.sh",
      "scripts/candidate_app_lifecycle.sh",
      "backend/tests/test_live_e2e_infrastructure.py"
    ],
    context_files: [
      "backend/main.py",
      "build_app.sh",
      "scripts/candidate_app_lifecycle.sh"
    ]
  },
  policy_gap: {
    target_id: "aaa-host-policy-repair",
    target_repo: "across-agents-assistant",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/api_server.py",
      "backend/src/across_agents_assistant/loop_engineering_self_iteration.py",
      "backend/tests/test_api_autopilot.py"
    ],
    context_files: [
      "backend/src/across_agents_assistant/api_server.py",
      "backend/src/across_agents_assistant/loop_engineering_self_iteration.py"
    ]
  },
  supervisor_gap: {
    target_id: "autopilot-self-repair-replay-fixture",
    target_repo: "across-autopilot",
    allowed_patch_paths: [
      "tests/platform-self-repair.test.js"
    ],
    context_files: [
      "src/platform-self-repair.js",
      "tests/loop-platform.test.js",
      "examples/aaa-platform-self-repair.loop.json"
    ]
  }
});

export function diagnosePlatformSelfRepair({ spec = {}, failedRun = {}, evidence = {}, triggerItem = null } = {}) {
  const disabledReason = selfRepairDisabledReason(spec, failedRun, triggerItem);
  const triggerPayload = publicTriggerPayload(failedRun?.trigger_event?.payload || triggerItem?.trigger_event?.payload || {});
  const explicitCase = triggerPayload.platform_self_repair_case && typeof triggerPayload.platform_self_repair_case === "object"
    ? triggerPayload.platform_self_repair_case
    : null;
  const observed = collectFailureSignals({ failedRun, evidence, triggerPayload });
  const category = normalizeCategory(explicitCase?.category) || classifyObservedSignals(observed);
  const eligibleCategory = PLATFORM_REPAIR_CATEGORIES.has(category);
  const target = repairTargetForCategory(category);
  const disabled = Boolean(disabledReason);
  const eligible = !disabled && eligibleCategory && Boolean(target);
  const goal = explicitCase?.goal || repairGoal({ category, failedRun, observed, target });
  const diagnosis = {
    schema_version: PLATFORM_SELF_REPAIR_SCHEMA,
    status: eligible ? "ready" : "not_applicable",
    eligible,
    category,
    confidence: eligibleCategory ? (explicitCase ? "fixture" : "medium") : "low",
    reason: disabledReason || (eligibleCategory ? "platform failure is eligible for supervised self-repair" : "failure is not classified as a platform self-repair case"),
    failed_run_id: failedRun?.run_id || evidence?.run_id || null,
    failed_spec_id: spec?.id || failedRun?.spec_id || evidence?.spec_id || null,
    repair_spec_id: PLATFORM_SELF_REPAIR_SPEC_ID,
    target_id: target?.target_id || explicitCase?.target_id || null,
    target_repo: target?.target_repo || explicitCase?.target_repo || null,
    allowed_patch_paths: asArray(explicitCase?.allowed_patch_paths || target?.allowed_patch_paths).slice(0, 16),
    context_files: asArray(explicitCase?.context_files || target?.context_files).slice(0, 16),
    repair_goal: goal,
    observed_signals: observed,
    replay_contract: buildReplayContract({ failedRun, evidence, category, explicitCase }),
    trigger_payload: {
      failed_run_id: failedRun?.run_id || evidence?.run_id || null,
      failed_spec_id: spec?.id || failedRun?.spec_id || evidence?.spec_id || null,
      failure_category: category,
      repair_goal: goal,
      target_id: target?.target_id || explicitCase?.target_id || null,
      target_repo: target?.target_repo || explicitCase?.target_repo || null,
      allowed_patch_paths: asArray(explicitCase?.allowed_patch_paths || target?.allowed_patch_paths).slice(0, 16),
      context_files: asArray(explicitCase?.context_files || target?.context_files).slice(0, 16),
      replay_contract: buildReplayContract({ failedRun, evidence, category, explicitCase }),
      observed_signals: observed.slice(0, 12)
    }
  };
  return diagnosis;
}

export function buildPlatformSelfRepairTrigger(diagnosis, { source = "platform-self-repair-router", actor = "autopilot-supervisor" } = {}) {
  const failedRunId = diagnosis?.failed_run_id || "unknown-run";
  const category = diagnosis?.category || "unknown";
  return {
    type: "daemon",
    source,
    actor,
    payload: {
      schema_version: "across-platform-self-repair-trigger/1.0",
      ...diagnosis.trigger_payload,
      diagnosis: compactDiagnosis(diagnosis)
    },
    idempotency_key: `platform-self-repair:${failedRunId}:${category}`,
    replay_hint: `Replay failed run ${failedRunId} after applying the platform repair candidate.`
  };
}

export function redactTriggerPayload(payload = {}) {
  return publicTriggerPayload(payload);
}

function selfRepairDisabledReason(spec, failedRun, triggerItem) {
  if (spec?.id === PLATFORM_SELF_REPAIR_SPEC_ID || failedRun?.spec_id === PLATFORM_SELF_REPAIR_SPEC_ID) {
    return "platform self-repair does not recursively repair itself";
  }
  const payload = failedRun?.trigger_event?.payload || triggerItem?.trigger_event?.payload || {};
  const enabled = payload.auto_platform_self_repair === true
    || spec?.failure_policy?.platform_self_repair?.enabled === true
    || spec?.pack_config?.platform_self_repair?.enabled === true;
  return enabled ? null : "platform self-repair is not enabled for this run";
}

function classifyObservedSignals(observed) {
  const text = observed.map((item) => `${item.kind || ""} ${item.code || ""} ${item.adapter_id || ""} ${item.text || ""}`).join("\n").toLowerCase();
  if (!text.trim()) return "unknown";
  if (/(source\.unreachable|source\.rate_limited|context\.unavailable|network|timeout|rate limit|dns|provider|api key|credential)/.test(text)) {
    return "infrastructure_failure";
  }
  if (/(sandbox\.violation|approval\.required|merge_pr|release_publish|write_secret|sign_artifact)/.test(text)) {
    return "security_policy_stop";
  }
  if (candidateValidationStoppedBadCandidate(observed)) {
    return "candidate_code_failure";
  }
  if (/(candidate_ecosystem_validation)/.test(text)
    && /(internal operation failed|python_version_incompatible|candidate_test_assertion|candidate_exception|candidate_import_failure)/.test(text)
    && !platformValidationGapSignal(text)) {
    return "candidate_code_failure";
  }
  if (/(candidate_ecosystem_validation)/.test(text)
    && /(traceback|filenotfounderror|syntaxerror|assertionerror|typeerror|valueerror|pytest|test failed|py_compile|lint failed)/.test(text)
    && !platformValidationGapSignal(text)) {
    return "candidate_code_failure";
  }
  if (/(syntaxerror|assertionerror|pytest|test failed|py_compile|lint failed)/.test(text)
    && !platformValidationGapSignal(text)) {
    return "candidate_code_failure";
  }
  if (/(autopilot-review-decision|missing_subcommand|packaged backend|candidate app lifecycle|build_app|module executable|subcommand)/.test(text)) {
    return "packaging_gap";
  }
  if (/(candidate_ecosystem_validation)/.test(text)
    && /(modulenotfounderror|importerror|nameerror|missing internal api import|undeclared runtime dependency|aaa backend api import contract)/.test(text)
    && !platformValidationGapSignal(text)) {
    return "candidate_code_failure";
  }
  if (/(runtime preflight|backend runtime)/.test(text)) {
    return "runtime_gap";
  }
  if (platformValidationGapSignal(text)) {
    return "validation_gap";
  }
  if (/(host_validation_repair_fallback|selected path is outside target catalog|generated target|allowed_patch_paths|research decision|fallback)/.test(text)) {
    return "policy_gap";
  }
  if (/(trigger queue|runqueuedtrigger|self-repair|supervisor|queue status|dispatch)/.test(text)) {
    return "supervisor_gap";
  }
  if (/(model returned|invalid json|no patches|empty patch|model output)/.test(text)) {
    return "model_output_failure";
  }
  return "unknown";
}

function candidateValidationStoppedBadCandidate(observed) {
  return observed.some((item) => (
    item.kind === "validation_command"
    && item.adapter_id === "candidate_ecosystem_validation"
    && /(candidate_quality|unintegrated_candidate_helper|destructive_product_entrypoint_rewrite|excessive_blank_lines|placeholder_implementation|unsafe_shell_execution|hardcoded_secret_literal|pytest_dependency_in_candidate_test|undeclared runtime dependency|aaa backend api import contract)/i.test(String(item.text || ""))
  ));
}

function platformValidationGapSignal(text) {
  return /(validation gap|validator|validation finding|not blocking|not promoted into a blocking command|failed to block|missing deterministic validation)/.test(text);
}

function collectFailureSignals({ failedRun = {}, evidence = {}, triggerPayload = {} } = {}) {
  const signals = [];
  const push = (kind, value = {}) => {
    const text = String(value.message || value.stderr || value.stdout || value.summary || value.reason || value.text || "").trim();
    const code = value.code || value.failure?.code || null;
    const adapter = value.adapter_id || value.adapter || value.failure?.adapter_id || null;
    if (!text && !code && !adapter) return;
    signals.push({
      kind,
      code,
      adapter_id: adapter,
      text: text.slice(0, 700)
    });
  };
  push("run_failure", failedRun.failure || evidence.failure || {});
  for (const action of asArray(evidence.actions).slice(-12)) {
    push("action", {
      adapter: action.adapter,
      code: action.failure?.code,
      message: action.failure?.message || action.result?.summary || action.status
    });
    for (const command of asArray(action.result?.commands).filter((item) => item?.status && item.status !== "passed").slice(0, 8)) {
      push("validation_command", {
        adapter: action.adapter,
        code: action.failure?.code,
        summary: [
          command.summary,
          command.diagnostic?.failure_kind,
          command.diagnostic?.failure_summary
        ].filter(Boolean).join(": "),
        stdout: command.stdout,
        stderr: command.stderr || [command.command, ...asArray(command.args)].join(" ")
      });
    }
  }
  for (const gate of asArray(evidence.gates).filter((item) => item?.status && item.status !== "passed").slice(0, 8)) {
    push("gate", { code: gate.id, message: gate.summary || gate.message || gate.status });
  }
  if (triggerPayload.platform_self_repair_case) {
    push("trigger_case", {
      code: triggerPayload.platform_self_repair_case.category,
      message: triggerPayload.platform_self_repair_case.goal || triggerPayload.platform_self_repair_case.summary
    });
  }
  return signals.slice(0, 30);
}

function repairTargetForCategory(category) {
  return TARGETS[category] || null;
}

function repairGoal({ category, failedRun, observed, target }) {
  const primary = observed[0]?.text || "Platform failure was detected during loop engineering.";
  return [
    `Repair ${category || "platform_gap"} exposed by failed run ${failedRun?.run_id || "unknown"}.`,
    `Target repo: ${target?.target_repo || "Across platform"}.`,
    "Implement a general platform fix, add regression coverage, and keep merge/release human-approved.",
    `Primary signal: ${primary}`
  ].join(" ");
}

function buildReplayContract({ failedRun = {}, evidence = {}, category, explicitCase = null } = {}) {
  return {
    schema_version: "across-platform-self-repair-replay/1.0",
    failed_run_id: failedRun?.run_id || evidence?.run_id || null,
    failed_spec_id: failedRun?.spec_id || evidence?.spec_id || null,
    category: category || "unknown",
    required: true,
    replay_hint: explicitCase?.replay_hint || "Replay the original failure or a minimized fixture before promotion.",
    expected_after_repair: explicitCase?.expected_after_repair || "platform gap is caught earlier or resolved by deterministic validation"
  };
}

function compactDiagnosis(diagnosis = {}) {
  return {
    schema_version: diagnosis.schema_version,
    eligible: Boolean(diagnosis.eligible),
    category: diagnosis.category,
    confidence: diagnosis.confidence,
    failed_run_id: diagnosis.failed_run_id,
    failed_spec_id: diagnosis.failed_spec_id,
    target_id: diagnosis.target_id,
    target_repo: diagnosis.target_repo,
    repair_goal: diagnosis.repair_goal,
    observed_signal_count: asArray(diagnosis.observed_signals).length
  };
}

function normalizeCategory(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  if (PLATFORM_REPAIR_CATEGORIES.has(text) || NON_REPAIR_CATEGORIES.has(text)) return text;
  return null;
}

function publicTriggerPayload(payload = {}) {
  return sanitizeValue(payload, 0);
}

function sanitizeValue(value, depth) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|token|credential|password|api[_-]?key|authorization|transcript|raw/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitizeValue(item, depth + 1);
      }
    }
    return output;
  }
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated ${value.length - 2000} chars]` : value;
  }
  return value;
}

export function renderTriggerPayloadSource(payload = {}) {
  const sanitized = publicTriggerPayload(payload);
  return {
    kind: "trigger_payload",
    title: "Loop trigger payload",
    content: stableJson(sanitized),
    payload: sanitized
  };
}
