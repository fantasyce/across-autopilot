import test from "node:test";
import assert from "node:assert/strict";
import {
  FINDING_STATES,
  LOCAL_PATH_REDACTION,
  buildPushReceipt,
  hashStableJson,
  normalizeFinding,
  normalizeFindingState,
  normalizeFindings,
  normalizeQualityFindings,
  stableReceiptJson
} from "../src/findings.js";

test("finding state normalization is constrained to the stable protocol states", () => {
  assert.deepEqual(FINDING_STATES, [
    "pass",
    "auto_fix_available",
    "ask_user",
    "blocked",
    "no_op",
    "failed"
  ]);
  assert.equal(normalizeFindingState("passed"), "pass");
  assert.equal(normalizeFindingState("auto-fix"), "auto_fix_available");
  assert.equal(normalizeFindingState("needs_input"), "ask_user");
  assert.equal(normalizeFindingState("skipped"), "no_op");
  assert.equal(normalizeFindingState("unexpected-new-state"), "failed");
});

test("normalizeFinding emits a compact stable finding shape", () => {
  const finding = normalizeFinding({
    code: "lint-console",
    status: "error",
    message: "Console statement left in production path",
    level: "warning",
    path: "src/cli.js",
    line: "12",
    refs: ["run:123", "", "gate:lint"],
    sourceGate: "candidate_quality",
    owner: "across-autopilot",
    remediation: "Remove the statement before promotion.",
    repairRound: "2",
    evidence: { command: "npm test", status: "failed" },
    metadata: { command: "npm test", ignored: undefined }
  });

  assert.deepEqual(finding, {
    schema_version: "across-autopilot-finding/1.0",
    id: "lint-console",
    state: "failed",
    summary: "Console statement left in production path",
    details: null,
    severity: "warning",
    source: null,
    source_gate: "candidate_quality",
    owner: "across-autopilot",
    suggested_action: "Remove the statement before promotion.",
    file: "src/cli.js",
    line: 12,
    repair_round: 2,
    evidence: "{\n  \"command\": \"npm test\",\n  \"status\": \"failed\"\n}",
    evidence_refs: ["gate:lint", "run:123"],
    metadata: { command: "npm test" }
  });
});

test("normalizeFinding maps legacy severity to non-breaking protocol states", () => {
  assert.equal(normalizeFinding({ id: "error", severity: "error", message: "Broken" }).state, "blocked");
  assert.equal(normalizeFinding({ id: "warning", severity: "warning", message: "Review" }).state, "no_op");
  assert.equal(normalizeFinding({ id: "explicit", severity: "warning", state: "ask_user", message: "Needs owner" }).state, "ask_user");
});

test("normalizeFinding preserves an explicit zero repair round", () => {
  const finding = normalizeFinding({
    id: "first-round",
    state: "failed",
    summary: "Initial gate round failed.",
    repair_round: 0
  });

  assert.equal(finding.repair_round, 0);
});

test("normalizeQualityFindings annotates candidate gate ownership and actions", () => {
  const findings = normalizeQualityFindings([
    {
      id: "unsafe_shell_execution",
      severity: "error",
      repo: "across-autopilot",
      path: "src/cli.js",
      line: 10,
      message: "candidate code must not introduce shell execution"
    },
    {
      id: "long_source_line",
      severity: "warning",
      repo: "across-autopilot",
      path: "src/cli.js",
      line: 12,
      message: "long source lines reduce reviewability"
    }
  ]);

  const blocking = findings.find((finding) => finding.id === "unsafe_shell_execution");
  const warning = findings.find((finding) => finding.id === "long_source_line");

  assert.deepEqual(findings.map((finding) => finding.state), ["blocked", "no_op"]);
  assert.equal(warning.source_gate, "candidate_quality");
  assert.equal(warning.owner, "across-autopilot");
  assert.equal(warning.suggested_action, "Review before promotion.");
  assert.equal(blocking.suggested_action, "Repair before promotion.");
  assert.deepEqual(blocking.evidence_refs, ["file:src/cli.js", "line:10", "repo:across-autopilot"]);
});

test("normalizeFindings sorts findings by state and id for deterministic receipts", () => {
  const findings = normalizeFindings([
    { id: "z", state: "failed", summary: "Z" },
    { id: "a", state: "pass", summary: "A" },
    { id: "b", state: "blocked", summary: "B" }
  ]);

  assert.deepEqual(findings.map((finding) => finding.id), ["a", "b", "z"]);
  assert.deepEqual(findings.map((finding) => finding.state), ["pass", "blocked", "failed"]);
});

test("buildPushReceipt infers gate verdict and stable evidence hash", () => {
  const receipt = buildPushReceipt({
    repository: {
      path: "/Users/example/Documents/projects/private-repo",
      name: "example",
      remote: "git@example.com:org/repo.git"
    },
    baseRef: "origin/main",
    headRef: "codex/findings",
    headSha: "abc123",
    dirtyTree: false,
    diffSummary: {
      files: ["src/findings.js", "tests/findings.test.js"],
      additions: 120,
      deletions: 0
    },
    findings: [
      { id: "format", state: "pass", summary: "Formatted" },
      { id: "docs", state: "no_op", summary: "No docs required" }
    ]
  });

  assert.equal(receipt.schema_version, "across-autopilot-push-receipt/1.0");
  assert.equal(receipt.repository.path, LOCAL_PATH_REDACTION);
  assert.equal(receipt.base_ref, "origin/main");
  assert.equal(receipt.head_ref, "codex/findings");
  assert.equal(receipt.head_sha, "abc123");
  assert.equal(receipt.dirty_tree, false);
  assert.equal(receipt.gate_verdict, "pass");
  assert.equal(receipt.pr_ready_summary, "PR-ready: checks passed with no blocking findings.");
  assert.match(receipt.evidence_hash, /^[a-f0-9]{64}$/);
  assert.equal(receipt.evidence_hash, hashStableJson({ ...receipt, evidence_hash: null }));
});

test("push receipt hash is independent of finding and object key order", () => {
  const left = buildPushReceipt({
    repository: { remote: "git@example.com:org/repo.git", name: "repo" },
    base_ref: "main",
    head_ref: "feature",
    head_sha: "def456",
    dirty_tree: false,
    diff_summary: { deletions: 1, additions: 2, changed_files: ["b.js", "a.js"] },
    findings: [
      { summary: "B", id: "b", state: "blocked" },
      { state: "pass", id: "a", summary: "A" }
    ]
  });
  const right = buildPushReceipt({
    head_sha: "def456",
    head_ref: "feature",
    base_ref: "main",
    dirty_tree: false,
    repository: { name: "repo", remote: "git@example.com:org/repo.git" },
    findings: [
      { id: "a", summary: "A", state: "pass" },
      { id: "b", state: "blocked", summary: "B" }
    ],
    diff_summary: { additions: 2, changed_files: ["a.js", "b.js"], deletions: 1 }
  });

  assert.equal(left.evidence_hash, right.evidence_hash);
  assert.equal(stableReceiptJson(left), stableReceiptJson(right));
  assert.equal(left.gate_verdict, "blocked");
  assert.equal(left.pr_ready_summary, "Not PR-ready: 1 blocking finding(s) remain.");
});

test("push receipt marks dirty trees as not PR-ready even when checks pass", () => {
  const receipt = buildPushReceipt({
    repository: "example",
    base_ref: "main",
    head_ref: "feature",
    head_sha: "abc123",
    dirty_tree: true,
    findings: [{ id: "tests", state: "pass", summary: "Tests passed" }]
  });

  assert.equal(receipt.gate_verdict, "pass");
  assert.equal(receipt.pr_ready_summary, "Not PR-ready: working tree has uncommitted changes.");
});

test("push receipt treats available auto-fixes as not PR-ready until applied", () => {
  const receipt = buildPushReceipt({
    repository: "example",
    base_ref: "main",
    head_ref: "feature",
    head_sha: "abc123",
    dirty_tree: false,
    findings: [{ id: "format", state: "auto_fix_available", summary: "Formatter can update files" }]
  });

  assert.equal(receipt.gate_verdict, "warn");
  assert.equal(receipt.pr_ready_summary, "Not PR-ready: apply 1 available auto-fix(es) first.");
});
