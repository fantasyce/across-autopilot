import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stableJson } from "./json-utils.js";
import {
  normalizeCiSnapshot,
  readTrustedRemotePolicy,
  renderGateMarkdown,
  runRepoPushGate
} from "./repo-gate.js";

const REMOTE_SCHEMA = "across-autopilot-github-remote/1.0";
const CI_WATCH_SCHEMA = "across-autopilot-github-ci-watcher/1.0";
const COMMENT_MARKER = "<!-- across-autopilot:repo-push-gate -->";
const CHECK_NAME = "Across Repository Push Gate";

export async function runRepoPushGateWithGitHub(options = {}) {
  const requested = options.approveRemote === true || options.approve_remote === true;
  const localOptions = { ...options, approveRemote: undefined, approve_remote: undefined };
  const initial = await runRepoPushGate({ ...localOptions, deferCiRequirement: requested });
  if (!requested) return { ...initial, github_remote: remoteReceipt("not_requested") };

  const trusted = await readTrustedRemotePolicy(options);
  const authorization = authorizeRemote({ result: initial, trusted, options });
  if (!authorization.allowed) {
    return {
      ...initial,
      status: "remote_blocked",
      github_remote: remoteReceipt("denied", { authorization: authorization.public, errors: authorization.errors })
    };
  }

  const client = createGitHubClient({
    command: options.ghCommand || options.gh_command || "gh",
    repoRoot: trusted.repo_root,
    token: authorization.token,
    host: authorization.host,
    extraEnv: options.ghEnv || options.gh_env,
    commandIdleTimeoutMs: positiveMs(options.ghCommandIdleTimeoutMs ?? options.gh_command_idle_timeout_ms, 30_000, 1_000, 300_000),
    commandMaxWallMs: positiveMs(options.ghCommandMaxWallMs ?? options.gh_command_max_wall_ms, 120_000, 1_000, 600_000)
  });
  const gitClient = createGitClient({
    command: options.gitCommand || options.git_command || "git",
    repoRoot: trusted.repo_root,
    extraEnv: options.gitEnv || options.git_env,
    commandIdleTimeoutMs: positiveMs(options.gitCommandIdleTimeoutMs ?? options.git_command_idle_timeout_ms, 30_000, 1_000, 300_000),
    commandMaxWallMs: positiveMs(options.gitCommandMaxWallMs ?? options.git_command_max_wall_ms, 120_000, 1_000, 600_000)
  });
  const operations = [];
  let branchPush = null;
  let pullRequest;
  let ciWatch = null;
  let final = initial;
  try {
    branchPush = await auditedRemoteOperation(operations, {
      id: "push_branch",
      idempotency_key: `${authorization.repository}:${initial.head_sha}:${authorization.push_ref}`
    }, () => ensureFeatureBranch({
      client: gitClient,
      remoteUrl: initial.repository.remote,
      expectedHost: authorization.host,
      expectedRepository: authorization.repository,
      sourceSha: initial.head_sha,
      targetRef: authorization.push_ref,
      baseRef: initial.base_ref
    }));

    pullRequest = await auditedRemoteOperation(operations, {
      id: "draft_pr",
      idempotency_key: `${authorization.repository}:${initial.head_ref}:draft-pr`
    }, () => ensureDraftPullRequest({
      client,
      repository: authorization.repository,
      baseRef: initial.base_ref,
      headRef: initial.head_ref,
      body: renderRemoteBody(initial),
      title: `[Across] ${initial.head_ref} repository gate`
    }));

    if (optionBoolean(options.watchCi ?? options.watch_ci, true)) {
      requireOperation(authorization.policy, "ci_watch");
      ciWatch = await watchGitHubCi({
        client,
        repository: authorization.repository,
        headRef: initial.head_ref,
        headSha: initial.head_sha,
        expectedChecks: trusted.expected_checks || [],
        pollMs: positiveMs(options.ciPollMs ?? options.ci_poll_ms, 5_000, options.allowFastPolling ? 5 : 250, 60_000),
        idleTimeoutMs: positiveMs(options.ciIdleTimeoutMs ?? options.ci_idle_timeout_ms, 900_000, 1_000, 7_200_000),
        maxWallTimeoutMs: positiveMs(options.ciMaxWallTimeoutMs ?? options.ci_max_wall_timeout_ms, 7_200_000, 1_000, 14_400_000),
        maxLogBytes: positiveMs(options.ciMaxLogBytes ?? options.ci_max_log_bytes, 16_384, 1_024, 65_536)
      });
      operations.push({
        id: "ci_watch",
        status: ciWatch.status,
        mutation_performed: false,
        idempotency_key: `${authorization.repository}:${initial.head_sha}:ci`,
        polls: ciWatch.polls,
        heartbeat_count: ciWatch.heartbeats.length
      });
      final = await runRepoPushGate({ ...localOptions, ci: ciWatch.snapshot });
    }

    pullRequest = await auditedRemoteOperation(operations, {
      id: "draft_pr_finalize",
      idempotency_key: `${authorization.repository}:${final.head_ref}:draft-pr`
    }, () => ensureDraftPullRequest({
      client,
      repository: authorization.repository,
      baseRef: final.base_ref,
      headRef: final.head_ref,
      body: renderRemoteBody(final),
      title: `[Across] ${final.head_ref} repository gate`
    }), "draft_pr_finalize");

    if (authorization.policy.allowed_operations.includes("check_run")) {
      await auditedRemoteOperation(operations, {
        id: "check_run",
        idempotency_key: `${authorization.repository}:${final.head_sha}:${CHECK_NAME}`
      }, () => upsertCheckRun({ client, repository: authorization.repository, result: final, verificationMode: authorization.policy.verification_mode }));
    }
    if (authorization.policy.allowed_operations.includes("pr_comment")) {
      await auditedRemoteOperation(operations, {
        id: "pr_comment",
        idempotency_key: `${authorization.repository}:${pullRequest.number}:gate-comment`
      }, () => upsertPullRequestComment({
        client,
        repository: authorization.repository,
        number: pullRequest.number,
      body: bounded(`${COMMENT_MARKER}\n${renderGateMarkdown(final)}`, 60_000)
      }));
    }
  } catch (error) {
    const receipt = remoteReceipt("failed", {
      authorization: authorization.public,
      branch_push: branchPush,
      pull_request: publicPullRequest(pullRequest),
      ci_watch: ciWatch,
      operations,
      errors: [bounded(redact(String(error?.message || error), authorization.token), 2_000)]
    });
    return { ...final, status: "remote_failed", github_remote: receipt };
  }

  return {
    ...final,
    github_remote: remoteReceipt("completed", {
      authorization: authorization.public,
      branch_push: branchPush,
      pull_request: publicPullRequest(pullRequest),
      ci_watch: ciWatch,
      operations
    })
  };
}

export async function watchGitHubCi({
  client,
  repository,
  headRef,
  headSha,
  expectedChecks = [],
  pollMs = 5_000,
  idleTimeoutMs = 900_000,
  maxWallTimeoutMs = 7_200_000,
  maxLogBytes = 16_384
}) {
  const startedAt = Date.now();
  let lastHeartbeatAt = startedAt;
  let polls = 0;
  let checks = [];
  const heartbeats = [];
  const errors = [];
  let status = "max_wall_timeout";
  while (Date.now() - startedAt < maxWallTimeoutMs) {
    polls += 1;
    try {
      const runs = await client.json([
        "run", "list", "--repo", repository, "--branch", headRef, "--commit", headSha,
        "--limit", "100", "--json", "databaseId,name,status,conclusion,url,workflowName,updatedAt"
      ]);
      lastHeartbeatAt = Date.now();
      checks = await normalizeWorkflowRuns(client, repository, Array.isArray(runs) ? runs : [], maxLogBytes);
      heartbeats.push({
        sequence: polls,
        observed_at: new Date(lastHeartbeatAt).toISOString(),
        check_count: checks.length,
        pending_count: checks.filter((item) => ["queued", "in_progress"].includes(item.status)).length,
        snapshot_sha256: sha256(stableJson(checks))
      });
      if (heartbeats.length > 50) heartbeats.shift();
      const expectedReady = expectedChecks.length === 0 || expectedChecks.every((expected) => checks.some((item) => item.id === expected || item.name === expected || item.category === expected));
      if (checks.length > 0 && expectedReady && checks.every((item) => !["queued", "in_progress"].includes(item.status))) {
        status = "completed";
        break;
      }
    } catch (error) {
      errors.push(bounded(String(error?.message || error), 1_000));
      if (errors.length > 20) errors.shift();
      if (Date.now() - lastHeartbeatAt >= idleTimeoutMs) {
        status = "idle_timeout";
        break;
      }
    }
    await sleep(pollMs);
  }
  const snapshot = normalizeCiSnapshot({ checks });
  snapshot.watcher = {
    schema_version: CI_WATCH_SCHEMA,
    mode: "github_actions_poll",
    status,
    polls,
    heartbeat_refresh: true,
    idle_timeout_ms: idleTimeoutMs,
    max_wall_timeout_ms: maxWallTimeoutMs,
    elapsed_ms: Date.now() - startedAt,
    last_heartbeat_at: new Date(lastHeartbeatAt).toISOString(),
    errors
  };
  return {
    schema_version: CI_WATCH_SCHEMA,
    status,
    polls,
    heartbeats,
    snapshot,
    failure_summaries: checks.filter((item) => item.failure_summary).map((item) => ({
      run_id: item.run_id,
      name: item.name,
      summary: item.failure_summary,
      log_sha256: item.failure_log_sha256
    }))
  };
}

function authorizeRemote({ result, trusted, options }) {
  const policy = trusted.policy;
  const errors = [...trusted.errors.map((item) => `${item.path}: ${item.message}`)];
  const remote = parseGitRemote(result.repository?.remote);
  if (result.gate_verdict !== "pass") errors.push(`Local gate verdict is ${result.gate_verdict}; remote mutation requires pass.`);
  if (!policy.enabled) errors.push("Trusted baseline does not enable GitHub remote mutation.");
  if (!policy.allowed_operations.includes("push_branch")) errors.push("Trusted baseline does not allow push_branch.");
  if (!policy.allowed_operations.includes("draft_pr")) errors.push("Trusted baseline does not allow draft_pr.");
  if (!remote) errors.push("Origin remote is not a supported GitHub SSH or HTTPS URL.");
  if (remote && !policy.allowed_hosts.includes(remote.host)) errors.push(`Remote host ${remote.host} is not trusted.`);
  if (remote && remote.repository !== policy.repository) errors.push(`Remote repository ${remote.repository} does not match trusted ${policy.repository}.`);
  const approvalToken = process.env[policy.approval_token_env] || "";
  const authToken = process.env[policy.auth_token_env] || "";
  if (!approvalToken || !safeDigestMatch(approvalToken, policy.approval_token_sha256)) errors.push("Approval token is missing or does not match the trusted digest.");
  if (!authToken) errors.push(`GitHub credential is missing from trusted environment variable ${policy.auth_token_env}.`);
  if (options.draftPr === false || options.draft_pr === false) errors.push("Remote mode requires draft PR intent.");
  if (options.pushBranch !== true && options.push_branch !== true) errors.push("Remote mode requires explicit push_branch intent.");
  const branch = result.git_binding?.branch || null;
  const pushRef = branch ? `refs/heads/${branch}` : null;
  if (!isSafeFeatureBranch(branch, result.base_ref)) errors.push("The gated head must be a safe named feature branch; HEAD, main, tags, deletes, and ambiguous refs are forbidden.");
  if (pushRef && !policy.allowed_push_refs.includes(pushRef)) errors.push(`Push ref ${pushRef} is not explicitly trusted.`);
  const publicAuthorization = {
    requested: true,
    allowed: errors.length === 0,
    policy_source: "git_object_at_base_commit",
    policy_base_sha: trusted.base_sha,
    repository: policy.repository,
    host: remote?.host || null,
    push_requested: options.pushBranch === true || options.push_branch === true,
    push_ref: pushRef,
    approval_token_env: policy.approval_token_env,
    approval_token_verified: Boolean(approvalToken) && safeDigestMatch(approvalToken, policy.approval_token_sha256),
    auth_token_env: policy.auth_token_env,
    credential_present: Boolean(authToken),
    secret_material_included: false
  };
  return {
    allowed: errors.length === 0,
    errors,
    public: publicAuthorization,
    policy,
    repository: policy.repository,
    host: remote?.host || null,
    push_ref: pushRef,
    token: authToken
  };
}

function createGitHubClient({ command, repoRoot, token, host, extraEnv, commandIdleTimeoutMs, commandMaxWallMs }) {
  if (isAbsolute(command)) {
    const rel = relative(repoRoot, resolve(command));
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) throw new Error("gh executable may not resolve inside the feature repository.");
  }
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME || "",
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "",
    GH_HOST: host,
    GH_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    NO_COLOR: "1",
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || "",
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || "",
    NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || "",
    SSL_CERT_FILE: process.env.SSL_CERT_FILE || "",
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || "",
    ...safeExtraEnv(extraEnv)
  };
  return {
    async run(args, input = null) {
      return runCommand(command, args, { env, input, idleTimeoutMs: commandIdleTimeoutMs, maxWallTimeoutMs: commandMaxWallMs, token });
    },
    async json(args, input = null) {
      const result = await runCommand(command, args, { env, input, idleTimeoutMs: commandIdleTimeoutMs, maxWallTimeoutMs: commandMaxWallMs, token });
      try {
        return JSON.parse(result.stdout || "null");
      } catch {
        throw new Error(`gh returned invalid JSON for ${args.slice(0, 2).join(" ")}.`);
      }
    }
  };
}

function createGitClient({ command, repoRoot, extraEnv, commandIdleTimeoutMs, commandMaxWallMs }) {
  if (isAbsolute(command)) {
    const rel = relative(repoRoot, resolve(command));
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) throw new Error("git executable may not resolve inside the feature repository.");
  }
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME || "",
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    NO_COLOR: "1",
    HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || "",
    HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || "",
    NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || "",
    SSL_CERT_FILE: process.env.SSL_CERT_FILE || "",
    ...safeGitExtraEnv(extraEnv)
  };
  return {
    async run(args) {
      return runCommand(command, args, {
        cwd: repoRoot,
        env,
        input: null,
        idleTimeoutMs: commandIdleTimeoutMs,
        maxWallTimeoutMs: commandMaxWallMs,
        token: null,
        label: "git"
      });
    }
  };
}

async function ensureFeatureBranch({ client, remoteUrl, expectedHost, expectedRepository, sourceSha, targetRef, baseRef }) {
  if (!/^[a-f0-9]{40,64}$/i.test(sourceSha || "")) throw new Error("Push source must be an explicit commit SHA.");
  const effectiveRemote = await client.run(["ls-remote", "--get-url", remoteUrl]);
  const parsedEffectiveRemote = parseGitRemote(effectiveRemote.stdout);
  if (!parsedEffectiveRemote || parsedEffectiveRemote.host !== expectedHost || parsedEffectiveRemote.repository !== expectedRepository) {
    throw new Error("Git URL rewriting changed the authorized host or repository; refusing to push.");
  }
  const branch = String(targetRef || "").replace(/^refs\/heads\//, "");
  if (targetRef !== `refs/heads/${branch}` || !isSafeFeatureBranch(branch, baseRef)) {
    throw new Error("Push target must be an explicit safe feature branch ref.");
  }
  const idempotencyKey = `${sourceSha}:${targetRef}`;
  const beforeSha = await readRemoteBranchSha(client, remoteUrl, targetRef);
  if (beforeSha === sourceSha) {
    return {
      id: "push_branch",
      status: "unchanged",
      mutation_performed: false,
      resumed: true,
      reconciled: true,
      source_sha: sourceSha,
      target_ref: targetRef,
      remote_sha: beforeSha,
      idempotency_key: idempotencyKey
    };
  }
  try {
    await client.run(["push", "--no-force", "--porcelain", remoteUrl, `${sourceSha}:${targetRef}`]);
  } catch (error) {
    const reconciledSha = await readRemoteBranchSha(client, remoteUrl, targetRef).catch(() => null);
    if (reconciledSha === sourceSha) {
      return {
        id: "push_branch",
        status: "reconciled",
        mutation_performed: true,
        mutation_response_lost: true,
        resumed: true,
        reconciled: true,
        source_sha: sourceSha,
        previous_remote_sha: beforeSha,
        target_ref: targetRef,
        remote_sha: reconciledSha,
        idempotency_key: idempotencyKey
      };
    }
    throw error;
  }
  const remoteSha = await readRemoteBranchSha(client, remoteUrl, targetRef);
  if (remoteSha !== sourceSha) throw new Error("Remote branch SHA does not match the gated source SHA after push.");
  return {
    id: "push_branch",
    status: beforeSha ? "updated" : "created",
    mutation_performed: true,
    resumed: false,
    reconciled: true,
    source_sha: sourceSha,
    previous_remote_sha: beforeSha,
    target_ref: targetRef,
    remote_sha: remoteSha,
    idempotency_key: idempotencyKey
  };
}

async function readRemoteBranchSha(client, remoteUrl, targetRef) {
  try {
    const result = await client.run(["ls-remote", "--exit-code", remoteUrl, targetRef]);
    const rows = String(result.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const exact = rows.find((line) => line.split(/\s+/)[1] === targetRef);
    const sha = exact?.split(/\s+/)[0] || null;
    if (!sha || !/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("git ls-remote did not return an exact branch SHA.");
    return sha;
  } catch (error) {
    if (error?.exitCode === 2) return null;
    throw error;
  }
}

async function ensureDraftPullRequest({ client, repository, baseRef, headRef, title, body }) {
  const safeTitle = bounded(title, 255);
  const safeBody = bounded(body, 60_000);
  const owner = repository.split("/", 1)[0];
  const base = shortRef(baseRef);
  const query = `repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headRef}`)}&base=${encodeURIComponent(base)}`;
  const listed = await client.json(["api", "--method", "GET", query, "--header", "Accept: application/vnd.github+json"]);
  const existing = Array.isArray(listed) && listed.length ? normalizePullRequest(listed[0]) : null;
  if (existing) {
    if (existing.state !== "OPEN" || existing.isDraft !== true) throw new Error("Existing pull request is not an open draft; refusing to mutate it.");
    if (existing.baseRefName && existing.baseRefName !== base) throw new Error("Existing draft PR base does not match the gated base ref.");
    const updated = await client.json(
      ["api", "--method", "PATCH", `repos/${repository}/pulls/${existing.number}`, "--input", "-"],
      stableJson({ title: safeTitle, body: safeBody, base })
    );
    return {
      ...normalizePullRequest(updated),
      operation: { id: "draft_pr", status: "updated", mutation_performed: true, resumed: true, idempotency_key: `${repository}:${headRef}:draft-pr` }
    };
  }
  const payload = { title: safeTitle, body: safeBody, base, head: headRef, draft: true };
  const created = normalizePullRequest(await client.json(
    ["api", "--method", "POST", `repos/${repository}/pulls`, "--input", "-"],
    stableJson(payload)
  ));
  if (!created?.number || created.isDraft !== true) throw new Error("GitHub did not return the created draft pull request.");
  return {
    ...created,
    operation: { id: "draft_pr", status: "created", mutation_performed: true, resumed: false, idempotency_key: `${repository}:${headRef}:draft-pr` }
  };
}

function normalizePullRequest(value) {
  if (!value || typeof value !== "object") return null;
  return {
    number: value.number,
    url: value.url || value.html_url || null,
    isDraft: value.isDraft ?? value.draft ?? false,
    state: String(value.state || "").toUpperCase(),
    headRefName: value.headRefName || value.head?.ref || null,
    baseRefName: value.baseRefName || value.base?.ref || null
  };
}

async function upsertCheckRun({ client, repository, result, verificationMode = "auto" }) {
  if (verificationMode === "commit_status") return upsertCommitStatus({ client, repository, result });
  try {
    const endpoint = `repos/${repository}/commits/${result.head_sha}/check-runs`;
    const listed = await client.json(["api", "--method", "GET", endpoint, "--header", "Accept: application/vnd.github+json"]);
    const existing = (listed?.check_runs || []).find((item) => item.name === CHECK_NAME);
    const payload = {
      name: CHECK_NAME,
      head_sha: result.head_sha,
      status: "completed",
      conclusion: result.github_review.check_run.conclusion,
      external_id: result.evidence_hash,
      output: {
        title: bounded(result.github_review.check_run.output.title, 255),
        summary: bounded(result.github_review.check_run.output.summary, 60_000),
        text: bounded(result.github_review.check_run.output.text, 60_000)
      }
    };
    if (existing?.id) {
      await client.json(["api", "--method", "PATCH", `repos/${repository}/check-runs/${existing.id}`, "--input", "-"], stableJson(payload));
      return { id: "check_run", status: "updated", mutation_performed: true, resumed: true, verification_mode: "check_run", remote_id: String(existing.id), idempotency_key: `${repository}:${result.head_sha}:${CHECK_NAME}` };
    }
    const created = await client.json(["api", "--method", "POST", `repos/${repository}/check-runs`, "--input", "-"], stableJson(payload));
    return { id: "check_run", status: "created", mutation_performed: true, resumed: false, verification_mode: "check_run", remote_id: String(created.id), idempotency_key: `${repository}:${result.head_sha}:${CHECK_NAME}` };
  } catch (error) {
    if (verificationMode !== "auto" || !/authenticate via a GitHub App.*HTTP 403/i.test(String(error?.message || error))) throw error;
    return upsertCommitStatus({ client, repository, result });
  }
}

async function upsertCommitStatus({ client, repository, result }) {
  const endpoint = `repos/${repository}/commits/${result.head_sha}/status`;
  const listed = await client.json(["api", "--method", "GET", endpoint, "--header", "Accept: application/vnd.github+json"]);
  const state = result.github_review.check_run.conclusion === "success" ? "success" : "failure";
  const description = bounded(result.pr_ready_summary || `Across gate: ${result.gate_verdict}`, 140);
  const existing = (listed?.statuses || []).find((item) => item.context === CHECK_NAME);
  if (existing && existing.state === state && existing.description === description) {
    return { id: "check_run", status: "unchanged", mutation_performed: false, resumed: true, verification_mode: "commit_status_fallback", remote_id: String(existing.id), idempotency_key: `${repository}:${result.head_sha}:${CHECK_NAME}` };
  }
  const created = await client.json(
    ["api", "--method", "POST", `repos/${repository}/statuses/${result.head_sha}`, "--input", "-"],
    stableJson({ state, context: CHECK_NAME, description })
  );
  return { id: "check_run", status: "created", mutation_performed: true, resumed: Boolean(existing), verification_mode: "commit_status_fallback", remote_id: String(created.id), idempotency_key: `${repository}:${result.head_sha}:${CHECK_NAME}` };
}

async function upsertPullRequestComment({ client, repository, number, body }) {
  const payload = await client.json(["api", "--method", "GET", `repos/${repository}/issues/${number}/comments?per_page=100`, "--paginate", "--slurp"]);
  const comments = Array.isArray(payload) ? payload.flat().filter((item) => item && typeof item === "object") : [];
  const existing = comments.find((item) => String(item.body || "").includes(COMMENT_MARKER));
  if (existing?.id) {
    await client.json(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${existing.id}`, "--input", "-"], stableJson({ body }));
    return { id: "pr_comment", status: "updated", mutation_performed: true, resumed: true, remote_id: String(existing.id), idempotency_key: `${repository}:${number}:gate-comment` };
  }
  const created = await client.json(["api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "--input", "-"], stableJson({ body }));
  return { id: "pr_comment", status: "created", mutation_performed: true, resumed: false, remote_id: String(created.id), idempotency_key: `${repository}:${number}:gate-comment` };
}

async function auditedRemoteOperation(operations, intent, operation, overrideId = null) {
  const index = operations.push({
    ...intent,
    status: "started",
    mutation_performed: false,
    mutation_may_have_occurred: false
  }) - 1;
  const retryDelaysMs = [0, 500, 1_500, 3_500, 7_500, 15_000];
  let lastError;
  for (let attempt = 1; attempt <= retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt - 1] > 0) await sleep(retryDelaysMs[attempt - 1]);
    try {
      const result = await operation();
      const completed = result?.operation || result;
      operations[index] = { ...completed, id: overrideId || completed.id || intent.id, attempts: attempt };
      return result;
    } catch (error) {
      lastError = error;
      if (!isTransientTransportError(error) || attempt === retryDelaysMs.length) break;
      operations[index] = {
        ...operations[index],
        status: "retrying_transport",
        attempts: attempt,
        last_transport_error_sha256: sha256(String(error?.message || error)),
        last_heartbeat_at: new Date().toISOString()
      };
    }
  }
  operations[index] = {
    ...operations[index],
    status: "unknown_after_attempt",
    mutation_may_have_occurred: true,
    recovery: "rerun_with_same_idempotency_key"
  };
  throw lastError;
}

function isTransientTransportError(error) {
  return /\bEOF\b|TLS handshake timeout|connection reset|socket hang up|ETIMEDOUT|ECONNRESET|temporary failure|HTTP (?:502|503|504)\b/i
    .test(String(error?.message || error));
}

async function normalizeWorkflowRuns(client, repository, runs, maxLogBytes) {
  const checks = [];
  for (const run of runs) {
    const category = categoryFor(run.workflowName || run.name);
    const raw = String(run.conclusion || run.status || "unknown").toLowerCase();
    const failed = ["failure", "action_required", "stale", "startup_failure"].includes(raw);
    let failureSummary = null;
    let failureLogSha256 = null;
    if (failed && run.databaseId) {
      try {
        const log = await client.run(["run", "view", String(run.databaseId), "--repo", repository, "--log-failed"]);
        const cleaned = bounded(log.stdout || log.stderr, maxLogBytes);
        failureSummary = summarizeFailureLog(cleaned);
        failureLogSha256 = sha256(cleaned);
      } catch (error) {
        failureSummary = bounded(`Failed logs unavailable: ${error.message}`, 1_000);
      }
    }
    checks.push({
      id: String(run.workflowName || run.name || run.databaseId),
      name: String(run.name || run.workflowName || run.databaseId),
      category,
      status: raw,
      run_id: run.databaseId === undefined ? null : String(run.databaseId),
      details_url: run.url || null,
      updated_at: run.updatedAt || null,
      failure_summary: failureSummary,
      failure_log_sha256: failureLogSha256
    });
  }
  return normalizeCiSnapshot({ checks }).checks;
}

function remoteReceipt(status, fields = {}) {
  const withoutHash = {
    schema_version: REMOTE_SCHEMA,
    status,
    mutation_performed: (fields.operations || []).some((item) => item.mutation_performed === true),
    remote_state_requires_reconciliation: (fields.operations || []).some((item) => item.mutation_may_have_occurred === true),
    recoverable: ["failed", "completed"].includes(status),
    secret_material_persisted: false,
    authorization: fields.authorization || { requested: false, allowed: false, secret_material_included: false },
    branch_push: fields.branch_push || null,
    pull_request: fields.pull_request || null,
    ci_watch: fields.ci_watch || null,
    operations: fields.operations || [],
    errors: fields.errors || []
  };
  return { ...withoutHash, audit_hash: sha256(stableJson(withoutHash)) };
}

function publicPullRequest(pr) {
  if (!pr) return null;
  return { number: pr.number, url: pr.url || null, state: pr.state, draft: pr.isDraft === true, head_ref: pr.headRefName || null, base_ref: pr.baseRefName || null };
}

function renderRemoteBody(result) {
  return bounded(`${COMMENT_MARKER}\n${renderGateMarkdown(result)}\n\nRemote operations remain draft-only and require a trusted approval receipt.`, 60_000);
}

function requireOperation(policy, operation) {
  if (!policy.allowed_operations.includes(operation)) throw new Error(`Trusted baseline does not allow ${operation}.`);
}

function parseGitRemote(remote) {
  const value = String(remote || "").trim();
  let match = value.match(/^git@([^:]+):([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match) return { host: match[1].toLowerCase(), repository: match[2].replace(/\.git$/, "") };
  match = value.match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? { host: match[1].toLowerCase(), repository: match[2].replace(/\.git$/, "") } : null;
}

function safeDigestMatch(value, expected) {
  if (!value || !/^[a-f0-9]{64}$/i.test(expected || "")) return false;
  const actual = Buffer.from(sha256(value), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function safeExtraEnv(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key.startsWith("FAKE_GH_") && typeof item === "string"));
}

function safeGitExtraEnv(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key.startsWith("FAKE_GIT_") && typeof item === "string"));
}

function runCommand(command, args, { cwd, env, input, idleTimeoutMs, maxWallTimeoutMs, token, label = "gh" }) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const started = Date.now();
    let lastActivity = started;
    let stdout = "";
    let stderr = "";
    let timeoutReason = null;
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - started >= maxWallTimeoutMs) timeoutReason = "maximum wall timeout";
      else if (now - lastActivity >= idleTimeoutMs) timeoutReason = "idle timeout";
      if (timeoutReason) child.kill("SIGTERM");
    }, Math.min(250, Math.max(25, Math.floor(idleTimeoutMs / 4))));
    child.stdout.on("data", (chunk) => {
      lastActivity = Date.now();
      stdout = bounded(`${stdout}${chunk}`, 1_000_000);
    });
    child.stderr.on("data", (chunk) => {
      lastActivity = Date.now();
      stderr = bounded(`${stderr}${chunk}`, 256_000);
    });
    child.on("error", (error) => {
      clearInterval(timer);
      reject(new Error(`Unable to execute ${label}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearInterval(timer);
      const cleanOut = redact(stdout, token);
      const cleanErr = redact(stderr, token);
      if (code === 0 && !timeoutReason) return accept({ stdout: cleanOut.trim(), stderr: cleanErr.trim(), exit_code: 0, signal: null });
      const error = new Error(`${label} ${args.slice(0, 2).join(" ")} failed: ${timeoutReason || cleanErr || `exit ${code}${signal ? ` signal ${signal}` : ""}`}`);
      error.exitCode = code;
      reject(error);
    });
    if (input !== null && input !== undefined) child.stdin.end(String(input));
    else child.stdin.end();
  });
}

function isSafeFeatureBranch(branch, baseRef) {
  const value = String(branch || "");
  if (!value || value === "HEAD" || value === "main" || value === "master" || value === shortRef(baseRef)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{")) return false;
  if (/[~^:?*\\[\\\\\s]/.test(value) || value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) return false;
  return !value.startsWith("refs/") && !value.startsWith("tags/");
}

function summarizeFailureLog(log) {
  const lines = String(log || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const selected = lines.filter((line) => /error|fail|fatal|assert|exception|timeout/i.test(line));
  return bounded((selected.length ? selected : lines).slice(0, 40).join("\n"), 8_000) || null;
}

function categoryFor(value) {
  const text = String(value || "").toLowerCase();
  if (/lint|format|style|ruff|eslint/.test(text)) return "lint";
  if (/test|pytest|jest|spec|coverage/.test(text)) return "test";
  if (/doc|markdown|link|spell/.test(text)) return "docs";
  if (/review|approval|codeowner/.test(text)) return "review";
  if (/security|secret|sast|codeql|vulnerab|sbom|dependabot/.test(text)) return "security";
  return "other";
}

function optionBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function positiveMs(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
}

function shortRef(value) {
  return String(value || "main").replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

function bounded(value, limit) {
  const text = String(value || "");
  return Buffer.byteLength(text) <= limit ? text : Buffer.from(text).subarray(0, limit).toString("utf8");
}

function redact(value, token) {
  let text = String(value || "");
  if (token) text = text.split(token).join("[REDACTED_TOKEN]");
  return text
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED_SECRET]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED_PROXY_CREDENTIALS]@");
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function sleep(ms) {
  return new Promise((accept) => setTimeout(accept, ms));
}
