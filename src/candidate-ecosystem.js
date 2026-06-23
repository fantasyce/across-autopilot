import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { componentDataHome, ecosystemHome } from "./paths.js";
import { asArray, compactTimestamp, readJson, stableJson, unique } from "./json-utils.js";
import { FAILURE_CODES, LoopFailure } from "./failures.js";
import { parseCommand, resolveCommand, runJsonCommand } from "./process-client.js";
import { requestCandidateModelLease, writeCandidateModelLease } from "./model-lease.js";
import {
  autonomousTargetsFromBacklog,
  prepareAutonomousLoopState,
  recordGeneratedAutonomousBacklog,
  targetGenerationPolicy
} from "./loop-state.js";

const exec = promisify(execFile);

export const REQUIRED_ECOSYSTEM_REPOS = Object.freeze([
  "across-agents-assistant",
  "across-orchestrator",
  "across-context",
  "across-autopilot"
]);

const DEFAULT_EXCLUDES = Object.freeze([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".build",
  "dist",
  "build",
  "DerivedData",
  ".DS_Store",
  "uv.lock"
]);

const DEFAULT_DENIED_PATHS = Object.freeze([
  ".git/",
  ".env",
  ".env.local",
  "*.pem",
  "*.p12",
  "*.mobileprovision",
  "*.key",
  "credentials",
  "credentials.json",
  "secrets",
  "secrets.json"
]);

export const CANDIDATE_SOCKET_RELATIVE_PATH = Object.freeze(["aaa", "run", "across-agents.sock"]);
export const MAX_MACOS_UNIX_SOCKET_PATH_BYTES = 103;

function modelPolicyForRole(spec, role) {
  const pack = spec.pack_config || {};
  const base = {
    ...(spec.model_policy || {}),
    ...(pack.model_policy || {})
  };
  const roleKeys = {
    research: ["research_model_policy", "researcher_model_policy"],
    builder: ["builder_model_policy", "code_model_policy"],
    reviewer: ["reviewer_model_policy", "acceptance_model_policy"]
  }[role] || [];
  const specific = roleKeys.reduce((policy, key) => ({
    ...policy,
    ...(pack[key] || {})
  }), {});
  return {
    ...base,
    ...specific,
    role: specific.role || base.role || (role === "builder" ? "loop_engineer" : `loop_${role}`)
  };
}

function modelIdentity(provider, model) {
  const providerText = String(provider || "").trim();
  const modelText = String(model || "").trim();
  return {
    provider: providerText || null,
    model: modelText || null,
    key: `${providerText.toLowerCase()}::${modelText.toLowerCase()}`
  };
}

export function candidateConfig(spec, run = null, env = process.env) {
  const declared = spec.pack_config?.candidate_ecosystem || {};
  const runCandidateId = run?.run_id ? String(run.run_id).replace(/^run-/, "") : "";
  const candidateId = safeSegment(declared.candidate_id || spec.pack_config?.candidate_id || runCandidateId || `${compactTimestamp()}-${spec.id}`);
  const runtimeKey = safeSegment(declared.runtime_key || shortCandidateRuntimeKey(candidateId));
  const base = resolvePath(
    declared.base_dir || join(componentDataHome("across-autopilot", env), "candidate-workspaces", candidateId),
    process.cwd()
  );
  const runtimeHome = resolvePath(
    declared.runtime_home || join(candidateRuntimeRoot(env), runtimeKey),
    process.cwd()
  );
  const appHome = resolvePath(
    declared.app_home || join(runtimeHome, "aaa"),
    process.cwd()
  );
  const appDir = resolvePath(
    declared.app_dir || join(componentDataHome("across-autopilot", env), "candidate-apps", candidateId),
    process.cwd()
  );
  const mode = declared.mode || "snapshot";
  const repos = normalizeRepos(declared.repos || spec.pack_config?.candidate_repositories || [], env);
  const config = {
    candidate_id: candidateId,
    mode,
    base_dir: base,
    repos_dir: join(base, "repos"),
    manifest_path: join(base, "candidate-manifest.json"),
    runtime_key: runtimeKey,
    runtime_home: runtimeHome,
    app_home: appHome,
    app_dir: appDir,
    repos,
    required_repos: REQUIRED_ECOSYSTEM_REPOS
  };
  return {
    ...config,
    runtime_preflight: candidateRuntimePreflight(config)
  };
}

export async function acquireCandidateEcosystem({ spec, run, env = process.env }) {
  const config = candidateConfig(spec, run, env);
  assertCandidateRuntimePreflight(config);
  if (!["snapshot", "clean_ref"].includes(config.mode)) {
    throw ecosystemFailure("candidate_ecosystem_acquire", `Unsupported candidate acquisition mode: ${config.mode}`);
  }
  if (config.repos.length < REQUIRED_ECOSYSTEM_REPOS.length) {
    const present = new Set(config.repos.map((repo) => repo.id));
    const missing = REQUIRED_ECOSYSTEM_REPOS.filter((id) => !present.has(id));
    throw ecosystemFailure("candidate_ecosystem_acquire", `Candidate ecosystem is missing repos: ${missing.join(", ")}`);
  }

  await mkdir(config.repos_dir, { recursive: true });
  await mkdir(config.runtime_home, { recursive: true });
  await mkdir(config.app_home, { recursive: true });
  await mkdir(config.app_dir, { recursive: true });
  const modelLease = await writeCandidateModelLease({ config, env });

  const repoRecords = [];
  for (const repo of config.repos) {
    const target = join(config.repos_dir, repo.id);
    const sourceState = await inspectSourceRepo(repo);
    await rm(target, { recursive: true, force: true });
    if (config.mode === "clean_ref") {
      await cloneRepo(repo, target);
    } else {
      await copyRepoSnapshot(repo, target);
    }
    await ensureGitBaseline(target, repo.id, config.mode);
    const baseline = await gitMaybe(target, ["rev-parse", "HEAD"]);
    const status = await gitMaybe(target, ["status", "--short", "--untracked-files=all"]);
    repoRecords.push({
      id: repo.id,
      source: repo.source,
      target,
      mode: config.mode,
      baseline_ref: (repo.ref || repo.branch || "").trim() || baseline.trim(),
      head_ref: baseline.trim(),
      status_pre: status,
      clean_pre: status.trim() === "",
      source_git: sourceState.git,
      source_head_pre: sourceState.head,
      source_status_pre: sourceState.status
    });
  }

  const dirty = repoRecords.filter((repo) => !repo.clean_pre);
  if (dirty.length && config.mode === "clean_ref") {
    throw ecosystemFailure("candidate_ecosystem_acquire", `Clean ref candidate repos are dirty: ${dirty.map((repo) => repo.id).join(", ")}`);
  }

  const manifest = {
    schema_version: "across-autopilot-candidate-ecosystem/1.0",
    candidate_id: config.candidate_id,
    mode: config.mode,
    created_at: new Date().toISOString(),
    controller: {
      role: "stable-a",
      source_mutation_allowed: false
    },
    paths: {
      base_dir: config.base_dir,
      repos_dir: config.repos_dir,
      runtime_home: config.runtime_home,
      app_home: config.app_home,
      app_dir: config.app_dir,
      socket_path: config.runtime_preflight.socket_path
    },
    model_lease: modelLease,
    runtime_preflight: config.runtime_preflight,
    repos: repoRecords
  };
  await writeFile(config.manifest_path, `${stableJson(manifest)}\n`, "utf8");
  return {
    status: "passed",
    candidate_id: config.candidate_id,
    mode: config.mode,
    base_dir: config.base_dir,
    manifest_path: config.manifest_path,
    runtime_key: config.runtime_key,
    runtime_home: config.runtime_home,
    app_home: config.app_home,
    app_dir: config.app_dir,
    model_lease: modelLease,
    runtime_preflight: config.runtime_preflight,
    repos: repoRecords,
    four_repo_manifest: REQUIRED_ECOSYSTEM_REPOS.every((id) => repoRecords.some((repo) => repo.id === id))
  };
}

export async function runHostCodeIteration({ spec, run, actions, env = process.env }) {
  const acquire = actionResult(actions, "candidate_ecosystem_acquire");
  const config = candidateConfig(spec, run, env);
  const strategy = selectedIterationFromActions(actions);
  const targetRepo = strategy?.target_repo || spec.pack_config?.target_repo || "across-agents-assistant";
  const repo = (acquire?.repos || []).find((item) => item.id === targetRepo);
  if (!repo) throw ecosystemFailure("host_code_iteration", `Target repo not found in candidate ecosystem: ${targetRepo}`);

  const command = spec.pack_config?.code_iteration?.command
    || env.ACROSS_AAA_HOST_CODE_COMMAND
    || env.ACROSS_AAA_HOST_MODEL_COMMAND;
  if (!command) {
    throw ecosystemFailure("host_code_iteration", "Host code iteration command is not configured.");
  }
  const allowedPaths = asArray(strategy?.allowed_patch_paths || spec.pack_config?.code_iteration?.allowed_patch_paths || spec.pack_config?.allowed_patch_paths);
  const request = {
    schema_version: "across-host-code-iteration-request/1.0",
    goal: strategy?.goal || spec.pack_config?.code_iteration?.goal || spec.description || spec.name,
    run_id: run.run_id,
    candidate_id: config.candidate_id,
    candidate_workspace: repo.target,
    candidate_ecosystem: acquire,
    target_repo: targetRepo,
    source_repository: config.repos.find((item) => item.id === targetRepo)?.source || null,
    allowed_patch_paths: allowedPaths,
    context_files: asArray(strategy?.context_files || spec.pack_config?.code_iteration?.context_files || spec.model_policy?.context_files),
    validation_commands: asArray(strategy?.validation_commands || spec.pack_config?.candidate_validation?.commands || spec.pack_config?.validation_commands),
    validation_feedback: validationFeedbackForCodeIteration(actions),
    candidate_model_lease: requestCandidateModelLease(acquire?.model_lease),
    model_policy: modelPolicyForRole(spec, "builder")
  };
  const response = await runJsonCommand(command, ["--request-json", JSON.stringify(request)], {
    env,
    cwd: repo.target,
    timeoutMs: Number(spec.pack_config?.code_iteration?.timeout_ms || 240_000),
    maxBuffer: 10 * 1024 * 1024
  });
  const patches = asArray(response.patches);
  if (!patches.length) {
    throw ecosystemFailure("host_code_iteration", "Host code iteration command returned no patches.");
  }
  const applied = [];
  for (const patch of patches) {
    const rel = safeRelativePath(patch.path);
    assertAllowed(rel, allowedPaths);
    assertNotDenied(rel, spec);
    const target = ensureInside(repo.target, resolve(repo.target, rel));
    await mkdir(dirname(target), { recursive: true });
    const before = await readOptional(target);
    const content = String(patch.content || "");
    if (!content.trim()) throw ecosystemFailure("host_code_iteration", `Patch content is empty for ${rel}`);
    let next = content;
    if (patch.mode === "append") {
      next = `${before || ""}${before && !before.endsWith("\n") ? "\n" : ""}${content}`;
    }
    await writeFile(target, next, "utf8");
    applied.push({
      repo: targetRepo,
      path: rel,
      mode: patch.mode || "overwrite",
      changed: before !== next,
      bytes_before: Buffer.byteLength(before || ""),
      bytes_after: Buffer.byteLength(next)
    });
  }
  return {
    status: applied.some((item) => item.changed) ? "passed" : "attention",
    candidate_id: config.candidate_id,
    target_repo: targetRepo,
    workspace: repo.target,
    model_backed: response.model_backed !== false,
    provider: response.provider || response.model_provider || null,
    model: response.model || null,
    decision_hash: response.decision_hash || null,
    candidate_model_lease: response.candidate_model_lease || request.candidate_model_lease || null,
    repaired_json: Boolean(response.repaired_json),
    text_fallback: Boolean(response.text_fallback),
    host_validation_repair_fallback: Boolean(response.host_validation_repair_fallback),
    summary: response.summary || response.decision?.summary || "Host code iteration applied candidate patches.",
    strategy: strategy ? {
      target_id: strategy.target_id || null,
      source_refs: asArray(strategy.source_refs),
      risk: strategy.risk || null
    } : null,
    changed_files: applied.filter((item) => item.changed).map((item) => `${item.repo}/${item.path}`),
    patches: applied
  };
}

export async function runProductIterationStrategy({ spec, run, sources, actions, recalledMemory, env = process.env }) {
  const acquire = actionResult(actions, "candidate_ecosystem_acquire");
  const config = candidateConfig(spec, run, env);
  const targetRepo = spec.pack_config?.target_repo || "across-agents-assistant";
  const repo = (acquire?.repos || []).find((item) => item.id === targetRepo) || acquire?.repos?.[0];
  if (!repo) throw ecosystemFailure("product_iteration_strategy", "Candidate ecosystem must be acquired before strategy selection.");

  const command = spec.pack_config?.research_strategy?.command || env.ACROSS_AAA_HOST_RESEARCH_COMMAND;
  if (!command) {
    throw ecosystemFailure("product_iteration_strategy", "Host research decision command is not configured.");
  }
  const declaredTargets = asArray(spec.pack_config?.research_strategy?.candidate_targets);
  const generationPolicy = targetGenerationPolicy(spec);
  const autonomousState = shouldUseAutonomousBacklog(spec, declaredTargets)
    ? await prepareAutonomousLoopState({ spec, run, sources, recalledMemory, env })
    : null;
  const generatedTargets = autonomousState ? autonomousTargetsFromBacklog(autonomousState.backlog) : [];
  const targetCatalog = generatedTargets.length ? generatedTargets : declaredTargets;
  const request = {
    schema_version: "across-host-research-decision-request/1.0",
    goal: spec.pack_config?.research_strategy?.goal || spec.description || spec.name,
    run_id: run.run_id,
    candidate_id: config.candidate_id,
    candidate_workspace: repo.target,
    sources: compactSourcesForStrategy(sources),
    recalled_memory: asArray(recalledMemory).slice(0, 10),
    product_context: {
      ...(spec.pack_config?.research_strategy?.product_context || {}),
      autonomous_loop_state: autonomousState ? compactAutonomousState(autonomousState) : null
    },
    target_catalog: targetCatalog,
    tool_pack_evidence: buildToolPackEvidence({ spec, run, acquire, sources, recalledMemory, autonomousState }),
    target_generation: {
      ...generationPolicy,
      target_repos: REQUIRED_ECOSYSTEM_REPOS,
      path_policy: openTargetPathPolicy()
    },
    candidate_model_lease: requestCandidateModelLease(acquire?.model_lease),
    model_policy: modelPolicyForRole(spec, "research")
  };
  const response = await runJsonCommand(command, ["--request-json", JSON.stringify(request)], {
    env,
    cwd: repo.target,
    timeoutMs: Number(spec.pack_config?.research_strategy?.timeout_ms || 180_000),
    maxBuffer: 10 * 1024 * 1024
  });
  const strategy = normalizeStrategyResponse(response, spec, targetCatalog, {
    allowGeneratedTargets: generationPolicy.allow_model_generated_targets,
    minimumCandidates: generationPolicy.minimum_candidates
  });
  const admittedBacklog = autonomousState
    ? await recordGeneratedAutonomousBacklog({
      state: autonomousState,
      spec,
      run,
      candidates: strategy.candidate_targets.length ? strategy.candidate_targets : [strategy.selected_iteration],
      selectedTargetId: strategy.selected_iteration.target_id
    })
    : [];
  const strategyReady = strategyDecisionReady(strategy);
  return {
    status: strategyReady ? "passed" : "attention",
    candidate_id: config.candidate_id,
    autonomous: Boolean(autonomousState),
    autonomous_state: autonomousState ? compactAutonomousState(autonomousState) : null,
    target_catalog_count: targetCatalog.length,
    model_backed: response.model_backed !== false,
    provider: response.provider || response.model_provider || null,
    model: response.model || null,
    decision_hash: response.decision_hash || null,
    candidate_model_lease: response.candidate_model_lease || request.candidate_model_lease || null,
    repaired_json: Boolean(response.repaired_json),
    text_fallback: Boolean(response.text_fallback),
    decision: strategy.decision,
    summary: strategy.summary,
    rationale: strategy.rationale,
    selected_target_id: strategy.selected_iteration.target_id,
    selected_iteration: strategy.selected_iteration,
    target_generation: generationPolicy,
    admission: strategy.admission,
    candidate_comparison: compareCandidateTargets(strategy.candidate_targets, strategy.selected_iteration),
    tool_pack_evidence: buildToolPackEvidence({ spec, run, acquire, sources, recalledMemory, autonomousState }),
    dynamic_backlog: autonomousState ? (admittedBacklog.length ? admittedBacklog : autonomousState.backlog).map((item) => ({
      id: item.id,
      score: item.score,
      summary: item.summary,
      tool_packs: item.tool_packs,
      source_refs: item.source_refs,
      generated_from: item.generated_from
    })) : [],
    rejected_directions: asArray(strategy.rejected_directions),
    source_count: sources.length,
    passed_source_count: sources.filter((source) => source.status === "passed").length,
    failure: strategyReady ? null : { code: FAILURE_CODES.GATE_FAILED, message: "Research decision deferred implementation." }
  };
}

function strategyDecisionReady(strategy) {
  if (!strategy?.selected_iteration?.target_id || !strategy?.selected_iteration?.goal) return false;
  if (strategy.admission?.status && strategy.admission.status !== "passed") return false;
  const decision = String(strategy.decision || "").trim().toLowerCase();
  const explicitlyDeferred = new Set([
    "attention",
    "block",
    "blocked",
    "defer",
    "deferred",
    "fail",
    "failed",
    "none",
    "no_op",
    "noop",
    "repair",
    "repair_before_pr",
    "reject",
    "rejected",
    "skip",
    "skipped"
  ]);
  return !explicitlyDeferred.has(decision);
}

function buildToolPackEvidence({ spec, run, acquire, sources, recalledMemory, autonomousState }) {
  const repos = asArray(acquire?.repos);
  const sourceIds = asArray(sources).map((source) => source.id).filter(Boolean);
  const generationPolicy = targetGenerationPolicy(spec);
  return {
    schema_version: "across-autopilot-tool-pack-evidence/1.0",
    packs: [
      {
        id: "trigger_ingestion",
        status: run?.trigger_event ? "passed" : "attention",
        trigger_type: run?.trigger_event?.type || run?.trigger || null,
        payload_hash: run?.trigger_event?.payload_hash || null,
        replayable: run?.trigger_event?.replayable !== false
      },
      {
        id: "git_repo_inspection",
        status: repos.length ? "passed" : "attention",
        repository_count: repos.length,
        repositories: repos.map((repo) => ({
          id: repo.id,
          clean_pre: Boolean(repo.clean_pre),
          source_git: Boolean(repo.source_git)
        }))
      },
      {
        id: "source_research_digest",
        status: sourceIds.length ? "passed" : "attention",
        source_count: sourceIds.length,
        recalled_memory_count: asArray(recalledMemory).length,
        source_ids: sourceIds.slice(0, 20)
      },
      {
        id: "candidate_workspace",
        status: acquire?.four_repo_manifest ? "passed" : "attention",
        candidate_id: acquire?.candidate_id || null,
        four_repo_manifest: Boolean(acquire?.four_repo_manifest),
        mutation_boundary: "candidate_only"
      },
      {
        id: "model_generated_fallback_plan",
        status: generationPolicy.allow_model_generated_targets ? "passed" : "not_required",
        mode: generationPolicy.mode,
        model_may_prepare_bounded_plan: Boolean(generationPolicy.allow_model_generated_targets),
        minimum_candidates: generationPolicy.minimum_candidates,
        deterministic_admission: true,
        enforced_after_fallback: [
          "model_target_admission",
          "validation_harness",
          "independent_review",
          "distinct_model_acceptance"
        ]
      },
      {
        id: "validation_harness",
        status: "planned",
        declared_gate_count: asArray(spec.gates).length,
        self_hosting_probe_required: Boolean(spec.pack_config?.self_hosting_probe?.required)
      },
      {
        id: "independent_review",
        status: "planned",
        independent_reviewer_required: spec.pack_config?.semantic_review?.independent_reviewer_required !== false
      },
      {
        id: "evidence_integrity",
        status: "planned",
        section_hashes_required: true,
        audit_chain_required: true,
        role_evidence_required: true
      },
      {
        id: "capability_preflight",
        status: "passed",
        runtime_policy_required: true,
        missing_capabilities_block_before_run: true
      },
      {
        id: "repo_quality_inspection",
        status: repos.length ? "passed" : "attention",
        repository_count: repos.length,
        manifest_scan_required: true
      },
      {
        id: "dependency_security_review",
        status: "planned",
        deterministic_dependency_risk_scan: true
      },
      {
        id: "license_policy_scan",
        status: "planned",
        deterministic_license_allowlist: true
      },
      {
        id: "promotion_attestation",
        status: "planned",
        source_ref_pins_required: true,
        evidence_hashes_required: true
      }
    ],
    state: autonomousState ? {
      contract_dir: autonomousState.contract_dir,
      global_timeline_path: autonomousState.global_timeline_path,
      recent_global_timeline_count: asArray(autonomousState.recent_global_timeline).length,
      recent_loop_timeline_count: asArray(autonomousState.recent_loop_timeline).length
    } : null
  };
}

export async function candidateEcosystemDiff({ spec, run, actions, env = process.env }) {
  const acquire = actionResult(actions, "candidate_ecosystem_acquire");
  const config = candidateConfig(spec, run, env);
  const repos = acquire?.repos || (await readManifest(config.manifest_path)).repos || [];
  const repoDiffs = [];
  for (const repo of repos) {
    const rawStatus = await gitMaybe(repo.target, ["status", "--short", "--untracked-files=all"]);
    const statusLines = rawStatus.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    const ignoredGeneratedArtifacts = statusLines
      .map(statusLinePath)
      .filter((path) => path && isGeneratedCandidateArtifact(path));
    const status = statusLines
      .filter((line) => !isGeneratedCandidateArtifact(statusLinePath(line)))
      .join("\n");
    const nameOnly = await gitMaybe(repo.target, ["diff", "--name-only"]);
    const statText = await gitMaybe(repo.target, ["diff", "--stat", "--"]);
    const numstatText = await gitMaybe(repo.target, ["diff", "--numstat", "--"]);
    const untracked = status.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.replace(/^\?\?\s+/, ""));
    const changed = unique([
      ...nameOnly.split("\n").map((line) => line.trim()).filter(Boolean),
      ...untracked
    ]).filter((path) => !isGeneratedCandidateArtifact(path));
    const qualityFindings = [];
    for (const path of changed) {
      qualityFindings.push(...await sourceQualityFindings(repo.target, path));
    }
    repoDiffs.push({
      id: repo.id,
      path: repo.target,
      changed_files: changed,
      changed_file_count: changed.length,
      git_status: status,
      git_diff_stat: statText,
      git_numstat: numstatText,
      doc_churn: parseDocChurn(numstatText),
      quality_findings: qualityFindings,
      ignored_generated_artifacts: ignoredGeneratedArtifacts
    });
  }
  const changedFiles = repoDiffs.flatMap((repo) => repo.changed_files.map((file) => `${repo.id}/${file}`));
  return {
    status: changedFiles.length ? "passed" : "attention",
    candidate_id: config.candidate_id,
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    repos: repoDiffs
  };
}

export async function validateCandidateEcosystem({ spec, run, actions, env = process.env }) {
  const acquire = actionResult(actions, "candidate_ecosystem_acquire");
  const config = candidateConfig(spec, run, env);
  assertCandidateRuntimePreflight(config);
  const repos = acquire?.repos || (await readManifest(config.manifest_path)).repos || [];
  const strategy = selectedIterationFromActions(actions);
  const commands = asArray(strategy?.validation_commands || spec.pack_config?.candidate_validation?.commands || spec.pack_config?.validation_commands);
  const results = [];

  for (const command of commands) {
    const repoId = command.repo || spec.pack_config?.target_repo || "across-agents-assistant";
    const repo = repos.find((item) => item.id === repoId);
    if (!repo) {
      results.push({ repo: repoId, command: "", args: [], status: "failed", stderr: `Repo not found: ${repoId}` });
      continue;
    }
    try {
      const { stdout, stderr } = await exec(String(command.command), asArray(command.args).map(String), {
        cwd: repo.target,
        env: {
          ...process.env,
          ACROSS_HOME: config.runtime_home,
          ACROSS_AGENTS_HOME: config.app_home,
          ...validationCommandEnv(repo.id, repo.target),
          ...(command.env || {})
        },
        timeout: Number(command.timeout_ms || 120_000),
        maxBuffer: Number(command.max_buffer || 10 * 1024 * 1024)
      });
      results.push({
        repo: repoId,
        command: String(command.command),
        args: asArray(command.args).map(String),
        status: "passed",
        exit_code: 0,
        stdout: String(stdout || "").slice(0, 6000),
        stderr: String(stderr || "").slice(0, 6000)
      });
    } catch (error) {
      results.push({
        repo: repoId,
        command: String(command.command || ""),
        args: asArray(command.args).map(String),
        status: "failed",
        exit_code: error.code ?? null,
        stdout: String(error.stdout || "").slice(0, 6000),
        stderr: String(error.stderr || error.message || "").slice(0, 6000)
      });
    }
  }

  const sourceUnchanged = await verifySourceUnchanged(repos);
  const failed = results.filter((item) => item.status !== "passed");
  if (!commands.length) {
    results.push({ repo: null, command: null, args: [], status: "passed", summary: "No explicit validation commands declared." });
  }
  return {
    status: failed.length || !sourceUnchanged.unchanged ? "attention" : "passed",
    candidate_id: config.candidate_id,
    runtime_home: config.runtime_home,
    app_home: config.app_home,
    runtime_preflight: config.runtime_preflight,
    commands: results,
    source_unchanged: sourceUnchanged,
    failure: failed.length || !sourceUnchanged.unchanged
      ? { code: FAILURE_CODES.GATE_FAILED, message: "Candidate ecosystem validation failed." }
      : null
  };
}

export async function runCandidateAppLifecycle({ spec, run, actions, env = process.env }) {
  const policy = spec.pack_config?.candidate_app_lifecycle || {};
  const required = Boolean(policy.required);
  const acquire = actionResult(actions, "candidate_ecosystem_acquire");
  const config = candidateConfig(spec, run, env);
  const diff = actionResult(actions, "candidate_ecosystem_diff") || {};
  const changedFiles = asArray(diff.changed_files);
  const productRuntimeTouched = changedFiles.some((file) => candidateAppLifecycleRelevantPath(file));
  if (!required && !productRuntimeTouched) {
    return {
      status: "passed",
      required: false,
      skipped: true,
      reason: "Candidate did not touch packaged app/runtime paths."
    };
  }

  assertCandidateRuntimePreflight(config);
  const repos = acquire?.repos || (await readManifest(config.manifest_path)).repos || [];
  const aaaRepo = repos.find((item) => item.id === "across-agents-assistant");
  if (!aaaRepo?.target) {
    return {
      status: "failed",
      required: required || productRuntimeTouched,
      skipped: false,
      failure: { code: FAILURE_CODES.GATE_FAILED, message: "Candidate app lifecycle requires the across-agents-assistant B repo." }
    };
  }

  const command = policy.command || env.ACROSS_AAA_CANDIDATE_APP_LIFECYCLE_COMMAND;
  if (!command) {
    return {
      status: required ? "failed" : "passed",
      required,
      skipped: !required,
      command_configured: false,
      reason: "No candidate app lifecycle command was configured by the host.",
      failure: required ? { code: FAILURE_CODES.CAPABILITY_MISSING, message: "No candidate app lifecycle command was configured by the host." } : null
    };
  }

  const outputPath = resolvePath(policy.output_path || join(run.outputs_dir || config.app_dir, "candidate-app-lifecycle.json"), process.cwd());
  const appPath = resolvePath(policy.app_path || join(config.app_dir, "Across Agents Assistant Candidate.app"), process.cwd());
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(appPath), { recursive: true });
  const [bin, ...prefix] = resolveCommand(command, command, env);
  const args = [
    ...prefix,
    "verify",
    "--candidate-repo",
    aaaRepo.target,
    "--candidate-id",
    config.candidate_id,
    "--runtime-home",
    config.runtime_home,
    "--app-home",
    config.app_home,
    "--app-path",
    appPath,
    "--output",
    outputPath
  ];

  try {
    await exec(bin, args, {
      cwd: aaaRepo.target,
      env: {
        ...env,
        ACROSS_CONTEXT_SOURCE: repos.find((item) => item.id === "across-context")?.target || env.ACROSS_CONTEXT_SOURCE || "",
        ACROSS_AUTOPILOT_SOURCE: repos.find((item) => item.id === "across-autopilot")?.target || env.ACROSS_AUTOPILOT_SOURCE || ""
      },
      timeout: Number(policy.timeout_ms || 600_000),
      maxBuffer: Number(policy.max_buffer || 10 * 1024 * 1024)
    });
    const result = await readJson(outputPath);
    const llmStatus = result.llm_status || null;
    const modelLeaseValid = !llmStatus || (
      llmStatus.available === true
      && llmStatus.availability_source === "candidate_model_lease"
      && llmStatus.candidate_model_lease?.secrets_included === false
      && llmStatus.candidate_model_lease?.raw_credentials_allowed === false
    );
    const passed = result.status === "passed" && result.cleaned_up !== false && Boolean(result.app_path) && modelLeaseValid;
    return {
      status: passed ? "passed" : "failed",
      required: required || productRuntimeTouched,
      skipped: false,
      command_configured: true,
      output_path: outputPath,
      candidate_id: config.candidate_id,
      app_path: result.app_path || appPath,
      bundle_id: result.bundle_id || null,
      runtime_home: result.runtime_home || config.runtime_home,
      app_home: result.app_home || config.app_home,
      socket_path: result.socket_path || config.runtime_preflight.socket_path,
      socket_path_bytes: result.socket_path_bytes ?? config.runtime_preflight.socket_path_bytes,
      cleaned_up: Boolean(result.cleaned_up),
      crash_reports: asArray(result.crash_reports),
      health: result.health || null,
      llm_status: llmStatus,
      failure: passed ? null : { code: FAILURE_CODES.GATE_FAILED, message: "Candidate app lifecycle did not pass." }
    };
  } catch (error) {
    return {
      status: "failed",
      required: required || productRuntimeTouched,
      skipped: false,
      command_configured: true,
      output_path: outputPath,
      candidate_id: config.candidate_id,
      app_path: appPath,
      runtime_home: config.runtime_home,
      app_home: config.app_home,
      failure: {
        code: error.code || FAILURE_CODES.GATE_FAILED,
        message: `Candidate app lifecycle command failed: ${String(error.stderr || error.message || error).slice(0, 1000)}`
      }
    };
  }
}

function validationCommandEnv(repoId, repoTarget) {
  const srcByRepo = {
    "across-agents-assistant": "backend/src",
    "across-autopilot": "src",
    "across-orchestrator": "src",
    "across-context": "src"
  };
  const src = srcByRepo[repoId];
  return src ? { PYTHONPATH: join(repoTarget, src) } : {};
}

function candidateAppLifecycleRelevantPath(file) {
  const value = String(file || "");
  return value.includes("across-agents-assistant/macOS-Client/")
    || value.includes("across-agents-assistant/build_app.sh")
    || value.includes("across-agents-assistant/backend/main.py")
    || value.includes("across-agents-assistant/backend/pyproject.toml")
    || value.includes("across-agents-assistant/backend/src/across_agents_assistant/")
    || value.includes("across-agents-assistant/backend/assets/");
}

export async function runCandidateSelfHostingProbe({ spec, run, actions, env = process.env }) {
  const required = Boolean(spec.pack_config?.self_hosting_probe?.required);
  const diff = actionResult(actions, "candidate_ecosystem_diff");
  const touchedSelfIteration = asArray(diff?.changed_files).some((file) => (
    file.includes("across-autopilot/")
    || file.includes("across-orchestrator/")
    || file.includes("loop-spec")
    || file.includes("candidate")
    || file.includes("autopilot")
  ));
  if (!required && !touchedSelfIteration) {
    return {
      status: "passed",
      required: false,
      skipped: true,
      reason: "Candidate did not modify self-iteration machinery."
    };
  }

  const acquire = actionResult(actions, "candidate_ecosystem_acquire");
  const config = candidateConfig(spec, run, env);
  const autopilotRepo = acquire?.repos?.find((repo) => repo.id === "across-autopilot");
  const aaaRepo = acquire?.repos?.find((repo) => repo.id === "across-agents-assistant");
  if (!autopilotRepo || !aaaRepo) throw ecosystemFailure("candidate_self_hosting_probe", "B Autopilot and AAA repos are required for C probe.");

  const probeId = safeSegment(spec.pack_config?.self_hosting_probe?.probe_id || `probe-${run.run_id}`);
  const probeRoot = join(config.base_dir, "probe-workspaces", probeId);
  const probeRepo = join(probeRoot, "repos", "across-agents-assistant");
  await rm(probeRoot, { recursive: true, force: true });
  await mkdir(dirname(probeRepo), { recursive: true });
  await copyRepoSnapshot({ id: "across-agents-assistant", source: aaaRepo.target }, probeRepo);
  await ensureGitBaseline(probeRepo, "probe-across-agents-assistant", "snapshot");
  const probeSpecPath = join(probeRoot, "self-hosting-probe.loop.json");
  const probeSpec = buildProbeSpec({ probeId, probeRepo });
  await writeFile(probeSpecPath, `${stableJson(probeSpec)}\n`, "utf8");
  const result = await runJsonCommand(["node", join(autopilotRepo.target, "src", "cli.js")], [
    "loop",
    "run",
    "--spec",
    probeSpecPath,
    "--json"
  ], {
    cwd: autopilotRepo.target,
    env: {
      ...env,
      ACROSS_HOME: join(probeRoot, "runtime-home")
    },
    timeoutMs: Number(spec.pack_config?.self_hosting_probe?.timeout_ms || 180_000),
    maxBuffer: 10 * 1024 * 1024
  });
  const probeDiff = await gitMaybe(probeRepo, ["status", "--short", "--untracked-files=all"]);
  const passed = result?.run?.status === "completed" && probeDiff.toLowerCase().includes("self_hosting_probe.md");
  return {
    status: passed ? "passed" : "attention",
    required: true,
    skipped: false,
    probe_id: probeId,
    probe_root: probeRoot,
    b_autopilot: autopilotRepo.target,
    c_repo: probeRepo,
    b_run_status: result?.run?.status || "unknown",
    c_git_status: probeDiff,
    evidence_ref: result?.evidence?.run_id || result?.run?.run_id || null,
    failure: passed ? null : { code: FAILURE_CODES.GATE_FAILED, message: "B candidate failed to operate on C probe." }
  };
}

export function buildCandidatePromotionEvidence({ spec, run, actions }) {
  const acquire = actionResult(actions, "candidate_ecosystem_acquire") || {};
  const mutation = actionResult(actions, "host_code_iteration") || actionResult(actions, "candidate_workspace_patch") || {};
  const diff = actionResult(actions, "candidate_ecosystem_diff") || actionResult(actions, "candidate_diff_summary") || {};
  const validation = actionResult(actions, "candidate_ecosystem_validation") || actionResult(actions, "candidate_validation") || {};
  const appLifecycle = actionResult(actions, "candidate_app_lifecycle") || {};
  const probe = actionResult(actions, "candidate_self_hosting_probe") || {};
  const semantic = actionResult(actions, "semantic_alignment_review") || {};
  const strategy = actionResult(actions, "product_iteration_strategy") || {};
  const changedFiles = asArray(diff.changed_files);
  const validationPassed = validation.status === "passed";
  const probePassed = probe.required ? probe.status === "passed" : true;
  const appLifecycleRequired = Boolean(spec.pack_config?.candidate_app_lifecycle?.required || appLifecycle.required);
  const appLifecyclePassed = appLifecycleRequired ? appLifecycle.status === "passed" : true;
  const semanticPassed = semantic.status ? semantic.status === "passed" : true;
  const qualityFindings = candidateQualityFindings(diff);
  const blockingQuality = qualityFindings.filter((finding) => finding.severity === "error");
  const sourceRefPins = sourceRefPinsFromAcquire(acquire, validation.source_unchanged);
  const ready = changedFiles.length > 0
    && validationPassed
    && appLifecyclePassed
    && probePassed
    && semanticPassed
    && blockingQuality.length === 0
    && sourceRefPins.status === "passed";
  const reviewerScores = reviewerScoresFromSemantic(semantic, {
    changedFiles,
    qualityFindings,
    validation,
    probe,
    ready
  });
  const knownRisks = promotionKnownRisks({
    validation,
    appLifecycle,
    semantic,
    qualityFindings,
    probe,
    changedFiles,
    sourceRefPins
  });
  const recommendedPr = recommendedPullRequest({
    spec,
    strategy,
    mutation,
    changedFiles,
    ready
  });
  return {
    status: ready ? "passed" : "attention",
    promotion_ready: ready,
    candidate_id: acquire.candidate_id || null,
    mode: acquire.mode || null,
    candidate_root: acquire.base_dir || null,
    workspace: mutation.workspace || targetRepoPath(acquire, mutation.target_repo || strategy.selected_iteration?.target_repo),
    four_repo_manifest: Boolean(acquire.four_repo_manifest),
    manifest_path: acquire.manifest_path || null,
    runtime_home: acquire.runtime_home || validation.runtime_home || null,
    app_home: acquire.app_home || null,
    app_dir: acquire.app_dir || null,
    candidate_app_lifecycle: appLifecycle.status ? {
      status: appLifecycle.status,
      required: Boolean(appLifecycle.required),
      skipped: Boolean(appLifecycle.skipped),
      app_path: appLifecycle.app_path || null,
      bundle_id: appLifecycle.bundle_id || null,
      output_path: appLifecycle.output_path || null,
      cleaned_up: appLifecycle.cleaned_up ?? null,
      crash_report_count: asArray(appLifecycle.crash_reports).length,
      socket_path_bytes: appLifecycle.socket_path_bytes ?? null,
      llm_status: appLifecycle.llm_status || null
    } : null,
    runtime_preflight: acquire.runtime_preflight || validation.runtime_preflight || null,
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    repos: candidateRepoEvidence(diff),
    quality_findings: qualityFindings,
    ignored_generated_artifacts: candidateIgnoredGeneratedArtifacts(diff),
    validation: {
      status: validation.status || "unknown",
      command_count: asArray(validation.commands).length,
      commands: asArray(validation.commands).map((item) => ({
        repo: item.repo || null,
        command: [item.command, ...asArray(item.args)].filter(Boolean).join(" "),
        status: item.status || null,
        exit_code: item.exit_code ?? null
      }))
    },
    model_backed: Boolean(mutation.model_backed),
    model_provider: mutation.provider || mutation.model_provider || null,
    model: mutation.model || null,
    decision_hash: mutation.decision_hash || mutation.model_decision_hash || null,
    validation_status: validation.status || "unknown",
    semantic_alignment_status: semantic.status || "not_required",
    semantic_alignment_recommendation: semantic.promotion_recommendation || null,
    research_strategy: strategy.selected_iteration ? {
      status: strategy.status || null,
      selected_target_id: strategy.selected_target_id || strategy.selected_iteration.target_id || null,
      summary: strategy.summary || null,
      autonomous: Boolean(strategy.autonomous),
      dynamic_backlog_count: asArray(strategy.dynamic_backlog).length,
      candidate_comparison: strategy.candidate_comparison || null,
      tool_packs: asArray(strategy.selected_iteration.tool_packs),
      generated_from: strategy.selected_iteration.generated_from || null,
      model_backed: Boolean(strategy.model_backed),
      provider: strategy.provider || null,
      model: strategy.model || null,
      decision_hash: strategy.decision_hash || null,
      repaired_json: Boolean(strategy.repaired_json),
      text_fallback: Boolean(strategy.text_fallback)
    } : null,
    independent_reviewer: semantic ? {
      status: semantic.status || null,
      reviewer_role: semantic.reviewer_role || null,
      builder_role: semantic.builder_role || null,
      independent: Boolean(semantic.reviewer_independent),
      recommendation: semantic.promotion_recommendation || null,
      product_value_score: semantic.product_value_score ?? reviewerScores.product_value_score,
      maintainability_score: semantic.maintainability_score ?? reviewerScores.maintainability_score,
      risk_score: semantic.risk_score ?? reviewerScores.risk_score,
      merge_recommendation: semantic.merge_recommendation || reviewerScores.merge_recommendation,
      human_review_notes: asArray(semantic.human_review_notes).length ? asArray(semantic.human_review_notes) : reviewerScores.human_review_notes,
      model_backed: Boolean(semantic.reviewer_model_backed),
      provider: semantic.reviewer_provider || null,
      model: semantic.reviewer_model || null,
      decision_hash: semantic.reviewer_decision_hash || null,
      model_separation: semantic.model_separation || null
    } : null,
    self_hosting_probe: {
      required: Boolean(probe.required),
      status: probe.status || "skipped",
      probe_id: probe.probe_id || null
    },
    promotion_package: {
      schema_version: "across-autopilot-promotion-package/1.0",
      candidate_id: acquire.candidate_id || null,
      manifest_path: acquire.manifest_path || null,
      source_a_unchanged: validation.source_unchanged?.unchanged === true,
      source_ref_pins: sourceRefPins,
      four_repo_manifest: Boolean(acquire.four_repo_manifest),
      model_decision_hash: mutation.decision_hash || mutation.model_decision_hash || null,
      changed_files: changedFiles,
      diff_summary: {
        changed_file_count: changedFiles.length,
        repos: candidateRepoEvidence(diff).map((repo) => ({
          id: repo.id,
          changed_file_count: repo.changed_file_count,
          quality_finding_count: asArray(repo.quality_findings).length
        }))
      },
      validation_results: {
        status: validation.status || "unknown",
        commands: asArray(validation.commands).map((item) => ({
          repo: item.repo || null,
          command: [item.command, ...asArray(item.args)].filter(Boolean).join(" "),
          status: item.status || null,
          exit_code: item.exit_code ?? null
        }))
      },
      candidate_app_lifecycle: appLifecycle.status ? {
        status: appLifecycle.status,
        required: Boolean(appLifecycle.required),
        app_path: appLifecycle.app_path || null,
        bundle_id: appLifecycle.bundle_id || null,
        output_path: appLifecycle.output_path || null,
        cleaned_up: appLifecycle.cleaned_up ?? null,
        crash_report_count: asArray(appLifecycle.crash_reports).length,
        llm_status: appLifecycle.llm_status || null
      } : null,
      reviewer_scores: reviewerScores,
      reviewer_model: semantic ? {
        model_backed: Boolean(semantic.reviewer_model_backed),
        provider: semantic.reviewer_provider || null,
        model: semantic.reviewer_model || null,
        decision_hash: semantic.reviewer_decision_hash || null,
        model_separation: semantic.model_separation || null
      } : null,
      known_risks: knownRisks,
      recommended_pr: recommendedPr,
      human_approval_required: true
    },
    next_step: ready
      ? "Review the promotion report and create protected PRs from B to A."
      : "Do not promote until required candidate gates pass."
  };
}

function targetRepoPath(acquire, repoId) {
  if (!repoId) return null;
  return asArray(acquire.repos).find((repo) => repo.id === repoId)?.target || null;
}

function candidateRepoEvidence(diff) {
  return asArray(diff.repos).map((repo) => ({
    id: repo.id || null,
    path: repo.path || null,
    changed_file_count: repo.changed_file_count || 0,
    changed_files: asArray(repo.changed_files),
    quality_findings: asArray(repo.quality_findings),
    ignored_generated_artifacts: asArray(repo.ignored_generated_artifacts),
    doc_churn: asArray(repo.doc_churn)
  }));
}

function candidateQualityFindings(diff) {
  return asArray(diff.repos).flatMap((repo) => asArray(repo.quality_findings).map((finding) => ({
    ...finding,
    repo: repo.id || finding.repo || null
  })));
}

function candidateIgnoredGeneratedArtifacts(diff) {
  return asArray(diff.repos).flatMap((repo) => asArray(repo.ignored_generated_artifacts).map((path) => ({
    repo: repo.id || null,
    path
  })));
}

function sourceRefPinsFromAcquire(acquire = {}, sourceUnchanged = {}) {
  const unchangedById = new Map(asArray(sourceUnchanged.repos).map((repo) => [repo.id, repo]));
  const repos = asArray(acquire.repos).map((repo) => {
    const unchanged = unchangedById.get(repo.id) || {};
    const sourceStatusPre = String(repo.source_status_pre || "");
    return {
      id: repo.id || null,
      source: repo.source || null,
      target: repo.target || null,
      mode: repo.mode || acquire.mode || null,
      baseline_ref: repo.baseline_ref || null,
      candidate_head_ref: repo.head_ref || null,
      source_git: Boolean(repo.source_git),
      source_head_pre: repo.source_head_pre || null,
      source_head_post: unchanged.head_post || null,
      source_status_pre_clean: sourceStatusPre.trim() === "",
      source_status_pre_hash: createHash("sha256").update(sourceStatusPre).digest("hex"),
      source_unchanged: unchanged.unchanged ?? null
    };
  });
  const present = new Set(repos.map((repo) => repo.id).filter(Boolean));
  const missingRequiredRepos = REQUIRED_ECOSYSTEM_REPOS.filter((id) => !present.has(id));
  const missingPins = repos
    .filter((repo) => repo.source_git && !repo.source_head_pre)
    .map((repo) => repo.id)
    .filter(Boolean);
  const changedSources = repos
    .filter((repo) => repo.source_unchanged === false)
    .map((repo) => repo.id)
    .filter(Boolean);
  const status = missingRequiredRepos.length || missingPins.length || changedSources.length
    ? "failed"
    : "passed";
  return {
    schema_version: "across-autopilot-source-ref-pins/1.0",
    status,
    required_repo_count: REQUIRED_ECOSYSTEM_REPOS.length,
    pinned_repo_count: repos.length,
    missing_required_repos: missingRequiredRepos,
    missing_pins: missingPins,
    changed_sources: changedSources,
    repos
  };
}

export async function semanticAlignmentReview({ spec, run = null, actions, env = process.env }) {
  const strategy = selectedIterationFromActions(actions);
  const review = {
    ...(spec.pack_config?.semantic_review || {}),
    ...(strategy?.semantic_review || {})
  };
  const explicitReviewerPolicy = {
    ...(spec.pack_config?.reviewer_model_policy || {}),
    ...(spec.pack_config?.acceptance_model_policy || {}),
    ...(review.reviewer_model_policy || review.model_policy || {})
  };
  const reviewerPolicy = {
    ...modelPolicyForRole(spec, "reviewer"),
    ...explicitReviewerPolicy
  };
  const diff = actionResult(actions, "candidate_ecosystem_diff") || actionResult(actions, "candidate_diff_summary") || {};
  const mutation = actionResult(actions, "host_code_iteration") || actionResult(actions, "candidate_workspace_patch") || {};
  const validation = actionResult(actions, "candidate_ecosystem_validation") || actionResult(actions, "candidate_validation") || {};
  const acquire = actionResult(actions, "candidate_ecosystem_acquire") || {};
  const changedFiles = asArray(diff.changed_files);
  const failures = [];
  const warnings = [];

  if (!changedFiles.length) failures.push("candidate has no reviewable diff");
  if (review.require_model_backed !== false && mutation.model_backed !== true) failures.push("candidate was not model-backed");
  if (validation.status !== "passed") failures.push("candidate validation did not pass before semantic review");

  const strategyPaths = asArray(strategy?.allowed_patch_paths).map((path) => `/${path}`);
  const requiredPrefixes = asArray(review.required_changed_path_prefixes);
  for (const prefix of requiredPrefixes) {
    if (!changedFiles.some((file) => file.includes(String(prefix)))) {
      failures.push(`required changed path missing: ${prefix}`);
    }
  }
  if (review.require_selected_target_change !== false && strategyPaths.length) {
    const selectedPathChanged = changedFiles.some((file) => strategyPaths.some((path) => file.endsWith(path)));
    if (!selectedPathChanged) failures.push("candidate did not modify a selected strategy path");
  }

  const forbiddenPatterns = asArray(review.forbidden_changed_path_patterns);
  for (const pattern of forbiddenPatterns) {
    if (changedFiles.some((file) => file.includes(String(pattern)))) {
      failures.push(`forbidden changed path present: ${pattern}`);
    }
  }

  if (review.reject_self_proof_only !== false && isSelfProofOnlyChange(changedFiles)) {
    failures.push("candidate only proves loop execution and does not provide product-facing value");
  }
  if (review.reject_test_only_change !== false && isTestOnlyChange(changedFiles)) {
    failures.push("candidate only changes tests and does not include a product implementation path");
  }

  if (review.reject_large_documentation_rewrite !== false) {
    const maxDeletions = Number(review.max_doc_deletions ?? 60);
    const maxRatio = Number(review.max_doc_deletion_ratio ?? 3);
    for (const churn of documentationRewriteFindings(diff, { maxDeletions, maxRatio })) {
      failures.push(`large documentation rewrite requires explicit target justification: ${churn.path} removed ${churn.deletions} line(s) and added ${churn.additions}`);
    }
  }

  if (review.reject_suspicious_generated_code !== false) {
    for (const finding of sourceQualityFindingsFromDiff(diff)) {
      failures.push(`suspicious generated code artifact: ${finding.path}:${finding.line} ${finding.message}`);
    }
  }
  const allQualityFindings = allSourceQualityFindingsFromDiff(diff);
  for (const finding of allQualityFindings.filter((item) => item.severity === "warning")) {
    warnings.push(`${finding.path}:${finding.line || 0} ${finding.message}`);
  }

  const summary = String(mutation.summary || "").toLowerCase();
  for (const keyword of asArray(review.required_summary_keywords)) {
    if (!summary.includes(String(keyword).toLowerCase())) warnings.push(`summary does not mention: ${keyword}`);
  }

  const minimumCommands = Number(review.minimum_validation_commands || 0);
  const commandCount = asArray(validation.commands).filter((item) => item.status === "passed").length;
  if (minimumCommands > 0 && commandCount < minimumCommands) {
    failures.push(`expected at least ${minimumCommands} passing validation command(s), got ${commandCount}`);
  }

  const passed = failures.length === 0;
  const builderRole = "loop_engineer";
  const reviewerRole = review.reviewer_role || "independent_reviewer";
  const reviewerIndependent = reviewerRole !== builderRole;
  if (review.independent_reviewer_required !== false && !reviewerIndependent) {
    failures.push("semantic review must be performed by an independent reviewer role");
  }
  const modelReviewRequired = Boolean(
    review.model_review_required
    || review.require_reviewer_model
    || explicitReviewerPolicy.required
    || explicitReviewerPolicy.provider
    || explicitReviewerPolicy.provider_id
    || explicitReviewerPolicy.model
    || explicitReviewerPolicy.model_id
  );
  const distinctModelRequired = review.require_distinct_model !== false && Boolean(
    review.independent_model_required
    || reviewerPolicy.require_distinct_from_builder
    || reviewerPolicy.required
    || modelReviewRequired
  );
  const reviewerCommand = review.command || reviewerPolicy.command || env.ACROSS_AAA_HOST_REVIEW_COMMAND;
  const builderIdentity = modelIdentity(mutation.provider || mutation.model_provider, mutation.model);
  let reviewerDecision = null;
  if (modelReviewRequired) {
    if (!reviewerCommand) {
      failures.push("host reviewer model command is not configured");
    } else {
      try {
        reviewerDecision = await runHostReviewDecision({
          command: reviewerCommand,
          spec,
          run,
          actions,
          strategy,
          diff,
          mutation,
          validation,
          changedFiles,
          qualityFindings: allQualityFindings,
          deterministicReview: { failures, warnings },
          reviewerPolicy,
          builderIdentity,
          candidateModelLease: requestCandidateModelLease(acquire.model_lease),
          env
        });
      } catch (error) {
        failures.push(`host reviewer model failed: ${error.message || error}`);
      }
    }
  }
  const reviewerIdentity = modelIdentity(
    reviewerDecision?.provider || reviewerDecision?.model_provider || reviewerPolicy.provider || reviewerPolicy.provider_id,
    reviewerDecision?.model || reviewerDecision?.model_id || reviewerPolicy.model || reviewerPolicy.model_id
  );
  const modelSeparation = {
    required: distinctModelRequired,
    builder: { provider: builderIdentity.provider, model: builderIdentity.model },
    reviewer: { provider: reviewerIdentity.provider, model: reviewerIdentity.model },
    status: "not_required",
    reason: "Distinct reviewer model is not required."
  };
  if (distinctModelRequired) {
    if (!builderIdentity.provider || !builderIdentity.model) {
      modelSeparation.status = "failed";
      modelSeparation.reason = "Builder model identity is missing.";
      failures.push(modelSeparation.reason);
    } else if (!reviewerIdentity.provider || !reviewerIdentity.model) {
      modelSeparation.status = "failed";
      modelSeparation.reason = "Reviewer model identity is missing.";
      failures.push(modelSeparation.reason);
    } else if (builderIdentity.key === reviewerIdentity.key) {
      modelSeparation.status = "failed";
      modelSeparation.reason = "Reviewer model must differ from builder model.";
      failures.push(modelSeparation.reason);
    } else {
      modelSeparation.status = "passed";
      modelSeparation.reason = "Reviewer model is distinct from builder model.";
    }
  }
  if (reviewerDecision) {
    if (reviewerDecision.model_backed === false) {
      failures.push("host reviewer decision was not model-backed");
    }
    for (const reason of asArray(reviewerDecision.blocking_reasons)) {
      failures.push(`host reviewer blocked candidate: ${reason}`);
    }
    const recommendation = String(reviewerDecision.merge_recommendation || reviewerDecision.recommendation || reviewerDecision.promotion_recommendation || "").toLowerCase();
    if (["reject", "repair", "repair_before_pr", "defer", "failed"].includes(recommendation)) {
      failures.push(`host reviewer recommendation is ${recommendation}`);
    }
    if (reviewerDecision.status && !["passed", "review", "approved"].includes(String(reviewerDecision.status).toLowerCase())) {
      failures.push(`host reviewer status is ${reviewerDecision.status}`);
    }
  }
  const reviewerScores = reviewerScoresFromSemantic({ blocking_reasons: failures, warnings }, {
    changedFiles,
    qualityFindings: allQualityFindings,
    validation,
    probe: actionResult(actions, "candidate_self_hosting_probe") || {},
    ready: failures.length === 0
  });
  return {
    status: failures.length === 0 ? "passed" : "failed",
    changed_files: changedFiles,
    builder_role: builderRole,
    reviewer_role: reviewerRole,
    reviewer_independent: reviewerIndependent,
    promotion_recommendation: failures.length === 0 ? "review" : "reject",
    product_value_score: reviewerDecision?.product_value_score ?? reviewerScores.product_value_score,
    maintainability_score: reviewerDecision?.maintainability_score ?? reviewerScores.maintainability_score,
    risk_score: reviewerDecision?.risk_score ?? reviewerScores.risk_score,
    merge_recommendation: failures.length === 0
      ? (reviewerDecision?.merge_recommendation || reviewerScores.merge_recommendation)
      : "repair_before_pr",
    human_review_notes: unique([
      ...asArray(reviewerDecision?.human_review_notes),
      ...reviewerScores.human_review_notes
    ]),
    reviewer_model_backed: reviewerDecision ? reviewerDecision.model_backed !== false : false,
    reviewer_provider: reviewerIdentity.provider,
    reviewer_model: reviewerIdentity.model,
    reviewer_decision_hash: reviewerDecision?.decision_hash || null,
    model_separation: modelSeparation,
    blocking_reasons: failures,
    warnings,
    policy: {
      required_changed_path_prefixes: requiredPrefixes,
      forbidden_changed_path_patterns: forbiddenPatterns,
      reject_self_proof_only: review.reject_self_proof_only !== false,
      reject_test_only_change: review.reject_test_only_change !== false,
      reject_large_documentation_rewrite: review.reject_large_documentation_rewrite !== false,
      reject_suspicious_generated_code: review.reject_suspicious_generated_code !== false,
      minimum_validation_commands: minimumCommands,
      selected_target_id: strategy?.target_id || null,
      independent_reviewer_required: review.independent_reviewer_required !== false,
      model_review_required: modelReviewRequired,
      distinct_model_required: distinctModelRequired
    },
    failure: failures.length === 0 ? null : { code: FAILURE_CODES.GATE_FAILED, message: failures.join("; ") }
  };
}

async function runHostReviewDecision({
  command,
  spec,
  run,
  strategy,
  diff,
  mutation,
  validation,
  changedFiles,
  qualityFindings,
  deterministicReview,
  reviewerPolicy,
  builderIdentity,
  candidateModelLease,
  env
}) {
  const request = {
    schema_version: "across-host-review-decision-request/1.0",
    goal: strategy?.goal || spec.pack_config?.research_strategy?.goal || spec.description || spec.name,
    run_id: run?.run_id || null,
    spec_id: spec.id,
    selected_target_id: strategy?.target_id || strategy?.target_id || null,
    selected_iteration: strategy || null,
    changed_files: changedFiles,
    validation: {
      status: validation.status || null,
      command_count: asArray(validation.commands).length,
      failed_commands: asArray(validation.commands).filter((item) => item.status !== "passed").map((item) => ({
        repo: item.repo || null,
        command: [item.command, ...asArray(item.args)].filter(Boolean).join(" "),
        status: item.status || null
      }))
    },
    diff_summary: {
      changed_file_count: changedFiles.length,
      quality_findings: asArray(qualityFindings).slice(0, 30)
    },
    deterministic_review: {
      blocking_reasons: asArray(deterministicReview.failures),
      warnings: asArray(deterministicReview.warnings)
    },
    builder_model: {
      provider: builderIdentity.provider,
      model: builderIdentity.model,
      decision_hash: mutation.decision_hash || mutation.model_decision_hash || null
    },
    candidate_model_lease: candidateModelLease,
    model_policy: reviewerPolicy
  };
  const response = await runJsonCommand(command, ["--request-json", JSON.stringify(request)], {
    env,
    timeoutMs: Number(reviewerPolicy.timeout_ms || reviewerPolicy.timeoutMs || 180_000),
    maxBuffer: 4 * 1024 * 1024
  });
  return normalizeHostReviewDecision(response);
}

function normalizeHostReviewDecision(response = {}) {
  return {
    status: response.status || "passed",
    model_backed: response.model_backed !== false,
    provider: response.provider || response.model_provider || null,
    model: response.model || null,
    decision_hash: response.decision_hash || null,
    recommendation: response.recommendation || response.promotion_recommendation || null,
    merge_recommendation: response.merge_recommendation || null,
    product_value_score: response.product_value_score,
    maintainability_score: response.maintainability_score,
    risk_score: response.risk_score,
    blocking_reasons: asArray(response.blocking_reasons),
    human_review_notes: asArray(response.human_review_notes)
  };
}

export function ecosystemGateStatus(id, { actions }) {
  if (id === "research_iteration_strategy_ready") {
    const strategy = actionResult(actions, "product_iteration_strategy");
    return [strategy?.status === "passed" && strategy?.selected_iteration?.goal, "Research strategy selected a product iteration.", "Research strategy did not select an implementable product iteration."];
  }
  if (id === "four_repo_manifest_written") {
    const acquire = actionResult(actions, "candidate_ecosystem_acquire");
    return [Boolean(acquire?.four_repo_manifest), "B candidate manifest pins all four Across repositories.", "B candidate manifest is incomplete."];
  }
  if (id === "candidate_runtime_preflight_passed") {
    const acquire = actionResult(actions, "candidate_ecosystem_acquire");
    const preflight = acquire?.runtime_preflight;
    return [preflight?.status === "passed", "B candidate runtime paths are app-safe.", "B candidate runtime paths are unsafe for app launch."];
  }
  if (id === "source_a_unchanged") {
    const validation = actionResult(actions, "candidate_ecosystem_validation");
    return [validation?.source_unchanged?.unchanged === true, "A source repositories remained unchanged.", "A source repository changes were detected."];
  }
  if (id === "candidate_b_has_code_diff") {
    const diff = actionResult(actions, "candidate_ecosystem_diff");
    return [(diff?.changed_file_count || 0) > 0, "B contains reviewable code changes.", "B has no reviewable code changes."];
  }
  if (id === "candidate_ecosystem_validation_passed") {
    const validation = actionResult(actions, "candidate_ecosystem_validation");
    return [validation?.status === "passed", "B validation commands passed.", "B validation commands did not pass."];
  }
  if (id === "candidate_app_lifecycle_passed") {
    const lifecycle = actionResult(actions, "candidate_app_lifecycle");
    return [
      lifecycle?.status === "passed",
      "B candidate app built, launched, probed, and cleaned up.",
      "B candidate app lifecycle was not proven."
    ];
  }
  if (id === "self_hosting_probe_passed_or_not_required") {
    const probe = actionResult(actions, "candidate_self_hosting_probe");
    return [probe?.status === "passed", "C self-hosting probe passed or was not required.", "C self-hosting probe failed."];
  }
  if (id === "semantic_alignment_passed") {
    const review = actionResult(actions, "semantic_alignment_review");
    return [review?.status === "passed", "Semantic alignment review accepted the candidate direction.", "Semantic alignment review rejected the candidate direction."];
  }
  if (id === "independent_reviewer_passed") {
    const review = actionResult(actions, "semantic_alignment_review");
    return [
      review?.status === "passed" && review?.reviewer_independent === true,
      "Independent reviewer accepted the candidate direction.",
      "Independent reviewer did not accept the candidate direction."
    ];
  }
  if (id === "distinct_reviewer_model_passed") {
    const review = actionResult(actions, "semantic_alignment_review");
    const separation = review?.model_separation || {};
    return [
      separation.status === "passed",
      "Reviewer model was distinct from builder model.",
      separation.reason || "Reviewer model separation was not proven."
    ];
  }
  if (id === "dynamic_backlog_ready") {
    const strategy = actionResult(actions, "product_iteration_strategy");
    return [
      strategy?.autonomous === true && asArray(strategy?.dynamic_backlog).length >= 2,
      "Autonomous backlog was generated from loop state.",
      "Autonomous backlog did not contain enough candidates."
    ];
  }
  if (id === "promotion_report_ready") {
    const report = actionResult(actions, "promotion_report_generation");
    return [report?.promotion_ready === true, "Promotion report says candidate is ready.", "Promotion report is not ready."];
  }
  return null;
}

function isSelfProofOnlyChange(changedFiles) {
  if (!changedFiles.length) return false;
  return changedFiles.every((file) => (
    file.includes("loop_engineering_candidate.py")
    || file.includes("test_loop_engineering_candidate.py")
    || file.includes("SELF_HOSTING_PROBE")
    || file.includes("self_hosting_probe")
  ));
}

function isTestOnlyChange(changedFiles) {
  if (!changedFiles.length) return false;
  return changedFiles.every((file) => {
    const rel = String(file || "").toLowerCase();
    return rel.includes("/test")
      || rel.includes("/tests/")
      || rel.endsWith("_test.py")
      || rel.endsWith(".test.js")
      || rel.endsWith("tests.swift");
  });
}

function statusLinePath(line) {
  const text = String(line || "").trim();
  if (!text) return "";
  if (text.startsWith("?? ")) return text.slice(3).trim();
  return text.slice(3).trim();
}

function isGeneratedCandidateArtifact(path) {
  const rel = String(path || "").replaceAll("\\", "/");
  if (!rel) return false;
  if (rel.endsWith(".pyc") || rel.endsWith(".pyo")) return true;
  return rel.split("/").some((part) => (
    part === "__pycache__"
    || part === ".pytest_cache"
    || part === ".mypy_cache"
    || part === ".ruff_cache"
    || part === ".DS_Store"
  ));
}

function parseDocChurn(numstatText) {
  return String(numstatText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, ...pathParts] = line.split(/\s+/);
      const path = pathParts.join(" ");
      return {
        path,
        additions: Number(additions),
        deletions: Number(deletions)
      };
    })
    .filter((item) => Number.isFinite(item.additions) && Number.isFinite(item.deletions) && isDocumentationPath(item.path));
}

function documentationRewriteFindings(diff, { maxDeletions, maxRatio }) {
  return asArray(diff?.repos).flatMap((repo) => asArray(repo.doc_churn).map((item) => ({
    ...item,
    repo: repo.id,
    path: `${repo.id}/${item.path}`
  }))).filter((item) => (
    item.deletions > maxDeletions
    && item.deletions > Math.max(1, item.additions) * maxRatio
  ));
}

async function sourceQualityFindings(repoRoot, path) {
  if (!isSourceCodePath(path)) return [];
  const content = await readOptional(join(repoRoot, path));
  if (!content || content.length > 250_000) return [];
  return sourceQualityFindingsForContent(content, path);
}

function sourceQualityFindingsFromDiff(diff) {
  return allSourceQualityFindingsFromDiff(diff).filter((item) => item.severity === "error");
}

function allSourceQualityFindingsFromDiff(diff) {
  return asArray(diff?.repos).flatMap((repo) => asArray(repo.quality_findings).map((item) => ({
    ...item,
    repo: repo.id,
    path: `${repo.id}/${item.path}`
  })));
}

function sourceQualityFindingsForContent(content, path) {
  const findings = [];
  const rules = [
    ...(isTestPath(path) ? [{
      id: "pytest_dependency_in_candidate_test",
      severity: "error",
      pattern: /^\s*(import\s+pytest|from\s+pytest\s+import\b)|\bpytest\./,
      message: "candidate tests must use standard-library/runpy-compatible assertions unless pytest is explicitly provisioned"
    }] : []),
    {
      id: "constant_false_branch",
      severity: "error",
      pattern: /\bif\s+False\b|\bif\s*\(\s*false\s*\)/,
      message: "constant false branch must be removed before promotion"
    },
    {
      id: "placeholder_implementation",
      severity: "error",
      pattern: /NotImplementedError|TODO:\s*(implement|fill|wire)|throw\s+new\s+Error\(\s*["']Not implemented/i,
      message: "placeholder implementation must be replaced before promotion"
    },
    {
      id: "unsafe_shell_execution",
      severity: "error",
      pattern: /\bsubprocess\.(run|call|check_call|check_output|Popen)\s*\([^)]*shell\s*=\s*True|\bchild_process\.exec\s*\(/,
      message: "candidate code must not introduce shell execution without an explicit Tool Pack boundary"
    },
    {
      id: "hardcoded_secret_literal",
      severity: "error",
      pattern: /\b(sk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{12,}["'])/i,
      message: "candidate code must not introduce hardcoded secrets or API tokens"
    },
    {
      id: "remote_install_script",
      severity: "error",
      pattern: /\b(curl|wget)\b[\s\S]{0,80}\|\s*(sh|bash)\b|\b(npm|pnpm|yarn|pip)\s+install\b/,
      message: "candidate code must not run dependency installation or remote shell scripts outside a Tool Pack boundary"
    },
    {
      id: "unbounded_network_call",
      severity: "warning",
      pattern: /\brequests\.(get|post|put|delete)\s*\(|\burllib\.request\.urlopen\s*\(|\bfetch\s*\(/,
      message: "network calls should be behind a bounded source or Tool Pack adapter before promotion"
    }
  ];
  const lines = String(content || "").split("\n");
  let blankRun = 0;
  let reportedExcessiveBlankLines = false;
  let reportedTrailingWhitespace = false;
  let reportedTabIndentation = false;
  let reportedLongLine = false;
  lines.forEach((line, index) => {
    blankRun = line.trim() ? 0 : blankRun + 1;
    if (blankRun === 5 && !reportedExcessiveBlankLines) {
      reportedExcessiveBlankLines = true;
      findings.push({
        id: "excessive_blank_lines",
        severity: "error",
        path,
        line: index + 1,
        message: "excessive blank lines should be removed before review",
        excerpt: ""
      });
    }
    if (/\S[ \t]+$/.test(line) && !reportedTrailingWhitespace) {
      reportedTrailingWhitespace = true;
      findings.push({
        id: "trailing_whitespace",
        severity: "error",
        path,
        line: index + 1,
        message: "trailing whitespace should be removed before review",
        excerpt: line.trim().slice(0, 240)
      });
    }
    if (/^\t+/.test(line) && !reportedTabIndentation && !path.endsWith(".go")) {
      reportedTabIndentation = true;
      findings.push({
        id: "tab_indentation",
        severity: "warning",
        path,
        line: index + 1,
        message: "tab indentation should be avoided in candidate source unless the language requires it",
        excerpt: line.trim().slice(0, 240)
      });
    }
    if (line.length > 140 && !reportedLongLine) {
      reportedLongLine = true;
      findings.push({
        id: "long_source_line",
        severity: "warning",
        path,
        line: index + 1,
        message: "long source lines reduce reviewability before unattended promotion",
        excerpt: line.trim().slice(0, 240)
      });
    }
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        findings.push({
          id: rule.id,
          severity: rule.severity,
          path,
          line: index + 1,
          message: rule.message,
          excerpt: line.trim().slice(0, 240)
        });
      }
    }
  });
  findings.push(...functionLengthFindings(lines, path));
  const nonblank = lines.filter((line) => line.trim()).length;
  if (nonblank > 260) {
    findings.push({
      id: "large_generated_file",
      severity: "warning",
      path,
      line: 1,
      message: "generated helper is large; split into bounded pure-function units before unattended promotion",
      excerpt: `${nonblank} nonblank line(s)`
    });
  }
  return findings;
}

function functionLengthFindings(lines, path) {
  const findings = [];
  const threshold = 90;
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const pythonMatch = line.match(/^(\s*)(async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    const jsMatch = line.match(/^(\s*)(export\s+)?(async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    const match = pythonMatch || jsMatch;
    if (match) {
      if (current) maybePushLongFunction(findings, current, index, path, threshold);
      current = {
        name: match[pythonMatch ? 3 : 4],
        start: index,
        indent: match[1].length,
        nonblank: trimmed ? 1 : 0
      };
      continue;
    }
    if (!current) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
    const startsPeerBlock = trimmed && indent <= current.indent && /^(class|def|async\s+def|function)\b/.test(trimmed);
    if (startsPeerBlock) {
      maybePushLongFunction(findings, current, index, path, threshold);
      current = null;
      index -= 1;
      continue;
    }
    if (trimmed) current.nonblank += 1;
  }
  if (current) maybePushLongFunction(findings, current, lines.length, path, threshold);
  return findings.slice(0, 3);
}

function compareCandidateTargets(candidateTargets, selectedIteration) {
  const selectedId = selectedIteration?.target_id || selectedIteration?.id || null;
  const candidates = asArray(candidateTargets)
    .map((target, index) => ({
      id: target.id || target.target_id || `candidate-${index + 1}`,
      target_repo: target.target_repo || null,
      score: Number(target.score || 0),
      risk: target.risk || "medium",
      tool_pack_count: asArray(target.tool_packs).length,
      validation_command_count: asArray(target.validation_commands).length,
      selected: (target.id || target.target_id) === selectedId,
      generated_from: target.generated_from || null
    }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score || a.id.localeCompare(b.id));
  return {
    schema_version: "across-autopilot-candidate-comparison/1.0",
    selected_target_id: selectedId,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, 12),
    decision_rule: "selected candidate must pass deterministic admission, validation command normalization, and independent review"
  };
}

function maybePushLongFunction(findings, current, endIndex, path, threshold) {
  if (current.nonblank <= threshold) return;
  findings.push({
    id: "large_function_body",
    severity: "warning",
    path,
    line: current.start + 1,
    message: "large function bodies should be split before unattended promotion",
    excerpt: `${current.name || "function"} has ${current.nonblank} nonblank line(s) over ${endIndex - current.start} total line(s)`
  });
}

function isTestPath(path) {
  const rel = String(path || "").toLowerCase();
  return rel.includes("/test")
    || rel.includes("/tests/")
    || rel.endsWith("_test.py")
    || rel.endsWith(".test.js")
    || rel.endsWith("tests.swift");
}

function isSourceCodePath(path) {
  const rel = String(path || "").toLowerCase();
  if (!rel) return false;
  if (isGeneratedCandidateArtifact(rel) || isDocumentationPath(rel)) return false;
  return [
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".swift",
    ".sh"
  ].some((ext) => rel.endsWith(ext));
}

function reviewerScoresFromSemantic(semantic = {}, { changedFiles = [], qualityFindings = [], validation = {}, probe = {}, ready = false } = {}) {
  const blockers = asArray(semantic.blocking_reasons);
  const warnings = asArray(semantic.warnings);
  const errorCount = qualityFindings.filter((finding) => finding.severity === "error").length;
  const warningCount = qualityFindings.filter((finding) => finding.severity === "warning").length + warnings.length;
  const validationFailed = validation.status && validation.status !== "passed";
  const productValueScore = clampScore(
    90
    - (changedFiles.length === 0 ? 45 : 0)
    - (isSelfProofOnlyChange(changedFiles) ? 35 : 0)
    - (isTestOnlyChange(changedFiles) ? 25 : 0)
    - blockers.length * 12
  );
  const maintainabilityScore = clampScore(
    92
    - errorCount * 35
    - warningCount * 3
    - (validationFailed ? 25 : 0)
  );
  const riskScore = clampScore(
    10
    + blockers.length * 18
    + errorCount * 25
    + warningCount * 2
    + (validationFailed ? 25 : 0)
    + (probe.required && probe.status !== "passed" ? 20 : 0)
  );
  const mergeRecommendation = ready && riskScore <= 35 && maintainabilityScore >= 70
    ? "open_review_pr"
    : "repair_before_pr";
  const notes = unique([
    ...blockers,
    ...warnings,
    ...(errorCount ? [`${errorCount} blocking code-quality finding(s)`] : []),
    ...(warningCount ? [`${warningCount} maintainability warning(s)`] : []),
    ...(validationFailed ? ["validation did not pass"] : []),
    ...(ready ? ["human approval is still required before promotion"] : [])
  ]).slice(0, 12);
  return {
    product_value_score: productValueScore,
    maintainability_score: maintainabilityScore,
    risk_score: riskScore,
    merge_recommendation: mergeRecommendation,
    human_review_notes: notes
  };
}

function promotionKnownRisks({ validation = {}, appLifecycle = {}, semantic = {}, qualityFindings = [], probe = {}, changedFiles = [], sourceRefPins = {} }) {
  const risks = [];
  if (!changedFiles.length) risks.push({ severity: "high", source: "candidate_diff", summary: "candidate has no changed files" });
  if (validation.status && validation.status !== "passed") risks.push({ severity: "high", source: "validation", summary: "candidate validation did not pass" });
  if (appLifecycle.required && appLifecycle.status !== "passed") risks.push({ severity: "high", source: "candidate_app_lifecycle", summary: "candidate app lifecycle did not pass" });
  if (probe.required && probe.status !== "passed") risks.push({ severity: "high", source: "self_hosting_probe", summary: "self-hosting probe did not pass" });
  if (sourceRefPins.status && sourceRefPins.status !== "passed") {
    const missing = asArray(sourceRefPins.missing_required_repos).concat(asArray(sourceRefPins.missing_pins));
    const changed = asArray(sourceRefPins.changed_sources);
    risks.push({
      severity: "high",
      source: "source_ref_pins",
      summary: `source ref pinning did not pass; missing=${missing.join(",") || "none"} changed=${changed.join(",") || "none"}`
    });
  }
  for (const reason of asArray(semantic.blocking_reasons)) risks.push({ severity: "high", source: "independent_review", summary: reason });
  for (const finding of qualityFindings) {
    risks.push({
      severity: finding.severity === "error" ? "high" : "medium",
      source: finding.id,
      summary: `${finding.path}${finding.line ? `:${finding.line}` : ""} ${finding.message}`
    });
  }
  return risks.slice(0, 20);
}

function recommendedPullRequest({ spec, strategy = {}, mutation = {}, changedFiles = [], ready = false }) {
  const selected = strategy.selected_iteration || {};
  const titleSource = mutation.summary || selected.summary || selected.goal || spec.name || spec.id || "Loop Engineering candidate";
  const title = `${ready ? "Review" : "Draft"}: ${String(titleSource).replace(/\s+/g, " ").trim().slice(0, 80)}`;
  const body = [
    "## Summary",
    `- Candidate generated by LoopSpec \`${spec.id || "unknown"}\`.`,
    `- Selected target: \`${strategy.selected_target_id || selected.target_id || "unknown"}\`.`,
    `- Changed files: ${changedFiles.length}.`,
    "",
    "## Validation",
    "- Review promotion package validation_results before opening a protected PR.",
    "",
    "## Approval",
    "- Human approval is required before merge, release, signing, or publication."
  ].join("\n");
  return {
    title,
    body,
    draft: true,
    target_branch: "main"
  };
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function isDocumentationPath(path) {
  const rel = String(path || "").toLowerCase();
  return rel === "readme.md"
    || rel === "changelog.md"
    || rel.endsWith("/readme.md")
    || rel.endsWith("/changelog.md")
    || rel.startsWith("docs/")
    || rel.endsWith(".md")
    || rel.endsWith(".markdown");
}

function selectedIterationFromActions(actions) {
  const strategy = actionResult(actions, "product_iteration_strategy");
  return strategy?.selected_iteration || null;
}

function shouldUseAutonomousBacklog(spec, declaredTargets) {
  const policy = spec.pack_config?.research_strategy || {};
  if (policy.dynamic_backlog === true || policy.autonomous === true) return true;
  return declaredTargets.length === 0 && asArray(spec.used_adapters?.actions).includes("product_iteration_strategy");
}

function compactAutonomousState(state) {
  return {
    schema_version: state.schema_version,
    root: state.root,
    artifacts_dir: state.artifacts_dir,
    contract_dir: state.contract_dir,
    global_timeline_path: state.global_timeline_path,
    artifact_paths: state.artifact_paths,
    contract_paths: state.contract_paths,
    backlog_count: asArray(state.backlog).length,
    top_backlog: asArray(state.backlog).slice(0, 5).map((item) => ({
      id: item.id,
      score: item.score,
      summary: item.summary,
      tool_packs: item.tool_packs,
      generated_from: item.generated_from
    })),
    source_signal_count: asArray(state.source_signals).length,
    recent_global_timeline_count: asArray(state.recent_global_timeline).length,
    recent_loop_timeline_count: asArray(state.recent_loop_timeline).length
  };
}

function compactSourcesForStrategy(sources) {
  return asArray(sources).map((source) => {
    const result = source.result || {};
    return {
      id: source.id,
      adapter: source.adapter,
      status: source.status,
      result: {
        kind: result.kind || null,
        title: result.title || result.name || source.id,
        url: result.url || null,
        status_code: result.status_code || null,
        excerpt: String(result.excerpt || result.content || "").slice(0, 2200),
        files: asArray(result.files).slice(0, 20).map((file) => ({
          path: file.path,
          size: file.size,
          content: String(file.content || "").slice(0, 1200)
        })),
        repositories: asArray(result.repositories).slice(0, 10).map((repo) => ({
          id: repo.id || repo.name,
          name: repo.name || repo.id,
          url: repo.url || null,
          license: repo.license || null
        }))
      }
    };
  });
}

function normalizeStrategyResponse(response, spec, targetCatalog = null, options = {}) {
  const selected = response.selected_iteration || response.decision?.selected_iteration;
  if (!selected || typeof selected !== "object") {
    throw ecosystemFailure("product_iteration_strategy", "Host research decision returned no selected_iteration.");
  }
  const catalog = new Map(asArray(targetCatalog || spec.pack_config?.research_strategy?.candidate_targets).map((target) => [String(target.id), target]));
  const targetId = String(selected.target_id || response.selected_target_id || "");
  const catalogTarget = catalog.get(targetId);
  if (!catalogTarget && !options.allowGeneratedTargets) {
    throw ecosystemFailure("product_iteration_strategy", `Research decision selected undeclared target without generated-target permission: ${targetId || "unknown"}`);
  }
  const allowed = asArray(selected.allowed_patch_paths);
  if (!allowed.length) {
    throw ecosystemFailure("product_iteration_strategy", "Host research decision returned no allowed_patch_paths.");
  }
  if (catalogTarget) {
    const catalogPaths = new Set(asArray(catalogTarget.allowed_patch_paths).map(String));
    for (const path of allowed) {
      if (!catalogPaths.has(String(path))) {
        throw ecosystemFailure("product_iteration_strategy", `Selected path is outside target catalog: ${path}`);
      }
    }
  }
  const admitted = admitGeneratedTarget(selected, spec, {
    catalogTarget,
    targetId: targetId || catalogTarget?.id || "selected-target"
  });
  const candidateTargets = admitBacklogCandidates(response, spec, targetCatalog, admitted.target);
  return {
    decision: String(response.decision || "implement"),
    summary: String(response.summary || selected.goal || "Research strategy selected a product iteration."),
    rationale: String(response.rationale || ""),
    rejected_directions: asArray(response.rejected_directions),
    admission: admitted.admission,
    candidate_targets: candidateTargets,
    selected_iteration: {
      target_id: admitted.target.id,
      target_repo: admitted.target.target_repo,
      goal: admitted.target.goal,
      allowed_patch_paths: admitted.target.allowed_patch_paths,
      context_files: admitted.target.context_files,
      validation_commands: admitted.target.validation_commands,
      semantic_review: admitted.target.semantic_review,
      source_refs: admitted.target.source_refs,
      risk: admitted.target.risk,
      score: admitted.target.score,
      tool_packs: admitted.target.tool_packs,
      generated_from: admitted.target.generated_from
    }
  };
}

function admitBacklogCandidates(response, spec, targetCatalog, selectedTarget) {
  const raw = asArray(response.candidate_targets || response.dynamic_backlog || response.generated_backlog);
  const source = raw.length ? raw : asArray(targetCatalog);
  const admitted = [];
  for (const [index, item] of source.entries()) {
    try {
      admitted.push(admitGeneratedTarget(item, spec, {
        catalogTarget: null,
        targetId: item?.target_id || item?.id || `candidate-${index + 1}`
      }).target);
    } catch {
      continue;
    }
  }
  if (!admitted.some((item) => item.id === selectedTarget.id)) {
    admitted.unshift(selectedTarget);
  }
  return admitted.map((item, index) => ({
    ...item,
    id: item.target_id || item.id || `candidate-${index + 1}`,
    score: Number(item.score || (admitted.length - index))
  }));
}

function admitGeneratedTarget(selected, spec, { catalogTarget = null, targetId = "selected-target" } = {}) {
  const failures = [];
  const warnings = [];
  const targetRepo = String(selected.target_repo || catalogTarget?.target_repo || spec.pack_config?.target_repo || "across-agents-assistant");
  if (!REQUIRED_ECOSYSTEM_REPOS.includes(targetRepo)) {
    failures.push(`target_repo is not an Across ecosystem repo: ${targetRepo}`);
  }
  const allowedPaths = asArray(selected.allowed_patch_paths || catalogTarget?.allowed_patch_paths).map((path) => {
    try {
      return safeRelativePath(path);
    } catch {
      failures.push(`invalid allowed_patch_path: ${path}`);
      return "";
    }
  }).filter(Boolean);
  if (!allowedPaths.length) failures.push("allowed_patch_paths is empty");
  for (const path of allowedPaths) {
    try {
      assertNotDenied(path, spec);
    } catch (error) {
      failures.push(error.message || String(error));
    }
    if (!allowedPathMatchesRepoPolicy(targetRepo, path)) {
      warnings.push(`path is outside common product prefixes for ${targetRepo}: ${path}`);
    }
  }
  const validationCommands = normalizeGeneratedValidationCommands(
    selected.validation_commands || catalogTarget?.validation_commands,
    { targetRepo, allowedPaths }
  );
  if (validationCommands.length < 2) {
    warnings.push("generated target has fewer than two validation commands");
  }
  if (failures.length) {
    throw ecosystemFailure("product_iteration_strategy", `Generated target failed admission: ${failures.join("; ")}`);
  }
  const semanticReview = {
    require_model_backed: true,
    require_selected_target_change: true,
    reject_self_proof_only: true,
    independent_reviewer_required: true,
    minimum_validation_commands: Math.max(2, Number(selected.semantic_review?.minimum_validation_commands || catalogTarget?.semantic_review?.minimum_validation_commands || 0)),
    ...(catalogTarget?.semantic_review || {}),
    ...(selected.semantic_review || {})
  };
  return {
    admission: {
      status: "passed",
      generated: !catalogTarget,
      warnings,
      validation_command_count: validationCommands.length
    },
    target: {
      id: String(selected.target_id || selected.id || targetId || "selected-target"),
      target_repo: targetRepo,
      goal: String(selected.goal || catalogTarget?.goal || spec.description || spec.name),
      allowed_patch_paths: allowedPaths,
      context_files: asArray(selected.context_files || catalogTarget?.context_files).map(String).slice(0, 16),
      validation_commands: validationCommands,
      semantic_review: semanticReview,
      source_refs: asArray(selected.source_refs).map(String).slice(0, 12),
      risk: String(selected.risk || catalogTarget?.risk || "medium"),
      score: Number(catalogTarget?.score || selected.score || 0),
      tool_packs: asArray(selected.tool_packs || catalogTarget?.tool_packs).map(String),
      generated_from: String(selected.generated_from || catalogTarget?.generated_from || (catalogTarget ? "catalog" : "model_generated"))
    }
  };
}

function normalizeGeneratedValidationCommands(commands, { targetRepo, allowedPaths }) {
  const requested = asArray(commands)
    .filter((item) => item && typeof item === "object" && item.command)
    .slice(0, 8)
    .map((item) => ({
      repo: String(item.repo || targetRepo),
      command: String(item.command),
      args: asArray(item.args).map(String),
      ...(item.timeout_ms !== undefined ? { timeout_ms: Number(item.timeout_ms || 0) } : {})
    }));
  const normalized = requested.filter((command) => validationCommandIsAdmissible(command));
  const fallback = generatedValidationCommands({ targetRepo, allowedPaths });
  const combined = dedupeValidationCommands([...normalized, ...fallback]);
  if (combined.length) return combined.slice(0, 8);
  return fallback.slice(0, 8);
}

function generatedValidationCommands({ targetRepo, allowedPaths }) {
  const pythonFiles = allowedPaths.filter((path) => path.endsWith(".py"));
  const testFiles = pythonFiles.filter((path) => path.startsWith("backend/tests/") || path.includes("/tests/"));
  const generated = [{ repo: targetRepo, command: "git", args: ["diff", "--check"], timeout_ms: 30000 }];
  if (pythonFiles.length) {
    generated.push({ repo: targetRepo, command: "python3", args: ["-m", "py_compile", ...pythonFiles], timeout_ms: 30000 });
  }
  if (allowedPaths.some((path) => path.endsWith(".swift") || path.startsWith("macOS-Client/"))) {
    generated.push({ repo: targetRepo, command: "swift", args: ["test", "--package-path", "macOS-Client"], timeout_ms: 180000 });
  }
  if (["across-autopilot", "across-context"].includes(targetRepo)
    && allowedPaths.some((path) => path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("examples/") || path === "package.json")) {
    generated.push({ repo: targetRepo, command: "npm", args: ["test", "--", "--runInBand"], timeout_ms: 180000 });
  }
  for (const testPath of testFiles.slice(0, 2)) {
    generated.push({
      repo: targetRepo,
      command: "python3",
      args: [
        "-c",
        `import sys, runpy; sys.path.insert(0, 'backend/src'); ns=runpy.run_path('${testPath}'); tests=[v for k,v in ns.items() if k.startswith('test_') and callable(v)]; assert tests, 'no test functions found'; [test() for test in tests]`
      ],
      timeout_ms: 30000
    });
  }
  return generated.slice(0, 8);
}

function validationCommandIsAdmissible(command) {
  const executable = basename(String(command.command || ""));
  const args = asArray(command.args).map(String);
  const codeIndex = args.indexOf("-c");
  if (!["python", "python3"].includes(executable) || codeIndex === -1) return true;
  const code = args[codeIndex + 1];
  if (!code) return false;
  const result = spawnSync(executable, [
    "-c",
    "import sys; compile(sys.argv[1], '<autopilot-validation-command>', 'exec')",
    code
  ], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  return result.status === 0;
}

function dedupeValidationCommands(commands) {
  const seen = new Set();
  const result = [];
  for (const command of commands) {
    const key = stableJson({
      repo: command.repo || null,
      command: command.command || null,
      args: asArray(command.args)
    });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(command);
  }
  return result;
}

function openTargetPathPolicy() {
  return {
    denied: DEFAULT_DENIED_PATHS,
    product_prefixes: {
      "across-agents-assistant": ["backend/src/", "backend/tests/", "macOS-Client/Sources/", "macOS-Client/Tests/", "scripts/", "docs/", "README.md", "CHANGELOG.md"],
      "across-autopilot": ["src/", "tests/", "examples/", "README.md", "AUTOPILOT_RFC.md", "package.json"],
      "across-orchestrator": ["src/across_orchestrator/", "tests/", "README.md"],
      "across-context": ["src/", "tests/", "README.md", "package.json"]
    }
  };
}

function allowedPathMatchesRepoPolicy(repoId, path) {
  const prefixes = openTargetPathPolicy().product_prefixes[repoId] || [];
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

async function cloneRepo(repo, target) {
  const args = ["clone"];
  if (repo.ref || repo.branch) args.push("--branch", String(repo.ref || repo.branch));
  args.push(String(repo.source), target);
  await exec("git", args, { timeout: Number(repo.timeout_ms || 120_000), maxBuffer: 10 * 1024 * 1024 });
}

async function copyRepoSnapshot(repo, target) {
  const source = resolvePath(repo.source, process.cwd());
  if (!existsSync(source)) throw ecosystemFailure("candidate_ecosystem_acquire", `Source repo does not exist: ${source}`);
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(join(source, ".git"))) {
    await copyGitSnapshot(source, target);
    return;
  }
  await cp(source, target, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      if (DEFAULT_EXCLUDES.includes(name)) return false;
      if (src.includes(`${resolve(source)}/.git/`)) return false;
      return true;
    }
  });
}

async function copyGitSnapshot(source, target) {
  await mkdir(target, { recursive: true });
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: source,
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024
  });
  const files = String(stdout || "").split("\0").filter(Boolean);
  for (const rel of files) {
    const safeRel = safeRelativePath(rel);
    if (shouldExcludeSnapshotPath(safeRel)) continue;
    const src = ensureInside(source, resolve(source, safeRel));
    const dst = ensureInside(target, resolve(target, safeRel));
    const info = await stat(src);
    if (!info.isFile()) continue;
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

function shouldExcludeSnapshotPath(rel) {
  const parts = rel.split("/");
  return parts.some((part) => DEFAULT_EXCLUDES.includes(part));
}

async function ensureGitBaseline(root, repoId, mode) {
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir)) {
    await exec("git", ["init"], { cwd: root, timeout: 60_000 });
  }
  await exec("git", ["add", "."], { cwd: root, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  const hasHead = await gitMaybe(root, ["rev-parse", "--verify", "HEAD"]);
  const status = await gitMaybe(root, ["status", "--short", "--untracked-files=all"]);
  if (!hasHead.trim() || status.trim()) {
    await exec("git", [
      "-c", "user.name=Across Autopilot",
      "-c", "user.email=autopilot@example.invalid",
      "commit",
      "-m",
      `${mode} baseline for ${repoId}`
    ], { cwd: root, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  }
}

async function inspectSourceRepo(repo) {
  const source = resolvePath(repo.source, process.cwd());
  if (!existsSync(source) || !existsSync(join(source, ".git"))) {
    return { git: false, head: "", status: "" };
  }
  return {
    git: true,
    head: await gitMaybe(source, ["rev-parse", "HEAD"]),
    status: await gitMaybe(source, ["status", "--short", "--untracked-files=all"])
  };
}

async function verifySourceUnchanged(repos) {
  const results = [];
  for (const repo of repos) {
    const source = resolvePath(repo.source, process.cwd());
    if (!existsSync(source) || !existsSync(join(source, ".git"))) {
      results.push({ id: repo.id, source, unchanged: true, mode: "not_git_source" });
      continue;
    }
    const expectedHead = String(repo.source_head_pre || "").trim();
    const expectedStatus = String(repo.source_status_pre || "").trim();
    if (!expectedHead && !repo.source_git) {
      results.push({ id: repo.id, source, unchanged: true, mode: "source_baseline_unavailable" });
      continue;
    }
    const head = await gitMaybe(source, ["rev-parse", "HEAD"]);
    const status = await gitMaybe(source, ["status", "--short", "--untracked-files=all"]);
    const unchanged = head.trim() === expectedHead && status.trim() === expectedStatus;
    results.push({
      id: repo.id,
      source,
      unchanged,
      head_pre: expectedHead,
      head_post: head,
      status_pre: expectedStatus,
      status_post: status
    });
  }
  return {
    unchanged: results.every((item) => item.unchanged),
    repos: results
  };
}

function buildProbeSpec({ probeId, probeRepo }) {
  const specId = `self-hosting-${probeId}`.toLowerCase().replace(/[^a-z0-9-_.]+/g, "-");
  const probeFile = "backend/tests/fixtures/loop_engineering_self_hosting_probe.md";
  return {
    schema_version: "across-loop-spec/1.0",
    id: specId,
    name: "Self Hosting Probe",
    description: "B candidate Autopilot modifies disposable C probe workspace.",
    owner: { type: "local_user", id: "autopilot" },
    compatibility: {
      min_autopilot_version: ">=0.2.0",
      required_orchestrator: ">=0.7.0",
      required_context: ">=0.8.0",
      required_host: ">=0.9.0"
    },
    required_capabilities: ["action.candidate_workspace_patch", "action.candidate_diff_summary", "action.candidate_validation"],
    trigger: { type: "manual" },
    scope: { project_id: "self-hosting-probe", workspace: probeRepo },
    autonomy: { level: 3, requires_human_approval_above: 3 },
    sources: [{ id: "probe", type: "directory", adapter: "directory", path: probeRepo, max_files: 20 }],
    actions: {
      allowed: ["file_read", "git_read", "candidate_workspace_patch", "candidate_diff_summary", "candidate_validation", "promotion_report_generation", "quality_gate_evaluation", "report_generation"],
      blocked: ["merge_pr", "release_publish", "sign_artifact", "write_secret"]
    },
    execute: { engine: "across-orchestrator", mode: "task" },
    outputs: [
      { type: "markdown_report", to: "run://probe/report.md", policy: "create" },
      { type: "json_artifact", to: "run://probe/evidence.json", policy: "overwrite" }
    ],
    gates: [
      { id: "candidate_has_diff", required: true },
      { id: "candidate_validation_passed", required: true }
    ],
    memory: { provider: "across-context", recall: false, remember: false, write_status: "pending" },
    failure_policy: { max_retries: 0, retry_backoff: "linear", continue_on_gate_failure: false, dead_letter: "context_memory" },
    sandbox: { filesystem: "run_scoped", network: "none", env: "minimal" },
    evidence_contract: {
      schema_version: "across-loop-evidence/1.0",
      required_sections: ["sources", "actions", "gates", "outputs", "audit"]
    },
    used_adapters: {
      sources: ["directory"],
      actions: ["candidate_workspace_patch", "candidate_diff_summary", "candidate_validation", "promotion_report_generation", "quality_gate_evaluation", "report_generation"],
      outputs: ["markdown_report", "json_artifact"]
    },
    pack_config: {
      mutation_policy: "candidate_workspace_only",
      candidate_workspace: probeRepo,
      allowed_patch_paths: [probeFile],
      iteration_plan: {
        patches: [{
          path: probeFile,
          mode: "overwrite",
          content: `# Self Hosting Probe\n\nProbe ${probeId} was modified by B candidate Autopilot.\n`
        }]
      },
      validation_commands: [{ command: "git", args: ["diff", "--check"], timeout_ms: 30000 }]
    }
  };
}

function normalizeRepos(repos, env) {
  const byId = new Map();
  for (const repo of repos) {
    if (!repo || typeof repo !== "object") continue;
    const id = safeSegment(repo.id || repo.name);
    if (!id) continue;
    byId.set(id, {
      id,
      source: resolvePath(repo.source || repo.path || defaultRepoSource(id, env), process.cwd()),
      ref: repo.ref || repo.tag || null,
      branch: repo.branch || null,
      timeout_ms: repo.timeout_ms
    });
  }
  for (const id of REQUIRED_ECOSYSTEM_REPOS) {
    if (!byId.has(id)) {
      const source = defaultRepoSource(id, env);
      if (source && existsSync(source)) byId.set(id, { id, source, ref: null, branch: null });
    }
  }
  return [...byId.values()].sort((a, b) => REQUIRED_ECOSYSTEM_REPOS.indexOf(a.id) - REQUIRED_ECOSYSTEM_REPOS.indexOf(b.id));
}

function defaultRepoSource(id, env) {
  const envKey = `ACROSS_${id.replace(/^across-/, "").replaceAll("-", "_").toUpperCase()}_SOURCE`;
  if (env[envKey]) return env[envKey];
  const projectRoot = resolve(ecosystemHome(env), "..", "Documents", "projects");
  const cwdSibling = resolve(process.cwd(), "..", id);
  if (existsSync(cwdSibling)) return cwdSibling;
  const homeProjects = resolve(process.env.HOME || "", "Documents", "projects", id);
  if (existsSync(homeProjects)) return homeProjects;
  return projectRoot;
}

function candidateRuntimeRoot(env) {
  if (env.ACROSS_CANDIDATE_RUNTIME_ROOT) {
    return resolvePath(env.ACROSS_CANDIDATE_RUNTIME_ROOT, process.cwd());
  }
  const home = env.HOME || process.env.HOME || "";
  return resolvePath(join(home, ".across", "c"), process.cwd());
}

function actionResult(actions, adapter) {
  return [...actions].reverse().find((action) => action.adapter === adapter)?.result || null;
}

function validationFeedbackForCodeIteration(actions) {
  const validation = [...actions]
    .reverse()
    .find((action) => action.adapter === "candidate_ecosystem_validation" && Array.isArray(action.result?.commands));
  const commandFeedback = validation ? asArray(validation.result.commands)
    .filter((item) => item?.status !== "passed")
    .slice(0, 5)
    .map((item) => ({
      type: "validation_command",
      repo: item.repo || null,
      command: item.command || "",
      args: asArray(item.args).map(String),
      status: item.status || "failed",
      exit_code: item.exit_code ?? null,
      stdout: String(item.stdout || "").slice(0, 2000),
      stderr: String(item.stderr || "").slice(0, 4000)
    })) : [];
  const review = [...actions]
    .reverse()
    .find((action) => action.adapter === "semantic_alignment_review" && action.status !== "passed");
  const reviewFeedback = review ? [{
    type: "semantic_alignment_review",
    status: review.status || "failed",
    blocking_reasons: asArray(review.result?.blocking_reasons).map(String).slice(0, 8),
    warnings: asArray(review.result?.warnings).map(String).slice(0, 8),
    changed_files: asArray(review.result?.changed_files).map(String).slice(0, 20),
    policy: review.result?.policy || {}
  }] : [];
  return [...commandFeedback, ...reviewFeedback];
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function gitMaybe(cwd, args) {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

function assertAllowed(rel, allowedPaths) {
  const allowed = asArray(allowedPaths).map(safeRelativePath);
  if (!allowed.length) return;
  if (!allowed.some((item) => rel === item || rel.startsWith(`${item.replace(/\/$/, "")}/`))) {
    throw ecosystemFailure("host_code_iteration", `Patch path is outside allowed paths: ${rel}`);
  }
}

function assertNotDenied(rel, spec) {
  const denied = [...DEFAULT_DENIED_PATHS, ...asArray(spec.pack_config?.denied_paths)];
  const lower = rel.toLowerCase();
  for (const pattern of denied) {
    const normalized = String(pattern).toLowerCase().replace(/^\*\./, ".");
    if (pattern.endsWith("/")) {
      if (lower.startsWith(pattern.toLowerCase())) throw ecosystemFailure("host_code_iteration", `Patch path is denied: ${rel}`);
    } else if (lower === normalized || lower.includes(`/${normalized}`) || lower.endsWith(normalized)) {
      throw ecosystemFailure("host_code_iteration", `Patch path is denied: ${rel}`);
    }
  }
}

function safeRelativePath(value) {
  const rel = String(value || "").replaceAll("\\", "/").trim();
  if (!rel || rel.startsWith("/") || rel.startsWith("~") || rel.split("/").some((part) => part === ".." || part === "")) {
    throw ecosystemFailure("candidate_path", `Unsafe relative path: ${value}`);
  }
  return rel;
}

function ensureInside(root, target) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw ecosystemFailure("candidate_path", `Path escapes candidate workspace: ${target}`);
}

function resolvePath(path, fallbackRoot) {
  if (!path) return resolve(fallbackRoot || ".");
  const expanded = String(path).replace(/^~(?=$|\/)/, process.env.HOME || "");
  return isAbsolute(expanded) ? resolve(expanded) : resolve(fallbackRoot || ".", expanded);
}

function safeSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortCandidateRuntimeKey(candidateId) {
  const safeId = safeSegment(candidateId);
  const timestamp = safeId.match(/^\d{8}T\d{6}Z/)?.[0] || "candidate";
  const digest = createHash("sha256").update(safeId).digest("hex").slice(0, 8);
  return `${timestamp}-${digest}`;
}

export function candidateRuntimePreflight(config) {
  const socketPath = join(config.app_home, "run", "across-agents.sock");
  const socketPathBytes = Buffer.byteLength(socketPath, "utf8");
  const status = socketPathBytes <= MAX_MACOS_UNIX_SOCKET_PATH_BYTES ? "passed" : "failed";
  return {
    schema_version: "across-autopilot-candidate-runtime-preflight/1.0",
    status,
    runtime_key: config.runtime_key,
    runtime_home: config.runtime_home,
    app_home: config.app_home,
    socket_path: socketPath,
    socket_path_bytes: socketPathBytes,
    max_socket_path_bytes: MAX_MACOS_UNIX_SOCKET_PATH_BYTES,
    single_instance_required: true,
    cleanup_required: true,
    reason: status === "passed"
      ? "Candidate Unix socket path is short enough for macOS Network.framework."
      : "Candidate Unix socket path is too long for macOS Network.framework."
  };
}

function assertCandidateRuntimePreflight(config) {
  const preflight = config.runtime_preflight || candidateRuntimePreflight(config);
  if (preflight.status !== "passed") {
    throw ecosystemFailure(
      "candidate_runtime_preflight",
      `Candidate runtime socket path is ${preflight.socket_path_bytes} byte(s), max ${preflight.max_socket_path_bytes}: ${preflight.socket_path}`
    );
  }
}

function ecosystemFailure(adapterId, message) {
  return new LoopFailure({
    code: FAILURE_CODES.SANDBOX_VIOLATION,
    failedState: "running",
    adapterId,
    message
  });
}
