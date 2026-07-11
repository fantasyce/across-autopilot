import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CI_STATUS_TAXONOMY,
  GATE_CONFIG_SCHEMA_VERSION,
  GATE_RESULT_SCHEMA_VERSION,
  gateExitCode,
  normalizeCiSnapshot,
  runRepoPushGate
} from "../src/repo-gate.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { AutopilotSupervisor } from "../src/supervisor.js";
import { buildToolPackRegistry } from "../src/tool-packs.js";
import {
  loadWorkflowPack,
  renderWorkflowPackProductCard,
  validateWorkflowPack
} from "../src/workflow-packs.js";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("gate loads executable commands from the trusted base Git object", async () => {
  const fixture = await createGateRepository();
  const marker = join(fixture.home, "feature-command-ran.txt");
  try {
    const featureConfig = {
      ...fixture.config,
      checks: [{
        id: "malicious-feature-command",
        category: "test",
        argv: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`],
        required: true
      }]
    };
    await writeJson(join(fixture.repo, ".across", "repo-push-gate.json"), featureConfig);
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "feature branch");

    const first = await runRepoPushGate({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      maxRepairs: 2,
      draftPr: true
    });
    const second = await runRepoPushGate({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      maxRepairs: 2,
      draftPr: true
    });

    assert.equal(first.schema_version, GATE_RESULT_SCHEMA_VERSION);
    assert.equal(first.gate_verdict, "pass");
    assert.equal(first.status, "passed");
    assert.equal(first.base_ref, fixture.baseSha);
    assert.equal(first.head_sha, await git(fixture.repo, ["rev-parse", "HEAD"]));
    assert.equal(first.dirty_tree, false);
    assert.deepEqual(first.checks.commands[0].argv, fixture.config.checks[0].argv);
    assert.equal(first.checks.commands[0].command_source, "trusted_baseline_config");
    assert.equal(first.trusted_baseline.command_source, "git_object_at_base_commit");
    assert.equal(first.trusted_baseline.blob_sha, await git(fixture.repo, ["rev-parse", `${fixture.baseSha}:.across/repo-push-gate.json`]));
    assert.match(first.diff_binding.patch_sha256, /^[a-f0-9]{64}$/);
    assert.match(first.evidence_hash, /^[a-f0-9]{64}$/);
    assert.equal(first.evidence_hash, second.evidence_hash);
    assert.equal(first.push_receipt.evidence_hash, first.evidence_hash);
    assert.equal(first.draft_pr.status, "planned");
    assert.equal(first.draft_pr.ready, true);
    assert.equal(first.draft_pr.mutation_performed, false);
    assert.equal(first.draft_pr.remote_mutation_allowed, false);
    assert.equal(first.github_review.schema_version, "across-autopilot-github-review/1.0");
    assert.equal(first.github_review.check_run.conclusion, "success");
    assert.equal(first.github_review.check_run.head_sha, first.head_sha);
    assert.equal(first.github_review.check_run.external_id, first.evidence_hash);
    assert.match(first.github_review.pr_comment.body, /Repository Push Gate/);
    assert.equal(first.github_review.mutation_performed, false);
    await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("trusted remote policy rejects main and non-exact push refs", async () => {
  const fixture = await createGateRepository({
    createFeatureBranch: false,
    config: gateConfig({
      network_policy: "allow",
      github_remote: {
        enabled: true,
        repository: "gate-owner/gate-fixture",
        allowed_hosts: ["github.com"],
        allowed_operations: ["push_branch", "draft_pr"],
        allowed_push_refs: ["refs/heads/main", "refs/heads/feature/*"],
        require_draft: true,
        approval_token_env: "ACROSS_REPO_GATE_APPROVAL_TOKEN",
        approval_token_sha256: "a".repeat(64),
        auth_token_env: "GH_TOKEN"
      }
    })
  });
  try {
    const result = await runRepoPushGate({ repo: fixture.repo, baseRef: fixture.baseSha, headRef: "HEAD" });
    const invalidRefs = result.findings.filter((item) => item.id === "trusted_config_invalid_github_remote_allowed_push_refs");
    assert.equal(result.gate_verdict, "blocked");
    assert.equal(invalidRefs.length >= 1, true);
    assert.match(invalidRefs.map((item) => item.summary).join("\n"), /exact safe feature branch ref/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("gate blocks dirty trees before executing baseline commands", async () => {
  const fixture = await createGateRepository();
  try {
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "feature branch");
    await writeFile(join(fixture.repo, "src", "dirty.js"), "export const dirty = true;\n", "utf8");

    const result = await runRepoPushGate({ repo: fixture.repo, baseRef: fixture.baseSha, headRef: "HEAD" });

    assert.equal(result.dirty_tree, true);
    assert.equal(result.gate_verdict, "blocked");
    assert.equal(gateExitCode(result), 2);
    assert.equal(result.findings.some((finding) => finding.id === "dirty_tree" && finding.state === "blocked"), true);
    assert.equal(result.checks.commands.every((check) => check.status === "skipped" && check.reason === "preflight_blocked"), true);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("gate rejects executables resolved from the feature repository", async () => {
  const markerName = "feature-executable-ran.txt";
  const config = gateConfig({
    checks: [{
      id: "feature-executable",
      category: "test",
      argv: ["gate-feature-runner"],
      required: true
    }]
  });
  const fixture = await createGateRepository({ config });
  const previousPath = process.env.PATH;
  try {
    const bin = join(fixture.repo, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "gate-feature-runner"), `#!/bin/sh\ntouch ${markerName}\n`, "utf8");
    await chmod(join(bin, "gate-feature-runner"), 0o755);
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "feature executable");
    process.env.PATH = `${bin}:${previousPath}`;

    const result = await runRepoPushGate({ repo: fixture.repo, baseRef: fixture.baseSha, headRef: "HEAD" });

    assert.equal(result.checks.commands[0].status, "unavailable");
    assert.equal(result.checks.commands[0].reason, "untrusted_repository_executable");
    assert.equal(result.gate_verdict, "blocked");
    await assert.rejects(readFile(join(fixture.repo, markerName), "utf8"), /ENOENT/);
  } finally {
    process.env.PATH = previousPath;
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("gate reports branch, commit, base, and checked-out head mismatches", async () => {
  const fixture = await createGateRepository();
  try {
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "feature branch");
    const result = await runRepoPushGate({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: fixture.baseSha,
      branch: "expected-branch",
      commit: "0".repeat(40),
      expectedBaseSha: "f".repeat(40)
    });
    const ids = new Set(result.findings.map((finding) => finding.id));

    assert.equal(result.gate_verdict, "blocked");
    assert.equal(ids.has("head_worktree_mismatch"), true);
    assert.equal(ids.has("head_commit_mismatch"), true);
    assert.equal(ids.has("base_commit_mismatch"), true);
    assert.equal(ids.has("branch_mismatch"), true);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("gate returns a passing no-op receipt and skips executable checks", async () => {
  const fixture = await createGateRepository({ createFeatureBranch: false });
  try {
    const result = await runRepoPushGate({ repo: fixture.repo, baseRef: "HEAD", headRef: "HEAD", draftPr: true });

    assert.equal(result.status, "no_op");
    assert.equal(result.gate_verdict, "pass");
    assert.equal(result.diff_summary.changed_files.length, 0);
    assert.equal(result.checks.commands[0].status, "skipped");
    assert.equal(result.checks.commands[0].reason, "no_op");
    assert.equal(result.pr_ready_summary, "No-op: no committed or working-tree changes require a push.");
    assert.equal(result.draft_pr.status, "blocked");
    assert.deepEqual(result.draft_pr.blocking_reasons, ["no_op"]);
    assert.equal(gateExitCode(result), 0);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("command and repair budgets are bounded by the trusted baseline and CLI cap", async () => {
  const config = gateConfig({
    checks: [
      passingCheck("lint-one", "lint"),
      passingCheck("test-two", "test")
    ],
    budget: { max_commands: 1, max_repair_actions: 2, max_repair_rounds: 2 }
  });
  const fixture = await createGateRepository({ config });
  try {
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "feature branch");
    const result = await runRepoPushGate({ repo: fixture.repo, baseRef: fixture.baseSha, headRef: "HEAD", maxRepairs: 0 });

    assert.equal(result.checks.commands[0].status, "passed");
    assert.equal(result.checks.commands[1].status, "skipped");
    assert.equal(result.checks.commands[1].reason, "command_count_budget_exhausted");
    assert.equal(result.budget.max_repair_actions, 0);
    assert.equal(result.repair_plan.status, "exhausted");
    assert.equal(result.findings.some((finding) => finding.id === "repair_budget_exhausted"), true);
    assert.equal(result.gate_verdict, "blocked");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("CI watcher taxonomy feeds bounded lint, test, docs, and review repair planning", async () => {
  const snapshot = normalizeCiSnapshot({
    checks: [
      { id: "lint", name: "ESLint", conclusion: "failure" },
      { id: "test", name: "Unit tests", conclusion: "failure" },
      { id: "docs", name: "Docs links", conclusion: "failure" },
      { id: "review", name: "CODEOWNERS review", conclusion: "failure" },
      { id: "security", name: "CodeQL", conclusion: "success" }
    ]
  });
  assert.deepEqual(snapshot.checks.map((check) => check.status), [
    "failed_docs",
    "failed_lint",
    "failed_review",
    "passed",
    "failed_test"
  ]);
  assert.deepEqual(snapshot.taxonomy, [...CI_STATUS_TAXONOMY]);

  const fixture = await createGateRepository();
  try {
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "feature branch");
    const result = await runRepoPushGate({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      ci: { checks: snapshot.checks.map((check) => ({ ...check, status: check.status })) },
      maxRepairs: 2
    });

    assert.equal(result.ci.status, "failed");
    assert.equal(result.repair_plan.max_actions, 2);
    assert.equal(result.repair_plan.actions.length, 2);
    assert.equal(result.repair_plan.actions.every((action) => action.execution === "planned_only"), true);
    assert.equal(result.findings.some((finding) => finding.id === "repair_action_budget_exhausted"), true);
    assert.equal(result.gate_verdict, "blocked");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("CI file watcher waits boundedly for queued checks to become terminal", async () => {
  const fixture = await createGateRepository();
  const ciPath = join(fixture.home, "ci-watch.json");
  try {
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "feature branch");
    await writeJson(ciPath, { checks: [{ id: "test", status: "queued" }] });
    const publish = new Promise((accept, reject) => {
      setTimeout(() => {
        writeJson(ciPath, { checks: [{ id: "test", status: "passed" }] }).then(accept, reject);
      }, 150);
    });

    const result = await runRepoPushGate({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      ciPath,
      ciWaitSeconds: 2,
      ciPollMs: 50
    });
    await publish;

    assert.equal(result.ci.status, "passed");
    assert.equal(result.ci.watcher.mode, "bounded_file_watch");
    assert.equal(result.ci.watcher.status, "observed");
    assert.equal(result.ci.watcher.max_wait_seconds, 2);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("security, SAST, SBOM, vulnerability tool, and CODEOWNERS policies emit explicit findings", async () => {
  const config = gateConfig({
    checks: [],
    tools: [{
      id: "missing-vulnerability-tool",
      category: "vulnerability",
      argv: ["across-vulnerability-tool-that-does-not-exist", "scan", "."],
      required: true
    }],
    policies: {
      codeowners: { required: true, require_changed_file_coverage: true },
      generated_files: { mode: "report", patterns: ["**/*.generated.*"] },
      vulnerability: { required_tool: true }
    }
  });
  const fixture = await createGateRepository({ config, codeowners: false });
  try {
    await writeFile(join(fixture.repo, "src", "risky.js"), [
      "const api_key = 'abcdefghijklmnop';",
      "eval('unsafe');",
      ""
    ].join("\n"), "utf8");
    await commitAll(fixture.repo, "risky feature");
    const result = await runRepoPushGate({ repo: fixture.repo, baseRef: fixture.baseSha, headRef: "HEAD" });
    const byId = new Map(result.findings.map((finding) => [finding.id, finding]));

    assert.equal(byId.get("secret_scan_builtin_scan")?.state, "blocked");
    assert.equal(byId.get("sast_builtin_scan")?.state, "blocked");
    assert.equal(byId.get("codeowners_missing")?.state, "blocked");
    assert.equal(byId.get("tool_missing-vulnerability-tool_unavailable")?.state, "blocked");
    assert.equal(byId.get("sbom_manifest_inventory")?.state, "pass");
    assert.equal(result.checks.policies.sbom.status, "inventory_ready");
    assert.equal(result.checks.tools[0].available, false);
    assert.equal(result.gate_verdict, "blocked");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("generated-file policy blocks unpaired generated changes", async () => {
  const config = gateConfig({
    checks: [],
    tools: [],
    policies: {
      codeowners: { required: false, require_changed_file_coverage: false },
      generated_files: { mode: "block_unpaired", patterns: ["**/*.generated.js"] }
    }
  });
  const fixture = await createGateRepository({ config, codeowners: false });
  try {
    await mkdir(join(fixture.repo, "generated"), { recursive: true });
    await writeFile(join(fixture.repo, "generated", "client.generated.js"), "export const generated = true;\n", "utf8");
    await commitAll(fixture.repo, "generated only");
    const result = await runRepoPushGate({ repo: fixture.repo, baseRef: fixture.baseSha, headRef: "HEAD" });

    assert.equal(result.findings.find((finding) => finding.id === "generated_file_policy")?.state, "blocked");
    assert.equal(result.checks.policies.generated_files.unpaired, true);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("CLI exposes the gate result schema and documented exit codes", async () => {
  const fixture = await createGateRepository({ createFeatureBranch: false });
  try {
    const passed = await exec("node", [
      "src/cli.js", "gate", "--repo", fixture.repo, "--base-ref", "HEAD", "--head-ref", "HEAD", "--json"
    ], { cwd: packageRoot, maxBuffer: 4 * 1024 * 1024 });
    const payload = JSON.parse(passed.stdout);
    assert.equal(payload.schema_version, GATE_RESULT_SCHEMA_VERSION);
    assert.equal(payload.gate_verdict, "pass");

    await writeFile(join(fixture.repo, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(
      exec("node", [
        "src/cli.js", "gate", "--repo", fixture.repo, "--base-ref", "HEAD", "--head-ref", "HEAD", "--json"
      ], { cwd: packageRoot, maxBuffer: 4 * 1024 * 1024 }),
      (error) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).gate_verdict, "blocked");
        return true;
      }
    );
    await assert.rejects(
      exec("node", ["src/cli.js", "gate", "--json"], { cwd: packageRoot }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /--repo is required/);
        return true;
      }
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("workflow and Tool Pack registries expose the gate contract and realistic dry runs", async () => {
  const pack = await loadWorkflowPack("repo-push-gate");
  const validation = validateWorkflowPack(pack);
  const card = renderWorkflowPackProductCard(pack);
  const toolPack = buildToolPackRegistry().packs.find((item) => item.id === "repo_push_gate");
  const supervisor = new AutopilotSupervisor();
  const repoQualityDryRun = await supervisor.dryRun("repo-quality-copilot");
  const gateDryRun = await supervisor.dryRun("repo-push-gate");

  assert.equal(validation.valid, true);
  assert.match(card.quickstart.cli, /gate --repo \. --base-ref origin\/main/);
  assert.equal(toolPack.output_schema.properties.schema_version.const, GATE_RESULT_SCHEMA_VERSION);
  assert.ok(toolPack.output_schema.required.includes("repair_plan"));
  assert.equal(repoQualityDryRun.spec_id, "repo-quality-copilot");
  assert.equal(repoQualityDryRun.valid, true);
  assert.equal(gateDryRun.spec_id, "repo-push-gate");
  assert.equal(gateDryRun.valid, true);
});

test("repo_push_gate action and quality gate adapter share the CLI result contract", async () => {
  const fixture = await createGateRepository();
  try {
    await writeFile(join(fixture.repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
    await commitAll(fixture.repo, "adapter feature");
    const registry = new AdapterRegistry();
    const spec = {
      id: "adapter-repo-push-gate",
      name: "Adapter Repository Push Gate",
      description: "Exercise the workflow adapter.",
      autonomy: { level: 2 },
      scope: { workspace: fixture.repo },
      gates: [{ id: "repo_push_gate_passed", required: true }],
      pack_config: {
        repo_push_gate: {
          repository: fixture.repo,
          base_ref: fixture.baseSha,
          head_ref: "HEAD",
          max_repairs: 1
        }
      }
    };
    const action = await registry.getAction("repo_push_gate").run({ spec, sources: [], actions: [], gates: [] });
    const gate = await registry.getAction("quality_gate_evaluation").run({ spec, sources: [], actions: [action], gates: [] });

    assert.equal(action.result.schema_version, GATE_RESULT_SCHEMA_VERSION);
    assert.equal(action.result.gate_verdict, "pass");
    assert.equal(gate.status, "passed");
    assert.equal(gate.result.gates[0].status, "passed");
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

function gateConfig(overrides = {}) {
  const budget = {
    max_commands: 8,
    max_total_timeout_ms: 240_000,
    max_diff_bytes: 1_000_000,
    max_changed_files: 100,
    max_findings: 100,
    max_output_bytes: 64_000,
    max_repair_actions: 4,
    max_repair_rounds: 2,
    ...(overrides.budget || {})
  };
  const policies = {
    dirty_tree: "block",
    base_must_be_ancestor: true,
    codeowners: { required: true, require_changed_file_coverage: true },
    generated_files: { mode: "report", patterns: ["**/*.generated.*"] },
    vulnerability: { required_tool: false },
    ...(overrides.policies || {})
  };
  return {
    schema_version: GATE_CONFIG_SCHEMA_VERSION,
    id: "fixture-gate",
    network_policy: overrides.network_policy || "none",
    ...(overrides.github_remote ? { github_remote: overrides.github_remote } : {}),
    checks: overrides.checks || [passingCheck("baseline-test", "test")],
    tools: overrides.tools || [],
    budget,
    ci: overrides.ci || { required: false, expected_checks: [] },
    policies
  };
}

function passingCheck(id, category) {
  return {
    id,
    category,
    argv: ["node", "-e", `process.stdout.write(${JSON.stringify(`${id}:passed`)})`],
    required: true,
    timeout_ms: 10_000
  };
}

async function createGateRepository({ config = gateConfig(), codeowners = true, createFeatureBranch = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), "across-repo-gate-"));
  const repo = join(home, "repo");
  await mkdir(join(repo, ".across"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });
  await git(home, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "gate@example.com"]);
  await git(repo, ["config", "user.name", "Gate Test"]);
  await writeJson(join(repo, ".across", "repo-push-gate.json"), config);
  await writeJson(join(repo, "package.json"), { name: "gate-fixture", version: "1.0.0", type: "module" });
  await writeFile(join(repo, "src", "index.js"), "export const ready = true;\n", "utf8");
  if (codeowners) {
    await mkdir(join(repo, ".github"), { recursive: true });
    await writeFile(join(repo, ".github", "CODEOWNERS"), "* @gate-owner\n", "utf8");
  }
  await commitAll(repo, "baseline");
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);
  if (createFeatureBranch) await git(repo, ["checkout", "-b", "feature/gate"]);
  return { home, repo, baseSha, config };
}

async function commitAll(repo, message) {
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", message]);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function git(cwd, args) {
  const result = await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return String(result.stdout || "").trim();
}
