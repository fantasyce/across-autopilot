import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./json-utils.js";
import { FAILURE_CODES, LoopFailure } from "./failures.js";

export const LOOP_SPEC_SCHEMA = "across-loop-spec/1.0";
export const EVIDENCE_SCHEMA = "across-loop-evidence/1.0";
export const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export const BUILT_IN_SPEC_PATHS = Object.freeze({
  "aaa-autonomous-self-iteration": join(PACKAGE_ROOT, "examples", "aaa-autonomous-self-iteration.loop.json"),
  "aaa-self-iteration-product": join(PACKAGE_ROOT, "examples", "aaa-self-iteration-product.loop.json"),
  "aaa-research-driven-self-iteration": join(PACKAGE_ROOT, "examples", "aaa-research-driven-self-iteration.loop.json"),
  "aaa-release-readiness-gate": join(PACKAGE_ROOT, "examples", "aaa-release-readiness-gate.loop.json"),
  "plugin-compatibility-lab-v2": join(PACKAGE_ROOT, "examples", "plugin-compatibility-lab-v2.loop.json"),
  "repo-quality-copilot": join(PACKAGE_ROOT, "examples", "repo-quality-copilot.loop.json"),
  "github-plugin-radar": join(PACKAGE_ROOT, "examples", "github-plugin-radar.loop.json"),
  "daily-news-brief": join(PACKAGE_ROOT, "examples", "daily-news-brief.loop.json")
});

const VALID_TRIGGERS = new Set(["manual", "cron", "webhook", "orchestrator_event", "memory_pending", "file_change", "daemon"]);
const VALID_OUTPUT_POLICIES = new Set(["create", "overwrite", "append"]);
const VALID_RISK_PROFILES = new Set(["low", "medium", "high", "release"]);
const VALID_NETWORK_POLICIES = new Set(["none", "adapter_scoped", "allowlist", "unrestricted_requires_approval"]);
const VALID_FILESYSTEM_POLICIES = new Set(["read_only", "run_scoped", "candidate_workspace_only", "allowlist"]);
const TERMINAL_MUTATING_ACTIONS = new Set(["write_secret", "merge_pr", "release_publish", "sign_artifact", "payment", "publish_video"]);
const AUTONOMY_BY_ACTION = new Map([
  ["web_search", 1],
  ["file_read", 1],
  ["git_read", 1],
  ["write_pending_memory", 1],
  ["read_only_analysis", 1],
  ["source_digest", 1],
  ["workflow_pack_export", 1],
  ["license_check", 1],
  ["manifest_inspection", 1],
  ["dependency_risk_check", 1],
  ["compatibility_scoring", 2],
  ["report_generation", 2],
  ["quality_gate_evaluation", 2],
  ["orchestrator_task_dispatch", 2],
  ["candidate_diff_summary", 2],
  ["candidate_ecosystem_acquire", 3],
  ["product_iteration_strategy", 3],
  ["host_code_iteration", 3],
  ["candidate_ecosystem_diff", 3],
  ["candidate_ecosystem_validation", 3],
  ["candidate_app_lifecycle", 3],
  ["candidate_self_hosting_probe", 3],
  ["local_file_write", 3],
  ["candidate_workspace_patch", 3],
  ["candidate_validation", 3],
  ["promotion_report_generation", 3],
  ["github_issue_draft", 4],
  ["pull_request_draft", 4],
  ["merge_pr", 5],
  ["release_publish", 5],
  ["sign_artifact", 5],
  ["write_secret", 5],
  ["publish_video", 5]
]);

export async function loadLoopSpec(pathOrId) {
  const path = BUILT_IN_SPEC_PATHS[pathOrId] || pathOrId;
  return readJson(resolve(path));
}

export async function loadBuiltInSpecs() {
  const specs = [];
  for (const [id, path] of Object.entries(BUILT_IN_SPEC_PATHS)) {
    const spec = await loadLoopSpec(path);
    specs.push(summarizeLoopSpec(spec, { id, builtIn: true }));
  }
  return specs;
}

export function summarizeLoopSpec(spec, { id = null, builtIn = false, sourcePath = null, paused = false } = {}) {
  const specId = id || spec?.id;
  return {
    id: specId,
    title: spec?.name || spec?.title || specId,
    description: spec?.description || null,
    schema_version: spec?.schema_version || null,
    trigger: spec?.trigger || null,
    execute: spec?.execute || null,
    required_capabilities: asArray(spec?.required_capabilities),
    runtime_policy: normalizeRuntimePolicy(spec),
    outputs: Array.isArray(spec?.outputs)
      ? spec.outputs.map((output) => ({
          id: output.id || output.type || null,
          adapter: output.adapter || output.type || null,
          required: output.required !== false
        }))
      : [],
    built_in: Boolean(builtIn),
    source_path: sourcePath || null,
    paused: Boolean(paused)
  };
}

export function migrateLoopSpec(spec, { targetSchema = LOOP_SPEC_SCHEMA } = {}) {
  const sourceSchema = spec?.schema_version || "unknown";
  if (targetSchema !== LOOP_SPEC_SCHEMA) {
    throw validationFailure(`Unsupported target schema: ${targetSchema}`, "schema_version");
  }
  if (sourceSchema === LOOP_SPEC_SCHEMA) {
    return {
      schema_version: "across-loop-spec-migration/1.0",
      source_schema: sourceSchema,
      target_schema: targetSchema,
      changed_paths: [],
      warnings: [],
      execution_allowed: true,
      spec
    };
  }
  const parsed = parseSchemaVersion(sourceSchema);
  if (!parsed || parsed.name !== "across-loop-spec") {
    throw validationFailure(`Unsupported schema_version: ${sourceSchema}`, "schema_version");
  }
  if (parsed.major !== 1) {
    throw validationFailure(`Unsupported LoopSpec major version: ${sourceSchema}`, "schema_version");
  }
  const migrated = { ...spec, schema_version: targetSchema };
  return {
    schema_version: "across-loop-spec-migration/1.0",
    source_schema: sourceSchema,
    target_schema: targetSchema,
    changed_paths: ["schema_version"],
    warnings: [`Migrated compatible minor schema ${sourceSchema} to ${targetSchema}.`],
    execution_allowed: true,
    spec: migrated
  };
}

export function validateLoopSpec(spec, registry) {
  const errors = [];
  const warnings = [];
  const fail = (path, message) => errors.push({ path, message });

  if (!spec || typeof spec !== "object") fail("$", "LoopSpec must be an object.");
  if (spec?.schema_version !== LOOP_SPEC_SCHEMA) fail("schema_version", `Expected ${LOOP_SPEC_SCHEMA}.`);
  for (const field of ["id", "name", "description", "owner", "compatibility", "required_capabilities", "trigger", "scope", "autonomy", "actions", "execute", "outputs", "gates", "memory", "failure_policy", "sandbox", "evidence_contract", "used_adapters"]) {
    if (spec?.[field] === undefined) fail(field, "Required field is missing.");
  }
  if (spec?.id && !/^[a-z0-9][a-z0-9-_.]*$/.test(String(spec.id))) fail("id", "id must be stable lowercase identifier.");
  if (!VALID_TRIGGERS.has(spec?.trigger?.type)) fail("trigger.type", "Unsupported trigger type.");
  if (!Number.isInteger(spec?.autonomy?.level) || spec.autonomy.level < 0 || spec.autonomy.level > 5) {
    fail("autonomy.level", "Autonomy level must be an integer from 0 to 5.");
  }
  if (spec?.execute?.engine !== "across-orchestrator") fail("execute.engine", "Execution engine must be across-orchestrator.");
  if (spec?.execute?.mode !== "task") fail("execute.mode", "Execution mode must be task.");
  if (spec?.memory?.provider !== "across-context") fail("memory.provider", "Memory provider must be across-context.");
  if (spec?.memory?.write_status !== "pending") fail("memory.write_status", "Automatic memory writes must be pending.");
  if (spec?.evidence_contract?.schema_version !== EVIDENCE_SCHEMA) fail("evidence_contract.schema_version", `Expected ${EVIDENCE_SCHEMA}.`);
  if (!Array.isArray(spec?.required_capabilities) || spec.required_capabilities.length === 0) {
    fail("required_capabilities", "At least one required capability must be declared.");
  } else {
    for (const [index, capability] of spec.required_capabilities.entries()) {
      if (!String(capability || "").trim()) fail(`required_capabilities.${index}`, "Capability id must be a non-empty string.");
    }
  }
  validateModelPolicy(spec, fail, warnings);
  validateRuntimePolicy(spec, fail, warnings);

  const allowed = new Set(asArray(spec?.actions?.allowed));
  const blocked = new Set(asArray(spec?.actions?.blocked));
  for (const action of allowed) {
    if (blocked.has(action)) fail("actions", `Action ${action} is both allowed and blocked.`);
    const requiredLevel = AUTONOMY_BY_ACTION.get(action);
    if (requiredLevel === undefined && !registry?.hasAction(action)) {
      fail("actions.allowed", `Unknown action ${action}.`);
    }
    if (requiredLevel !== undefined && requiredLevel > spec.autonomy.level) {
      fail("actions.allowed", `Action ${action} requires autonomy level ${requiredLevel}.`);
    }
    if (TERMINAL_MUTATING_ACTIONS.has(action) && spec.autonomy.level < 5) {
      fail("actions.allowed", `Action ${action} requires L5 approval.`);
    }
  }

  for (const output of asArray(spec?.outputs)) {
    if (!output?.type) fail("outputs", "Every output requires type.");
    if (!output?.to) fail(`outputs.${output?.type || "unknown"}.to`, "Every output requires to.");
    if (!VALID_OUTPUT_POLICIES.has(output?.policy)) fail(`outputs.${output?.type || "unknown"}.policy`, "Unsupported output policy.");
    if (String(output?.type || "").includes("publish") && spec.autonomy.level < 5) {
      fail(`outputs.${output.type}`, "Publishing output requires L5 approval.");
    }
  }

  validateAdapters("sources", spec?.used_adapters?.sources, registry, fail, warnings);
  validateAdapters("actions", spec?.used_adapters?.actions, registry, fail, warnings);
  validateAdapters("outputs", spec?.used_adapters?.outputs, registry, fail, warnings);

  if (errors.length) {
    throw validationFailure("LoopSpec validation failed.", "LoopSpec", errors, warnings);
  }
  return {
    schema_version: "across-loop-validation/1.0",
    valid: true,
    spec_id: spec.id,
    warnings,
    required_capabilities: asArray(spec.required_capabilities),
    runtime_policy: normalizeRuntimePolicy(spec)
  };
}

export function normalizeRuntimePolicy(spec) {
  const policy = spec?.runtime_policy || spec?.pack_config?.runtime_policy || {};
  const timeoutPolicy = policy.timeouts || {};
  const budgetPolicy = policy.budget || {};
  const networkPolicy = normalizePolicyObject(policy.network_policy, spec?.sandbox?.network || "adapter_scoped");
  const filesystemPolicy = normalizePolicyObject(policy.filesystem_policy, spec?.sandbox?.filesystem || "run_scoped");
  return {
    schema_version: "across-loop-runtime-policy/1.0",
    risk_profile: String(policy.risk_profile || "medium"),
    timeouts: {
      total_run_timeout_ms: Number(timeoutPolicy.total_run_timeout_ms ?? timeoutPolicy.run_timeout_ms ?? 1_200_000),
      adapter_timeout_ms: Number(timeoutPolicy.adapter_timeout_ms ?? 120_000),
      model_timeout_ms: Number(timeoutPolicy.model_timeout_ms ?? 240_000)
    },
    budget: {
      max_model_calls: Number(budgetPolicy.max_model_calls ?? 12),
      max_candidate_repairs: Number(budgetPolicy.max_candidate_repairs ?? 3),
      max_usd: Number(budgetPolicy.max_usd ?? 0)
    },
    network_policy: {
      mode: networkPolicy.mode,
      allowlist: asArray(networkPolicy.allowlist).map(String)
    },
    filesystem_policy: {
      mode: filesystemPolicy.mode,
      allowlist_roots: asArray(filesystemPolicy.allowlist_roots || filesystemPolicy.allowlist).map(String)
    },
    promotion: {
      human_approval_required: policy.promotion?.human_approval_required !== false,
      merge_release_signing_blocked: policy.promotion?.merge_release_signing_blocked !== false
    }
  };
}

function normalizePolicyObject(value, fallbackMode) {
  if (typeof value === "string") return { mode: value };
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value, mode: value.mode || fallbackMode };
  return { mode: fallbackMode };
}

function validateRuntimePolicy(spec, fail, warnings) {
  const raw = spec?.runtime_policy || spec?.pack_config?.runtime_policy;
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    fail("runtime_policy", "runtime_policy must be an object.");
    return;
  }
  const policy = normalizeRuntimePolicy(spec);
  if (!VALID_RISK_PROFILES.has(policy.risk_profile)) {
    fail("runtime_policy.risk_profile", "Unsupported risk profile.");
  }
  if (!VALID_NETWORK_POLICIES.has(policy.network_policy.mode)) {
    fail("runtime_policy.network_policy.mode", "Unsupported network policy mode.");
  }
  if (policy.network_policy.mode === "allowlist" && !policy.network_policy.allowlist.length) {
    fail("runtime_policy.network_policy.allowlist", "Network allowlist mode requires at least one allowlist entry.");
  }
  if (policy.network_policy.allowlist.some((item) => item === "*" || item.includes("://*"))) {
    fail("runtime_policy.network_policy.allowlist", "Network allowlist entries must be explicit hosts or URLs.");
  }
  if (!VALID_FILESYSTEM_POLICIES.has(policy.filesystem_policy.mode)) {
    fail("runtime_policy.filesystem_policy.mode", "Unsupported filesystem policy mode.");
  }
  if (policy.filesystem_policy.mode === "allowlist" && !policy.filesystem_policy.allowlist_roots.length) {
    fail("runtime_policy.filesystem_policy.allowlist_roots", "Filesystem allowlist mode requires at least one root.");
  }
  for (const key of ["total_run_timeout_ms", "adapter_timeout_ms", "model_timeout_ms"]) {
    const value = policy.timeouts[key];
    if (!Number.isFinite(value) || value <= 0) fail(`runtime_policy.timeouts.${key}`, "Timeout must be a positive number.");
  }
  if (policy.timeouts.total_run_timeout_ms > 86_400_000) {
    fail("runtime_policy.timeouts.total_run_timeout_ms", "Total run timeout may not exceed 24 hours.");
  }
  if (policy.timeouts.adapter_timeout_ms > policy.timeouts.total_run_timeout_ms) {
    fail("runtime_policy.timeouts.adapter_timeout_ms", "Adapter timeout may not exceed total run timeout.");
  }
  if (policy.timeouts.model_timeout_ms > policy.timeouts.total_run_timeout_ms) {
    fail("runtime_policy.timeouts.model_timeout_ms", "Model timeout may not exceed total run timeout.");
  }
  if (!Number.isFinite(policy.budget.max_model_calls) || policy.budget.max_model_calls < 0 || policy.budget.max_model_calls > 100) {
    fail("runtime_policy.budget.max_model_calls", "max_model_calls must be between 0 and 100.");
  }
  if (!Number.isFinite(policy.budget.max_candidate_repairs) || policy.budget.max_candidate_repairs < 0 || policy.budget.max_candidate_repairs > 20) {
    fail("runtime_policy.budget.max_candidate_repairs", "max_candidate_repairs must be between 0 and 20.");
  }
  if (!Number.isFinite(policy.budget.max_usd) || policy.budget.max_usd < 0 || policy.budget.max_usd > 1000) {
    fail("runtime_policy.budget.max_usd", "max_usd must be between 0 and 1000.");
  }
  if (policy.promotion.human_approval_required !== true) {
    fail("runtime_policy.promotion.human_approval_required", "Promotion must require human approval.");
  }
  if (policy.promotion.merge_release_signing_blocked !== true) {
    fail("runtime_policy.promotion.merge_release_signing_blocked", "Merge, release, and signing must remain blocked in unattended loops.");
  }
  if (!raw) warnings.push("runtime_policy not declared; default runtime policy applied from sandbox fields.");
}

function validateModelPolicy(spec, fail, warnings) {
  const policy = spec?.model_policy || spec?.pack_config?.model_policy;
  if (policy === undefined) return;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("model_policy", "model_policy must be an object.");
    return;
  }
  const required = Boolean(policy.required);
  if (policy.allowed_patch_paths !== undefined && !Array.isArray(policy.allowed_patch_paths)) {
    fail("model_policy.allowed_patch_paths", "allowed_patch_paths must be an array.");
  }
  if (policy.context_files !== undefined && !Array.isArray(policy.context_files)) {
    fail("model_policy.context_files", "context_files must be an array.");
  }
  if (!required) return;
  const actionPlan = asArray(spec?.used_adapters?.actions);
  const dispatchIndex = actionPlan.indexOf("orchestrator_task_dispatch");
  const patchIndex = actionPlan.indexOf("candidate_workspace_patch");
  const hostCodeIndex = actionPlan.indexOf("host_code_iteration");
  const hasLegacyModelPatchPath = dispatchIndex >= 0 && patchIndex >= 0;
  const hasHostCodePath = hostCodeIndex >= 0;
  if (!hasLegacyModelPatchPath && !hasHostCodePath) {
    fail("used_adapters.actions", "model_policy.required requires either host_code_iteration or orchestrator_task_dispatch plus candidate_workspace_patch.");
  }
  if (dispatchIndex >= 0 && patchIndex >= 0 && dispatchIndex > patchIndex) {
    fail("used_adapters.actions", "orchestrator_task_dispatch must run before candidate_workspace_patch when model_policy.required=true.");
  }
  if (asArray(spec?.pack_config?.iteration_plan?.patches).length) {
    warnings.push("Static iteration_plan.patches are ignored when model_policy.required=true.");
  }
}

function validateAdapters(kind, ids, registry, fail, warnings) {
  const list = asArray(ids);
  if (!list.length) {
    fail(`used_adapters.${kind}`, "At least one adapter must be declared.");
    return;
  }
  for (const id of list) {
    const exists = kind === "sources"
      ? registry?.hasSource(id)
      : kind === "actions"
        ? registry?.hasAction(id)
        : registry?.hasOutput(id);
    if (!exists) fail(`used_adapters.${kind}`, `Adapter ${id} is not registered.`);
  }
  if (new Set(list).size !== list.length) warnings.push(`Duplicate ${kind} adapter declaration.`);
}

function validationFailure(message, path, errors = [{ path, message }], warnings = []) {
  const failure = new LoopFailure({
    code: FAILURE_CODES.SPEC_INVALID,
    failedState: "validating_spec",
    message,
    evidenceRefs: [],
    recovery: {
      type: "spec_change",
      description: "Fix the LoopSpec validation errors before execution.",
      requires_user_action: true
    },
    retryable: false
  });
  failure.errors = errors;
  failure.warnings = warnings;
  return failure;
}

function parseSchemaVersion(value) {
  const match = String(value || "").match(/^(.+)\/(\d+)\.(\d+)$/);
  if (!match) return null;
  return { name: match[1], major: Number(match[2]), minor: Number(match[3]) };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
