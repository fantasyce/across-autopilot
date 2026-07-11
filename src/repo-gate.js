import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  buildPushReceipt,
  hashStableJson,
  normalizeFindings
} from "./findings.js";
import { asArray, stableJson } from "./json-utils.js";

const exec = promisify(execFile);

export const GATE_RESULT_SCHEMA_VERSION = "across-autopilot-gate-result/1.0";
export const GATE_CONFIG_SCHEMA_VERSION = "across-autopilot-gate-config/1.0";
export const CI_STATUS_TAXONOMY = Object.freeze([
  "queued",
  "in_progress",
  "passed",
  "failed_lint",
  "failed_test",
  "failed_docs",
  "failed_review",
  "failed_security",
  "failed_other",
  "cancelled",
  "timed_out",
  "unavailable",
  "unknown"
]);

const CONFIG_PATH = ".across/repo-push-gate.json";
const CHECK_CATEGORIES = new Set(["lint", "test", "docs", "review"]);
const TOOL_CATEGORIES = new Set(["secret_scan", "sast", "sbom", "vulnerability"]);
const BLOCKED_EXECUTABLES = new Set([
  "bash", "bun", "cmd", "env", "fish", "npx", "npm", "osascript", "pnpm",
  "powershell", "pwsh", "sh", "yarn", "zsh"
]);
const MANIFEST_PATTERNS = [
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Package\.resolved$/,
  /(^|\/)go\.sum$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)package\.json$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)requirements[^/]*\.txt$/
];
const DEFAULT_GENERATED_PATTERNS = [
  "**/*.generated.*",
  "**/dist/**",
  "**/generated/**",
  "package-lock.json"
];
const DEFAULT_TOOL_CHECKS = [
  {
    id: "gitleaks",
    category: "secret_scan",
    argv: ["gitleaks", "git", ".", "--redact", "--no-banner"],
    required: false,
    timeout_ms: 60_000
  },
  {
    id: "semgrep",
    category: "sast",
    argv: ["semgrep", "scan", "--config", "auto", "--metrics", "off", "--disable-version-check", "--error", "--json", "."],
    required: false,
    network_required: true,
    timeout_ms: 120_000
  },
  {
    id: "syft",
    category: "sbom",
    argv: ["syft", "dir:.", "--output", "cyclonedx-json"],
    required: false,
    timeout_ms: 120_000
  },
  {
    id: "osv-scanner",
    category: "vulnerability",
    argv: ["osv-scanner", "scan", "source", "--format", "json", "--recursive", "."],
    required: false,
    network_required: true,
    timeout_ms: 120_000
  }
];

const DEFAULT_CONFIG = Object.freeze({
  schema_version: GATE_CONFIG_SCHEMA_VERSION,
  id: "built-in-safe-fallback",
  network_policy: "none",
  checks: [],
  tools: DEFAULT_TOOL_CHECKS,
  budget: {
    max_commands: 12,
    max_total_timeout_ms: 600_000,
    max_diff_bytes: 2_000_000,
    max_changed_files: 500,
    max_findings: 250,
    max_output_bytes: 64_000,
    max_repair_actions: 4,
    max_repair_rounds: 2
  },
  ci: { required: false },
  github_remote: {
    enabled: false,
    repository: null,
    allowed_hosts: ["github.com"],
    allowed_operations: [],
    allowed_push_refs: [],
    verification_mode: "auto",
    require_draft: true,
    approval_token_env: "ACROSS_REPO_GATE_APPROVAL_TOKEN",
    approval_token_sha256: null,
    auth_token_env: "GH_TOKEN"
  },
  policies: {
    dirty_tree: "block",
    base_must_be_ancestor: true,
    codeowners: { required: false, require_changed_file_coverage: false },
    generated_files: { mode: "report", patterns: DEFAULT_GENERATED_PATTERNS },
    vulnerability: { required_tool: false }
  }
});

export async function runRepoPushGate(options = {}) {
  const repoRoot = await repositoryRoot(options.repo || options.repository || process.cwd());
  const currentHeadSha = await revParse(repoRoot, "HEAD");
  const baseRef = clean(options.baseRef || options.base_ref) || await defaultBaseRef(repoRoot);
  const headRef = clean(options.headRef || options.head_ref) || "HEAD";
  const baseSha = await revParse(repoRoot, `${baseRef}^{commit}`);
  const headSha = await revParse(repoRoot, `${headRef}^{commit}`);
  const branch = await gitOptional(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remote = sanitizeRemote(await gitOptional(repoRoot, ["config", "--get", "remote.origin.url"]));
  const repositoryName = repositoryNameFromRemote(remote) || basename(repoRoot);
  const statusText = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirtyPaths = statusText.split("\n").map((line) => line.trimEnd()).filter(Boolean).sort();
  const diff = await inspectDiff(repoRoot, baseSha, headSha);
  const mergeBaseSha = await gitOptional(repoRoot, ["merge-base", baseSha, headSha]);
  const baseIsAncestor = await gitSucceeds(repoRoot, ["merge-base", "--is-ancestor", baseSha, headSha]);
  const configPath = safeRepositoryPath(options.configPath || options.config_path || CONFIG_PATH, "config path");
  const loadedConfig = await loadTrustedBaselineConfig(repoRoot, baseSha, configPath);
  const configValidation = normalizeGateConfig(loadedConfig.value);
  const config = configValidation.config;
  const budget = gateBudget(config.budget, options.maxRepairs ?? options.max_repairs);
  const noOp = diff.changed_files.length === 0 && dirtyPaths.length === 0;

  const binding = {
    repository: { name: repositoryName, path: repoRoot, remote },
    base_ref: baseRef,
    base_sha: baseSha,
    head_ref: headRef,
    head_sha: headSha,
    current_head_sha: currentHeadSha,
    branch: branch || null,
    expected_branch: clean(options.branch) || null,
    expected_commit: clean(options.commit || options.expectedHeadSha || options.expected_head_sha) || null,
    expected_base_sha: clean(options.expectedBaseSha || options.expected_base_sha) || null,
    merge_base_sha: mergeBaseSha || null,
    base_is_ancestor: baseIsAncestor,
    dirty_tree: dirtyPaths.length > 0,
    dirty_status_hash: sha256(dirtyPaths.join("\n")),
    dirty_paths: dirtyPaths.map(statusPath).filter(Boolean).sort()
  };

  const preflightFindings = bindingFindings(binding, config, repositoryName);
  if (!loadedConfig.found) {
    preflightFindings.push(gateFinding({
      id: "trusted_config_missing",
      state: "blocked",
      severity: "high",
      summary: `Trusted baseline config ${configPath} is missing from ${baseRef}.`,
      action: `Commit ${configPath} on the trusted base branch before running executable checks.`,
      gate: "trusted_baseline",
      owner: repositoryName,
      evidence: loadedConfig.provenance
    }));
  }
  if (loadedConfig.parse_error) {
    preflightFindings.push(gateFinding({
      id: "trusted_config_invalid_json",
      state: "blocked",
      severity: "high",
      summary: `Trusted baseline config ${configPath} is not valid JSON.`,
      action: "Repair the gate config JSON on the trusted base branch.",
      gate: "trusted_baseline",
      owner: repositoryName,
      evidence: { message: loadedConfig.parse_error }
    }));
  }
  for (const error of configValidation.errors) {
    preflightFindings.push(gateFinding({
      id: `trusted_config_invalid_${slug(error.path)}`,
      state: "blocked",
      severity: "high",
      summary: `Trusted baseline config is invalid at ${error.path}: ${error.message}`,
      action: "Repair the gate config on the trusted base branch.",
      gate: "trusted_baseline",
      owner: repositoryName,
      evidence: error
    }));
  }
  if (diff.patch_bytes > budget.max_diff_bytes || diff.changed_files.length > budget.max_changed_files) {
    preflightFindings.push(gateFinding({
      id: "gate_diff_budget_exhausted",
      state: "blocked",
      severity: "high",
      summary: "Repository diff exceeds the trusted gate budget.",
      action: "Split the change or raise the budget on the trusted base branch.",
      gate: "budget",
      owner: repositoryName,
      evidence: {
        patch_bytes: diff.patch_bytes,
        max_diff_bytes: budget.max_diff_bytes,
        changed_files: diff.changed_files.length,
        max_changed_files: budget.max_changed_files
      }
    }));
  }

  const policy = await evaluatePolicies({ repoRoot, headSha, diff, config, repositoryName, noOp });
  const blockedBeforeExecution = hasBlockingFinding(preflightFindings);
  const commandExecution = await runTrustedChecks({
    descriptors: config.checks,
    repoRoot,
    budget,
    skipReason: noOp ? "no_op" : blockedBeforeExecution ? "preflight_blocked" : null,
    repositoryName,
    sourceGate: "trusted_command"
  });
  const toolExecution = await runTrustedTools({
    descriptors: config.tools,
    repoRoot,
    budget,
    networkPolicy: config.network_policy,
    skipReason: noOp ? "no_op" : blockedBeforeExecution ? "preflight_blocked" : null,
    repositoryName
  });
  const ci = await loadCiSnapshot(
    options.ci || options.ciSnapshot || options.ci_snapshot,
    options.ciPath || options.ci_path,
    {
      waitSeconds: options.ciWaitSeconds ?? options.ci_wait_seconds,
      pollMs: options.ciPollMs ?? options.ci_poll_ms
    }
  );
  const ciFindings = options.deferCiRequirement === true || options.defer_ci_requirement === true
    ? []
    : findingsFromCi(ci, config.ci, repositoryName);
  const toolPolicyFindings = findingsFromToolPolicy(toolExecution.results, config.policies, repositoryName);
  let findings = normalizeFindings([
    ...preflightFindings,
    ...policy.findings,
    ...commandExecution.findings,
    ...toolExecution.findings,
    ...toolPolicyFindings,
    ...ciFindings,
    ...(noOp ? [gateFinding({
      id: "git_no_op",
      state: "no_op",
      severity: "info",
      summary: "No committed or working-tree changes require a push gate.",
      action: null,
      gate: "git_binding",
      owner: repositoryName,
      evidence: { base_sha: baseSha, head_sha: headSha }
    })] : [])
  ]);
  const repair = buildRepairPlan({
    findings,
    config,
    currentRound: Number(options.repairRound ?? options.repair_round ?? 0),
    maxRepairs: budget.max_repair_actions,
    repositoryName
  });
  findings = normalizeFindings([...findings, ...repair.findings]);
  findings = limitFindings(findings, budget.max_findings, repositoryName);
  const gateVerdict = verdictFromFindings(findings);
  const draftPr = buildDraftPrPlan({
    requested: Boolean(options.draftPr ?? options.draft_pr),
    repository: repositoryName,
    baseRef,
    headRef: branch || headRef,
    headSha,
    gateVerdict,
    dirtyTree: binding.dirty_tree,
    noOp
  });
  const checks = {
    commands: commandExecution.results,
    tools: toolExecution.results,
    policies: policy.evidence
  };
  const receiptDraft = buildPushReceipt({
    repository: binding.repository,
    base_ref: baseRef,
    head_ref: branch || headRef,
    head_sha: headSha,
    dirty_tree: binding.dirty_tree,
    diff_summary: diff,
    findings,
    gate_verdict: gateVerdict,
    pr_ready_summary: noOp ? "No-op: no committed or working-tree changes require a push." : undefined
  });
  const evidencePayload = {
    schema_version: GATE_RESULT_SCHEMA_VERSION,
    repository: receiptDraft.repository,
    base_ref: receiptDraft.base_ref,
    head_ref: receiptDraft.head_ref,
    head_sha: receiptDraft.head_sha,
    dirty_tree: receiptDraft.dirty_tree,
    diff_summary: receiptDraft.diff_summary,
    findings: receiptDraft.findings,
    gate_verdict: receiptDraft.gate_verdict,
    pr_ready_summary: receiptDraft.pr_ready_summary,
    checks,
    repair_plan: repair.plan,
    ci,
    draft_pr: draftPr,
    git_binding: publicBinding(binding),
    diff_binding: {
      base_sha: baseSha,
      head_sha: headSha,
      patch_sha256: diff.patch_sha256,
      patch_bytes: diff.patch_bytes,
      changes: diff.changes
    },
    trusted_baseline: {
      ...loadedConfig.provenance,
      schema_version: config.schema_version,
      config_id: config.id,
      config_hash: hashStableJson(config),
      command_source: "git_object_at_base_commit"
    },
    github_remote_policy: publicRemotePolicy(config.github_remote),
    budget
  };
  const pushReceipt = buildPushReceipt({
    repository: binding.repository,
    base_ref: baseRef,
    head_ref: branch || headRef,
    head_sha: headSha,
    dirty_tree: binding.dirty_tree,
    diff_summary: diff,
    findings,
    gate_verdict: gateVerdict,
    pr_ready_summary: receiptDraft.pr_ready_summary,
    evidence_payload: evidencePayload
  });
  const result = {
    ...evidencePayload,
    status: resultStatus(gateVerdict, noOp),
    evidence_hash: pushReceipt.evidence_hash,
    push_receipt: pushReceipt
  };

  return {
    ...result,
    github_review: buildGitHubReviewPayload(result)
  };
}

export async function readTrustedRemotePolicy(options = {}) {
  const repoRoot = await repositoryRoot(options.repo || options.repository || process.cwd());
  const baseRef = clean(options.baseRef || options.base_ref) || await defaultBaseRef(repoRoot);
  const baseSha = await revParse(repoRoot, `${baseRef}^{commit}`);
  const configPath = safeRepositoryPath(options.configPath || options.config_path || CONFIG_PATH, "config path");
  const loaded = await loadTrustedBaselineConfig(repoRoot, baseSha, configPath);
  const normalized = normalizeGateConfig(loaded.value);
  return {
    repo_root: repoRoot,
    base_ref: baseRef,
    base_sha: baseSha,
    provenance: loaded.provenance,
    errors: normalized.errors.filter((item) => item.path.startsWith("github_remote")),
    policy: normalized.config.github_remote,
    expected_checks: normalized.config.ci.expected_checks
  };
}

export async function writeGateResult(result, path) {
  await writeFile(resolve(path), `${stableJson(result)}\n`, "utf8");
  return resolve(path);
}

export function gateExitCode(result) {
  if (result?.github_remote && !["completed", "not_requested"].includes(result.github_remote.status)) return 2;
  return result?.gate_verdict === "pass" ? 0 : 2;
}

export function normalizeCiSnapshot(input = null) {
  const records = asArray(Array.isArray(input) ? input : input?.checks || input?.statuses || input?.runs)
    .map((item, index) => normalizeCiRecord(item, index))
    .sort((left, right) => left.id.localeCompare(right.id));
  const counts = Object.fromEntries(CI_STATUS_TAXONOMY.map((status) => [status, 0]));
  for (const record of records) counts[record.status] += 1;
  const terminal = records.filter((record) => !["queued", "in_progress"].includes(record.status));
  return {
    schema_version: "across-autopilot-ci-watch/1.0",
    mode: records.length ? "snapshot" : "not_configured",
    status: records.some((record) => record.status.startsWith("failed_") || ["cancelled", "timed_out"].includes(record.status))
      ? "failed"
      : records.some((record) => ["queued", "in_progress"].includes(record.status))
        ? "pending"
        : records.length && terminal.every((record) => record.status === "passed")
          ? "passed"
          : "unavailable",
    taxonomy: [...CI_STATUS_TAXONOMY],
    counts,
    checks: records
  };
}

export function buildRepairPlan({ findings = [], config = DEFAULT_CONFIG, currentRound = 0, maxRepairs = 0, repositoryName = null } = {}) {
  const eligible = normalizeFindings(findings).filter((item) => {
    const category = item.metadata?.category;
    return CHECK_CATEGORIES.has(category) && !["pass", "no_op"].includes(item.state);
  });
  const maxRounds = nonNegativeInteger(config?.budget?.max_repair_rounds, 2);
  const allowedActions = nonNegativeInteger(maxRepairs, config?.budget?.max_repair_actions ?? 4);
  const remainingRounds = Math.max(0, maxRounds - nonNegativeInteger(currentRound, 0));
  const actions = eligible.slice(0, allowedActions).map((item, index) => ({
    id: `repair-${item.metadata.category}-${index + 1}`,
    category: item.metadata.category,
    source_finding_ids: [item.id],
    suggested_action: item.suggested_action || defaultRepairAction(item.metadata.category),
    current_round: nonNegativeInteger(currentRound, 0),
    max_rounds: maxRounds,
    remaining_rounds: remainingRounds,
    execution: "planned_only",
    command_source: "trusted_baseline_only"
  }));
  const planFindings = [];
  if (eligible.length && (remainingRounds === 0 || allowedActions === 0)) {
    planFindings.push(gateFinding({
      id: "repair_budget_exhausted",
      state: "blocked",
      severity: "high",
      summary: "Bounded repair planning budget is exhausted.",
      action: "Request human review or raise the repair budget on the trusted base branch.",
      gate: "repair_budget",
      owner: repositoryName,
      evidence: { eligible_failures: eligible.length, current_round: currentRound, max_rounds: maxRounds, max_repairs: allowedActions }
    }));
  } else if (eligible.length > actions.length) {
    planFindings.push(gateFinding({
      id: "repair_action_budget_exhausted",
      state: "blocked",
      severity: "high",
      summary: `${eligible.length - actions.length} repair action(s) exceed the bounded plan.`,
      action: "Split the repair work or request human review.",
      gate: "repair_budget",
      owner: repositoryName,
      evidence: { eligible_failures: eligible.length, planned_actions: actions.length }
    }));
  }
  return {
    plan: {
      schema_version: "across-autopilot-bounded-repair-plan/1.0",
      status: !eligible.length ? "not_needed" : planFindings.length ? "exhausted" : "planned",
      mutation_performed: false,
      current_round: nonNegativeInteger(currentRound, 0),
      max_rounds: maxRounds,
      max_actions: allowedActions,
      actions
    },
    findings: planFindings
  };
}

export function renderGateMarkdown(result) {
  const lines = [
    "# Repository Push Gate",
    "",
    `- Repository: ${typeof result.repository === "string" ? result.repository : result.repository?.name || "unknown"}`,
    `- Base: ${result.base_ref}`,
    `- Head: ${result.head_ref} (${result.head_sha})`,
    `- Dirty tree: ${result.dirty_tree}`,
    `- Verdict: ${result.gate_verdict}`,
    `- Evidence hash: ${result.evidence_hash}`,
    `- PR readiness: ${result.pr_ready_summary}`,
    "",
    "## Findings",
    ...asArray(result.findings).map((item) => `- ${item.id}: ${item.state} - ${item.summary}`),
    "",
    "## Repair Plan",
    `- Status: ${result.repair_plan?.status || "not_needed"}`,
    `- Planned actions: ${asArray(result.repair_plan?.actions).length}`,
    "",
    "## Draft PR",
    `- Status: ${result.draft_pr?.status || "not_requested"}`,
    "- Remote mutation performed: false"
  ];
  return lines.join("\n");
}

export function buildGitHubReviewPayload(result) {
  const markdown = renderGateMarkdown(result);
  const conclusion = result.gate_verdict === "pass"
    ? "success"
    : result.gate_verdict === "warn"
      ? "neutral"
      : "failure";
  return {
    schema_version: "across-autopilot-github-review/1.0",
    mutation_performed: false,
    remote_mutation_allowed: false,
    check_run: {
      name: "Across Repository Push Gate",
      external_id: result.evidence_hash,
      head_sha: result.head_sha,
      conclusion,
      output: {
        title: `Across gate: ${result.gate_verdict}`,
        summary: result.pr_ready_summary,
        text: markdown
      }
    },
    pr_comment: {
      body: markdown,
      evidence_hash: result.evidence_hash
    }
  };
}

async function repositoryRoot(path) {
  let candidate = await realpath(resolve(path));
  while (true) {
    try {
      await stat(join(candidate, ".git"));
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error("Repository does not contain Git metadata.");
      candidate = parent;
    }
  }
}

async function defaultBaseRef(repoRoot) {
  for (const ref of ["@{upstream}", "origin/HEAD", "origin/main", "main", "HEAD^"]) {
    if (await gitSucceeds(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])) return ref;
  }
  return "HEAD";
}

async function revParse(repoRoot, ref) {
  return git(repoRoot, ["rev-parse", "--verify", ref]);
}

async function inspectDiff(repoRoot, baseSha, headSha) {
  const range = `${baseSha}..${headSha}`;
  const [numstat, nameStatus, patch] = await Promise.all([
    git(repoRoot, ["diff", "--numstat", "--no-renames", range]),
    git(repoRoot, ["diff", "--name-status", "--no-renames", range]),
    git(repoRoot, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--unified=0", range])
  ]);
  const totals = { additions: 0, deletions: 0 };
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    totals.additions += /^\d+$/.test(added) ? Number(added) : 0;
    totals.deletions += /^\d+$/.test(deleted) ? Number(deleted) : 0;
  }
  const changes = nameStatus.split("\n").filter(Boolean).map((line) => {
    const [status, ...paths] = line.split("\t");
    return { status, path: paths.at(-1) };
  }).filter((item) => item.path).sort((left, right) => left.path.localeCompare(right.path));
  const changedFiles = [...new Set(changes.map((item) => item.path))].sort();
  return {
    changed_files: changedFiles,
    additions: totals.additions,
    deletions: totals.deletions,
    text: `${changedFiles.length} changed file(s), +${totals.additions}/-${totals.deletions}`,
    patch_sha256: sha256(patch),
    patch_bytes: Buffer.byteLength(patch),
    changes,
    patch
  };
}

async function loadTrustedBaselineConfig(repoRoot, baseSha, path) {
  const provenance = {
    source: "git_object_at_base_commit",
    base_sha: baseSha,
    path,
    blob_sha: null,
    found: false
  };
  try {
    const [text, blobSha] = await Promise.all([
      git(repoRoot, ["show", `${baseSha}:${path}`]),
      git(repoRoot, ["rev-parse", `${baseSha}:${path}`])
    ]);
    try {
      return {
        found: true,
        value: JSON.parse(text),
        parse_error: null,
        provenance: { ...provenance, blob_sha: blobSha, found: true }
      };
    } catch (error) {
      return {
        found: true,
        value: clone(DEFAULT_CONFIG),
        parse_error: boundedMessage(error.message),
        provenance: { ...provenance, blob_sha: blobSha, found: true, parse_error: boundedMessage(error.message) }
      };
    }
  } catch (error) {
    return {
      found: false,
      value: clone(DEFAULT_CONFIG),
      parse_error: null,
      provenance: { ...provenance, error: boundedMessage(error.message) }
    };
  }
}

function normalizeGateConfig(input) {
  const errors = [];
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (raw.schema_version !== GATE_CONFIG_SCHEMA_VERSION) {
    errors.push({ path: "schema_version", message: `Expected ${GATE_CONFIG_SCHEMA_VERSION}.` });
  }
  const checks = normalizeDescriptors(raw.checks, CHECK_CATEGORIES, "checks", errors, true);
  const tools = normalizeDescriptors(raw.tools === undefined ? DEFAULT_TOOL_CHECKS : raw.tools, TOOL_CATEGORIES, "tools", errors, false);
  const budgetInput = raw.budget && typeof raw.budget === "object" ? raw.budget : {};
  const policies = raw.policies && typeof raw.policies === "object" ? raw.policies : {};
  const githubRemote = normalizeRemotePolicy(raw.github_remote, raw.network_policy, errors);
  return {
    errors,
    config: {
      schema_version: raw.schema_version || GATE_CONFIG_SCHEMA_VERSION,
      id: clean(raw.id) || "repo-push-gate",
      network_policy: raw.network_policy === "allow" ? "allow" : "none",
      checks,
      tools,
      budget: {
        max_commands: positiveInteger(budgetInput.max_commands, DEFAULT_CONFIG.budget.max_commands),
        max_total_timeout_ms: positiveInteger(budgetInput.max_total_timeout_ms, DEFAULT_CONFIG.budget.max_total_timeout_ms),
        max_diff_bytes: positiveInteger(budgetInput.max_diff_bytes, DEFAULT_CONFIG.budget.max_diff_bytes),
        max_changed_files: positiveInteger(budgetInput.max_changed_files, DEFAULT_CONFIG.budget.max_changed_files),
        max_findings: positiveInteger(budgetInput.max_findings, DEFAULT_CONFIG.budget.max_findings),
        max_output_bytes: positiveInteger(budgetInput.max_output_bytes, DEFAULT_CONFIG.budget.max_output_bytes),
        max_repair_actions: nonNegativeInteger(budgetInput.max_repair_actions, DEFAULT_CONFIG.budget.max_repair_actions),
        max_repair_rounds: nonNegativeInteger(budgetInput.max_repair_rounds, DEFAULT_CONFIG.budget.max_repair_rounds)
      },
      ci: {
        required: raw.ci?.required === true,
        expected_checks: asArray(raw.ci?.expected_checks).map(String).filter(Boolean).sort()
      },
      github_remote: githubRemote,
      policies: {
        dirty_tree: policies.dirty_tree === "allow" ? "allow" : "block",
        base_must_be_ancestor: policies.base_must_be_ancestor !== false,
        codeowners: {
          required: policies.codeowners?.required === true,
          require_changed_file_coverage: policies.codeowners?.require_changed_file_coverage === true
        },
        generated_files: {
          mode: ["allow", "report", "block_unpaired"].includes(policies.generated_files?.mode)
            ? policies.generated_files.mode
            : "report",
          patterns: asArray(policies.generated_files?.patterns || DEFAULT_GENERATED_PATTERNS).map(String).filter(Boolean).sort()
        },
        vulnerability: { required_tool: policies.vulnerability?.required_tool === true }
      }
    }
  };
}

function normalizeRemotePolicy(value, networkPolicy, errors) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const enabled = raw.enabled === true;
  const allowedOperations = [...new Set(asArray(raw.allowed_operations).map(String).filter(Boolean))].sort();
  const validOperations = new Set(["push_branch", "draft_pr", "check_run", "pr_comment", "ci_watch"]);
  const repository = clean(raw.repository) || null;
  const allowedHosts = [...new Set(asArray(raw.allowed_hosts || ["github.com"])
    .map((item) => clean(item).toLowerCase()).filter(Boolean))].sort();
  const allowedPushRefs = [...new Set(asArray(raw.allowed_push_refs).map((item) => clean(item)).filter(Boolean))].sort();
  const approvalTokenEnv = clean(raw.approval_token_env) || "ACROSS_REPO_GATE_APPROVAL_TOKEN";
  const approvalTokenSha256 = clean(raw.approval_token_sha256).toLowerCase() || null;
  const authTokenEnv = clean(raw.auth_token_env) || "GH_TOKEN";
  const verificationMode = clean(raw.verification_mode).toLowerCase() || "auto";
  if (enabled && networkPolicy !== "allow") errors.push({ path: "github_remote", message: "Enabled GitHub remote policy requires network_policy=allow." });
  if (enabled && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) errors.push({ path: "github_remote.repository", message: "Expected an exact owner/repository slug." });
  if (enabled && !allowedHosts.length) errors.push({ path: "github_remote.allowed_hosts", message: "At least one trusted GitHub host is required." });
  for (const operation of allowedOperations) {
    if (!validOperations.has(operation)) errors.push({ path: "github_remote.allowed_operations", message: `Unsupported operation ${operation}.` });
  }
  for (const ref of allowedPushRefs) {
    if (!isExactFeatureRef(ref)) errors.push({ path: "github_remote.allowed_push_refs", message: `Expected an exact safe feature branch ref, received ${ref}.` });
  }
  if (allowedOperations.includes("push_branch") && !allowedPushRefs.length) errors.push({ path: "github_remote.allowed_push_refs", message: "push_branch requires at least one exact refs/heads/... allowlist entry." });
  if (enabled && !allowedOperations.includes("draft_pr")) errors.push({ path: "github_remote.allowed_operations", message: "Enabled policy must explicitly allow draft_pr." });
  if (enabled && raw.require_draft !== true) errors.push({ path: "github_remote.require_draft", message: "Remote PR creation must remain draft-only." });
  if (enabled && !/^[A-Fa-f0-9]{64}$/.test(approvalTokenSha256 || "")) errors.push({ path: "github_remote.approval_token_sha256", message: "Expected a SHA-256 approval-token digest." });
  if (!/^[A-Z_][A-Z0-9_]*$/.test(approvalTokenEnv)) errors.push({ path: "github_remote.approval_token_env", message: "Expected an uppercase environment variable name." });
  if (!/^[A-Z_][A-Z0-9_]*$/.test(authTokenEnv)) errors.push({ path: "github_remote.auth_token_env", message: "Expected an uppercase environment variable name." });
  if (!["auto", "check_run", "commit_status"].includes(verificationMode)) errors.push({ path: "github_remote.verification_mode", message: "Expected auto, check_run, or commit_status." });
  return {
    enabled,
    repository,
    allowed_hosts: allowedHosts,
    allowed_push_refs: allowedPushRefs,
    allowed_operations: allowedOperations,
    verification_mode: verificationMode,
    require_draft: raw.require_draft !== false,
    approval_token_env: approvalTokenEnv,
    approval_token_sha256: approvalTokenSha256,
    auth_token_env: authTokenEnv
  };
}

function publicRemotePolicy(policy) {
  return {
    enabled: policy.enabled,
    repository: policy.repository,
    allowed_hosts: policy.allowed_hosts,
    allowed_push_refs: policy.allowed_push_refs,
    allowed_operations: policy.allowed_operations,
    verification_mode: policy.verification_mode,
    require_draft: policy.require_draft,
    approval_token_env: policy.approval_token_env,
    approval_token_configured: Boolean(policy.approval_token_sha256),
    auth_token_env: policy.auth_token_env,
    secret_material_included: false
  };
}

function isExactFeatureRef(ref) {
  const value = String(ref || "");
  if (!value.startsWith("refs/heads/")) return false;
  const branch = value.slice("refs/heads/".length);
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return false;
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("..") || branch.includes("@{")) return false;
  if (/[~^:?*\\[\\\\\s]/.test(branch) || branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) return false;
  return !branch.startsWith("refs/") && !branch.startsWith("tags/");
}

function normalizeDescriptors(value, categories, path, errors, requiredDefault) {
  const seen = new Set();
  return asArray(value).map((item, index) => {
    const itemPath = `${path}.${index}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ path: itemPath, message: "Entry must be an object." });
      return null;
    }
    const id = clean(item.id) || `${path}-${index + 1}`;
    if (seen.has(id)) errors.push({ path: `${itemPath}.id`, message: `Duplicate id ${id}.` });
    seen.add(id);
    const category = clean(item.category);
    if (!categories.has(category)) errors.push({ path: `${itemPath}.category`, message: `Unsupported category ${category || "<empty>"}.` });
    const argv = asArray(item.argv).map(String);
    const executable = basename(argv[0] || "");
    if (!argv.length) errors.push({ path: `${itemPath}.argv`, message: "argv must be a non-empty array." });
    if (argv[0] !== executable || BLOCKED_EXECUTABLES.has(executable)) {
      errors.push({ path: `${itemPath}.argv`, message: "Shells, package scripts, paths, and command wrappers are not allowed." });
    }
    if (argv.some((arg) => arg.includes("\0"))) errors.push({ path: `${itemPath}.argv`, message: "argv may not contain NUL bytes." });
    let cwd = clean(item.cwd) || ".";
    try {
      cwd = safeRepositoryPath(cwd, `${itemPath}.cwd`);
    } catch (error) {
      errors.push({ path: `${itemPath}.cwd`, message: error.message });
      cwd = ".";
    }
    return {
      id,
      category,
      argv,
      cwd,
      required: item.required === undefined ? requiredDefault : item.required === true,
      network_required: item.network_required === true,
      timeout_ms: Math.min(300_000, positiveInteger(item.timeout_ms, 60_000)),
      success_exit_codes: asArray(item.success_exit_codes === undefined ? [0] : item.success_exit_codes)
        .map(Number).filter(Number.isInteger).sort((a, b) => a - b),
      repair: item.repair && typeof item.repair === "object" ? {
        strategy: clean(item.repair.strategy) || "plan",
        suggested_action: clean(item.repair.suggested_action) || null
      } : null
    };
  }).filter(Boolean);
}

function gateBudget(configBudget, maxRepairs) {
  const requested = maxRepairs === undefined || maxRepairs === null || maxRepairs === ""
    ? configBudget.max_repair_actions
    : nonNegativeInteger(maxRepairs, configBudget.max_repair_actions);
  return {
    ...configBudget,
    max_repair_actions: Math.min(configBudget.max_repair_actions, requested),
    repair_cap_source: "minimum_of_cli_and_trusted_baseline"
  };
}

function bindingFindings(binding, config, repositoryName) {
  const findings = [];
  if (binding.current_head_sha !== binding.head_sha) {
    findings.push(gateFinding({
      id: "head_worktree_mismatch",
      state: "blocked",
      severity: "high",
      summary: "The checked-out HEAD does not match the requested head ref.",
      action: "Check out the requested head commit before running commands.",
      gate: "git_binding",
      owner: repositoryName,
      evidence: { current_head_sha: binding.current_head_sha, requested_head_sha: binding.head_sha }
    }));
  }
  if (binding.expected_commit && binding.expected_commit !== binding.head_sha) {
    findings.push(gateFinding({
      id: "head_commit_mismatch",
      state: "blocked",
      severity: "high",
      summary: "Resolved head SHA does not match the expected commit.",
      action: "Refresh the gate request with the current commit SHA.",
      gate: "git_binding",
      owner: repositoryName,
      evidence: { expected: binding.expected_commit, actual: binding.head_sha }
    }));
  }
  if (binding.expected_base_sha && binding.expected_base_sha !== binding.base_sha) {
    findings.push(gateFinding({
      id: "base_commit_mismatch",
      state: "blocked",
      severity: "high",
      summary: "Resolved base SHA does not match the expected base commit.",
      action: "Refresh the trusted base ref before running the gate.",
      gate: "git_binding",
      owner: repositoryName,
      evidence: { expected: binding.expected_base_sha, actual: binding.base_sha }
    }));
  }
  if (binding.expected_branch && binding.expected_branch !== binding.branch) {
    findings.push(gateFinding({
      id: "branch_mismatch",
      state: "blocked",
      severity: "high",
      summary: "Checked-out branch does not match the expected branch.",
      action: "Check out the expected branch and retry.",
      gate: "git_binding",
      owner: repositoryName,
      evidence: { expected: binding.expected_branch, actual: binding.branch }
    }));
  }
  if (config.policies.base_must_be_ancestor && !binding.base_is_ancestor) {
    findings.push(gateFinding({
      id: "base_not_ancestor",
      state: "blocked",
      severity: "high",
      summary: "Trusted base is not an ancestor of the requested head.",
      action: "Rebase or choose the correct trusted base ref.",
      gate: "git_binding",
      owner: repositoryName,
      evidence: { base_sha: binding.base_sha, head_sha: binding.head_sha, merge_base_sha: binding.merge_base_sha }
    }));
  }
  if (binding.dirty_tree && config.policies.dirty_tree !== "allow") {
    findings.push(gateFinding({
      id: "dirty_tree",
      state: "blocked",
      severity: "high",
      summary: "Working tree contains uncommitted changes.",
      action: "Commit, stash, or remove working-tree changes before gating a push.",
      gate: "git_binding",
      owner: repositoryName,
      evidence: { dirty_paths: binding.dirty_paths, dirty_status_hash: binding.dirty_status_hash }
    }));
  }
  return findings;
}

async function evaluatePolicies({ repoRoot, headSha, diff, config, repositoryName, noOp }) {
  const addedLines = addedDiffLines(diff.patch);
  const secretMatches = noOp ? [] : scanAddedLines(addedLines, [
    ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
    ["github_token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
    ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["generic_secret_assignment", /\b(?:api[_-]?key|password|secret|token)\b\s*[:=]\s*["'][^"']{12,}["']/i]
  ]);
  const sastMatches = noOp ? [] : scanAddedLines(addedLines, [
    ["javascript_eval", /\beval\s*\(/],
    ["node_child_process_exec", /\b(?:exec|execSync)\s*\(/],
    ["python_shell_true", /\bshell\s*=\s*True\b/],
    ["unsafe_yaml_load", /\byaml\.load\s*\(/]
  ]);
  const tree = await git(repoRoot, ["ls-tree", "-r", "--full-tree", headSha]);
  const treeEntries = tree.split("\n").filter(Boolean).map(parseTreeEntry).filter(Boolean);
  const manifests = treeEntries.filter((item) => MANIFEST_PATTERNS.some((pattern) => pattern.test(item.path)))
    .map((item) => ({ path: item.path, blob_sha: item.sha })).sort((a, b) => a.path.localeCompare(b.path));
  const codeowners = await codeownersEvidence(repoRoot, headSha, treeEntries, diff.changed_files, config.policies.codeowners);
  const generated = generatedFileEvidence(diff.changed_files, config.policies.generated_files);
  const findings = [
    scanFinding("secret_scan", secretMatches, repositoryName, "Potential secret material appears in added lines."),
    scanFinding("sast", sastMatches, repositoryName, "Static-risk patterns appear in added lines."),
    gateFinding({
      id: "sbom_manifest_inventory",
      state: manifests.length ? "pass" : "no_op",
      severity: "info",
      summary: manifests.length ? `${manifests.length} dependency manifest(s) are bound into the SBOM contract.` : "No supported dependency manifests were found.",
      action: manifests.length ? null : "Add a supported dependency manifest when the repository gains dependencies.",
      gate: "sbom",
      owner: repositoryName,
      evidence: { manifests }
    }),
    ...codeowners.findings.map((item) => ({ ...item, owner: repositoryName })),
    ...generated.findings.map((item) => ({ ...item, owner: repositoryName }))
  ];
  return {
    findings,
    evidence: {
      secret_scan: { engine: "builtin-added-line-secret-scan/1.0", status: secretMatches.length ? "failed" : noOp ? "no_op" : "passed", matches: secretMatches },
      sast: { engine: "builtin-added-line-static-risk/1.0", status: sastMatches.length ? "failed" : noOp ? "no_op" : "passed", matches: sastMatches },
      sbom: { schema_version: "across-autopilot-sbom-contract/1.0", status: manifests.length ? "inventory_ready" : "no_manifests", manifests },
      dependency_vulnerability: { schema_version: "across-autopilot-vulnerability-contract/1.0", external_tool_required: config.policies.vulnerability.required_tool },
      codeowners: codeowners.evidence,
      generated_files: generated.evidence
    }
  };
}

async function runTrustedChecks({ descriptors, repoRoot, budget, skipReason, repositoryName, sourceGate }) {
  const results = [];
  const findings = [];
  let timeoutBudget = 0;
  for (const [index, descriptor] of descriptors.entries()) {
    let reason = skipReason;
    if (!reason && index >= budget.max_commands) reason = "command_count_budget_exhausted";
    if (!reason && timeoutBudget + descriptor.timeout_ms > budget.max_total_timeout_ms) reason = "timeout_budget_exhausted";
    if (!reason) timeoutBudget += descriptor.timeout_ms;
    const result = reason
      ? skippedCommandResult(descriptor, reason)
      : await executeDescriptor(descriptor, repoRoot, budget.max_output_bytes);
    results.push(result);
    findings.push(commandFinding(result, descriptor, repositoryName, sourceGate));
  }
  return { results, findings };
}

async function runTrustedTools({ descriptors, repoRoot, budget, networkPolicy, skipReason, repositoryName }) {
  const results = [];
  const findings = [];
  for (const descriptor of descriptors) {
    const available = await executableAvailable(descriptor.argv[0]);
    let reason = null;
    if (!available) reason = "tool_unavailable";
    else if (descriptor.network_required && networkPolicy !== "allow") reason = "network_policy_denied";
    else if (skipReason) reason = skipReason;
    const result = reason
      ? { ...skippedCommandResult(descriptor, reason), available }
      : { ...await executeDescriptor(descriptor, repoRoot, budget.max_output_bytes), available };
    results.push(result);
    findings.push(toolFinding(result, descriptor, repositoryName));
  }
  return { results, findings };
}

async function executeDescriptor(descriptor, repoRoot, maxOutputBytes) {
  const cwd = await resolveInsideRepository(repoRoot, descriptor.cwd);
  const [command, ...args] = descriptor.argv;
  const env = sanitizedEnvironment();
  const executable = await resolveExecutable(command, repoRoot);
  if (!executable.path) {
    return {
      ...commandResult(descriptor, null, "", "", "unavailable"),
      reason: executable.reason,
      executable: null
    };
  }
  try {
    const result = await exec(executable.path, args, {
      cwd,
      env,
      timeout: descriptor.timeout_ms,
      maxBuffer: maxOutputBytes,
      shell: false,
      windowsHide: true
    });
    return { ...commandResult(descriptor, 0, result.stdout, result.stderr, "passed"), executable: executable.path };
  } catch (error) {
    const exitCode = Number.isInteger(error.code) ? error.code : null;
    const status = error.killed || error.signal ? "timed_out" : descriptor.success_exit_codes.includes(exitCode) ? "passed" : "failed";
    return { ...commandResult(descriptor, exitCode, error.stdout, error.stderr, status, error.signal || null), executable: executable.path };
  }
}

function commandResult(descriptor, exitCode, stdout, stderr, status, signal = null) {
  const out = boundedOutput(stdout);
  const err = boundedOutput(stderr);
  return {
    id: descriptor.id,
    category: descriptor.category,
    status,
    required: descriptor.required,
    argv: descriptor.argv,
    cwd: descriptor.cwd,
    command_source: "trusted_baseline_config",
    exit_code: exitCode,
    signal,
    stdout_sha256: sha256(out),
    stderr_sha256: sha256(err),
    output_bytes: Buffer.byteLength(out) + Buffer.byteLength(err)
  };
}

function skippedCommandResult(descriptor, reason) {
  return {
    id: descriptor.id,
    category: descriptor.category,
    status: "skipped",
    reason,
    required: descriptor.required,
    argv: descriptor.argv,
    cwd: descriptor.cwd,
    command_source: "trusted_baseline_config",
    exit_code: null,
    signal: null,
    stdout_sha256: sha256(""),
    stderr_sha256: sha256(""),
    output_bytes: 0
  };
}

function commandFinding(result, descriptor, repositoryName, sourceGate) {
  if (result.status === "passed") {
    return gateFinding({ id: `check_${descriptor.id}`, state: "pass", severity: "info", summary: `${descriptor.id} passed.`, gate: `${sourceGate}.${descriptor.category}`, owner: repositoryName, evidence: result, metadata: { category: descriptor.category } });
  }
  if (result.status === "skipped" && ["no_op", "preflight_blocked"].includes(result.reason)) {
    return gateFinding({ id: `check_${descriptor.id}`, state: "no_op", severity: "info", summary: `${descriptor.id} was not run because ${result.reason}.`, gate: `${sourceGate}.${descriptor.category}`, owner: repositoryName, evidence: result, metadata: { category: descriptor.category } });
  }
  if (result.status === "unavailable") {
    return gateFinding({ id: `check_${descriptor.id}`, state: "blocked", severity: "high", summary: `${descriptor.id} executable is unavailable or resolves inside the feature repository.`, action: "Install the trusted executable outside the repository or repair the base config.", gate: `${sourceGate}.${descriptor.category}`, owner: repositoryName, evidence: result, metadata: { category: descriptor.category } });
  }
  const repairable = descriptor.repair?.strategy === "auto";
  const state = repairable ? "auto_fix_available" : descriptor.category === "review" ? "ask_user" : "blocked";
  return gateFinding({
    id: `check_${descriptor.id}`,
    state,
    severity: result.status === "timed_out" ? "high" : "error",
    summary: `${descriptor.id} ${result.status === "skipped" ? `was skipped: ${result.reason}` : `${result.status}.`}`,
    action: descriptor.repair?.suggested_action || defaultRepairAction(descriptor.category),
    gate: `${sourceGate}.${descriptor.category}`,
    owner: repositoryName,
    evidence: result,
    metadata: { category: descriptor.category }
  });
}

function toolFinding(result, descriptor, repositoryName) {
  if (result.status === "passed") {
    return gateFinding({ id: `tool_${descriptor.id}`, state: "pass", severity: "info", summary: `${descriptor.id} completed its ${descriptor.category} check.`, gate: descriptor.category, owner: repositoryName, evidence: result });
  }
  if (result.reason === "tool_unavailable") {
    return gateFinding({
      id: `tool_${descriptor.id}_unavailable`,
      state: descriptor.required ? "blocked" : "no_op",
      severity: descriptor.required ? "high" : "info",
      summary: `${descriptor.id} is unavailable; the ${descriptor.category} tool check was not hidden.`,
      action: descriptor.required ? `Install ${descriptor.argv[0]} or change the trusted baseline policy.` : null,
      gate: descriptor.category,
      owner: repositoryName,
      evidence: result
    });
  }
  if (result.reason === "network_policy_denied") {
    return gateFinding({ id: `tool_${descriptor.id}_network_denied`, state: descriptor.required ? "blocked" : "no_op", severity: descriptor.required ? "high" : "info", summary: `${descriptor.id} requires network access denied by trusted policy.`, action: descriptor.required ? "Approve network use in the trusted baseline config." : null, gate: descriptor.category, owner: repositoryName, evidence: result });
  }
  if (result.status === "skipped") {
    return gateFinding({ id: `tool_${descriptor.id}_skipped`, state: "no_op", severity: "info", summary: `${descriptor.id} was not run because ${result.reason}.`, gate: descriptor.category, owner: repositoryName, evidence: result });
  }
  return gateFinding({ id: `tool_${descriptor.id}_failed`, state: "blocked", severity: "high", summary: `${descriptor.id} reported a ${descriptor.category} failure.`, action: `Inspect ${descriptor.id} output locally before promotion.`, gate: descriptor.category, owner: repositoryName, evidence: result });
}

async function loadCiSnapshot(input, path, options = {}) {
  if (input) {
    const snapshot = normalizeCiSnapshot(input);
    return input.watcher && typeof input.watcher === "object"
      ? { ...snapshot, watcher: { ...input.watcher } }
      : withCiWatcher(snapshot, "supplied", 0);
  }
  if (!path) return withCiWatcher(normalizeCiSnapshot(null), "not_configured", 0);
  const waitSeconds = Math.min(900, nonNegativeNumber(options.waitSeconds, 0));
  const pollMs = Math.max(100, Math.min(5_000, nonNegativeNumber(options.pollMs, 500)));
  const deadline = Date.now() + waitSeconds * 1_000;
  let snapshot;
  while (true) {
    snapshot = normalizeCiSnapshot(JSON.parse(await readFile(resolve(path), "utf8")));
    if (snapshot.status !== "pending" || waitSeconds === 0 || Date.now() >= deadline) break;
    await new Promise((accept) => setTimeout(accept, pollMs));
  }
  const watcherStatus = snapshot.status === "pending" && waitSeconds > 0 ? "timed_out" : "observed";
  return withCiWatcher(snapshot, waitSeconds > 0 ? "bounded_file_watch" : "snapshot_file", waitSeconds, watcherStatus);
}

function withCiWatcher(snapshot, mode, maxWaitSeconds, status = "observed") {
  return {
    ...snapshot,
    watcher: {
      schema_version: "across-autopilot-ci-watcher/1.0",
      mode,
      status,
      max_wait_seconds: maxWaitSeconds,
      deterministic_snapshot: true
    }
  };
}

function findingsFromCi(ci, policy, repositoryName) {
  const findings = [];
  if (["idle_timeout", "max_wall_timeout", "timed_out"].includes(ci.watcher?.status)) {
    findings.push(gateFinding({
      id: `ci_watcher_${ci.watcher.status}`,
      state: "blocked",
      severity: "high",
      summary: `CI watcher stopped with ${ci.watcher.status} before checks became terminal.`,
      action: "Resume the same approved gate run; completed checks and remote artifacts are idempotently reused.",
      gate: "ci.watcher",
      owner: repositoryName,
      evidence: ci.watcher
    }));
  }
  if (policy.required && ci.mode === "not_configured") {
    findings.push(gateFinding({ id: "ci_snapshot_missing", state: "ask_user", severity: "high", summary: "CI evidence is required but no watcher snapshot was provided.", action: "Provide --ci-path with a bounded CI status snapshot.", gate: "ci", owner: repositoryName, evidence: ci }));
  }
  if (ci.mode !== "not_configured") {
    const missing = asArray(policy.expected_checks).filter((expected) => !ci.checks.some((check) => check.id === expected || check.name === expected || check.category === expected));
    for (const expected of missing) {
      findings.push(gateFinding({ id: `ci_expected_${slug(expected)}_missing`, state: policy.required ? "blocked" : "no_op", severity: policy.required ? "high" : "info", summary: `Expected CI check ${expected} is missing from the watcher snapshot.`, action: policy.required ? "Wait for or configure the expected CI check." : null, gate: "ci", owner: repositoryName, evidence: { expected_check: expected } }));
    }
  }
  for (const check of ci.checks) {
    if (check.status.startsWith("failed_")) {
      const category = check.status.slice("failed_".length);
      findings.push(gateFinding({ id: `ci_${slug(check.id)}`, state: category === "review" ? "ask_user" : "blocked", severity: "error", summary: `CI check ${check.name} failed in ${category}.`, action: defaultRepairAction(category), gate: `ci.${category}`, owner: repositoryName, evidence: check, metadata: { category } }));
    } else if (["cancelled", "timed_out"].includes(check.status)) {
      findings.push(gateFinding({ id: `ci_${slug(check.id)}`, state: "blocked", severity: "high", summary: `CI check ${check.name} is ${check.status}.`, action: "Rerun the bounded CI check before promotion.", gate: "ci", owner: repositoryName, evidence: check, metadata: { category: check.category } }));
    }
  }
  return findings;
}

function findingsFromToolPolicy(results, policies, repositoryName) {
  if (!policies.vulnerability.required_tool) return [];
  const passed = results.some((result) => result.category === "vulnerability" && result.status === "passed");
  if (passed) return [];
  return [gateFinding({
    id: "vulnerability_tool_required",
    state: "blocked",
    severity: "high",
    summary: "Trusted policy requires a vulnerability tool, but no vulnerability scan passed.",
    action: "Install and run the baseline-configured vulnerability scanner.",
    gate: "vulnerability",
    owner: repositoryName,
    evidence: { vulnerability_tool_results: results.filter((result) => result.category === "vulnerability") }
  })];
}

function normalizeCiRecord(item, index) {
  const input = item && typeof item === "object" ? item : { name: item };
  const name = clean(input.name || input.context || input.workflow || input.id) || `ci-check-${index + 1}`;
  const category = ciCategory(input.category, name);
  const raw = clean(input.status || input.conclusion || input.state).toLowerCase().replace(/[ -]+/g, "_");
  let status;
  if (["queued", "pending", "waiting", "requested"].includes(raw)) status = "queued";
  else if (["in_progress", "running", "started"].includes(raw)) status = "in_progress";
  else if (["pass", "passed", "success", "successful", "completed"].includes(raw)) status = "passed";
  else if (["cancelled", "canceled", "skipped"].includes(raw)) status = "cancelled";
  else if (["timed_out", "timeout"].includes(raw)) status = "timed_out";
  else if (["unavailable", "not_found", "missing"].includes(raw)) status = "unavailable";
  else if (["fail", "failed", "failure", "error", "action_required", "stale"].includes(raw)) status = `failed_${category || "other"}`;
  else if (CI_STATUS_TAXONOMY.includes(raw)) status = raw;
  else status = "unknown";
  return {
    id: clean(input.id || input.context || name) || name,
    name,
    category: category || "other",
    status,
    required: input.required !== false,
    details_url: sanitizeRemote(input.details_url || input.url) || null,
    run_id: clean(input.run_id || input.databaseId) || null,
    updated_at: clean(input.updated_at || input.updatedAt) || null,
    failure_summary: clean(input.failure_summary || input.log_summary) || null,
    failure_log_sha256: clean(input.failure_log_sha256) || null
  };
}

function ciCategory(explicit, name) {
  const category = clean(explicit).toLowerCase();
  if ([...CHECK_CATEGORIES, "security", "other"].includes(category)) return category;
  const text = String(name).toLowerCase();
  if (/lint|format|style|ruff|eslint/.test(text)) return "lint";
  if (/test|pytest|jest|spec|coverage/.test(text)) return "test";
  if (/doc|markdown|link|spell/.test(text)) return "docs";
  if (/review|approval|codeowner/.test(text)) return "review";
  if (/security|secret|sast|codeql|vulnerab|sbom|dependabot/.test(text)) return "security";
  return "other";
}

async function codeownersEvidence(repoRoot, headSha, treeEntries, changedFiles, policy) {
  const candidates = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  const path = candidates.find((candidate) => treeEntries.some((item) => item.path === candidate)) || null;
  const rules = path ? parseCodeowners(await git(repoRoot, ["show", `${headSha}:${path}`])) : [];
  const uncovered = policy.require_changed_file_coverage
    ? changedFiles.filter((file) => !rules.some((rule) => globMatches(rule.pattern, file)))
    : [];
  const findings = [];
  if (!path) {
    findings.push(gateFinding({ id: "codeowners_missing", state: policy.required ? "blocked" : "no_op", severity: policy.required ? "high" : "info", summary: "No CODEOWNERS file was found.", action: policy.required ? "Add CODEOWNERS on the trusted branch." : null, gate: "codeowners", evidence: { searched: candidates } }));
  } else if (uncovered.length) {
    findings.push(gateFinding({ id: "codeowners_uncovered_changes", state: "ask_user", severity: "high", summary: `${uncovered.length} changed file(s) are not covered by CODEOWNERS.`, action: "Add ownership rules or request explicit owner review.", gate: "codeowners", evidence: { path, uncovered } }));
  } else {
    findings.push(gateFinding({ id: "codeowners_policy", state: "pass", severity: "info", summary: "CODEOWNERS policy passed.", gate: "codeowners", evidence: { path, rule_count: rules.length } }));
  }
  return { findings, evidence: { path, rule_count: rules.length, uncovered_files: uncovered, required: policy.required, require_changed_file_coverage: policy.require_changed_file_coverage } };
}

function generatedFileEvidence(changedFiles, policy) {
  const generated = changedFiles.filter((file) => policy.patterns.some((pattern) => globMatches(pattern, file))).sort();
  const source = changedFiles.filter((file) => !generated.includes(file)).sort();
  const unpaired = generated.length > 0 && source.length === 0;
  const state = policy.mode === "block_unpaired" && unpaired ? "blocked" : generated.length ? "no_op" : "pass";
  const findings = [gateFinding({
    id: "generated_file_policy",
    state,
    severity: state === "blocked" ? "high" : "info",
    summary: unpaired ? "Generated files changed without a corresponding source change." : generated.length ? `${generated.length} generated file change(s) were recorded.` : "No generated-file changes were detected.",
    action: state === "blocked" ? "Include the source change or regenerate from a trusted source." : null,
    gate: "generated_files",
    evidence: { mode: policy.mode, generated_files: generated, source_files: source }
  })];
  return { findings, evidence: { mode: policy.mode, patterns: policy.patterns, generated_files: generated, source_files: source, unpaired } };
}

function scanFinding(id, matches, owner, failureSummary) {
  return gateFinding({
    id: `${id}_builtin_scan`,
    state: matches.length ? "blocked" : "pass",
    severity: matches.length ? "critical" : "info",
    summary: matches.length ? `${failureSummary} ${matches.length} match(es) require review.` : `${id} built-in scan passed.`,
    action: matches.length ? "Remove or explicitly remediate the flagged added lines." : null,
    gate: id,
    owner,
    evidence: { match_count: matches.length, matches }
  });
}

function addedDiffLines(patch) {
  const records = [];
  let path = null;
  let lineNumber = 0;
  for (const line of String(patch || "").split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (!path || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      records.push({ file: path, line: lineNumber, text: line.slice(1) });
      lineNumber += 1;
    } else if (!line.startsWith("-")) {
      lineNumber += 1;
    }
  }
  return records;
}

function scanAddedLines(lines, rules) {
  const matches = [];
  for (const record of lines) {
    for (const [ruleId, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(record.text)) matches.push({ rule_id: ruleId, file: record.file, line: record.line });
    }
  }
  return matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule_id.localeCompare(b.rule_id));
}

function parseTreeEntry(line) {
  const match = line.match(/^\d+\s+\w+\s+([a-f0-9]+)\t(.+)$/);
  return match ? { sha: match[1], path: match[2] } : null;
}

function parseCodeowners(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const [pattern, ...owners] = line.split(/\s+/);
    return { pattern, owners: owners.sort() };
  }).filter((rule) => rule.pattern && rule.owners.length);
}

function globMatches(pattern, path) {
  let source = String(pattern || "").trim();
  if (!source) return false;
  if (source.startsWith("!")) return false;
  source = source.replace(/^\//, "");
  if (source.endsWith("/")) source += "**";
  const hasSlash = source.includes("/");
  let escaped = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        escaped += "(?:.*/)?";
        index += 2;
      } else {
        escaped += ".*";
        index += 1;
      }
    } else if (char === "*") {
      escaped += "[^/]*";
    } else if (char === "?") {
      escaped += "[^/]";
    } else {
      escaped += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(hasSlash ? `^${escaped}$` : `(?:^|/)${escaped}$`).test(path);
}

function verdictFromFindings(findings) {
  const states = findings.map((item) => item.state);
  if (states.includes("failed")) return "fail";
  if (states.some((state) => ["ask_user", "blocked"].includes(state))) return "blocked";
  if (states.includes("auto_fix_available")) return "warn";
  return "pass";
}

function buildDraftPrPlan({ requested, repository, baseRef, headRef, headSha, gateVerdict, dirtyTree, noOp }) {
  const ready = requested && gateVerdict === "pass" && !dirtyTree && !noOp;
  return {
    schema_version: "across-autopilot-draft-pr-plan/1.0",
    requested,
    ready,
    status: !requested ? "not_requested" : ready ? "planned" : "blocked",
    mutation_performed: false,
    remote_mutation_allowed: false,
    provider: "github",
    operation: "create_draft_pr",
    repository,
    base_ref: baseRef,
    head_ref: headRef,
    head_sha: headSha,
    title: requested ? `Draft: ${headRef} -> ${baseRef}` : null,
    body_evidence_refs: requested ? ["gate:evidence_hash", "gate:findings", "gate:checks", "gate:repair_plan"] : [],
    blocking_reasons: requested ? [
      ...(gateVerdict !== "pass" ? [`gate_verdict:${gateVerdict}`] : []),
      ...(dirtyTree ? ["dirty_tree"] : []),
      ...(noOp ? ["no_op"] : [])
    ] : []
  };
}

function gateFinding({ id, state, severity, summary, action = null, gate, owner = null, evidence = null, metadata = {} }) {
  return {
    id,
    state,
    severity,
    summary,
    evidence,
    suggested_action: action,
    owner,
    repair_round: 0,
    source_gate: gate,
    metadata
  };
}

function limitFindings(findings, limit, repositoryName) {
  if (findings.length <= limit) return findings;
  const kept = findings.slice(0, Math.max(0, limit - 1));
  return normalizeFindings([...kept, gateFinding({
    id: "finding_budget_exhausted",
    state: "blocked",
    severity: "high",
    summary: `${findings.length - kept.length} finding(s) exceed the evidence budget.`,
    action: "Narrow the change or raise max_findings on the trusted base branch.",
    gate: "budget",
    owner: repositoryName,
    evidence: { total_findings: findings.length, retained_findings: kept.length, limit }
  })]);
}

function publicBinding(binding) {
  return {
    base_sha: binding.base_sha,
    head_sha: binding.head_sha,
    current_head_sha: binding.current_head_sha,
    branch: binding.branch,
    expected_branch: binding.expected_branch,
    expected_commit: binding.expected_commit,
    expected_base_sha: binding.expected_base_sha,
    merge_base_sha: binding.merge_base_sha,
    base_is_ancestor: binding.base_is_ancestor,
    dirty_paths: binding.dirty_paths,
    dirty_status_hash: binding.dirty_status_hash
  };
}

function statusPath(line) {
  const value = line.length > 3 ? line.slice(3) : line;
  return value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
}

function safeRepositoryPath(value, label) {
  const path = clean(value) || ".";
  if (isAbsolute(path) || path.split(/[\\/]+/).includes("..")) throw new Error(`${label} must be repository-relative.`);
  return path.replace(/^\.\//, "") || ".";
}

async function resolveInsideRepository(repoRoot, child) {
  const path = resolve(repoRoot, child);
  const rel = relative(repoRoot, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Command cwd escapes the repository.");
  const [rootReal, pathReal] = await Promise.all([realpath(repoRoot), realpath(path)]);
  const realRel = relative(rootReal, pathReal);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error("Command cwd resolves outside the repository.");
  return pathReal;
}

async function resolveExecutable(command, repoRoot) {
  try {
    const result = await exec("which", [command], { timeout: 5_000, maxBuffer: 16_384, env: sanitizedEnvironment() });
    const path = await realpath(String(result.stdout || "").trim());
    const root = await realpath(repoRoot);
    const rel = relative(root, path);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      return { path: null, reason: "untrusted_repository_executable" };
    }
    return { path, reason: null };
  } catch {
    return { path: null, reason: "executable_unavailable" };
  }
}

function sanitizedEnvironment() {
  return Object.fromEntries(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "CI"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

async function executableAvailable(command) {
  try {
    await exec("which", [command], { timeout: 5_000, maxBuffer: 16_384 });
    return true;
  } catch {
    return false;
  }
}

async function git(repoRoot, args) {
  // Packaged macOS apps can block in getcwd() when Git enters a privacy-managed
  // user folder. Keep the process in the system temp directory and provide the
  // repository metadata/worktree explicitly, so Git never changes cwd there.
  const gitDir = await repositoryGitDir(repoRoot);
  const result = await exec("git", [
    "-c", "core.quotePath=false",
    `--git-dir=${gitDir}`,
    `--work-tree=${repoRoot}`,
    ...args
  ], {
    cwd: tmpdir(),
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: sanitizedEnvironment()
  });
  return String(result.stdout || "").trimEnd();
}

async function repositoryGitDir(repoRoot) {
  const dotGit = join(repoRoot, ".git");
  const metadata = await stat(dotGit);
  if (metadata.isDirectory()) return realpath(dotGit);
  const marker = String(await readFile(dotGit, "utf8")).trim();
  const match = marker.match(/^gitdir:\s*(.+)$/i);
  if (!match) throw new Error("Repository .git file is invalid.");
  return realpath(resolve(repoRoot, match[1]));
}

async function gitOptional(repoRoot, args) {
  try {
    return await git(repoRoot, args);
  } catch {
    return "";
  }
}

async function gitSucceeds(repoRoot, args) {
  try {
    await git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}

function sanitizeRemote(value) {
  const text = clean(value);
  if (!text) return "";
  return text.replace(/(https?:\/\/)[^/@\s]+@/i, "$1[REDACTED]@");
}

function repositoryNameFromRemote(remote) {
  const match = String(remote || "").replace(/\.git$/, "").match(/[:/]([^/:]+\/[^/]+)$/);
  return match?.[1] || null;
}

function defaultRepairAction(category) {
  return ({
    lint: "Repair lint or formatting failures, then rerun the trusted check.",
    test: "Repair the failing test or implementation, then rerun the trusted check.",
    docs: "Repair documentation validation failures, then rerun the trusted check.",
    review: "Request a bounded human or independent reviewer decision."
  })[category] || "Inspect the failure and request human review.";
}

function resultStatus(verdict, noOp) {
  if (verdict === "pass") return noOp ? "no_op" : "passed";
  if (verdict === "warn") return "attention";
  if (verdict === "blocked") return "blocked";
  return "failed";
}

function hasBlockingFinding(findings) {
  return findings.some((item) => ["ask_user", "blocked", "failed"].includes(item.state));
}

function boundedOutput(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function boundedMessage(value) {
  return clean(value).split("\n")[0].slice(0, 240);
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "unknown";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
