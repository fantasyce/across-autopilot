import { createHash } from "node:crypto";


export const GOAL_CONTRACT_SCHEMA = "across-goal-contract/1.0";
export const GOAL_CHANGE_PROPOSAL_SCHEMA = "across-goal-change-proposal/1.0";

const executionProfiles = new Set(["direct", "orchestrated", "workflow-pack"]);
const reviewPolicies = new Set(["automatic", "human", "independent_agent", "quality_gate", "security_policy"]);
const proposalOperations = new Set(["add", "replace", "remove"]);
const proposalDecisions = new Set(["pending", "accepted", "partially_accepted", "rejected", "superseded"]);
const hostOwnedPaths = new Set(["/confirmed_by", "/confirmed_at", "/revision", "/goal_id", "/task_id"]);

function isHostOwnedPath(path) {
  return [...hostOwnedPaths].some((owned) => path === owned || path.startsWith(`${owned}/`));
}


function normalizedText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}


function requiredText(value, name) {
  const normalized = normalizedText(value);
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}


function positiveRevision(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}


function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}


function stringList(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return value;
}


function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]));
  }
  return value;
}


function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}


export function criterionId(description, validatorKind) {
  const descriptionValue = requiredText(description, "description");
  const validatorValue = requiredText(validatorKind, "validator_kind").toLowerCase();
  const digest = createHash("sha256").update(`${validatorValue}\n${descriptionValue}`, "utf8").digest("hex");
  return `criterion-${digest.slice(0, 16)}`;
}


export function stableGoalHash(value = {}) {
  const payload = JSON.stringify(sortedJsonValue(objectValue(value, "value")));
  return createHash("sha256").update(payload, "utf8").digest("hex");
}


export function normalizeGoalContract(value = {}) {
  const contract = cloneJson(objectValue(value, "goal contract"));
  if (contract.schema_version !== GOAL_CONTRACT_SCHEMA) throw new TypeError(`schema_version must be ${GOAL_CONTRACT_SCHEMA}`);
  requiredText(contract.goal_id, "goal_id");
  positiveRevision(contract.revision, "revision");
  requiredText(contract.task_id, "task_id");
  requiredText(contract.statement, "statement");
  requiredText(contract.success_outcome, "success_outcome");
  const scope = objectValue(contract.scope, "scope");
  stringList(scope.includes, "scope.includes");
  stringList(scope.excludes, "scope.excludes");
  if (!Array.isArray(contract.acceptance_criteria) || contract.acceptance_criteria.length === 0) {
    throw new TypeError("acceptance_criteria must be a non-empty array");
  }
  const seen = new Set();
  for (const criterion of contract.acceptance_criteria) {
    objectValue(criterion, "criterion");
    const identifier = requiredText(criterion.criterion_id, "criterion_id");
    if (seen.has(identifier)) throw new TypeError(`duplicate criterion_id: ${identifier}`);
    seen.add(identifier);
    requiredText(criterion.description, "criterion description");
    if (typeof criterion.required !== "boolean") throw new TypeError("criterion required must be a boolean");
    requiredText(criterion.validator_kind, "validator_kind");
    if (!reviewPolicies.has(criterion.review_policy)) throw new TypeError("criterion review_policy is invalid");
    requiredText(criterion.source, "criterion source");
  }
  if (!Array.isArray(contract.dependencies)) throw new TypeError("dependencies must be an array");
  if (!executionProfiles.has(contract.execution_profile)) throw new TypeError("execution_profile is invalid");
  requiredText(contract.source, "source");
  if (Boolean(contract.confirmed_by) !== Boolean(contract.confirmed_at)) {
    throw new TypeError("confirmed_by and confirmed_at must be supplied together");
  }
  requiredText(contract.created_at, "created_at");
  stableGoalHash(contract);
  return contract;
}


export function normalizeGoalChangeProposal(value = {}) {
  const proposal = cloneJson(objectValue(value, "goal change proposal"));
  if (proposal.schema_version !== GOAL_CHANGE_PROPOSAL_SCHEMA) {
    throw new TypeError(`schema_version must be ${GOAL_CHANGE_PROPOSAL_SCHEMA}`);
  }
  requiredText(proposal.proposal_id, "proposal_id");
  requiredText(proposal.goal_id, "goal_id");
  positiveRevision(proposal.base_goal_revision, "base_goal_revision");
  requiredText(proposal.proposed_by, "proposed_by");
  requiredText(proposal.reason, "reason");
  if (!Array.isArray(proposal.operations) || proposal.operations.length === 0) {
    throw new TypeError("operations must be a non-empty array");
  }
  for (const operation of proposal.operations) {
    objectValue(operation, "operation");
    if (!proposalOperations.has(operation.op)) throw new TypeError("proposal operation is invalid");
    const path = requiredText(operation.path, "operation path");
    if (!path.startsWith("/") || isHostOwnedPath(path)) throw new TypeError("proposal operation targets host-owned fields");
    if (operation.op !== "remove" && !("value" in operation)) throw new TypeError("proposal operation value is required");
  }
  const impact = objectValue(proposal.impact_summary, "impact_summary");
  stringList(impact.goal_ids, "impact_summary.goal_ids");
  stringList(impact.criterion_ids, "impact_summary.criterion_ids");
  stringList(impact.evidence_ids, "impact_summary.evidence_ids");
  if (typeof impact.requires_revalidation !== "boolean") {
    throw new TypeError("impact_summary.requires_revalidation must be a boolean");
  }
  objectValue(proposal.risk_summary, "risk_summary");
  objectValue(proposal.estimated_cost, "estimated_cost");
  stringList(proposal.alternatives, "alternatives");
  if (!proposalDecisions.has(proposal.decision_state)) throw new TypeError("decision_state is invalid");
  requiredText(proposal.created_at, "created_at");
  stableGoalHash(proposal);
  return proposal;
}
