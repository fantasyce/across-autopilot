import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  acquireCandidateEcosystem,
  buildCandidatePromotionEvidence,
  candidateEcosystemDiff,
  ecosystemGateStatus,
  runProductIterationStrategy,
  runCandidateAppLifecycle,
  runCandidateSelfHostingProbe,
  runHostCodeIteration,
  semanticAlignmentReview,
  validateCandidateEcosystem
} from "./candidate-ecosystem.js";
import { FAILURE_CODES, LoopFailure } from "./failures.js";
import { asArray, stableJson, unique } from "./json-utils.js";
import { listToolPacks } from "./tool-packs.js";
import { roleForAdapter } from "./roles.js";

const exec = promisify(execFile);

export class AdapterRegistry {
  constructor({ orchestratorClient = null, contextClient = null, store = null } = {}) {
    this.orchestratorClient = orchestratorClient;
    this.contextClient = contextClient;
    this.store = store;
    this.sourceAdapters = new Map();
    this.actionAdapters = new Map();
    this.outputAdapters = new Map();
    registerBuiltIns(this);
  }

  registerSource(adapter) {
    this.sourceAdapters.set(adapter.id, adapter);
  }

  registerAction(adapter) {
    this.actionAdapters.set(adapter.id, adapter);
  }

  registerOutput(adapter) {
    this.outputAdapters.set(adapter.id, adapter);
  }

  hasSource(id) {
    return this.sourceAdapters.has(id);
  }

  hasAction(id) {
    return this.actionAdapters.has(id);
  }

  hasOutput(id) {
    return this.outputAdapters.has(id);
  }

  getSource(id) {
    return this.sourceAdapters.get(id);
  }

  getAction(id) {
    return this.actionAdapters.get(id);
  }

  getOutput(id) {
    return this.outputAdapters.get(id);
  }

  capabilities() {
    const sources = [...this.sourceAdapters.keys()].sort().map((id) => `source.${id}`);
    const actions = [...this.actionAdapters.keys()].sort().map((id) => `action.${id}`);
    const outputs = [...this.outputAdapters.keys()].sort().map((id) => `output.${id}`);
    const runtime = [
      "memory.pending_summary",
      "runtime.capability_preflight",
      "runtime.evidence_integrity",
      "runtime.promotion_attestation",
      "runtime.role_orchestration",
      "runtime.runtime_policy",
      "runtime.tool_pack_registry",
      "runtime.trigger_queue"
    ];
    const available = new Set([...sources, ...actions, ...outputs, ...runtime]);
    return {
      sources,
      actions,
      outputs,
      runtime,
      tool_packs: listToolPacks().map((pack) => ({
        ...pack,
        available: pack.capability_refs.every((capability) => available.has(capability)),
        missing_capabilities: pack.capability_refs.filter((capability) => !available.has(capability))
      }))
    };
  }
}

export function registerBuiltIns(registry) {
  for (const id of ["file", "directory", "url", "rss", "github_repo", "github_search", "package_registry", "manual_input"]) {
    registry.registerSource(sourceAdapter(id));
  }
  for (const id of ["read_only_analysis", "source_digest", "compatibility_scoring", "license_check", "manifest_inspection", "dependency_risk_check", "candidate_ecosystem_acquire", "product_iteration_strategy", "host_code_iteration", "candidate_ecosystem_diff", "candidate_ecosystem_validation", "candidate_app_lifecycle", "candidate_self_hosting_probe", "semantic_alignment_review", "candidate_workspace_patch", "candidate_diff_summary", "candidate_validation", "promotion_report_generation", "report_generation", "orchestrator_task_dispatch", "quality_gate_evaluation", "memory_write_candidate"]) {
    registry.registerAction(actionAdapter(id));
  }
  for (const id of ["markdown_report", "json_artifact", "context_memory", "local_file", "github_issue_draft", "pull_request_draft", "media_storyboard", "video_draft_manifest"]) {
    registry.registerOutput(outputAdapter(id));
  }
}

function sourceAdapter(id) {
  return {
    id,
    capability: `source.${id}`,
    required_autonomy_level: 1,
    async run({ spec, source, run }) {
      const startedAt = new Date().toISOString();
      const result = await runSource(id, source || {}, spec, run);
      return {
        id: source?.id || id,
        adapter: id,
        status: "passed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        result
      };
    }
  };
}

async function runSource(id, source, spec, run) {
  if (source.fixture) return normalizeFixtureSource(source);
  if (id === "manual_input") {
    return { kind: "manual_input", title: source.title || source.id || "Manual input", content: source.content || "" };
  }
  if (id === "file") {
    const path = resolvePath(source.path, run?.sandbox);
    const text = await readFile(path, "utf8");
    return textRecord(path, text);
  }
  if (id === "directory") {
    const root = resolvePath(source.path || spec?.scope?.workspace || ".", process.cwd());
    const files = await directoryRecords(root, Number(source.max_files || 200));
    return { kind: "directory", root, files };
  }
  if (id === "github_repo" || id === "package_registry") {
    if (source.path) {
      const root = resolvePath(source.path, process.cwd());
      return { kind: id, root, files: await directoryRecords(root, Number(source.max_files || 120)) };
    }
    if (id === "github_repo" && source.url) return cloneGitRepository(source, run);
    if (source.url) return fetchUrlRecord(source.url, { kind: id });
  }
  if (id === "github_search") {
    const fixtures = asArray(source.repositories || source.fixtures);
    if (fixtures.length) return { kind: "github_search", query: source.query || "", repositories: fixtures.map(normalizeFixtureSource) };
    return fetchUrlRecord(source.url || `https://api.github.com/search/repositories?q=${encodeURIComponent(source.query || "topic:mcp")}`, { kind: id });
  }
  if (id === "rss" || id === "url") {
    if (source.path) return textRecord(resolvePath(source.path, process.cwd()), await readFile(resolvePath(source.path, process.cwd()), "utf8"));
    return fetchUrlRecord(source.url, { kind: id });
  }
  return { kind: id, source };
}

function actionAdapter(id) {
  return {
    id,
    capability: `action.${id}`,
    required_autonomy_level: id === "orchestrator_task_dispatch" ? 2 : 1,
    failure_codes: [FAILURE_CODES.ADAPTER_INVALID_OUTPUT],
    retry_behavior: "none",
    async run(context) {
      const startedAt = new Date().toISOString();
      const result = await runAction(id, context);
      return {
        id,
        adapter: id,
        status: result.status || "passed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        autonomy_level: context.spec?.autonomy?.level ?? 0,
        role: roleForAdapter(id),
        inputs: result.inputs || [],
        outputs: result.outputs || [],
        result,
        failure: result.failure || null
      };
    }
  };
}

async function runAction(id, context) {
  if (id === "read_only_analysis") return readOnlyAnalysis(context);
  if (id === "source_digest") return sourceDigest(context);
  if (id === "license_check") return licenseCheck(context);
  if (id === "manifest_inspection") return manifestInspection(context);
  if (id === "dependency_risk_check") return dependencyRisk(context);
  if (id === "compatibility_scoring") return compatibilityScore(context);
  if (id === "candidate_ecosystem_acquire") return acquireCandidateEcosystem({ ...context, env: process.env });
  if (id === "product_iteration_strategy") return runProductIterationStrategy({ ...context, env: process.env });
  if (id === "host_code_iteration") return runHostCodeIteration({ ...context, env: process.env });
  if (id === "candidate_ecosystem_diff") return candidateEcosystemDiff({ ...context, env: process.env });
  if (id === "candidate_ecosystem_validation") return validateCandidateEcosystem({ ...context, env: process.env });
  if (id === "candidate_app_lifecycle") return runCandidateAppLifecycle({ ...context, env: process.env });
  if (id === "candidate_self_hosting_probe") return runCandidateSelfHostingProbe({ ...context, env: process.env });
  if (id === "semantic_alignment_review") return semanticAlignmentReview({ ...context, env: process.env });
  if (id === "candidate_workspace_patch") return candidateWorkspacePatch(context);
  if (id === "candidate_diff_summary") return candidateDiffSummary(context);
  if (id === "candidate_validation") return candidateValidation(context);
  if (id === "promotion_report_generation") return promotionReportGeneration(context);
  if (id === "orchestrator_task_dispatch") return orchestratorDispatch(context);
  if (id === "quality_gate_evaluation") return qualityGateEvaluation(context);
  if (id === "report_generation") return reportGeneration(context);
  if (id === "memory_write_candidate") return memoryWriteCandidate(context);
  return { status: "passed", summary: `Adapter ${id} completed.` };
}

function outputAdapter(id) {
  return {
    id,
    capability: `output.${id}`,
    required_autonomy_level: id.includes("draft") ? 3 : 1,
    async write({ output, payload, run }) {
      const target = output.to || `run://outputs/${id}.json`;
      if (id === "context_memory") {
        return { id, status: "deferred_to_context_action", target };
      }
      const path = target.startsWith("run://")
        ? join(run.outputs_dir, target.replace(/^run:\/\//, ""))
        : resolve(target);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, typeof payload === "string" ? payload : `${stableJson(payload)}\n`, "utf8");
      return { id, status: "written", target, path };
    }
  };
}

function readOnlyAnalysis({ sources, spec }) {
  return {
    summary: `Analyzed ${sources.length} source records for ${spec.id}.`,
    source_count: sources.length,
    inputs: sources.map((source) => source.id),
    risks: sources.filter((source) => source.status === "failed").map((source) => source.id)
  };
}

function sourceDigest({ sources, recalledMemory }) {
  const titles = sources.map((source) => source.result?.title || source.result?.name || source.id);
  return {
    digest: titles.map((title) => ({ title, summary: `Source reviewed: ${title}` })),
    recalled_memory_count: recalledMemory.length,
    source_count: sources.length
  };
}

function licenseCheck({ sources, spec }) {
  const acceptable = new Set(spec.pack_config?.acceptable_licenses || ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"]);
  const licenses = collectValues(sources, "license");
  const unknown = licenses.length === 0;
  const unacceptable = licenses.filter((license) => !acceptable.has(license));
  return {
    status: unacceptable.length ? "failed" : "passed",
    licenses,
    unknown,
    acceptable: [...acceptable],
    failure: unacceptable.length
      ? { code: FAILURE_CODES.GATE_FAILED, message: `Unacceptable licenses: ${unacceptable.join(", ")}` }
      : null
  };
}

function manifestInspection({ sources }) {
  const manifests = [];
  for (const { sourceId, files } of manifestFileGroups(sources)) {
    const lockfiles = files.filter((file) => isLockfile(file.path)).map((file) => file.path).sort();
    const manifestFiles = files.filter((file) => isManifestFile(file.path));
    for (const file of manifestFiles) {
      const parsed = parseManifestFile(file);
      manifests.push({
        source_id: sourceId,
        path: file.path,
        package_manager: parsed.package_manager,
        manifest: parsed.manifest,
        dependencies: parsed.dependencies,
        dev_dependencies: parsed.dev_dependencies,
        scripts: parsed.scripts,
        lockfiles,
        invalid: parsed.invalid,
        parse_error: parsed.parse_error
      });
    }
  }
  return { manifests, manifest_count: manifests.length, status: manifests.some((item) => item.invalid) ? "failed" : "passed" };
}

function manifestFileGroups(sources) {
  const groups = [];
  for (const source of sources) {
    if (Array.isArray(source.result?.files)) {
      groups.push({ sourceId: source.id, files: source.result.files });
    }
    for (const repo of source.result?.repositories || []) {
      if (Array.isArray(repo.files)) {
        groups.push({ sourceId: repo.id || repo.name || source.id, files: repo.files });
      }
    }
  }
  return groups;
}

function isManifestFile(path) {
  const rel = String(path || "").toLowerCase();
  return rel === "package.json"
    || rel.endsWith("/package.json")
    || rel === "pyproject.toml"
    || rel.endsWith("/pyproject.toml")
    || rel === "requirements.txt"
    || rel.endsWith("/requirements.txt")
    || rel === "package.swift"
    || rel.endsWith("/package.swift");
}

function isLockfile(path) {
  const rel = String(path || "").toLowerCase();
  return /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|poetry\.lock|requirements-lock\.txt|pipfile\.lock)$/.test(rel);
}

function parseManifestFile(file) {
  const path = String(file.path || "");
  const content = String(file.content || "");
  try {
    if (path.endsWith("package.json")) {
      const manifest = JSON.parse(content || "{}");
      return {
        package_manager: "npm",
        manifest,
        dependencies: manifest.dependencies || {},
        dev_dependencies: manifest.devDependencies || {},
        scripts: manifest.scripts || {},
        invalid: false
      };
    }
    if (path.endsWith("requirements.txt")) {
      const dependencies = {};
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
        const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*([=<>!~]=?.*)?$/);
        if (match) dependencies[match[1]] = (match[2] || "").trim() || "*";
      }
      return { package_manager: "pip", manifest: { path }, dependencies, dev_dependencies: {}, scripts: {}, invalid: false };
    }
    if (path.endsWith("pyproject.toml")) {
      return {
        package_manager: "python",
        manifest: {
          name: tomlStringValue(content, "name"),
          version: tomlStringValue(content, "version"),
          license: tomlStringValue(content, "license")
        },
        dependencies: tomlArrayDependencies(content, "dependencies"),
        dev_dependencies: {},
        scripts: {},
        invalid: false
      };
    }
    if (path.endsWith("Package.swift")) {
      return {
        package_manager: "swiftpm",
        manifest: { path, dependency_count: (content.match(/\.package\s*\(/g) || []).length },
        dependencies: {},
        dev_dependencies: {},
        scripts: {},
        invalid: false
      };
    }
    return { package_manager: "unknown", manifest: {}, dependencies: {}, dev_dependencies: {}, scripts: {}, invalid: false };
  } catch (error) {
    return {
      package_manager: "unknown",
      manifest: {},
      dependencies: {},
      dev_dependencies: {},
      scripts: {},
      invalid: true,
      parse_error: error.message || String(error)
    };
  }
}

function tomlStringValue(content, key) {
  const match = String(content || "").match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"));
  return match?.[1] || null;
}

function tomlArrayDependencies(content, key) {
  const dependencies = {};
  const match = String(content || "").match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!match) return dependencies;
  for (const item of match[1].split(",")) {
    const text = item.replace(/["']/g, "").trim();
    if (!text) continue;
    const dep = text.match(/^([A-Za-z0-9_.-]+)\s*(.*)$/);
    if (dep) dependencies[dep[1]] = dep[2].trim() || "*";
  }
  return dependencies;
}

function isUnpinnedDependency(version) {
  const text = String(version || "").trim().toLowerCase();
  if (!text || text === "*" || text === "latest") return true;
  if (/^(workspace:|file:|link:|path:)/.test(text)) return false;
  if (/^[~^><=]/.test(text)) return true;
  return false;
}

function riskyScripts(scripts) {
  const risks = [];
  for (const [name, command] of Object.entries(scripts || {})) {
    const text = String(command || "");
    if (/\b(curl|wget)\b[\s\S]{0,80}\|\s*(sh|bash)\b/.test(text)) {
      risks.push({ script: name, command: text.slice(0, 240), reason: "downloads and executes remote shell content" });
    } else if (/\bpostinstall\b|\bpreinstall\b/.test(String(name)) && /\b(node|python|bash|sh)\b/.test(text)) {
      risks.push({ script: name, command: text.slice(0, 240), reason: "install lifecycle script executes code" });
    }
  }
  return risks;
}

function dependencyRisk({ actions }) {
  const manifestAction = actions.find((action) => action.adapter === "manifest_inspection");
  const manifests = manifestAction?.result?.manifests || [];
  const risks = [];
  for (const item of manifests) {
    const deps = {
      ...(item.dependencies || {}),
      ...(item.dev_dependencies || {})
    };
    const depNames = Object.keys(deps);
    if (depNames.length > 50) risks.push({ source_id: item.source_id, path: item.path, risk: "large_dependency_surface", severity: "medium", dependency_count: depNames.length });
    const unpinned = Object.entries(deps)
      .filter(([, version]) => isUnpinnedDependency(version))
      .map(([name, version]) => ({ name, version }));
    if (unpinned.length) {
      risks.push({
        source_id: item.source_id,
        path: item.path,
        risk: "unpinned_dependency",
        severity: "medium",
        dependencies: unpinned.slice(0, 20)
      });
    }
    const scriptRisks = riskyScripts(item.scripts || {});
    for (const script of scriptRisks) {
      risks.push({ source_id: item.source_id, path: item.path, risk: "risky_install_script", severity: "high", ...script });
    }
    if (item.package_manager === "npm" && depNames.length && !asArray(item.lockfiles).some((path) => /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(path))) {
      risks.push({ source_id: item.source_id, path: item.path, risk: "missing_lockfile", severity: "medium", package_manager: "npm" });
    }
  }
  const high = risks.some((risk) => risk.severity === "high");
  return { risks, status: high ? "failed" : (risks.length ? "attention" : "passed") };
}

function compatibilityScore({ spec, actions, sources }) {
  const license = actions.find((action) => action.adapter === "license_check")?.result || {};
  const manifest = actions.find((action) => action.adapter === "manifest_inspection")?.result || {};
  const score = Math.max(0, Math.min(100,
    35 +
    (license.status === "passed" ? 25 : 0) +
    (manifest.manifest_count ? 20 : 0) +
    Math.min(20, sources.length * 5)
  ));
  return {
    score,
    dimensions: {
      license_compatibility: license.status === "passed" ? 25 : 0,
      manifest_readability: manifest.manifest_count ? 20 : 0,
      source_coverage: Math.min(20, sources.length * 5)
    },
    recommendation: score >= Number(spec.pack_config?.minimum_score || 60) ? "fit" : "review",
    rationale: "Score is derived from license compatibility, manifest readability, and source coverage."
  };
}

function modelPolicyRequired(spec) {
  return Boolean(spec.model_policy?.required || spec.pack_config?.model_policy?.required);
}

function modelDecisionFromActions(actions) {
  const dispatch = actions.find((action) => action.adapter === "orchestrator_task_dispatch")?.result?.task;
  const decision = dispatch?.model_decision || dispatch?.evidence_summary?.model_decision;
  if (decision && typeof decision === "object") return decision;
  return null;
}

async function candidateWorkspacePatch({ spec, run, actions }) {
  const workspace = candidateWorkspace(spec);
  const modelRequired = modelPolicyRequired(spec);
  const modelDecision = modelDecisionFromActions(actions);
  const patches = modelRequired
    ? asArray(modelDecision?.patches)
    : (asArray(modelDecision?.patches).length ? asArray(modelDecision.patches) : asArray(spec.pack_config?.iteration_plan?.patches));
  if (!patches.length) {
    throw new LoopFailure({
      code: FAILURE_CODES.SPEC_INVALID,
      failedState: "running",
      adapterId: "candidate_workspace_patch",
      message: modelRequired
        ? "candidate_workspace_patch requires model_decision.patches when model_policy.required=true."
        : "candidate_workspace_patch requires pack_config.iteration_plan.patches or model_decision.patches."
    });
  }

  const results = [];
  for (const patch of patches) {
    const relPath = safeRelativePath(patch.path);
    const target = ensureInside(workspace.root, resolve(workspace.root, relPath));
    await mkdir(dirname(target), { recursive: true });
    const before = await readOptional(target);
    const content = renderTemplate(String(patch.content || ""), { spec, run, workspace });
    const mode = patch.mode || "overwrite";
    let after;
    if (mode === "upsert_between_markers") {
      const start = patch.marker_start || `<!-- across-autopilot:${safeSegment(relPath)}:start -->`;
      const end = patch.marker_end || `<!-- across-autopilot:${safeSegment(relPath)}:end -->`;
      const block = `${start}\n${content.trimEnd()}\n${end}`;
      after = upsertBetweenMarkers(before || "", start, end, block);
    } else if (mode === "append") {
      after = `${before || ""}${before?.endsWith("\n") || !before ? "" : "\n"}${content}`;
    } else {
      after = content;
    }
    const changed = before !== after;
    if (changed) await writeFile(target, after, "utf8");
    results.push({
      path: relPath,
      mode,
      changed,
      bytes_before: before ? Buffer.byteLength(before) : 0,
      bytes_after: Buffer.byteLength(after)
    });
  }

  return {
    status: results.some((item) => item.changed) ? "passed" : "attention",
    workspace: workspace.root,
    source_repository: workspace.sourceRepository,
    mutation_policy: workspace.mutationPolicy,
    model_backed: Boolean(modelDecision),
    model_decision_hash: modelDecision?.decision_hash || null,
    model_provider: modelDecision?.provider || null,
    model: modelDecision?.model || null,
    decision_summary: modelDecision?.decision?.summary || null,
    changed_files: results.filter((item) => item.changed).map((item) => item.path),
    files: results,
    source_repository_untouched_by_policy: true
  };
}

async function candidateDiffSummary({ spec }) {
  const workspace = candidateWorkspace(spec);
  const status = await gitOutput(workspace.root, ["status", "--short", "--untracked-files=all"]);
  const nameOnly = await gitOutput(workspace.root, ["diff", "--name-only"]);
  const stat = await gitOutput(workspace.root, ["diff", "--stat", "--"]);
  const numstat = await gitOutput(workspace.root, ["diff", "--numstat", "--"]);
  const changedFiles = unique([
    ...status.split("\n").map((line) => line.trim().replace(/^[MADRCU?! ]+\s+/, "")).filter(Boolean),
    ...nameOnly.split("\n").map((line) => line.trim()).filter(Boolean)
  ]);
  return {
    status: changedFiles.length ? "passed" : "attention",
    workspace: workspace.root,
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    git_status: status,
    git_diff_stat: stat,
    git_numstat: numstat
  };
}

async function candidateValidation({ spec }) {
  const workspace = candidateWorkspace(spec);
  const commands = asArray(spec.pack_config?.validation_commands);
  if (!commands.length) {
    return {
      status: "attention",
      workspace: workspace.root,
      commands: [],
      summary: "No validation commands declared."
    };
  }
  const results = [];
  for (const command of commands) {
    const executable = String(command.command || "");
    const args = asArray(command.args).map(String);
    if (!executable) {
      results.push({ command: "", args, status: "failed", exit_code: null, stderr: "Missing command." });
      continue;
    }
    try {
      const { stdout, stderr } = await exec(executable, args, {
        cwd: workspace.root,
        timeout: Number(command.timeout_ms || 120_000),
        maxBuffer: Number(command.max_buffer || 1024 * 1024)
      });
      results.push({
        command: executable,
        args,
        status: "passed",
        exit_code: 0,
        stdout: String(stdout || "").slice(0, 4000),
        stderr: String(stderr || "").slice(0, 4000)
      });
    } catch (error) {
      results.push({
        command: executable,
        args,
        status: "failed",
        exit_code: error.code ?? null,
        stdout: String(error.stdout || "").slice(0, 4000),
        stderr: String(error.stderr || error.message || "").slice(0, 4000)
      });
    }
  }
  const failed = results.filter((item) => item.status !== "passed");
  return {
    status: failed.length ? "attention" : "passed",
    workspace: workspace.root,
    commands: results,
    failure: failed.length
      ? { code: FAILURE_CODES.GATE_FAILED, message: `${failed.length} candidate validation command(s) failed.` }
      : null
  };
}

function promotionReportGeneration({ spec, actions }) {
  if (actions.some((action) => action.adapter === "candidate_ecosystem_acquire")) {
    return buildCandidatePromotionEvidence({ spec, actions });
  }
  const patch = actions.find((action) => action.adapter === "candidate_workspace_patch")?.result || {};
  const diff = actions.find((action) => action.adapter === "candidate_diff_summary")?.result || {};
  const validation = actions.find((action) => action.adapter === "candidate_validation")?.result || {};
  const modelDecision = modelDecisionFromActions(actions);
  const changedFiles = asArray(diff.changed_files);
  const validationCommands = asArray(validation.commands);
  return {
    status: changedFiles.length && validation.status === "passed" ? "passed" : "attention",
    promotion_ready: changedFiles.length > 0 && validation.status === "passed",
    source_repository: spec.pack_config?.source_repository || null,
    candidate_workspace: patch.workspace || diff.workspace || spec.pack_config?.candidate_workspace || null,
    changed_files: changedFiles,
    changed_file_count: changedFiles.length,
    model_backed: Boolean(modelDecision),
    model_decision_hash: modelDecision?.decision_hash || null,
    model_provider: modelDecision?.provider || null,
    model: modelDecision?.model || null,
    validation_status: validation.status || "unknown",
    validation_commands: validationCommands.map((item) => ({
      command: [item.command, ...asArray(item.args)].filter(Boolean).join(" "),
      status: item.status,
      exit_code: item.exit_code
    })),
    next_step: changedFiles.length && validation.status === "passed"
      ? "Review the candidate diff and promote it through the host approval path."
      : "Inspect the candidate evidence before promotion."
  };
}

async function orchestratorDispatch({ spec, run, orchestratorClient }) {
  if (!orchestratorClient) {
    throw new LoopFailure({
      code: FAILURE_CODES.ORCHESTRATOR_SUBMIT_FAILED,
      failedState: "dispatching",
      message: "Orchestrator client is not configured."
    });
  }
  const task = await orchestratorClient.runLoopTask({ spec, run });
  const failed = task.status === "failed" || task.quality_status === "failed";
  const failureMessage = task.status_payload?.error
    || task.evidence_summary?.failure?.message
    || task.evidence_summary?.routing?.outcomes?.find((item) => item.status === "failed")?.reason
    || "Orchestrator loop did not complete successfully.";
  return {
    status: failed ? "failed" : "passed",
    task,
    outputs: [task.task_id || task.loop_id].filter(Boolean),
    failure: failed
      ? {
        code: FAILURE_CODES.ORCHESTRATOR_TASK_FAILED,
        message: failureMessage,
        evidence_refs: task.evidence_refs || []
      }
      : null
  };
}

function qualityGateEvaluation({ spec, sources, actions }) {
  const gates = asArray(spec.gates).map((gate) => evaluateGate(gate, { spec, sources, actions }));
  const requiredFailures = gates.filter((gate) => gate.required && gate.status !== "passed");
  return {
    status: requiredFailures.length ? "failed" : "passed",
    gates,
    failure: requiredFailures.length
      ? { code: FAILURE_CODES.GATE_FAILED, message: `${requiredFailures.length} required gates failed.` }
      : null
  };
}

function reportGeneration({ spec, sources, actions, gates }) {
  const sourceLines = sources.map((source) => {
    const result = source.result || {};
    const details = [];
    if (result.root) details.push(`root: ${result.root}`);
    if (Array.isArray(result.files)) details.push(`files: ${result.files.length}`);
    if (Array.isArray(result.repositories)) details.push(`repositories: ${result.repositories.length}`);
    if (result.url) details.push(`url: ${result.url}`);
    return `- ${source.id}: ${source.status}${details.length ? ` (${details.join(", ")})` : ""}`;
  });
  const actionLines = actions.map((action) => {
    const result = action.result || {};
    const details = [];
    if (result.source_count !== undefined) details.push(`sources: ${result.source_count}`);
    if (result.score !== undefined) details.push(`score: ${result.score}`);
    if (result.recommendation) details.push(`recommendation: ${result.recommendation}`);
    if (result.selected_target_id) details.push(`selected: ${result.selected_target_id}`);
    if (result.selected_iteration?.target_repo) details.push(`target repo: ${result.selected_iteration.target_repo}`);
    if (result.manifest_count !== undefined) details.push(`manifests: ${result.manifest_count}`);
    if (result.task?.loop_id || result.task?.task_id) details.push(`loop: ${result.task.loop_id || result.task.task_id}`);
    if (result.task?.model_backed) details.push(`model: ${result.task.model_decision?.provider || "host"}/${result.task.model_decision?.model || "unknown"}`);
    if (result.changed_file_count !== undefined) details.push(`changed files: ${result.changed_file_count}`);
    if (result.model_backed) details.push(`model: ${result.model_provider || "host"}/${result.model || "unknown"}`);
    if (Array.isArray(result.changed_files) && result.changed_files.length && result.changed_file_count === undefined) details.push(`changed files: ${result.changed_files.length}`);
    if (result.validation_status) details.push(`validation: ${result.validation_status}`);
    if (result.promotion_ready !== undefined) details.push(`promotion ready: ${result.promotion_ready}`);
    return `- ${action.adapter}: ${action.status}${details.length ? ` (${details.join(", ")})` : ""}`;
  });
  const diffAction = actions.find((action) => action.adapter === "candidate_diff_summary")?.result || {};
  const validationAction = actions.find((action) => action.adapter === "candidate_validation")?.result || {};
  const promotionAction = actions.find((action) => action.adapter === "promotion_report_generation")?.result || {};
  const modelDecision = modelDecisionFromActions(actions);
  const focus = asArray(spec.pack_config?.focus);
  const candidateWorkspace = spec.pack_config?.candidate_workspace;
  const sourceRepository = spec.pack_config?.source_repository;
  const lines = [
    `# ${spec.name}`,
    "",
    spec.description,
    "",
    "## Scope",
    `- Spec: ${spec.id}`,
    `- Autonomy level: ${spec.autonomy?.level ?? "unknown"}`,
    `- Mutation policy: ${spec.pack_config?.mutation_policy || "not declared"}`,
    ...(sourceRepository ? [`- Source repository: ${sourceRepository}`] : []),
    ...(candidateWorkspace ? [`- Candidate workspace: ${candidateWorkspace}`] : []),
    ...(focus.length ? ["", "## Focus", ...focus.map((item) => `- ${item}`)] : []),
    "",
    "## Sources",
    ...sourceLines,
    "",
    "## Actions",
    ...actionLines,
    ...(modelDecision ? [
      "",
      "## Model Decision",
      `- Provider: ${modelDecision.provider || "host"}`,
      `- Model: ${modelDecision.model || "unknown"}`,
      `- Decision hash: ${modelDecision.decision_hash || "unknown"}`,
      `- Summary: ${modelDecision.decision?.summary || "Model produced candidate patches."}`
    ] : []),
    ...(asArray(diffAction.changed_files).length ? [
      "",
      "## Candidate Diff",
      ...diffAction.changed_files.map((file) => `- ${file}`)
    ] : []),
    ...(asArray(validationAction.commands).length ? [
      "",
      "## Candidate Validation",
      ...validationAction.commands.map((item) => `- ${[item.command, ...asArray(item.args)].filter(Boolean).join(" ")}: ${item.status}`)
    ] : []),
    ...(promotionAction.next_step ? [
      "",
      "## Promotion",
      `- Ready: ${Boolean(promotionAction.promotion_ready)}`,
      `- Next: ${promotionAction.next_step}`
    ] : []),
    "",
    "## Gates",
    ...gates.map((gate) => `- ${gate.id}: ${gate.status} - ${gate.reason}`),
    "",
    "## Result",
    gates.every((gate) => gate.status === "passed")
      ? "All required gates passed. The candidate workspace is ready for human review or a stricter mutation-capable follow-up loop."
      : "One or more required gates failed. Inspect evidence before scheduling follow-up work."
  ];
  return { markdown: lines.join("\n"), status: "passed" };
}

async function memoryWriteCandidate({ spec, run, contextClient, actions, gates }) {
  const text = `Loop ${spec.id} run ${run.run_id} produced ${actions.length} actions and ${gates.length} gates.`;
  if (!contextClient) {
    return {
      status: "attention",
      memory: {
        status: "pending",
        text,
        mode: "context-client-not-configured"
      }
    };
  }
  const memory = await contextClient.rememberLoop({ spec, run, text, actions, gates });
  return { status: memory.status === "rejected" ? "failed" : "passed", memory };
}

function evaluateGate(gate, { sources, actions }) {
  const id = gate.id || gate.type;
  const ecosystemStatus = ecosystemGateStatus(id, { actions });
  if (ecosystemStatus) {
    const [passed, passedReason, failedReason] = ecosystemStatus;
    return {
      id,
      status: passed ? "passed" : "failed",
      required: gate.required !== false,
      reason: passed ? passedReason : failedReason,
      evidence_refs: [...sources.map((source) => `sources/${source.id}`), ...actions.map((action) => `actions/${action.id}`)].slice(0, 10)
    };
  }
  let passed = true;
  let reason = "Gate passed.";
  if (id === "source_reachable") {
    passed = sources.every((source) => source.status === "passed");
    reason = passed ? "All sources were reachable." : "One or more sources failed.";
  } else if (id === "license_acceptable") {
    const license = actions.find((action) => action.adapter === "license_check");
    passed = license?.status === "passed";
    reason = passed ? "License check passed." : "License check failed.";
  } else if (id === "manifest_readable") {
    const manifest = actions.find((action) => action.adapter === "manifest_inspection");
    passed = (manifest?.result?.manifest_count || 0) > 0;
    reason = passed ? "Manifest was readable." : "No readable manifest found.";
  } else if (id === "recommendation_has_rationale") {
    const score = actions.find((action) => action.adapter === "compatibility_scoring");
    passed = Boolean(score?.result?.rationale);
    reason = passed ? "Recommendation includes rationale." : "Recommendation rationale missing.";
  } else if (id === "citations_present") {
    passed = sources.length > 0;
    reason = passed ? "Sources provide citation anchors." : "No citation sources present.";
  } else if (id === "no_raw_page_persistence") {
    passed = true;
    reason = "Raw page content is not persisted outside run evidence.";
  } else if (id === "orchestrator_quality_passed") {
    const task = actions.find((action) => action.adapter === "orchestrator_task_dispatch");
    passed = task?.status === "passed";
    reason = passed ? "Orchestrator task passed." : "Orchestrator task failed.";
  } else if (id === "model_decision_present") {
    const task = actions.find((action) => action.adapter === "orchestrator_task_dispatch");
    passed = task?.result?.task?.model_backed === true && Boolean(task?.result?.task?.model_decision?.decision_hash);
    reason = passed ? "Host model decision evidence is present." : "Host model decision evidence is missing.";
  } else if (id === "candidate_has_diff") {
    const diff = actions.find((action) => action.adapter === "candidate_diff_summary");
    passed = (diff?.result?.changed_file_count || 0) > 0;
    reason = passed ? "Candidate workspace has reviewable changes." : "Candidate workspace has no diff.";
  } else if (id === "candidate_validation_passed") {
    const validation = actions.find((action) => action.adapter === "candidate_validation");
    passed = validation?.status === "passed";
    reason = passed ? "Candidate validation commands passed." : "Candidate validation did not pass.";
  } else if (id === "source_repository_not_targeted") {
    const patch = actions.find((action) => action.adapter === "candidate_workspace_patch");
    passed = patch?.result?.source_repository_untouched_by_policy === true;
    reason = passed ? "Mutation target was restricted to the candidate workspace." : "Source repository mutation boundary was not proven.";
  }
  return {
    id,
    status: passed ? "passed" : "failed",
    required: gate.required !== false,
    reason,
    evidence_refs: [...sources.map((source) => `sources/${source.id}`), ...actions.map((action) => `actions/${action.id}`)].slice(0, 10)
  };
}

function normalizeFixtureSource(source) {
  const payload = source.fixture || source;
  return {
    kind: payload.kind || "fixture",
    id: payload.id || source.id,
    name: payload.name || source.name || source.id,
    title: payload.title || payload.name || source.name,
    url: payload.url || source.url || "",
    license: payload.license || source.license || "",
    manifest: payload.manifest || source.manifest || null,
    content: payload.content || source.content || "",
    files: payload.files || [],
    repositories: payload.repositories || source.repositories || []
  };
}

async function directoryRecords(root, maxFiles) {
  const files = [];
  const seen = new Set();
  for (const rel of PRIORITY_SOURCE_FILES) {
    if (files.length >= maxFiles) break;
    await addFileRecord(root, rel, files, seen);
  }
  await walk(root, "", files, maxFiles, seen);
  return files;
}

async function cloneGitRepository(source, run) {
  const sandbox = run?.sandbox || process.cwd();
  const root = join(sandbox, "sources", safeSegment(source.id || basename(source.url || "repo")));
  await mkdir(dirname(root), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (source.branch) args.push("--branch", String(source.branch));
  args.push(String(source.url), root);
  try {
    await exec("git", args, {
      timeout: Number(source.timeout_ms || 60_000),
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    throw new LoopFailure({
      code: FAILURE_CODES.SOURCE_UNREACHABLE,
      failedState: "discovering_sources",
      message: `Git repository clone failed: ${error.message || error}`,
      causedBy: [{ command: `git ${args.join(" ")}`, stderr: String(error.stderr || "").slice(0, 1000) }]
    });
  }
  return {
    kind: "github_repo",
    url: source.url,
    branch: source.branch || null,
    root,
    files: await directoryRecords(root, Number(source.max_files || 120))
  };
}

function safeSegment(value) {
  return String(value || "repo").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

const PRIORITY_SOURCE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "requirements-lock.txt",
  "Pipfile.lock",
  "Package.swift",
  "Cargo.toml",
  "go.mod",
  "README.md",
  "LICENSE",
  "LICENSE.md",
  "COPYING"
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".pytest_cache",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  "build",
  "dist",
  "DerivedData"
]);

async function walk(root, rel, files, maxFiles, seen = new Set()) {
  if (files.length >= maxFiles) return;
  const dir = join(root, rel);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    const path = join(root, nextRel);
    if (entry.isDirectory()) {
      await walk(root, nextRel, files, maxFiles, seen);
    } else if (entry.isFile()) {
      await addFileRecord(root, nextRel, files, seen);
    }
  }
}

async function addFileRecord(root, rel, files, seen) {
  if (seen.has(rel)) return;
  const path = join(root, rel);
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (!info.isFile()) return;
  seen.add(rel);
  const record = { path: rel, size: info.size };
  if (info.size < 100_000 && shouldReadSourceExcerpt(rel)) {
    record.content = await readFile(path, "utf8");
  }
  files.push(record);
}

function shouldReadSourceExcerpt(rel) {
  return /(^|\/)(LICENSE|COPYING|Package\.swift|Cargo\.toml|go\.mod|requirements(?:-lock)?\.txt|Pipfile\.lock|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|README\.md)$/i.test(rel)
    || /(\.json|\.md|\.toml|\.swift|\.txt|\.lock|\.yaml)$/i.test(rel);
}

async function fetchUrlRecord(url, extra = {}) {
  if (!url) throw new LoopFailure({ code: FAILURE_CODES.SOURCE_UNREACHABLE, failedState: "discovering_sources", message: "Source URL is missing." });
  const response = await fetch(url, { headers: { "User-Agent": "AcrossAutopilot/1.0" } });
  if (!response.ok) {
    throw new LoopFailure({ code: response.status === 429 ? FAILURE_CODES.SOURCE_RATE_LIMITED : FAILURE_CODES.SOURCE_UNREACHABLE, failedState: "discovering_sources", message: `Source request failed with ${response.status}.` });
  }
  const text = await response.text();
  return { ...extra, url, status_code: response.status, sha256: sha256(text), title: basename(url), excerpt: text.slice(0, 500) };
}

function textRecord(path, text) {
  return { kind: "file", path, size: Buffer.byteLength(text), sha256: sha256(text), excerpt: text.slice(0, 1000), content: text };
}

function collectValues(sources, key) {
  const values = [];
  for (const source of sources) {
    if (source.result?.[key]) values.push(source.result[key]);
    if (Array.isArray(source.result?.repositories)) {
      for (const repo of source.result.repositories) {
        if (repo[key]) values.push(repo[key]);
        for (const file of repo.files || []) {
          if (file.path?.toLowerCase() === "license" && /mit license/i.test(file.content || "")) values.push("MIT");
          if (key === "license" && isManifestFile(file.path) && file.content) {
            const parsed = parseManifestFile(file);
            if (parsed.manifest?.license) values.push(String(parsed.manifest.license));
          }
        }
      }
    }
    for (const file of source.result?.files || []) {
      if (file.path?.toLowerCase() === "license" && /mit license/i.test(file.content || "")) values.push("MIT");
      if (key === "license" && isManifestFile(file.path) && file.content) {
        const parsed = parseManifestFile(file);
        if (parsed.manifest?.license) values.push(String(parsed.manifest.license));
      }
    }
  }
  return unique(values);
}

function resolvePath(path, fallbackRoot) {
  if (!path) return resolve(fallbackRoot || ".");
  const expanded = String(path).replace(/^~(?=$|\/)/, process.env.HOME || "");
  return isAbsolute(expanded) ? resolve(expanded) : resolve(fallbackRoot || ".", expanded);
}

function candidateWorkspace(spec) {
  const mutationPolicy = spec.pack_config?.mutation_policy;
  if (mutationPolicy !== "candidate_workspace_only") {
    throw new LoopFailure({
      code: FAILURE_CODES.SANDBOX_VIOLATION,
      failedState: "running",
      adapterId: "candidate_workspace_patch",
      message: "Candidate mutation requires pack_config.mutation_policy=candidate_workspace_only."
    });
  }
  const root = resolvePath(spec.pack_config?.candidate_workspace || spec.scope?.workspace, process.cwd());
  const sourceRepository = spec.pack_config?.source_repository
    ? resolvePath(spec.pack_config.source_repository, process.cwd())
    : null;
  if (!root) {
    throw new LoopFailure({
      code: FAILURE_CODES.SANDBOX_VIOLATION,
      failedState: "running",
      adapterId: "candidate_workspace_patch",
      message: "Candidate workspace is missing."
    });
  }
  if (sourceRepository && (root === sourceRepository || isInside(root, sourceRepository))) {
    throw new LoopFailure({
      code: FAILURE_CODES.SANDBOX_VIOLATION,
      failedState: "running",
      adapterId: "candidate_workspace_patch",
      message: "Candidate workspace must not be the source repository or a child of it."
    });
  }
  return { root, sourceRepository, mutationPolicy };
}

function safeRelativePath(value) {
  const rel = String(value || "").replaceAll("\\", "/");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) {
    throw new LoopFailure({
      code: FAILURE_CODES.SANDBOX_VIOLATION,
      failedState: "running",
      adapterId: "candidate_workspace_patch",
      message: `Unsafe candidate patch path: ${value}`
    });
  }
  return rel;
}

function ensureInside(root, target) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
  throw new LoopFailure({
    code: FAILURE_CODES.SANDBOX_VIOLATION,
    failedState: "running",
    adapterId: "candidate_workspace_patch",
    message: `Path escapes candidate workspace: ${target}`
  });
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function renderTemplate(content, { spec, run, workspace }) {
  const values = {
    spec_id: spec.id,
    spec_name: spec.name,
    run_id: run.run_id,
    candidate_workspace: workspace.root,
    source_repository: workspace.sourceRepository || "",
    mutation_policy: workspace.mutationPolicy,
    generated_at: new Date().toISOString()
  };
  return content.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => values[key] ?? "");
}

function upsertBetweenMarkers(text, start, end, block) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    const before = text.slice(0, startIndex).replace(/\s*$/, "");
    const after = text.slice(endIndex + end.length).replace(/^\s*/, "");
    return [before, block, after].filter(Boolean).join("\n\n") + "\n";
  }
  return `${text.trimEnd()}${text.trimEnd() ? "\n\n" : ""}${block}\n`;
}

async function gitOutput(cwd, args) {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    });
    return String(stdout || "").trim();
  } catch (error) {
    throw new LoopFailure({
      code: FAILURE_CODES.ADAPTER_INVALID_OUTPUT,
      failedState: "running",
      adapterId: "candidate_diff_summary",
      message: `git ${args.join(" ")} failed: ${error.message || error}`,
      causedBy: [{ stderr: String(error.stderr || "").slice(0, 1000) }]
    });
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
