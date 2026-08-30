import { FAILURE_CODES, LoopFailure } from "./failures.js";
import { commandAvailable, resolveCommand, runJsonCommand } from "./process-client.js";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";

export class OrchestratorClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.command = resolveCommand(options.command || this.env.ACROSS_ORCHESTRATOR_COMMAND, ["across-orchestrator"], this.env);
    this.cwd = options.cwd || process.cwd();
    this.hostRequest = options.hostRequest || hostJsonRequest;
    this.hostSocketExists = options.hostSocketExists || existsSync;
  }

  async capabilities() {
    return {
      engine: "across-orchestrator",
      actions: ["orchestrator_task_dispatch", "quality_gate_evaluation"],
      metadata_reflection: true
    };
  }

  available() {
    const socketPath = hostSocketPath(this.env);
    return Boolean(socketPath && this.hostSocketExists(socketPath))
      || commandAvailable(this.command, ["across-orchestrator"], this.env);
  }

  async runLoopTask({ spec, run, goalBinding = null }) {
    const modelPolicy = modelPolicyFor(spec, this.env);
    const metadata = {
      autopilot: {
        run_id: run.run_id,
        spec_id: spec.id,
        schema_version: spec.schema_version,
        evidence_contract: spec.evidence_contract?.schema_version,
        actions_allowed: spec.actions?.allowed || [],
        actions_blocked: spec.actions?.blocked || [],
        sandbox: { root: run.sandbox },
        model_policy: modelPolicy
      },
      model_policy: modelPolicy,
      candidate_workspace: spec.pack_config?.candidate_workspace || spec.scope?.workspace || null,
      source_repository: spec.pack_config?.source_repository || null,
      allowed_patch_paths: spec.pack_config?.allowed_patch_paths || spec.model_policy?.allowed_patch_paths || [],
      context_files: spec.pack_config?.context_files || spec.model_policy?.context_files || [],
      focus: spec.pack_config?.focus || spec.model_policy?.focus || []
    };
    const goalExecutionContract = goalBinding ? {
      schema_version: "across-goal-execution-contract/1.0",
      goal_id: goalBinding.goal_id,
      goal_revision: goalBinding.goal_revision,
      task_id: goalBinding.task_id,
      criterion_ids: [...goalBinding.criterion_ids],
      input_fingerprint: goalBinding.input_fingerprint
    } : null;
    if (goalExecutionContract) metadata.goal_execution_contract = structuredClone(goalExecutionContract);
    try {
      const runTimeoutMs = orchestratorRunTimeoutMs(modelPolicy);
      const hostSocket = hostSocketPath(this.env);
      if (hostSocket && this.hostSocketExists(hostSocket)) {
        return await runLoopTaskViaHost({
          socketPath: hostSocket,
          spec,
          run,
          metadata,
          goalExecutionContract,
          timeoutMs: runTimeoutMs,
          requestJson: this.hostRequest
        });
      }
      const started = await runJsonCommand(this.command, [
        "loop-start",
        spec.description || spec.name,
        "--project",
        run.sandbox,
        "--agent",
        "autopilot",
        "--max-turns",
        String(spec.execute?.max_turns || 8),
        "--metadata-json",
        JSON.stringify(metadata),
        ...(goalExecutionContract ? ["--goal-execution-contract-json", JSON.stringify(goalExecutionContract)] : []),
        "--json"
      ], { env: this.env, cwd: this.cwd, timeoutMs: runTimeoutMs });
      const loopId = started.loop_id;
      const completed = await runJsonCommand(this.command, ["loop-run", loopId, "--json"], {
        env: this.env,
        cwd: this.cwd,
        timeoutMs: runTimeoutMs
      });
      const status = await runJsonCommand(this.command, ["loop-status", loopId, "--json"], { env: this.env, cwd: this.cwd });
      const summary = await runJsonCommand(this.command, ["loop-evidence-summary", loopId, "--json"], { env: this.env, cwd: this.cwd });
      const events = await runJsonCommand(this.command, ["loop-events", loopId, "--json"], { env: this.env, cwd: this.cwd });
      const modelDecision = extractModelDecision(completed, status, summary);
      return {
        task_id: loopId,
        loop_id: loopId,
        status: completed.status || status.status || "completed",
        quality_status: summary.quality_status || summary.status || "passed",
        metadata_reflected: Boolean(status.metadata?.autopilot?.run_id === run.run_id || completed.metadata?.autopilot?.run_id === run.run_id),
        model_backed: Boolean(modelDecision),
        model_decision: modelDecision,
        status_payload: status,
        evidence_summary: summary,
        event_count: Array.isArray(events) ? events.length : 0,
        evidence_refs: [`orchestrator/${loopId}/evidence-summary`],
        evidence_receipt: extractAuthorityProjection("evidence_receipt", completed, status, summary),
        goal_evidence_binding: extractAuthorityProjection("goal_evidence_binding", completed, status, summary)
      };
    } catch (error) {
      throw new LoopFailure({
        code: FAILURE_CODES.ORCHESTRATOR_SUBMIT_FAILED,
        failedState: "dispatching",
        message: `Orchestrator dispatch failed: ${error.message || error}`,
        causedBy: [{ command: error.command, stderr: String(error.stderr || "").slice(0, 1000) }]
      });
    }
  }
}

async function runLoopTaskViaHost({ socketPath, spec, run, metadata, goalExecutionContract, timeoutMs, requestJson }) {
  const started = await requestJson(socketPath, "POST", "/api/orchestrator/loops", {
    goal: spec.description || spec.name,
    project_dir: run.sandbox,
    agent: "autopilot",
    max_turns: spec.execute?.max_turns || 8,
    metadata,
    ...(goalExecutionContract ? { goal_execution_contract: goalExecutionContract } : {})
  }, timeoutMs);
  const loopId = started.loop_id;
  if (!loopId) throw new Error("AAA Orchestrator host did not return a loop id");
  const encodedLoopId = encodeURIComponent(loopId);
  const completed = await requestJson(socketPath, "POST", `/api/orchestrator/loops/${encodedLoopId}/run`, {}, timeoutMs);
  const status = await requestJson(socketPath, "GET", `/api/orchestrator/loops/${encodedLoopId}`, null, timeoutMs);
  const summary = await requestJson(socketPath, "GET", `/api/orchestrator/loops/${encodedLoopId}/evidence-summary`, null, timeoutMs);
  const events = await requestJson(socketPath, "GET", `/api/orchestrator/loops/${encodedLoopId}/events`, null, timeoutMs);
  const modelDecision = extractModelDecision(completed, status, summary);
  return {
    task_id: loopId,
    loop_id: loopId,
    status: completed.status || status.status || "completed",
    quality_status: summary.quality_status || summary.status || "passed",
    metadata_reflected: Boolean(status.metadata?.autopilot?.run_id === run.run_id || completed.metadata?.autopilot?.run_id === run.run_id),
    model_backed: Boolean(modelDecision),
    model_decision: modelDecision,
    status_payload: status,
    evidence_summary: summary,
    event_count: Array.isArray(events) ? events.length : 0,
    evidence_refs: [`orchestrator/${loopId}/evidence-summary`],
    evidence_receipt: extractAuthorityProjection("evidence_receipt", completed, status, summary),
    goal_evidence_binding: extractAuthorityProjection("goal_evidence_binding", completed, status, summary)
  };
}

function extractAuthorityProjection(field, ...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (source[field] && typeof source[field] === "object") return source[field];
    for (const container of ["job", "result", "evidence", "authority"]) {
      if (source[container]?.[field] && typeof source[container][field] === "object") return source[container][field];
    }
  }
  return null;
}

function hostSocketPath(env) {
  const explicit = String(env.ACROSS_AAA_HOST_SOCKET || "").trim();
  if (explicit) return explicit;
  try {
    const lease = JSON.parse(String(env.ACROSS_AAA_CANDIDATE_MODEL_LEASE_JSON || "{}"));
    return String(lease.host_socket || "").trim();
  } catch {
    return "";
  }
}

function hostJsonRequest(socketPath, method, path, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? "" : JSON.stringify(payload);
    const request = httpRequest({
      socketPath,
      path,
      method,
      headers: body ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      } : {}
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let decoded = {};
        try {
          decoded = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`AAA Orchestrator host returned invalid JSON (${response.statusCode})`));
          return;
        }
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`AAA Orchestrator host failed (${response.statusCode}): ${decoded.detail || decoded.error || "unknown error"}`));
          return;
        }
        resolve(decoded);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`AAA Orchestrator host timed out after ${timeoutMs}ms`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function modelPolicyFor(spec, env) {
  const declared = { ...(spec.model_policy || {}), ...(spec.pack_config?.model_policy || {}) };
  const modelRequested = Object.keys(declared).length > 0;
  const hostSocket = hostSocketPath(env);
  if (modelRequested && hostSocket && existsSync(hostSocket)) {
    declared.host_model_command = [
      "/usr/bin/curl",
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--unix-socket",
      hostSocket,
      "--header",
      "content-type: application/json",
      "--data-binary",
      "@-",
      "http://localhost/api/autopilot/model-decision"
    ];
    delete declared.hostModelCommand;
  } else if (modelRequested && !declared.host_model_command && !declared.hostModelCommand && env.ACROSS_AAA_HOST_MODEL_COMMAND) {
    declared.host_model_command = env.ACROSS_AAA_HOST_MODEL_COMMAND;
  }
  if (modelRequested && !declared.provider && !declared.provider_id && env.ACROSS_AAA_HOST_MODEL_PROVIDER) {
    declared.provider = env.ACROSS_AAA_HOST_MODEL_PROVIDER;
  }
  return declared;
}

function orchestratorRunTimeoutMs(modelPolicy) {
  const hostTimeoutSeconds = Number(modelPolicy.timeout_seconds || modelPolicy.timeoutSeconds || 180);
  const boundedSeconds = Number.isFinite(hostTimeoutSeconds)
    ? Math.max(60, Math.min(900, hostTimeoutSeconds))
    : 180;
  return (boundedSeconds + 120) * 1000;
}

function extractModelDecision(...payloads) {
  for (const payload of payloads) {
    const found = findModelDecision(payload);
    if (found) return found;
  }
  return null;
}

function findModelDecision(value) {
  if (!value || typeof value !== "object") return null;
  if (value.schema_version === "across-host-model-decision/1.0" && value.model_backed) return value;
  if (value.model_decision && typeof value.model_decision === "object") {
    if (value.model_decision.schema_version === "across-host-model-decision/1.0") return value.model_decision;
    const nested = findModelDecision(value.model_decision);
    if (nested) return nested;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findModelDecision(item);
      if (found) return found;
    }
  } else {
    for (const item of Object.values(value)) {
      const found = findModelDecision(item);
      if (found) return found;
    }
  }
  return null;
}
