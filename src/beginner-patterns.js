import { createHash } from "node:crypto";
import { BUILT_IN_WORKFLOW_PACKS, validateWorkflowPack } from "./workflow-packs.js";

export const BEGINNER_PATTERN_SCHEMA = "across-beginner-workflow-pattern/1.0";
export const BEGINNER_PATTERN_REGISTRY_SCHEMA = "across-beginner-workflow-pattern-registry/1.0";
export const NO_KEY_DEMO_SCHEMA = "across-no-key-demo/1.0";

const PATTERNS = Object.freeze({
  "first-verified-task": pattern({
    id: "first-verified-task",
    title: "Check my project",
    purpose: "See whether a project has the basic proof needed for a safe next step.",
    loopSpecId: "repo-quality-copilot",
    missionId: "first_verified_task",
    nextAction: "Open the evidence behind the first item that needs attention.",
    nextActionId: "inspect_evidence"
  }),
  "understand-plugin-safety": pattern({
    id: "understand-plugin-safety",
    title: "Check a plugin",
    purpose: "Inspect compatibility and trust boundaries before depending on a plugin.",
    loopSpecId: "plugin-compatibility-lab-v2",
    missionId: "inspect_evidence",
    nextAction: "Review the plugin boundary before choosing whether to install it.",
    nextActionId: "inspect_evidence"
  }),
  "prepare-a-release": pattern({
    id: "prepare-a-release",
    title: "Check release readiness",
    purpose: "Collect release evidence without publishing, signing, or changing the project.",
    loopSpecId: "beginner-release-readiness",
    packId: "release-captain",
    missionId: "release_readiness",
    nextAction: "Resolve the first blocked release check, then run the pattern again.",
    nextActionId: "resolve_first_blocker"
  })
});

export function listBeginnerWorkflowPatterns() {
  const patterns = Object.values(PATTERNS).map((item) => validateBeginnerWorkflowPattern(item));
  return {
    schema_version: BEGINNER_PATTERN_REGISTRY_SCHEMA,
    status: patterns.every((item) => item.valid) ? "ready" : "attention",
    recommended_pattern_id: "first-verified-task",
    patterns
  };
}

export function getBeginnerWorkflowPattern(id = "first-verified-task") {
  const item = PATTERNS[String(id || "")];
  if (!item) throw new Error(`Unknown beginner workflow pattern: ${id}`);
  const validation = validateBeginnerWorkflowPattern(item);
  if (!validation.valid) {
    throw new Error(`Beginner workflow pattern is not runnable: ${validation.errors.join("; ")}`);
  }
  return clone(item);
}

export function validateBeginnerWorkflowPattern(input) {
  const item = clone(input || {});
  const errors = [];
  if (item.schema_version !== BEGINNER_PATTERN_SCHEMA) errors.push(`schema_version must be ${BEGINNER_PATTERN_SCHEMA}`);
  if (!item.id || !item.loop_spec_id) errors.push("id and loop_spec_id are required");
  const questions = item.input_contract?.questions;
  if (!Array.isArray(questions) || questions.length > 2) {
    errors.push("beginner patterns may ask only for a goal and one project folder");
  } else {
    const questionIds = new Set(questions.map((question) => question?.id));
    if (!questionIds.has("goal") || !questionIds.has("project_folder")) {
      errors.push("beginner patterns must bind one goal and one project folder");
    }
  }
  if (item.safe_defaults?.network_policy !== "none") errors.push("network must default to none");
  if (item.safe_defaults?.filesystem_policy !== "read_only") errors.push("filesystem must default to read_only");
  if (item.safe_defaults?.max_model_calls !== 0) errors.push("no-key patterns must use zero model calls");
  if (item.safe_defaults?.external_side_effects_blocked !== true) errors.push("external side effects must be blocked");
  const pack = BUILT_IN_WORKFLOW_PACKS[item.workflow_pack_id];
  if (!pack) {
    errors.push(`workflow pack is missing: ${item.workflow_pack_id}`);
  } else {
    const packValidation = validateWorkflowPack(pack, { throwOnError: false });
    if (!packValidation.valid) errors.push("workflow pack validation failed");
    if (Number(packValidation.runtime_policy?.budget?.max_model_calls) !== 0) errors.push("workflow pack requires model calls");
    if (packValidation.runtime_policy?.network_policy?.mode !== "none") errors.push("workflow pack requires network access");
    if (packValidation.runtime_policy?.promotion?.merge_release_signing_blocked !== true) errors.push("workflow pack may mutate release state");
  }
  return {
    ...item,
    valid: errors.length === 0,
    status: errors.length ? "attention" : "ready",
    errors
  };
}

export function buildNoKeyDemo(patternId = "first-verified-task") {
  const item = getBeginnerWorkflowPattern(patternId);
  const payload = {
    schema_version: NO_KEY_DEMO_SCHEMA,
    status: "ready",
    pattern_id: item.id,
    mission_id: item.mission_id,
    title: item.title,
    purpose: item.purpose,
    loop_spec_id: item.loop_spec_id,
    command: `across-autopilot beginner-pattern run --pattern ${item.id} --goal "<describe your goal>" --json`,
    requirements: {
      goal: true,
      project_folder: true,
      provider_key: false,
      network: false,
      model_calls: 0,
      external_side_effects: false
    },
    expected_result: item.result_contract,
    next_action: item.next_action,
    next_action_id: item.next_action_id
  };
  return { ...payload, contract_sha256: sha256(payload) };
}

export function renderNoKeyDemoResult(patternId, result = {}, options = {}) {
  const demo = buildNoKeyDemo(patternId);
  const run = result.run || {};
  const evidence = result.evidence || {};
  const budget = evidence.runtime_budget || {};
  const gates = Array.isArray(evidence.gates) ? evidence.gates : [];
  const payload = {
    schema_version: "across-no-key-demo-result/1.0",
    pattern_id: demo.pattern_id,
    mission_id: demo.mission_id,
    run_id: run.run_id || evidence.run_id || null,
    status: run.status || evidence.status || "unknown",
    verdict: gates.some((gate) => gate.required && gate.status !== "passed") ? "needs_attention" : "verified",
    evidence_route: (run.run_id || evidence.run_id) ? `run://${run.run_id || evidence.run_id}/evidence` : null,
    gates: gates.map((gate) => ({ id: gate.id, status: gate.status, required: Boolean(gate.required) })),
    policy: {
      provider_key_used: false,
      network_used: false,
      model_calls: Number(budget.usage?.model_calls || 0),
      external_side_effects_performed: false
    },
    evidence_sha256: evidence.integrity?.root_hash || null,
    goal_sha256: goalSha256(options.goal),
    next_action: demo.next_action,
    next_action_id: demo.next_action_id
  };
  return { ...payload, result_sha256: sha256(payload) };
}

function pattern({ id, title, purpose, loopSpecId, packId = null, missionId, nextAction, nextActionId }) {
  return Object.freeze({
    schema_version: BEGINNER_PATTERN_SCHEMA,
    id,
    title,
    purpose,
    mission_id: missionId,
    workflow_pack_id: packId || loopSpecId,
    loop_spec_id: loopSpecId,
    input_contract: {
      questions: [
        { id: "goal", label: "What do you want to understand?", type: "goal", required: true },
        { id: "project_folder", label: "Choose a project", type: "directory", required: true }
      ]
    },
    safe_defaults: {
      risk_profile: "low",
      network_policy: "none",
      filesystem_policy: "read_only",
      max_model_calls: 0,
      external_side_effects_blocked: true,
      promotion_requires_human_approval: true
    },
    result_contract: {
      schema_version: "across-beginner-result/1.0",
      fields: ["verdict", "evidence_route", "goal_sha256", "next_action_id", "next_action"],
      raw_details_collapsed: true
    },
    next_action: nextAction,
    next_action_id: nextActionId
  });
}

function goalSha256(value) {
  const normalized = String(value || "").trim();
  return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
