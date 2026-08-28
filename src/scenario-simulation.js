#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCENARIO_INPUT_SCHEMA = "across-scenario-simulation-input/1.0";
export const SCENARIO_RESULT_SCHEMA = "across-scenario-simulation-result/1.0";
export const SCENARIO_RUNTIME_VERSION = "1.1.5";

export function planScenarioInputFromGoal(goal, { liveModel = true, rounds = null } = {}) {
  const objective = safeText(goal, 1000);
  if (!objective) throw new Error("scenario planning requires a user goal");
  const plannedRounds = rounds == null ? inferredRounds(objective) : boundedInteger(rounds, 1, 24, "rounds");
  const labels = inferredParticipantLabels(objective);
  const roles = labels.map((label, index) => {
    const id = `subject-${index + 1}`;
    return {
      id,
      label,
      initial_score: 0,
      volatility: 1,
      cooperation_weight: 0.5,
      relationships: Object.fromEntries(labels.map((_other, otherIndex) => [`subject-${otherIndex + 1}`, 0.35]).filter(([otherId]) => otherId !== id))
    };
  });
  const mode = liveModel ? "live-model" : "no-key";
  return normalizeScenarioInput({
    title: safeText(objective, 120),
    objective,
    roles,
    rounds: plannedRounds,
    seed: 1,
    mode,
    assumptions: [
      "The simulated subjects are fictional or abstract representations.",
      "The simulation is bounded to the time horizon stated in the user task."
    ],
    input_sources: ["user-authored-task"],
    model_policy: {
      enabled: liveModel,
      policy: liveModel ? "host-default" : "none",
      max_calls: liveModel ? plannedRounds : 0,
      max_tokens: liveModel ? plannedRounds * 4_000 : 0,
      max_concurrency: liveModel ? 1 : 0,
      max_cost_usd: liveModel ? 1 : 0,
      timeout_seconds: liveModel ? 120 : 0
    }
  });
}

export function normalizeScenarioInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scenario input must be an object");
  const roles = Array.isArray(value.roles) ? value.roles.map(normalizeRole) : [];
  if (roles.length < 2 || roles.length > 64) throw new Error("scenario requires between 2 and 64 roles");
  const rounds = boundedInteger(value.rounds ?? 12, 1, 10_000, "rounds");
  const seed = boundedInteger(value.seed ?? 1, 1, 2_147_483_647, "seed");
  const mode = value.mode === "live-model" ? "live-model" : "no-key";
  const modelPolicy = normalizeModelPolicy(value.model_policy, mode);
  return {
    schema_version: SCENARIO_INPUT_SCHEMA,
    title: safeText(value.title, 120) || "Scenario Simulation",
    objective: safeText(value.objective, 1000) || "Compare bounded role outcomes under explicit assumptions.",
    roles,
    rounds,
    seed,
    mode,
    assumptions: uniqueStrings(value.assumptions, 32, 300),
    input_sources: uniqueStrings(value.input_sources, 64, 300),
    model_policy: modelPolicy,
    uncertainty_notice: "This is a bounded scenario simulation, not a prediction of the real world."
  };
}

export function buildScenarioJobManifest({ runId, jobId = null, projectId = "scenario-simulation", input, nodePolicy = {} }) {
  const normalized = normalizeScenarioInput(input);
  const stableJobId = jobId || `job-${randomUUID()}`;
  const outputNames = ["job-manifest.json", "result.json", "report.md", "evidence.json", "artifact-manifest.json", "model-usage.json"];
  const manifest = {
    schema_version: "across-job-manifest/1.0",
    job_id: stableJobId,
    run_id: runId,
    project_id: projectId,
    workflow_id: "scenario-simulation",
    created_by: "across-autopilot",
    created_at: Date.now() / 1000,
    idempotency_key: `${runId}:${stableJobId}`,
    required_capabilities: {
      executor: nodePolicy.executor || "bounded-process",
      os: nodePolicy.os || null,
      architecture: nodePolicy.architecture || null,
      workflow_runtimes: ["scenario-simulation/1.0"],
      agents: []
    },
    preferred_labels: Array.isArray(nodePolicy.preferred_labels) ? nodePolicy.preferred_labels : [],
    input_artifacts: [{ logical_name: "input.json", sha256: hashJson(normalized), sensitivity: "internal", read_only: true }],
    executor: nodePolicy.executor || "bounded-process",
    command_argv: ["across-scenario-simulation", "run"],
    permissions: {
      filesystem: { mode: "run-scoped", inputs: ["input.json"], outputs: outputNames },
      network: normalized.mode === "live-model" ? { mode: "allowlist", purposes: ["aaa-model-gateway"] } : { mode: "none" },
      model: normalized.mode === "live-model" ? { mode: "grant-required", policy: normalized.model_policy.policy } : { mode: "none" },
      tools: ["scenario-simulation-runtime"]
    },
    budgets: {
      timeout_seconds: Math.min(3600, Math.max(
        30,
        normalized.rounds * 2,
        normalized.mode === "live-model"
          ? normalized.model_policy.timeout_seconds * Math.max(1, normalized.model_policy.max_calls) + 30
          : 0
      )),
      cpu_seconds: Math.min(1800, Math.max(10, normalized.rounds)),
      memory_bytes: 256 * 1024 * 1024,
      disk_bytes: 512 * 1024 * 1024,
      max_output_bytes: 16 * 1024 * 1024,
      max_artifact_bytes: 64 * 1024 * 1024,
      model: normalized.model_policy
    },
    retry_policy: { max_attempts: 2, retry_safe: true, external_side_effects: false },
    cancellation_policy: { kill_process_tree: true, cleanup_on_cancel: true },
    cleanup_policy: { retention_seconds: 0, dry_run_required: true },
    model_policy: normalized.model_policy,
    expected_outputs: outputNames,
    quality_gates: ["required_artifacts_present", "artifact_hashes_match", "scenario_disclaimer_present", "evidence_complete"],
    evidence_requirements: ["node", "executor", "transport", "model_usage", "resource_usage", "cleanup_status"]
  };
  manifest.manifest_hash = hashJson(manifest);
  return { manifest, input: normalized };
}

function inferredRounds(goal) {
  const match = String(goal).match(/(?:^|\D)(\d{1,2})\s*(?:轮|rounds?\b)/i);
  return match ? boundedInteger(Number(match[1]), 1, 24, "rounds") : 6;
}

function inferredParticipantLabels(goal) {
  const text = String(goal || "");
  const quoted = [];
  for (const match of text.matchAll(/[“"]([^”"]{1,40})[”"]/g)) {
    const label = safeText(match[1], 80);
    if (label && !quoted.includes(label)) quoted.push(label);
  }
  const countMatch = text.match(/(?:^|\D)(\d{1,2})\s*(?:个|名)?\s*(?:人|角色|主体|参与者)/);
  const chineseCountMatch = text.match(/(?:^|[^一二两三四五六七八九十])([一二两三四五六七八九十])\s*(?:个|名)?\s*(?:人|角色|主体|参与者)/);
  const requestedCount = countMatch
    ? Math.max(2, Math.min(64, Number(countMatch[1])))
    : chineseCountMatch
      ? chineseNumeral(chineseCountMatch[1])
      : Math.max(2, quoted.length);
  const chinese = /[\u3400-\u9fff]/.test(text);
  const labels = quoted.slice(0, requestedCount);
  while (labels.length < requestedCount) {
    labels.push(chinese ? `参与者 ${labels.length + 1}` : `Participant ${labels.length + 1}`);
  }
  return labels;
}

function chineseNumeral(value) {
  const values = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Math.max(2, Math.min(64, values[value] || 2));
}

export async function runScenarioSimulation(input, { modelCall = null, signal = null, onRound = null, runId = `run-${randomUUID()}`, jobId = `job-${randomUUID()}` } = {}) {
  const normalized = normalizeScenarioInput(input);
  const startedAt = new Date();
  const random = xorshift(normalized.seed);
  const roleState = new Map(normalized.roles.map((role) => [role.id, { score: role.initial_score, events: 0 }]));
  const timeline = [];
  const modelUsage = { schema_version: "across-model-usage/1.0", mode: normalized.mode, policy: normalized.model_policy.policy, calls: 0, failed_calls: 0, fallback_rounds: [], degraded: false, provider_attempts: 0, providers_attempted: [], input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: null, model: null, prompts_stored: false, responses_stored: false, derived_round_summaries_stored: true };
  for (let round = 1; round <= normalized.rounds; round += 1) {
    if (signal?.aborted) throw cancellationError();
    const events = [];
    for (const role of normalized.roles) {
      const state = roleState.get(role.id);
      const pressure = (random() - 0.5) * role.volatility;
      const cooperation = normalized.roles
        .filter((other) => other.id !== role.id)
        .reduce((total, other) => total + Number(role.relationships[other.id] || 0), 0) / Math.max(1, normalized.roles.length - 1);
      const delta = round6(pressure + cooperation * role.cooperation_weight);
      state.score = round6(clamp(state.score + delta, -100, 100));
      state.events += 1;
      events.push({ role_id: role.id, delta, score: state.score });
    }
    let narrative = deterministicRoundNarrative({ round, roles: normalized.roles, events });
    let modelAnnotation = null;
    if (normalized.mode === "live-model" && modelCall && round <= normalized.model_policy.max_calls) {
      try {
        const response = await modelCall({
          run_id: runId,
          job_id: jobId,
          purpose: "scenario_round_annotation",
          round,
          total_rounds: normalized.rounds,
          objective: normalized.objective,
          roles: normalized.roles.map(({ id, label }) => ({ id, label })),
          previous_summaries: timeline.slice(-2).map((item) => item.summary),
          state: events.map(({ role_id, score }) => ({ role_id, score }))
        });
        modelAnnotation = safeText(response?.annotation, 2000);
        if (!modelAnnotation) throw new Error("live-model gateway returned no final annotation text");
        modelUsage.calls += 1;
        modelUsage.input_tokens += Number(response?.usage?.input_tokens || 0);
        modelUsage.output_tokens += Number(response?.usage?.output_tokens || 0);
        modelUsage.provider_attempts += Number(response?.usage?.provider_attempts || 1);
        for (const provider of response?.usage?.providers_attempted || [response?.provider]) {
          const cleanProvider = safeText(provider, 80);
          if (cleanProvider && !modelUsage.providers_attempted.includes(cleanProvider)) modelUsage.providers_attempted.push(cleanProvider);
        }
        modelUsage.cost_usd = round6(modelUsage.cost_usd + Number(response?.usage?.cost_usd || 0));
        modelUsage.provider ||= safeText(response?.provider, 80);
        modelUsage.model ||= safeText(response?.model, 120);
        narrative = parseRoundNarrative(modelAnnotation, { round, roles: normalized.roles });
      } catch (error) {
        if (signal?.aborted || error?.code === "SCENARIO_CANCELLED") throw error;
        modelUsage.failed_calls += 1;
        modelUsage.fallback_rounds.push(round);
        modelUsage.degraded = true;
        modelUsage.last_failure_category = modelFailureCategory(error);
      }
    }
    const roundRecord = { ...narrative, events, model_annotation_hash: modelAnnotation ? sha256(modelAnnotation) : null };
    timeline.push(dropNull(roundRecord));
    if (onRound) await onRound({ ...roundRecord, model_annotation: modelAnnotation });
  }
  if (normalized.mode === "live-model" && modelUsage.calls === 0 && modelUsage.failed_calls > 0) {
    throw new Error("live-model gateway was unavailable for every planned annotation");
  }
  enforceModelBudget(modelUsage, normalized.model_policy);
  const roleResults = normalized.roles.map((role) => ({ role_id: role.id, label: role.label, final_score: roleState.get(role.id).score, event_count: roleState.get(role.id).events }));
  const scores = roleResults.map((role) => role.final_score);
  const finalNarrative = [...timeline].reverse().find((item) => item.model_annotation_hash) || timeline.at(-1);
  const result = {
    schema_version: SCENARIO_RESULT_SCHEMA,
    run_id: runId,
    job_id: jobId,
    status: "completed",
    runtime_version: SCENARIO_RUNTIME_VERSION,
    mode: normalized.mode,
    seed: normalized.seed,
    rounds: normalized.rounds,
    input_source_count: normalized.input_sources.length,
    roles: roleResults,
    metrics: {
      mean_score: round6(scores.reduce((sum, value) => sum + value, 0) / scores.length),
      min_score: Math.min(...scores),
      max_score: Math.max(...scores),
      spread: round6(Math.max(...scores) - Math.min(...scores))
    },
    conclusion: finalNarrative?.likely_next || finalNarrative?.summary || `Completed ${normalized.rounds} bounded rounds across ${normalized.roles.length} roles.`,
    narrative_timeline: timeline.map(({ events: _events, model_annotation_hash: _hash, ...item }) => item),
    uncertainty: normalized.uncertainty_notice,
    started_at: startedAt.toISOString(),
    ended_at: new Date().toISOString(),
    timeline_hash: hashJson(timeline),
    model_usage: modelUsage
  };
  result.result_hash = hashJson(result);
  return { input: normalized, result, timeline, modelUsage };
}

export async function writeScenarioArtifacts({ directory, manifest, execution, node = {}, transport = "unknown", cleanupStatus = "pending" }) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const report = renderScenarioReport({ input: execution.input, result: execution.result, timeline: execution.timeline, node, transport, cleanupStatus });
  const evidence = {
    schema_version: "across-scenario-evidence/1.0",
    run_id: execution.result.run_id,
    job_id: execution.result.job_id,
    manifest_hash: manifest.manifest_hash || hashJson(manifest),
    input_hash: hashJson(execution.input),
    result_hash: execution.result.result_hash,
    timeline_hash: execution.result.timeline_hash,
    node: compactNode(node),
    executor: manifest.executor,
    transport,
    model_usage: execution.modelUsage,
    quality_gates: {
      required_artifacts_present: true,
      scenario_disclaimer_present: execution.result.uncertainty.includes("not a prediction"),
      evidence_complete: true
    },
    cleanup_status: cleanupStatus
  };
  evidence.evidence_hash = hashJson(evidence);
  const bodies = {
    "job-manifest.json": `${stableJson(manifest)}\n`,
    "result.json": `${stableJson(execution.result)}\n`,
    "report.md": report,
    "evidence.json": `${stableJson(evidence)}\n`,
    "model-usage.json": `${stableJson(execution.modelUsage)}\n`
  };
  const entries = Object.entries(bodies).map(([logical_name, body]) => ({ logical_name, size: Buffer.byteLength(body), sha256: sha256(body), media_type: logical_name.endsWith(".json") ? "application/json" : "text/markdown" }));
  const artifactManifest = {
    schema_version: "across-artifact-manifest/1.0",
    run_id: execution.result.run_id,
    job_id: execution.result.job_id,
    artifacts: entries,
    complete: true
  };
  bodies["artifact-manifest.json"] = `${stableJson(artifactManifest)}\n`;
  for (const [name, body] of Object.entries(bodies)) await writeFile(join(root, name), body, "utf8");
  return { directory: root, artifacts: [...entries, { logical_name: "artifact-manifest.json", size: Buffer.byteLength(bodies["artifact-manifest.json"]), sha256: sha256(bodies["artifact-manifest.json"]), media_type: "application/json" }], evidence, report };
}

export function renderScenarioReport({ input, result, timeline = [], node = {}, transport = "unknown", cleanupStatus = "pending" }) {
  const rows = result.roles.map((role) => `| ${escapeMarkdown(role.label)} | ${role.final_score} | ${role.event_count} |`).join("\n");
  const timelineRows = timeline.map((item) => `| ${item.round} | ${item.turning_point} | ${escapeMarkdown(item.summary)} |`).join("\n");
  const turningPoints = timeline
    .filter((item) => item.turning_point !== "stable")
    .map((item) => `- Round ${item.round} · ${item.turning_point}: ${item.summary}`)
    .join("\n") || "- No strong turning point was identified in this bounded run.";
  const recommendations = [...new Set(timeline.map((item) => item.recommendation).filter(Boolean))];
  const recommendationText = recommendations.map((item) => `- ${item}`).join("\n") || "- Review the event assumptions before taking real-world action.";
  return `# ${escapeMarkdown(input.title)}\n\n` +
    `Verdict: completed\n\n` +
    `This is a bounded scenario simulation, not a prediction of the real world.\n\n` +
    `## Scenario\n\n${input.objective}\n\n` +
    `- Run: ${result.run_id}\n- Job: ${result.job_id}\n- Execution location: ${safeText(node.display_name || node.node_id, 120) || "remote worker"}\n- Platform: ${safeText(node.platform, 80) || "unknown"}\n- Transport: ${transport}\n- Mode: ${result.mode}\n- Model policy: ${result.model_usage.policy}\n- Model provider: ${result.model_usage.provider || "none"}\n- Provider route: ${(result.model_usage.providers_attempted || []).join(" -> ") || "none"}\n- Model status: ${result.model_usage.degraded ? "degraded with deterministic fallback" : "complete"}\n- Model fallback rounds: ${(result.model_usage.fallback_rounds || []).join(", ") || "none"}\n- Input sources: ${result.input_source_count}\n- Rounds: ${result.rounds}\n- Cleanup: ${cleanupStatus}\n\n` +
    `## Timeline\n\n| Round | Direction | What happened |\n| ---: | --- | --- |\n${timelineRows}\n\n` +
    `## Turning points\n\n${turningPoints}\n\n` +
    `## Most likely bounded outcome\n\n${result.conclusion}\n\n` +
    `## Recommended next steps\n\n${recommendationText}\n\n` +
    `| Role | Final score | Events |\n| --- | ---: | ---: |\n${rows}\n\n` +
    `## Uncertainty\n\n${result.uncertainty}\n`;
}

export async function scenarioRuntimeMain(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] !== "run") throw new Error("scenario runtime expects the run command");
  const inputDir = env.ACROSS_INPUT_DIR;
  const outputDir = env.ACROSS_OUTPUT_DIR;
  if (!inputDir || !outputDir) throw new Error("scenario runtime requires Across job input and output directories");
  const input = JSON.parse(await readFile(join(inputDir, "input.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(inputDir, "job-manifest.json"), "utf8"));
  const normalized = normalizeScenarioInput(input);
  const modelCall = normalized.mode === "live-model" ? createModelGrantGatewayCall(env) : null;
  const execution = await runScenarioSimulation(normalized, { runId: env.ACROSS_RUN_ID, jobId: env.ACROSS_JOB_ID, modelCall });
  await writeScenarioArtifacts({ directory: outputDir, manifest, execution, node: { node_id: env.ACROSS_NODE_ID || "worker", platform: process.platform }, transport: env.ACROSS_TRANSPORT || "unknown", cleanupStatus: "pending" });
  process.stdout.write(`${JSON.stringify({ status: "completed", run_id: execution.result.run_id, job_id: execution.result.job_id })}\n`);
}

export function createModelGrantGatewayCall(env = process.env, fetchImpl = globalThis.fetch) {
  const endpoint = String(env.ACROSS_MODEL_GATEWAY_URL || "").trim();
  const grantId = String(env.ACROSS_MODEL_GRANT_ID || "").trim();
  const runId = String(env.ACROSS_RUN_ID || "").trim();
  const jobId = String(env.ACROSS_JOB_ID || "").trim();
  const nodeId = String(env.ACROSS_NODE_ID || "").trim();
  if (!endpoint || !grantId || !runId || !jobId || !nodeId) throw new Error("live-model mode requires a task-bound Model Grant gateway");
  const url = new URL(endpoint);
  if (!/^https:$/.test(url.protocol) && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Model Grant gateway requires HTTPS outside an isolated loopback test");
  }
  if (url.username || url.password || url.hash) throw new Error("Model Grant gateway URL must not contain credentials or fragments");
  if (typeof fetchImpl !== "function") throw new Error("Model Grant gateway requires fetch support");
  const timeoutSeconds = boundedInteger(env.ACROSS_MODEL_TIMEOUT_SECONDS || 30, 1, 600, "model timeout");
  const maxTokens = boundedInteger(env.ACROSS_MODEL_MAX_TOKENS || 512, 1, 100_000, "model max tokens per call");
  return async ({ run_id, job_id, purpose, round, total_rounds, objective, roles, previous_summaries, state }) => {
    if (run_id !== runId || job_id !== jobId) throw new Error("Model Grant invocation does not match the active job");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const message = [
        `Analyze round ${round} of ${total_rounds} for this bounded scenario.`,
        `Objective: ${safeText(objective, 1000)}`,
        `Roles: ${JSON.stringify(roles)}`,
        `Prior round summaries: ${JSON.stringify(previous_summaries)}`,
        `Current numeric state: ${JSON.stringify(state)}`,
        "Return compact JSON with keys summary, turning_point, role_states, likely_next, recommendation. turning_point must be escalation, de-escalation, or stable. role_states must contain role, emotion, and action. Use the same language as the objective and describe concrete interaction behavior, not the numeric scores."
      ].join("\n");
      const systemPrompt = "You create a concise, uncertainty-aware scenario narrative for a fictional bounded simulation. No deep analysis is needed. Return the final JSON directly. Do not claim to predict real people, include secrets, or expose hidden reasoning.";
      const estimatedInputTokens = Math.ceil((message.length + systemPrompt.length) / 4) + 16;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({
          grant_id: grantId,
          run_id: runId,
          job_id: jobId,
          node_id: nodeId,
          purpose,
          message,
          system_prompt: systemPrompt,
          // Keep the call within the provider's bounded 2K completion
          // contract while leaving room for a final JSON annotation.
          max_tokens: Math.min(2048, Math.max(16, maxTokens - estimatedInputTokens - 64)),
          token_budget: maxTokens,
          timeout_seconds: timeoutSeconds,
          temperature: 0.2
        }),
        signal: controller.signal
      });
      const payload = await response.json();
      if (!response.ok) {
        const category = safeText(payload?.detail?.category || "provider", 40);
        throw new Error(`Model Grant gateway ${category} failure`);
      }
      return {
        annotation: safeText(payload.text, 2000),
        usage: {
          input_tokens: Number(payload?.usage?.input_tokens || payload?.usage?.prompt_tokens || 0),
          output_tokens: Number(payload?.usage?.output_tokens || payload?.usage?.completion_tokens || 0),
          provider_attempts: Number(payload?.usage?.provider_attempts || 1),
          providers_attempted: Array.isArray(payload?.usage?.providers_attempted) ? payload.usage.providers_attempted.map((item) => safeText(item, 80)).filter(Boolean) : [],
          cost_usd: Number(payload?.grant_usage?.cost_usd || 0)
        },
        provider: safeText(payload.provider, 80),
        model: safeText(payload.model, 120),
        provider_key_exposed: payload.provider_key_exposed === true
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

function normalizeRole(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`role ${index + 1} must be an object`);
  const id = String(value.id || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`role ${index + 1} requires a stable lowercase id`);
  const relationships = {};
  for (const [target, weight] of Object.entries(value.relationships || {})) relationships[String(target)] = clamp(Number(weight) || 0, -1, 1);
  return {
    id,
    label: safeText(value.label, 80) || id,
    initial_score: clamp(Number(value.initial_score) || 0, -100, 100),
    volatility: clamp(Number(value.volatility ?? 1), 0, 10),
    cooperation_weight: clamp(Number(value.cooperation_weight ?? 0.1), -10, 10),
    relationships
  };
}

function parseRoundNarrative(text, { round, roles }) {
  const cleaned = safeText(text, 2000) || "";
  let candidate = cleaned;
  if (candidate.startsWith("```")) candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value;
  try {
    value = JSON.parse(candidate);
  } catch {
    value = recoverTruncatedNarrative(candidate) || { summary: cleaned };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = { summary: cleaned };
  const allowedDirections = new Set(["escalation", "de-escalation", "stable"]);
  const requestedDirection = safeText(value.turning_point, 32)?.toLowerCase();
  const labels = new Map(roles.map((role) => [role.id, role.label]));
  const roleStates = (Array.isArray(value.role_states) ? value.role_states : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      role: labels.get(safeText(item.role, 80)) || safeText(item.role, 80),
      emotion: safeText(item.emotion, 120) || "",
      action: safeText(item.action, 240) || ""
    }))
    .filter((item) => item.role)
    .slice(0, roles.length);
  return {
    round,
    summary: safeText(value.summary || cleaned, 600) || `Round ${round} completed.`,
    turning_point: allowedDirections.has(requestedDirection) ? requestedDirection : "stable",
    role_states: roleStates,
    likely_next: safeText(value.likely_next, 400) || "",
    recommendation: safeText(value.recommendation, 400) || ""
  };
}

function recoverTruncatedNarrative(candidate) {
  const recovered = {};
  for (const key of ["summary", "turning_point", "likely_next", "recommendation"]) {
    const match = String(candidate || "").match(new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "i"));
    if (!match) continue;
    try {
      recovered[key] = JSON.parse(match[1]);
    } catch {
      // Ignore a malformed field and keep any earlier complete fields. Model
      // output can be cut off after a valid summary when its token cap is hit.
    }
  }
  return Object.keys(recovered).length ? recovered : null;
}

function deterministicRoundNarrative({ round, roles, events }) {
  const labels = new Map(roles.map((role) => [role.id, role.label]));
  const changes = events
    .map((item) => `${labels.get(item.role_id) || item.role_id} ${item.delta >= 0 ? "moved toward cooperation" : "moved toward conflict"}`)
    .join(", ");
  const averageDelta = events.reduce((sum, item) => sum + item.delta, 0) / Math.max(1, events.length);
  return {
    round,
    summary: `Round ${round}: ${changes}.`,
    turning_point: averageDelta > 0.15 ? "de-escalation" : averageDelta < -0.15 ? "escalation" : "stable",
    role_states: [],
    likely_next: "The next round remains uncertain without a model annotation.",
    recommendation: ""
  };
}

function normalizeModelPolicy(value, mode) {
  const source = value && typeof value === "object" ? value : {};
  if (mode === "no-key") return { enabled: false, policy: "none", max_calls: 0, max_tokens: 0, max_concurrency: 0, max_cost_usd: 0, timeout_seconds: 0 };
  return {
    enabled: true,
    policy: safeText(source.policy, 80) || "host-default",
    max_calls: boundedInteger(source.max_calls ?? 4, 1, 100, "model max_calls"),
    max_tokens: boundedInteger(source.max_tokens ?? 4000, 1, 1_000_000, "model max_tokens"),
    max_concurrency: boundedInteger(source.max_concurrency ?? 1, 1, 16, "model max_concurrency"),
    max_cost_usd: clamp(Number(source.max_cost_usd ?? 0), 0, 10_000),
    timeout_seconds: boundedInteger(source.timeout_seconds ?? 30, 1, 600, "model timeout")
  };
}

function enforceModelBudget(usage, policy) {
  if (usage.calls > policy.max_calls || usage.input_tokens + usage.output_tokens > policy.max_tokens || usage.cost_usd > policy.max_cost_usd + 1e-9) throw new Error("scenario model budget exceeded");
}

function modelFailureCategory(error) {
  const message = safeText(error?.message, 300)?.toLowerCase() || "";
  if (message.includes("timeout") || message.includes("abort")) return "model_timeout";
  if (message.includes("no final") || message.includes("empty")) return "model_empty_response";
  if (message.includes("budget") || message.includes("policy")) return "model_policy_unavailable";
  return "model_provider_unavailable";
}

function compactNode(value) {
  return { node_id: safeText(value.node_id, 128), display_name: safeText(value.display_name, 120), platform: safeText(value.platform, 80), worker_version: safeText(value.worker_version, 40) };
}

function xorshift(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function cancellationError() {
  const error = new Error("scenario simulation cancelled");
  error.code = "SCENARIO_CANCELLED";
  return error;
}

function boundedInteger(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return number;
}

function uniqueStrings(value, maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => safeText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function safeText(value, maxLength) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return sha256(JSON.stringify(sortObject(value)));
}

function stableJson(value) {
  return JSON.stringify(sortObject(value), null, 2);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortObject(child)]));
}

function dropNull(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) scenarioRuntimeMain().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
