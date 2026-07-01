import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { componentDataHome } from "./paths.js";
import { AUTOPILOT_VERSION } from "./version.js";

const STATE_FILE = "autopilot-state.json";

export function defaultState(now = new Date()) {
  return {
    schema_version: "across-autopilot-state/1.0",
    component_id: "across-autopilot",
    autonomy_level: 1,
    stable_slot: {
      slot: "stable",
      version: AUTOPILOT_VERSION,
      status: "active",
      promoted_at: now.toISOString(),
      source: "local",
      rollback_tag: null
    },
    candidate_slot: null,
    promotion_policy: {
      candidate_cannot_self_approve: true,
      stable_controls_promotion: true,
      previous_stable_is_rollback_target: true,
      max_changed_products_without_review: 1,
      max_autonomy_level_without_human_approval: 1
    },
    guardrails: [
      "no_self_modification_of_running_stable",
      "candidate_runs_in_isolated_branch_or_worktree",
      "all_code_changes_go_through_pr_and_ci",
      "release_requires_evidence_and_rollback_plan",
      "secrets_signing_and_permissions_require_human_approval"
    ],
    promotion_gates: [
      { id: "unit_tests", label: "Unit tests", required: true },
      { id: "integration_tests", label: "Integration tests", required: true },
      { id: "e2e", label: "End-to-end evidence", required: true },
      { id: "ci", label: "GitHub CI", required: false },
      { id: "release_evidence", label: "Release evidence", required: true }
    ],
    candidates: [],
    updated_at: now.toISOString()
  };
}

export async function loadState(options = {}) {
  const path = statePath(options);
  try {
    const payload = JSON.parse(await readFile(path, "utf8"));
    return normalizeState(payload);
  } catch {
    return defaultState();
  }
}

export async function saveState(state, options = {}) {
  const path = statePath(options);
  await mkdir(componentDataHome("across-autopilot", options.env || process.env), { recursive: true });
  const normalized = normalizeState({ ...state, updated_at: new Date().toISOString() });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export async function recordCandidate(candidate, options = {}) {
  const state = await loadState(options);
  const next = {
    ...state,
    candidate_slot: {
      slot: "candidate",
      candidate_id: candidate.candidate_id,
      status: candidate.status,
      target_version: candidate.target_version,
      created_at: candidate.created_at
    },
    candidates: [
      candidate,
      ...(state.candidates || []).filter((item) => item.candidate_id !== candidate.candidate_id)
    ].slice(0, 50)
  };
  return saveState(next, options);
}

export function latestCandidate(state) {
  return (state.candidates || [])[0] || null;
}

export function statePath(options = {}) {
  return join(componentDataHome("across-autopilot", options.env || process.env), STATE_FILE);
}

function normalizeState(state) {
  const fallback = defaultState();
  return {
    ...fallback,
    ...state,
    stable_slot: { ...fallback.stable_slot, ...(state.stable_slot || {}) },
    promotion_policy: { ...fallback.promotion_policy, ...(state.promotion_policy || {}) },
    guardrails: Array.isArray(state.guardrails) ? state.guardrails : fallback.guardrails,
    promotion_gates: Array.isArray(state.promotion_gates) ? state.promotion_gates : fallback.promotion_gates,
    candidates: Array.isArray(state.candidates) ? state.candidates : []
  };
}
