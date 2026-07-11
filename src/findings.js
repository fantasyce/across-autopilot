import { createHash } from "node:crypto";
import { stableJson } from "./json-utils.js";

export const FINDING_SCHEMA_VERSION = "across-autopilot-finding/1.0";
export const PUSH_RECEIPT_SCHEMA_VERSION = "across-autopilot-push-receipt/1.0";
export const LOCAL_PATH_REDACTION = "[REDACTED_LOCAL_PATH]";

export const FINDING_STATES = [
  "pass",
  "auto_fix_available",
  "ask_user",
  "blocked",
  "no_op",
  "failed"
];

const FINDING_STATE_SET = new Set(FINDING_STATES);

const STATE_ALIASES = new Map([
  ["ok", "pass"],
  ["passed", "pass"],
  ["success", "pass"],
  ["succeeded", "pass"],
  ["fixed", "pass"],
  ["auto-fix", "auto_fix_available"],
  ["autofix", "auto_fix_available"],
  ["auto_fix", "auto_fix_available"],
  ["fix_available", "auto_fix_available"],
  ["needs_fix", "auto_fix_available"],
  ["needs-user", "ask_user"],
  ["needs_user", "ask_user"],
  ["needs_input", "ask_user"],
  ["user_input", "ask_user"],
  ["manual", "ask_user"],
  ["skipped", "no_op"],
  ["noop", "no_op"],
  ["no-op", "no_op"],
  ["error", "failed"],
  ["failure", "failed"],
  ["fail", "failed"]
]);

const FINDING_KEYS = [
  "schema_version",
  "id",
  "state",
  "summary",
  "details",
  "severity",
  "source",
  "source_gate",
  "owner",
  "suggested_action",
  "file",
  "line",
  "repair_round",
  "evidence",
  "evidence_refs",
  "metadata"
];

const RECEIPT_KEYS = [
  "schema_version",
  "repository",
  "base_ref",
  "head_ref",
  "head_sha",
  "dirty_tree",
  "diff_summary",
  "findings",
  "gate_verdict",
  "evidence_hash",
  "pr_ready_summary"
];

export function normalizeFinding(finding = {}, options = {}) {
  const input = finding && typeof finding === "object" ? finding : { summary: finding };
  const index = options.index ?? 0;
  const summary = cleanString(input.summary || input.title || input.message || input.description);
  const id = cleanString(input.id || input.code || input.key) || `finding-${index + 1}`;
  const severity = cleanString(input.severity || input.level) || "info";
  const explicitState = cleanString(input.state || input.status || input.verdict);
  const explicitSeverity = input.severity !== undefined || input.level !== undefined;
  const normalized = {
    schema_version: FINDING_SCHEMA_VERSION,
    id,
    state: normalizeFindingState(explicitState || (explicitSeverity ? stateFromSeverity(severity) : undefined)),
    summary: summary || id,
    details: cleanString(input.details || input.detail || input.body || input.excerpt) || null,
    severity,
    source: cleanString(input.source || input.adapter || input.check) || null,
    source_gate: cleanString(input.source_gate || input.sourceGate || input.gate) || null,
    owner: cleanString(input.owner || input.repo || input.repository) || null,
    suggested_action: cleanString(input.suggested_action || input.suggestedAction || input.remediation) || null,
    file: cleanString(input.file || input.path) || null,
    line: normalizePositiveInteger(input.line),
    repair_round: normalizeOptionalNonNegativeInteger(input.repair_round ?? input.repairRound),
    evidence: cleanEvidence(input.evidence),
    evidence_refs: normalizeStringArray(input.evidence_refs || input.evidenceRefs || input.refs),
    metadata: normalizeMetadata(input.metadata)
  };

  return compactOrdered(normalized, FINDING_KEYS);
}

export function normalizeFindings(findings = []) {
  const normalized = asArray(findings).map((finding, index) => normalizeFinding(finding, { index }));
  return normalized.sort((left, right) => (
    stateRank(left.state) - stateRank(right.state)
    || left.id.localeCompare(right.id)
    || left.summary.localeCompare(right.summary)
  ));
}

export function normalizeQualityFindings(findings = []) {
  return normalizeFindings(asArray(findings).map((finding) => {
    const input = finding && typeof finding === "object" ? finding : { summary: finding };
    return {
      ...input,
      source_gate: input.source_gate || input.sourceGate || "candidate_quality",
      owner: input.owner || input.repo || input.repository || null,
      suggested_action: input.suggested_action || input.suggestedAction || qualityFindingAction(input),
      evidence_refs: input.evidence_refs || input.evidenceRefs || input.refs || qualityFindingEvidenceRefs(input)
    };
  }));
}

export function normalizeFindingState(state) {
  const normalized = cleanString(state).toLowerCase().replace(/\s+/g, "_");
  if (FINDING_STATE_SET.has(normalized)) return normalized;
  return STATE_ALIASES.get(normalized) || "failed";
}

export function buildPushReceipt(input = {}) {
  const dirtyTree = Boolean(input.dirty_tree ?? input.dirtyTree);
  const findings = normalizeFindings(input.findings);
  const gateVerdict = normalizeGateVerdict(input.gate_verdict || input.gateVerdict, findings);
  const receiptWithoutHash = compactOrdered({
    schema_version: PUSH_RECEIPT_SCHEMA_VERSION,
    repository: normalizeRepository(input.repository),
    base_ref: cleanString(input.base_ref || input.baseRef) || null,
    head_ref: cleanString(input.head_ref || input.headRef) || null,
    head_sha: cleanString(input.head_sha || input.headSha) || null,
    dirty_tree: dirtyTree,
    diff_summary: normalizeDiffSummary(input.diff_summary || input.diffSummary),
    findings,
    gate_verdict: gateVerdict,
    evidence_hash: null,
    pr_ready_summary: cleanString(input.pr_ready_summary || input.prReadySummary)
      || buildPrReadySummary({
        dirtyTree,
        gateVerdict,
        findings
      })
  }, RECEIPT_KEYS);

  return {
    ...receiptWithoutHash,
    evidence_hash: input.evidence_payload === undefined
      ? hashStableJson({
        ...receiptWithoutHash,
        evidence_hash: null
      })
      : hashStableJson(input.evidence_payload)
  };
}

export function stableReceiptJson(receipt) {
  return stableJson(compactOrdered(receipt, RECEIPT_KEYS));
}

export function hashStableJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function buildPrReadySummary({ dirtyTree = false, gateVerdict = "unknown", findings = [] } = {}) {
  const normalizedFindings = normalizeFindings(findings);
  if (dirtyTree) return "Not PR-ready: working tree has uncommitted changes.";
  const blockingCount = normalizedFindings.filter((finding) => ["ask_user", "blocked", "failed"].includes(finding.state)).length;
  if (blockingCount > 0) return `Not PR-ready: ${blockingCount} blocking finding(s) remain.`;
  const autoFixCount = normalizedFindings.filter((finding) => finding.state === "auto_fix_available").length;
  if (autoFixCount > 0) return `Not PR-ready: apply ${autoFixCount} available auto-fix(es) first.`;
  if (gateVerdict !== "pass") return `Not PR-ready: gate verdict is ${gateVerdict}.`;
  return "PR-ready: checks passed with no blocking findings.";
}

function normalizeGateVerdict(verdict, findings = []) {
  const explicit = cleanString(verdict).toLowerCase().replace(/\s+/g, "_");
  if (["pass", "warn", "fail", "blocked", "unknown"].includes(explicit)) return explicit;

  const states = normalizeFindings(findings).map((finding) => finding.state);
  if (states.includes("failed")) return "fail";
  if (states.some((state) => ["ask_user", "blocked"].includes(state))) return "blocked";
  if (states.includes("auto_fix_available")) return "warn";
  if (states.length > 0 && states.every((state) => ["pass", "no_op"].includes(state))) return "pass";
  return "unknown";
}

function normalizeDiffSummary(summary = {}) {
  const input = summary && typeof summary === "object" ? summary : { text: summary };
  return compactOrdered({
    changed_files: normalizeStringArray(input.changed_files || input.changedFiles || input.files),
    additions: normalizeNonNegativeInteger(input.additions),
    deletions: normalizeNonNegativeInteger(input.deletions),
    text: cleanString(input.text || input.summary) || null
  }, ["changed_files", "additions", "deletions", "text"]);
}

function normalizeRepository(repository) {
  if (!repository) return null;
  if (typeof repository === "string") return cleanString(repository) || null;
  if (typeof repository !== "object") return String(repository);
  return compactOrdered({
    name: cleanString(repository.name || repository.full_name || repository.fullName) || null,
    path: cleanPublicPath(repository.path || repository.root || repository.cwd) || null,
    remote: cleanString(repository.remote || repository.url) || null
  }, ["name", "path", "remote"]);
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function compactOrdered(value, keys) {
  const entries = [];
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (item === undefined) continue;
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function normalizeStringArray(value) {
  return asArray(value)
    .map((item) => cleanString(item))
    .filter(Boolean)
    .sort();
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return null;
  return number;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number);
}

function normalizeOptionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeNonNegativeInteger(value);
}

function stateFromSeverity(severity) {
  switch (cleanString(severity).toLowerCase()) {
    case "blocker":
    case "critical":
    case "error":
    case "high":
      return "blocked";
    case "warn":
    case "warning":
    case "medium":
    case "low":
    case "info":
      return "no_op";
    default:
      return undefined;
  }
}

function stateRank(state) {
  return FINDING_STATES.indexOf(state);
}

function cleanEvidence(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return cleanString(value) || null;
  return stableJson(value);
}

function qualityFindingAction(finding = {}) {
  const severity = cleanString(finding.severity || finding.level).toLowerCase();
  if (["blocker", "critical", "error", "high"].includes(severity)) {
    return "Repair before promotion.";
  }
  if (["warn", "warning", "medium", "low"].includes(severity)) {
    return "Review before promotion.";
  }
  return null;
}

function qualityFindingEvidenceRefs(finding = {}) {
  const refs = [];
  if (finding.repo) refs.push(`repo:${finding.repo}`);
  if (finding.path) refs.push(`file:${finding.path}`);
  if (finding.line) refs.push(`line:${finding.line}`);
  return refs;
}

function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function cleanPublicPath(value) {
  const text = cleanString(value);
  if (!text) return "";
  return text.replace(/(?<![A-Za-z0-9+:])\/Users\/[^\s"'<>),\]}]+/g, LOCAL_PATH_REDACTION);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}
