export function buildCandidatePlan(options = {}) {
  const goal = normalizeText(options.goal || "Review Across ecosystem improvement opportunities");
  const targetProduct = normalizeProduct(options.targetProduct || options.target_product || "across-autopilot");
  const risk = inferRisk(goal, targetProduct);
  return {
    schema_version: "across-autopilot-candidate-plan/1.0",
    goal,
    target_product: targetProduct,
    proposed_branch_prefix: `autopilot/${slugify(targetProduct)}-${slugify(goal).slice(0, 40)}`,
    autonomy_level: risk === "low" ? 1 : 0,
    risk,
    required_owner: ownerForProduct(targetProduct),
    execution: {
      engine: "across-orchestrator",
      mode: "agent-loop",
      isolated_workspace_required: true,
      candidate_cannot_self_approve: true
    },
    validation_gates: [
      "unit_tests",
      "integration_tests",
      "e2e",
      "ci",
      "release_evidence"
    ],
    memory_policy: {
      provider: "across-context",
      write_candidates_as_pending: true,
      raw_transcripts_allowed: false
    },
    promotion_policy: {
      stable_controls_promotion: true,
      rollback_target_required: true,
      auto_release_allowed: false
    }
  };
}

export function createCandidate(options = {}) {
  const now = options.now || new Date();
  const plan = buildCandidatePlan(options);
  const candidateId = options.candidateId || `cand-${compactTimestamp(now)}-${slugify(plan.target_product)}`;
  return {
    schema_version: "across-autopilot-candidate/1.0",
    candidate_id: candidateId,
    status: "planned",
    created_at: now.toISOString(),
    target_version: options.targetVersion || options.target_version || null,
    base_version: options.baseVersion || options.base_version || null,
    plan,
    evidence: [],
    promotion: {
      readiness: "not_ready",
      reason: "No validation evidence has been attached."
    }
  };
}

export function evaluateCandidate(candidate, evidence = []) {
  const attached = Array.isArray(evidence) ? evidence : [];
  const gateStatus = summarizeGates(attached);
  const required = ["unit_tests", "integration_tests", "e2e", "release_evidence"];
  const missing = required.filter((gate) => !gateStatus[gate]);
  const failed = attached.filter((item) => item.status === "failed").map((item) => item.id || item.gate_id);
  const readiness = failed.length ? "blocked" : missing.length ? "attention" : "ready";
  return {
    ...candidate,
    status: readiness === "ready" ? "validated" : "planned",
    evidence: attached,
    promotion: {
      readiness,
      required_missing: missing,
      failed_gates: failed,
      recommendation: readiness === "ready"
        ? "Candidate can be promoted through normal PR/release mechanics."
        : "Do not promote until required evidence is complete and passing.",
      candidate_cannot_self_approve: true
    }
  };
}

export function buildPromotionReport(candidate, stableSlot = {}) {
  const evaluated = candidate.promotion ? candidate : evaluateCandidate(candidate, candidate.evidence || []);
  return {
    schema_version: "across-autopilot-promotion-report/1.0",
    generated_at: new Date().toISOString(),
    candidate_id: evaluated.candidate_id,
    target_product: evaluated.plan?.target_product,
    target_version: evaluated.target_version,
    readiness: evaluated.promotion.readiness,
    recommendation: evaluated.promotion.recommendation,
    stable_slot: stableSlot,
    rollback_target: stableSlot.version || stableSlot.rollback_tag || null,
    gates: {
      required_missing: evaluated.promotion.required_missing || [],
      failed_gates: evaluated.promotion.failed_gates || [],
      evidence_count: (evaluated.evidence || []).length
    },
    safety: {
      candidate_cannot_self_approve: true,
      stable_controls_promotion: true,
      auto_release_allowed: false
    }
  };
}

function summarizeGates(evidence) {
  const result = {};
  for (const item of evidence) {
    const id = String(item.id || item.gate_id || "").trim();
    if (!id) continue;
    result[id] = item.status === "passed";
  }
  return result;
}

function inferRisk(goal, targetProduct) {
  const value = `${goal} ${targetProduct}`.toLowerCase();
  if (/(secret|signing|notar|release|protocol|runtime|payment|credential|permission)/.test(value)) {
    return "high";
  }
  if (/(ui|api|orchestrator|context|autopilot|agent loop|workflow)/.test(value)) {
    return "medium";
  }
  return "low";
}

function ownerForProduct(product) {
  if (product === "across-orchestrator") return "runtime-owner";
  if (product === "across-context") return "memory-owner";
  if (product === "across-agents-assistant") return "host-owner";
  if (product === "across-autopilot") return "automation-owner";
  return "ecosystem-owner";
}

function normalizeProduct(value) {
  const product = String(value || "").trim();
  return product || "across-autopilot";
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work";
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

