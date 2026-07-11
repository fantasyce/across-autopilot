import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runRepoPushGateWithGitHub, watchGitHubCi } from "../src/github-remote.js";

const exec = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("remote gate stays non-mutating unless explicit approval is requested", async () => {
  const fixture = await createRemoteFixture();
  try {
    const result = await runRepoPushGateWithGitHub({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      draftPr: true,
      pushBranch: true,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    });
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(result.gate_verdict, "blocked");
    assert.equal(result.github_remote.status, "not_requested");
    assert.equal(result.github_remote.mutation_performed, false);
    assert.equal(state.pr, null);
  } finally {
    await fixture.cleanup();
  }
});

test("remote gate denies missing approval token before invoking gh", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    delete process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
    process.env.GH_TOKEN = fixture.githubToken;
    const result = await runRepoPushGateWithGitHub({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      draftPr: true,
      pushBranch: true,
      approveRemote: true,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    });
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(result.status, "remote_blocked");
    assert.equal(result.github_remote.status, "denied");
    assert.equal(result.github_remote.authorization.approval_token_verified, false);
    assert.equal(result.github_remote.mutation_performed, false);
    assert.equal(state.invocations, 0);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("approved GitHub gate creates then idempotently resumes draft PR, Check, comment, and CI findings", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN = fixture.approvalToken;
    process.env.GH_TOKEN = fixture.githubToken;
    const options = {
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      pushBranch: true,
      draftPr: true,
      approveRemote: true,
      watchCi: true,
      ciPollMs: 5,
      ciIdleTimeoutMs: 1_000,
      ciMaxWallTimeoutMs: 2_000,
      allowFastPolling: true,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    };

    const first = await runRepoPushGateWithGitHub(options);
    const second = await runRepoPushGateWithGitHub(options);
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));

    assert.equal(first.github_remote.status, "completed", JSON.stringify(first.github_remote, null, 2));
    assert.equal(first.github_remote.authorization.approval_token_verified, true);
    assert.equal(first.github_remote.authorization.credential_present, true);
    assert.equal(first.github_remote.branch_push.target_ref, "refs/heads/feature/remote-gate");
    assert.equal(first.github_remote.branch_push.remote_sha, first.head_sha);
    assert.equal(first.github_remote.operations[0].id, "push_branch");
    assert.equal(first.github_remote.pull_request.draft, true);
    assert.equal(first.ci.watcher.mode, "github_actions_poll");
    assert.equal(first.ci.watcher.status, "completed");
    assert.equal(first.ci.checks[0].status, "failed_test");
    assert.match(first.ci.checks[0].failure_summary, /AssertionError: expected 2 but got 3/);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(fixture.githubToken));
    assert.doesNotMatch(JSON.stringify(first), /secret-token-material/);
    assert.doesNotMatch(JSON.stringify(first), /super-secret-ci-value/);
    assert.equal(first.findings.some((item) => item.id === "ci_unit_tests" && item.state === "blocked"), true);
    assert.equal(first.repair_plan.actions.some((item) => item.category === "test"), true);
    assert.equal(first.gate_verdict, "blocked");
    assert.equal(first.github_remote.secret_material_persisted, false);
    assert.match(first.github_remote.audit_hash, /^[a-f0-9]{64}$/);

    assert.equal(second.github_remote.status, "completed");
    assert.equal(second.github_remote.operations[0].id, "push_branch");
    assert.equal(second.github_remote.operations[0].status, "unchanged");
    assert.equal(second.github_remote.operations[0].resumed, true);
    assert.equal(second.github_remote.operations.some((item) => item.id === "draft_pr" && item.resumed === true), true);
    assert.equal(second.github_remote.operations.some((item) => item.id === "check_run" && item.status === "updated"), true);
    assert.equal(second.github_remote.operations.some((item) => item.id === "pr_comment" && item.status === "updated"), true);
    assert.equal(state.prCreateCount, 1);
    assert.equal(state.pushCount, 1);
    assert.equal(state.checks.length, 1);
    assert.equal(state.comments.length, 1);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("CI watcher refreshes idle liveness on successful polls and keeps a separate wall limit", async () => {
  let polls = 0;
  const client = {
    async json() {
      polls += 1;
      await new Promise((accept) => setTimeout(accept, 8));
      return [{
        databaseId: 10,
        name: "Unit tests",
        workflowName: "Unit tests",
        status: polls < 3 ? "in_progress" : "completed",
        conclusion: polls < 3 ? null : "success",
        updatedAt: new Date().toISOString()
      }];
    },
    async run() { return { stdout: "", stderr: "" }; }
  };
  const watched = await watchGitHubCi({
    client,
    repository: "owner/repo",
    headRef: "feature/test",
    headSha: "a".repeat(40),
    pollMs: 2,
    idleTimeoutMs: 10,
    maxWallTimeoutMs: 200
  });
  assert.equal(watched.status, "completed");
  assert.equal(watched.polls, 3);
  assert.equal(watched.heartbeats.length, 3);
  assert.equal(watched.snapshot.watcher.heartbeat_refresh, true);
  assert.equal(watched.snapshot.watcher.max_wall_timeout_ms, 200);
});

test("remote audit marks an interrupted mutation as reconcilable and rerun resumes it", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    state.failViewAfterCreate = true;
    await writeJson(fixture.statePath, state);
    process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN = fixture.approvalToken;
    process.env.GH_TOKEN = fixture.githubToken;
    const options = {
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      pushBranch: true,
      draftPr: true,
      approveRemote: true,
      watchCi: false,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    };
    const interrupted = await runRepoPushGateWithGitHub(options);
    const resumed = await runRepoPushGateWithGitHub(options);
    const finalState = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(interrupted.github_remote.status, "failed");
    assert.equal(interrupted.github_remote.remote_state_requires_reconciliation, true);
    assert.equal(interrupted.github_remote.operations[1].status, "unknown_after_attempt");
    assert.equal(interrupted.github_remote.operations[1].recovery, "rerun_with_same_idempotency_key");
    assert.equal(resumed.github_remote.status, "completed");
    assert.equal(resumed.github_remote.operations[0].resumed, true);
    assert.equal(resumed.github_remote.operations[1].resumed, true);
    assert.equal(finalState.prCreateCount, 1);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("remote audit retries a transient transport failure through the idempotent operation", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    state.failCreateTransportOnce = true;
    await writeJson(fixture.statePath, state);
    process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN = fixture.approvalToken;
    process.env.GH_TOKEN = fixture.githubToken;
    const result = await runRepoPushGateWithGitHub({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      pushBranch: true,
      draftPr: true,
      approveRemote: true,
      watchCi: false,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    });
    const finalState = JSON.parse(await readFile(fixture.statePath, "utf8"));
    const draftOperation = result.github_remote.operations.find((item) => item.id === "draft_pr");
    assert.equal(result.github_remote.status, "completed");
    assert.equal(draftOperation.attempts, 2);
    assert.equal(finalState.createTransportFailed, true);
    assert.equal(finalState.prCreateCount, 1);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("user-token GitHub auth falls back from Check Runs to an idempotent commit status", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    state.rejectCheckRunAsUserToken = true;
    await writeJson(fixture.statePath, state);
    process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN = fixture.approvalToken;
    process.env.GH_TOKEN = fixture.githubToken;
    const options = {
      repo: fixture.repo, baseRef: fixture.baseSha, headRef: "HEAD", pushBranch: true,
      draftPr: true, approveRemote: true, watchCi: false, ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand, gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    };
    const first = await runRepoPushGateWithGitHub(options);
    const second = await runRepoPushGateWithGitHub(options);
    const finalState = JSON.parse(await readFile(fixture.statePath, "utf8"));
    const firstCheck = first.github_remote.operations.find((item) => item.id === "check_run");
    const secondCheck = second.github_remote.operations.find((item) => item.id === "check_run");
    assert.equal(first.github_remote.status, "completed");
    assert.equal(firstCheck.verification_mode, "commit_status_fallback");
    assert.equal(firstCheck.status, "created");
    assert.equal(secondCheck.status, "unchanged");
    assert.equal(secondCheck.resumed, true);
    assert.equal(finalState.statuses.length, 1);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("branch push reconciles a lost response before creating the draft PR", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    state.failPushAfterMutation = true;
    await writeJson(fixture.statePath, state);
    process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN = fixture.approvalToken;
    process.env.GH_TOKEN = fixture.githubToken;
    const result = await runRepoPushGateWithGitHub({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      pushBranch: true,
      draftPr: true,
      approveRemote: true,
      watchCi: false,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    });
    const finalState = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(result.github_remote.status, "completed", JSON.stringify(result.github_remote, null, 2));
    assert.equal(result.github_remote.branch_push.status, "reconciled");
    assert.equal(result.github_remote.branch_push.mutation_response_lost, true);
    assert.equal(result.github_remote.branch_push.remote_sha, result.head_sha);
    assert.equal(result.github_remote.operations[0].status, "reconciled");
    assert.equal(result.github_remote.operations[1].id, "draft_pr");
    assert.equal(finalState.pushCount, 1);
    assert.equal(finalState.prCreateCount, 1);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("remote gate refuses a dangerous or untrusted push ref before git or gh mutation", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN = fixture.approvalToken;
    process.env.GH_TOKEN = fixture.githubToken;
    await git(fixture.repo, ["checkout", "-b", "feature/not-allowed"]);
    const result = await runRepoPushGateWithGitHub({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      pushBranch: true,
      draftPr: true,
      approveRemote: true,
      watchCi: false,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    });
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(result.status, "remote_blocked");
    assert.match(result.github_remote.errors.join("\n"), /not explicitly trusted/);
    assert.equal(state.pushCount, 0);
    assert.equal(state.prCreateCount, 0);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("branch push refuses a Git-config URL rewrite before mutation", async () => {
  const fixture = await createRemoteFixture();
  const previousApproval = process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN;
  const previousToken = process.env.GH_TOKEN;
  try {
    const state = JSON.parse(await readFile(fixture.statePath, "utf8"));
    state.effectiveRemoteUrl = "git@github.com:other-owner/other-repo.git";
    await writeJson(fixture.statePath, state);
    process.env.ACROSS_REPO_GATE_APPROVAL_TOKEN = fixture.approvalToken;
    process.env.GH_TOKEN = fixture.githubToken;
    const result = await runRepoPushGateWithGitHub({
      repo: fixture.repo,
      baseRef: fixture.baseSha,
      headRef: "HEAD",
      pushBranch: true,
      draftPr: true,
      approveRemote: true,
      watchCi: false,
      ghCommand: fixture.gh,
      gitCommand: fixture.gitCommand,
      gitEnv: { FAKE_GIT_STATE: fixture.statePath },
      ghEnv: { FAKE_GH_STATE: fixture.statePath }
    });
    const finalState = JSON.parse(await readFile(fixture.statePath, "utf8"));
    assert.equal(result.github_remote.status, "failed");
    assert.match(result.github_remote.errors.join("\n"), /URL rewriting changed/);
    assert.equal(finalState.pushCount, 0);
    assert.equal(finalState.prCreateCount, 0);
  } finally {
    restoreEnv("ACROSS_REPO_GATE_APPROVAL_TOKEN", previousApproval);
    restoreEnv("GH_TOKEN", previousToken);
    await fixture.cleanup();
  }
});

test("CI watcher reports idle timeout after repeated transport failures", async () => {
  const client = {
    async json() { throw new Error("transport unavailable"); },
    async run() { return { stdout: "", stderr: "" }; }
  };
  const watched = await watchGitHubCi({
    client,
    repository: "owner/repo",
    headRef: "feature/test",
    headSha: "a".repeat(40),
    pollMs: 5,
    idleTimeoutMs: 20,
    maxWallTimeoutMs: 200
  });
  assert.equal(watched.status, "idle_timeout");
  assert.ok(watched.polls >= 2);
  assert.equal(watched.snapshot.watcher.errors.length > 0, true);
});

test("CLI approved remote mode uses environment-only credentials and writes resumable evidence", async () => {
  const fixture = await createRemoteFixture();
  const output = join(fixture.home, "gate-evidence.json");
  const env = {
    ...process.env,
    PATH: `${dirname(fixture.gh)}:${process.env.PATH}`,
    ACROSS_REPO_GATE_APPROVAL_TOKEN: fixture.approvalToken,
    GH_TOKEN: fixture.githubToken,
    FAKE_GH_STATE: fixture.statePath
  };
  try {
    await assert.rejects(
      exec("node", [
        "src/cli.js", "gate", "--repo", fixture.repo, "--base-ref", fixture.baseSha,
        "--head-ref", "HEAD", "--push-branch", "--draft-pr", "--approve-remote", "--watch-ci", "true",
        "--ci-poll-ms", "5", "--ci-idle-timeout-ms", "1000", "--ci-max-wall-timeout-ms", "2000",
        "--output", output, "--json"
      ], { cwd: packageRoot, env, maxBuffer: 8 * 1024 * 1024 }),
      (error) => {
        assert.equal(error.code, 2);
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.github_remote.status, "completed");
        assert.equal(payload.gate_verdict, "blocked");
        return true;
      }
    );
    const evidence = await readFile(output, "utf8");
    assert.doesNotMatch(evidence, new RegExp(fixture.githubToken));
    assert.doesNotMatch(evidence, new RegExp(fixture.approvalToken));
    assert.equal(JSON.parse(evidence).github_remote.recoverable, true);
  } finally {
    await fixture.cleanup();
  }
});

async function createRemoteFixture() {
  const home = await mkdtemp(join(tmpdir(), "across-github-remote-"));
  const repo = join(home, "repo");
  const statePath = join(home, "fake-gh-state.json");
  const gh = join(home, "bin", "gh");
  const approvalToken = "approval-token-material";
  const githubToken = "ghp_secret-token-material123456789012345";
  await mkdir(join(repo, ".across"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(dirname(gh), { recursive: true });
  await git(home, ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "gate@example.com"]);
  await git(repo, ["config", "user.name", "Gate Test"]);
  await git(repo, ["remote", "add", "origin", "git@github.com:gate-owner/gate-fixture.git"]);
  await writeJson(join(repo, ".across", "repo-push-gate.json"), remoteConfig(approvalToken));
  await writeJson(join(repo, "package.json"), { name: "gate-fixture", version: "1.0.0", type: "module" });
  await writeFile(join(repo, "src", "index.js"), "export const ready = true;\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "baseline"]);
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["checkout", "-b", "feature/remote-gate"]);
  await writeFile(join(repo, "src", "feature.js"), "export const feature = true;\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "feature"]);
  await writeJson(statePath, {
    invocations: 0,
    pr: null,
    prCreateCount: 0,
    checks: [],
    comments: [],
    runListIndex: 0,
    pushCount: 0,
    remoteRefs: {},
    runLists: [
      [{ databaseId: 91, name: "Unit tests", workflowName: "Unit tests", status: "in_progress", conclusion: null, url: "https://github.com/gate-owner/gate-fixture/actions/runs/91", updatedAt: "2026-07-11T00:00:00Z" }],
      [{ databaseId: 91, name: "Unit tests", workflowName: "Unit tests", status: "completed", conclusion: "failure", url: "https://github.com/gate-owner/gate-fixture/actions/runs/91", updatedAt: "2026-07-11T00:00:01Z" }]
    ],
    failureLog: `test failed\nAssertionError: expected 2 but got 3\nError API_KEY=super-secret-ci-value\n${githubToken}\n`
  });
  await writeFile(gh, fakeGhSource(statePath), "utf8");
  await chmod(gh, 0o755);
  const gitCommand = join(home, "bin", "git");
  const realGit = String((await exec("which", ["git"])).stdout || "").trim();
  await writeFile(gitCommand, fakeGitSource(statePath, realGit), "utf8");
  await chmod(gitCommand, 0o755);
  return {
    home, repo, statePath, gh, gitCommand, baseSha, approvalToken, githubToken,
    cleanup: () => rm(home, { recursive: true, force: true })
  };
}

function remoteConfig(approvalToken) {
  return {
    schema_version: "across-autopilot-gate-config/1.0",
    id: "remote-fixture",
    network_policy: "allow",
    github_remote: {
      enabled: true,
      repository: "gate-owner/gate-fixture",
      allowed_hosts: ["github.com"],
      allowed_operations: ["push_branch", "draft_pr", "ci_watch", "check_run", "pr_comment"],
      allowed_push_refs: ["refs/heads/feature/remote-gate"],
      require_draft: true,
      approval_token_env: "ACROSS_REPO_GATE_APPROVAL_TOKEN",
      approval_token_sha256: sha256(approvalToken),
      auth_token_env: "GH_TOKEN"
    },
    checks: [{ id: "syntax", category: "test", argv: ["node", "--check", "src/index.js"], required: true, timeout_ms: 10_000 }],
    tools: [],
    budget: { max_commands: 4, max_total_timeout_ms: 60_000, max_diff_bytes: 1_000_000, max_changed_files: 100, max_findings: 100, max_output_bytes: 64_000, max_repair_actions: 4, max_repair_rounds: 2 },
    ci: { required: true, expected_checks: ["Unit tests"] },
    policies: {
      dirty_tree: "block",
      base_must_be_ancestor: true,
      codeowners: { required: false, require_changed_file_coverage: false },
      generated_files: { mode: "report", patterns: ["**/*.generated.*"] },
      vulnerability: { required_tool: false }
    }
  };
}

function fakeGitSource(statePath, realGit) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const path = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const save = () => fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\\n");
if (args[0] === "ls-remote") {
  if (args[1] === "--get-url") { save(); process.stdout.write((state.effectiveRemoteUrl || args[2]) + "\\n"); process.exit(0); }
  const ref = args[args.length - 1];
  const sha = state.remoteRefs[ref];
  save();
  if (!sha) process.exit(2);
  process.stdout.write(sha + "\\t" + ref + "\\n");
} else if (args[0] === "push") {
  if (!args.includes("--no-force") || args.some((item) => /force|delete|tags/.test(item) && item !== "--no-force")) {
    process.stderr.write("unsafe push arguments"); process.exit(9);
  }
  const refspec = args[args.length - 1];
  const split = refspec.indexOf(":");
  const source = refspec.slice(0, split);
  const target = refspec.slice(split + 1);
  if (!/^[a-f0-9]{40,64}$/i.test(source) || !target.startsWith("refs/heads/") || target === "refs/heads/main") {
    process.stderr.write("unsafe refspec"); process.exit(9);
  }
  state.pushCount += 1;
  state.remoteRefs[target] = source;
  if (state.failPushAfterMutation && !state.pushResponseFailed) {
    state.pushResponseFailed = true; save(); process.stderr.write("simulated push response loss"); process.exit(1);
  }
  save(); process.stdout.write("ok " + refspec + "\\n");
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
`;
}

function fakeGhSource(statePath) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const path = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(path, "utf8"));
state.invocations += 1;
const save = () => fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\\n");
const value = (flag) => args[args.indexOf(flag) + 1];
const input = () => { try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; } };
const done = (payload = "") => { save(); process.stdout.write(typeof payload === "string" ? payload : JSON.stringify(payload)); };
if (args[0] === "pr" && args[1] === "view") {
  if (!state.pr) { save(); process.stderr.write("no pull requests found"); process.exit(1); }
  if (state.failViewAfterCreate && !state.viewFailedAfterCreate) { state.viewFailedAfterCreate = true; save(); process.stderr.write("simulated response loss after create"); process.exit(1); }
  done(state.pr);
} else if (args[0] === "pr" && args[1] === "create") {
  if (state.failCreateTransportOnce && !state.createTransportFailed) {
    state.createTransportFailed = true; save(); process.stderr.write("Post https://api.github.com/graphql: TLS handshake timeout"); process.exit(1);
  }
  state.prCreateCount += 1;
  state.pr = { number: 7, url: "https://github.com/gate-owner/gate-fixture/pull/7", isDraft: true, state: "OPEN", headRefName: value("--head"), baseRefName: value("--base"), title: value("--title"), body: value("--body") };
  done(state.pr.url);
} else if (args[0] === "pr" && args[1] === "edit") {
  state.pr.title = value("--title"); state.pr.body = value("--body"); done("");
} else if (args[0] === "run" && args[1] === "list") {
  const index = Math.min(state.runListIndex, state.runLists.length - 1);
  state.runListIndex += 1; done(state.runLists[index]);
} else if (args[0] === "run" && args[1] === "view") {
  done(state.failureLog);
} else if (args[0] === "api") {
  const method = value("--method");
  const endpoint = args.find((item) => item.startsWith("repos/"));
  const restPr = () => state.pr && ({ number: state.pr.number, html_url: state.pr.url, draft: state.pr.isDraft, state: state.pr.state.toLowerCase(), head: { ref: state.pr.headRefName }, base: { ref: state.pr.baseRefName } });
  if (method === "GET" && endpoint.includes("/pulls?")) {
    done(state.pr ? [restPr()] : []);
  }
  else if (method === "POST" && endpoint.endsWith("/pulls")) {
    if (state.failCreateTransportOnce && !state.createTransportFailed) { state.createTransportFailed = true; save(); process.stderr.write("Post https://api.github.com/repos: TLS handshake timeout"); process.exit(1); }
    const body = input(); state.prCreateCount += 1;
    state.pr = { number: 7, url: "https://github.com/gate-owner/gate-fixture/pull/7", isDraft: body.draft === true, state: "OPEN", headRefName: body.head, baseRefName: body.base, title: body.title, body: body.body };
    if (state.failViewAfterCreate && !state.viewFailedAfterCreate) { state.viewFailedAfterCreate = true; save(); process.stderr.write("simulated response loss after create"); process.exit(1); }
    done(restPr());
  }
  else if (method === "PATCH" && endpoint.includes("/pulls/")) {
    const body = input(); state.pr = { ...state.pr, title: body.title, body: body.body, baseRefName: body.base || state.pr.baseRefName }; done(restPr());
  }
  else if (method === "GET" && endpoint.includes("/commits/") && endpoint.endsWith("/check-runs")) done({ check_runs: state.checks });
  else if (method === "POST" && endpoint.endsWith("/check-runs")) { if (state.rejectCheckRunAsUserToken) { save(); process.stderr.write("gh: You must authenticate via a GitHub App. (HTTP 403)"); process.exit(1); } const body = input(); const item = { id: 11, ...body }; state.checks.push(item); done(item); }
  else if (method === "PATCH" && endpoint.includes("/check-runs/")) { const body = input(); state.checks[0] = { ...state.checks[0], ...body }; done(state.checks[0]); }
  else if (method === "GET" && endpoint.includes("/commits/") && endpoint.endsWith("/status")) done({ statuses: state.statuses || [] });
  else if (method === "POST" && endpoint.includes("/statuses/")) { const item = { id: 31, ...input() }; state.statuses = state.statuses || []; state.statuses.unshift(item); done(item); }
  else if (method === "GET" && endpoint.includes("/comments?")) done(state.comments);
  else if (method === "POST" && endpoint.includes("/issues/") && endpoint.endsWith("/comments")) { const item = { id: 21, ...input() }; state.comments.push(item); done(item); }
  else if (method === "PATCH" && endpoint.includes("/issues/comments/")) { state.comments[0] = { ...state.comments[0], ...input() }; done(state.comments[0]); }
  else { save(); process.stderr.write("unsupported api " + method + " " + endpoint); process.exit(2); }
} else { save(); process.stderr.write("unsupported command " + args.join(" ")); process.exit(2); }
`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function git(cwd, args) {
  const result = await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return String(result.stdout || "").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
