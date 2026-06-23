import { FAILURE_CODES, LoopFailure } from "./failures.js";
import { resolveCommand, runJsonCommand } from "./process-client.js";

export class OrchestratorClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.command = resolveCommand(options.command || this.env.ACROSS_ORCHESTRATOR_COMMAND, ["across-orchestrator"], this.env);
    this.cwd = options.cwd || process.cwd();
  }

  async capabilities() {
    return {
      engine: "across-orchestrator",
      actions: ["orchestrator_task_dispatch", "quality_gate_evaluation"],
      metadata_reflection: true
    };
  }

  async runLoopTask({ spec, run }) {
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
    try {
      const runTimeoutMs = orchestratorRunTimeoutMs(modelPolicy);
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
        evidence_refs: [`orchestrator/${loopId}/evidence-summary`]
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

function modelPolicyFor(spec, env) {
  const declared = { ...(spec.model_policy || {}), ...(spec.pack_config?.model_policy || {}) };
  if (!declared.host_model_command && !declared.hostModelCommand && env.ACROSS_AAA_HOST_MODEL_COMMAND) {
    declared.host_model_command = env.ACROSS_AAA_HOST_MODEL_COMMAND;
  }
  if (!declared.provider && !declared.provider_id && env.ACROSS_AAA_HOST_MODEL_PROVIDER) {
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
