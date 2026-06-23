import { AdapterRegistry } from "./adapter-registry.js";
import { ContextClient } from "./context-client.js";
import { buildEvidenceEnvelope, gateFromFailure, runtimeBudgetUsage } from "./evidence.js";
import { FAILURE_CODES, LoopFailure, failureFromError } from "./failures.js";
import { loadLoopSpec, migrateLoopSpec, normalizeRuntimePolicy, validateLoopSpec } from "./loop-spec.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import { RunStore } from "./run-store.js";
import { buildTelemetry } from "./telemetry.js";
import { TriggerQueue } from "./trigger-queue.js";
import { roleForAdapter } from "./roles.js";

const MODEL_BACKED_ACTIONS = new Set([
  "orchestrator_task_dispatch",
  "product_iteration_strategy",
  "host_code_iteration",
  "semantic_alignment_review"
]);

export class AutopilotSupervisor {
  constructor(options = {}) {
    this.store = options.store || new RunStore(options);
    this.contextClient = options.contextClient || new ContextClient(options);
    this.orchestratorClient = options.orchestratorClient || new OrchestratorClient(options);
    this.triggerQueue = options.triggerQueue || new TriggerQueue(options);
    this.registry = options.registry || new AdapterRegistry({
      orchestratorClient: this.orchestratorClient,
      contextClient: this.contextClient,
      store: this.store
    });
  }

  async validateSpec(pathOrId) {
    const raw = await this.loadSpec(pathOrId);
    const migration = migrateLoopSpec(raw);
    const validation = validateLoopSpec(migration.spec, this.registry);
    return { ...validation, migration };
  }

  async loadSpec(pathOrId) {
    if (typeof pathOrId === "object" && pathOrId !== null) return pathOrId;
    try {
      return await loadLoopSpec(pathOrId);
    } catch (error) {
      const registry = await this.store.loadRegistry();
      const registered = registry.specs?.find((item) => item.id === pathOrId);
      if (registered?.source_path) {
        return loadLoopSpec(registered.source_path);
      }
      throw error;
    }
  }

  async dryRun(pathOrId, options = {}) {
    const spec = applyRuntimeModelOverrides((await this.validateSpec(pathOrId)).migration.spec, options.modelOverrides);
    const capabilityPreflight = this.capabilityPreflight(spec);
    return {
      schema_version: "across-loop-dry-run/1.0",
      spec_id: spec.id,
      valid: true,
      capability_preflight: capabilityPreflight,
      runtime_policy: normalizeRuntimePolicy(spec),
      lifecycle: [
        "created",
        "validating_spec",
        "negotiating_capabilities",
        "recalling_context",
        "discovering_sources",
        "planning",
        "dispatching",
        "running",
        "collecting_evidence",
        "validating_gates",
        "remembering",
        "completed"
      ],
      used_adapters: spec.used_adapters,
      model_overrides: spec.pack_config?.runtime_model_overrides || null,
      outputs: spec.outputs
    };
  }

  async registerSpec(pathOrId) {
    const spec = (await this.validateSpec(pathOrId)).migration.spec;
    return this.store.registerSpec(spec, pathOrId);
  }

  async run(pathOrId, options = {}) {
    let spec;
    let run;
    let sources = [];
    let actions = [];
    let gates = [];
    let outputs = [];
    let memory = { recalled: [], written: [] };
    let failure = null;
    try {
      const validation = await this.validateSpec(pathOrId);
      spec = applyRuntimeModelOverrides(validation.migration.spec, options.modelOverrides);
      await this.assertNotPaused(spec);
      run = await this.store.createRun(spec, { trigger: options.trigger || "manual" });
      const capabilityPreflight = this.capabilityPreflight(spec);
      if (validation.migration.changed_paths.length) {
        await this.store.audit(run.run_id, spec.id, "spec_migrated", "LoopSpec migrated.", validation.migration);
      }
      await this.store.transition(run.run_id, "validating_spec", "LoopSpec validated.", { ...validation, capability_preflight: capabilityPreflight });
      if (capabilityPreflight.status !== "passed") {
        throw new LoopFailure({
          code: FAILURE_CODES.CAPABILITY_MISSING,
          failedState: "negotiating_capabilities",
          message: `Missing required capabilities: ${capabilityPreflight.missing_capabilities.join(", ")}`,
          evidenceRefs: ["spec/required_capabilities"],
          retryable: false
        });
      }
      await this.store.updateRun(run.run_id, { started_at: new Date().toISOString() });
      await this.store.transition(run.run_id, "negotiating_capabilities", "Capabilities negotiated.", { ...this.capabilities(), capability_preflight: capabilityPreflight });
      await this.writeEvidenceSnapshot({ spec, run, sources, actions, gates, outputs, memory });

      const recalled = await this.recallMemory(spec);
      memory.recalled = recalled.results || [];
      await this.store.audit(run.run_id, spec.id, "context_recalled", "Context recall completed.", recalled);
      await this.store.transition(run.run_id, "discovering_sources", "Discovering sources.");
      sources = await this.runSources(spec, run);
      await this.writeEvidenceSnapshot({ spec, run, sources, actions, gates, outputs, memory });

      await this.store.transition(run.run_id, "planning", "Planning actions.");
      const plan = this.buildPlan(spec, sources, memory.recalled);
      await this.store.writePlan(run.run_id, plan);

      await this.store.transition(run.run_id, "running", "Running adapters.");
      actions = await this.runActions(spec, run, sources, memory.recalled);
      gates = extractGates(actions);

      await this.store.transition(run.run_id, "collecting_evidence", "Collecting outputs.");
      outputs = await this.writeOutputs(spec, run, { sources, actions, gates });
      await this.writeEvidenceSnapshot({ spec, run, sources, actions, gates, outputs, memory });

      await this.store.transition(run.run_id, "validating_gates", "Validating gates.");
      const failedRequired = gates.filter((gate) => gate.required && gate.status !== "passed");
      if (failedRequired.length && !spec.failure_policy?.continue_on_gate_failure) {
        throw new LoopFailure({
          code: FAILURE_CODES.GATE_FAILED,
          failedState: "validating_gates",
          message: `${failedRequired.length} required gate(s) failed.`,
          evidenceRefs: failedRequired.flatMap((gate) => gate.evidence_refs || [])
        });
      }

      await this.store.transition(run.run_id, "remembering", "Writing pending memory.");
      const memoryActions = actions.filter((action) => action.adapter === "memory_write_candidate");
      memory.written = memoryActions.map((action) => action.result?.memory || action.result).filter(Boolean);
      run = await this.store.updateRun(run.run_id, { status: "completed", state: "completed", completed_at: new Date().toISOString() });
      await this.store.audit(run.run_id, spec.id, "run_completed", "Run completed.", { outputs: outputs.length });
    } catch (error) {
      if (Array.isArray(error?.partialActions) && !actions.length) actions = error.partialActions;
      if (Array.isArray(error?.partialGates) && !gates.length) gates = error.partialGates;
      if (!gates.length) gates = extractGates(actions);
      failure = failureFromError(error, error?.failed_state || "running");
      if (!run && spec) run = await this.store.createRun(spec, { trigger: options.trigger || "manual" });
      if (run) {
        gates = gates.length ? gates : [gateFromFailure(failure)];
        run = await this.store.updateRun(run.run_id, {
          status: failure.code === FAILURE_CODES.APPROVAL_REQUIRED ? "blocked" : "failed",
          state: failure.failed_state || "failed",
          completed_at: new Date().toISOString(),
          failure
        });
        await this.store.audit(run.run_id, run.spec_id, "run_failed", "Run failed.", failure);
      } else {
        throw error;
      }
    }

    const audit = await this.store.events(run.run_id);
    const evidence = buildEvidenceEnvelope({
      spec,
      run,
      sources,
      actions,
      gates,
      outputs,
      memory,
      risks: collectRisks(actions, gates, failure),
      audit,
      failure
    });
    await this.store.writeEvidence(run.run_id, evidence);
    return { run, evidence };
  }

  async enqueueTrigger(pathOrId, trigger = {}, options = {}) {
    const validation = await this.validateSpec(pathOrId);
    const spec = validation.migration.spec;
    await this.assertNotPaused(spec);
    return this.triggerQueue.enqueue(spec, trigger, options);
  }

  async triggerQueueStatus() {
    return this.triggerQueue.list();
  }

  async runQueuedTrigger(triggerId = null) {
    const item = triggerId
      ? await this.triggerQueue.claim(triggerId)
      : await this.triggerQueue.claimNext();
    if (!item) {
      return {
        schema_version: "across-autopilot-trigger-dispatch/1.0",
        status: "idle",
        trigger: null,
        run: null,
        evidence: null
      };
    }
    try {
      const result = await this.run(item.spec_snapshot || item.spec_source || item.spec_id, { trigger: item.trigger_event });
      const triggerStatus = result.run.status === "completed" ? "completed" : "failed";
      const completedTrigger = await this.triggerQueue.complete(item.trigger_id, {
        status: triggerStatus,
        run_id: result.run.run_id,
        failure: triggerStatus === "failed" ? result.run.failure || result.evidence.failure || null : null
      });
      return {
        schema_version: "across-autopilot-trigger-dispatch/1.0",
        status: triggerStatus,
        trigger: completedTrigger,
        run: result.run,
        evidence: result.evidence
      };
    } catch (error) {
      const completedTrigger = await this.triggerQueue.complete(item.trigger_id, {
        status: "failed",
        failure: failureFromError(error, "trigger_dispatch")
      });
      error.trigger = completedTrigger;
      throw error;
    }
  }

  async writeEvidenceSnapshot({ spec, run, sources = [], actions = [], gates = [], outputs = [], memory = {}, failure = null }) {
    if (!spec || !run?.run_id) return null;
    const currentRun = await this.store.loadRun(run.run_id);
    const audit = await this.store.events(run.run_id);
    const evidence = buildEvidenceEnvelope({
      spec,
      run: currentRun,
      sources,
      actions,
      gates,
      outputs,
      memory,
      risks: collectRisks(actions, gates, failure),
      audit,
      failure
    });
    await this.store.writeEvidence(run.run_id, evidence);
    return evidence;
  }

  async status(runId) {
    return this.store.loadRun(runId);
  }

  async evidence(runId) {
    return this.store.loadEvidence(runId);
  }

  async events(runId, options = {}) {
    return this.store.events(runId, options);
  }

  async cancel(runId, reason = "cancelled") {
    const run = await this.store.updateRun(runId, { status: "cancelled", state: "cancelled", completed_at: new Date().toISOString() });
    await this.store.audit(runId, run.spec_id, "run_cancelled", "Run cancelled.", { reason });
    return run;
  }

  async retry(runId) {
    const run = await this.store.loadRun(runId);
    if (!run.failure?.retryable) {
      throw new LoopFailure({
        code: FAILURE_CODES.RETRY_EXHAUSTED,
        failedState: "retry",
        message: `Retry denied by failure code ${run.failure?.code || "unknown"}.`
      });
    }
    const spec = await this.store.loadSpec(runId);
    return this.run(spec, { trigger: "retry" });
  }

  async listRuns() {
    return this.store.listRuns();
  }

  async telemetry() {
    return buildTelemetry(this.store);
  }

  async setSpecPaused(specId, paused) {
    return this.store.setSpecPaused(specId, paused);
  }

  async setAdapterPaused(adapterId, paused) {
    return this.store.setAdapterPaused(adapterId, paused);
  }

  async quarantineOutput(runId, outputId) {
    return this.store.quarantineOutput(runId, outputId);
  }

  capabilities() {
    return {
      schema_version: "across-autopilot-capabilities/1.0",
      loop_spec: "across-loop-spec/1.0",
      evidence: "across-loop-evidence/1.0",
      adapters: this.registry.capabilities()
    };
  }

  capabilityPreflight(spec) {
    const adapterCapabilities = this.registry.capabilities();
    const available = new Set([
      ...(adapterCapabilities.sources || []),
      ...(adapterCapabilities.actions || []),
      ...(adapterCapabilities.outputs || []),
      ...(adapterCapabilities.runtime || []),
      ...(adapterCapabilities.tool_packs || []).map((pack) => `tool_pack.${pack.id}`),
      "memory.pending_summary"
    ]);
    const required = [...new Set((spec.required_capabilities || []).map((item) => String(item || "").trim()).filter(Boolean))];
    const missing = required.filter((capability) => !available.has(capability));
    return {
      schema_version: "across-loop-capability-preflight/1.0",
      status: missing.length ? "failed" : "passed",
      spec_id: spec.id,
      required_capabilities: required,
      missing_capabilities: missing,
      available_count: available.size,
      runtime_policy: normalizeRuntimePolicy(spec)
    };
  }

  async assertNotPaused(spec) {
    const control = await this.store.loadControl();
    if (control.global_paused) throw pausedFailure("global", spec.id);
    if ((control.paused_specs || []).includes(spec.id)) throw pausedFailure("spec", spec.id);
    for (const id of [...(spec.used_adapters?.sources || []), ...(spec.used_adapters?.actions || []), ...(spec.used_adapters?.outputs || [])]) {
      if ((control.paused_adapters || []).includes(id)) throw pausedFailure("adapter", id);
    }
  }

  async recallMemory(spec) {
    if (!spec.memory?.recall) return { results: [] };
    return this.contextClient.recall({ spec, limit: spec.memory?.limit || 10 });
  }

  async runSources(spec, run) {
    const records = [];
    for (const source of spec.sources || []) {
      const adapter = this.registry.getSource(source.adapter || source.type);
      if (!adapter) throw new LoopFailure({ code: FAILURE_CODES.CAPABILITY_MISSING, failedState: "discovering_sources", message: `Missing source adapter ${source.adapter || source.type}.` });
      await this.store.audit(run.run_id, spec.id, "source_started", `Source ${source.id || adapter.id} started.`, { adapter: adapter.id });
      try {
        const record = await adapter.run({ spec, source, run });
        records.push(record);
        await this.store.audit(run.run_id, spec.id, "source_completed", `Source ${record.id} completed.`, { adapter: adapter.id, status: record.status });
      } catch (error) {
        const failure = failureFromError(error, "discovering_sources");
        records.push({ id: source.id || adapter.id, adapter: adapter.id, status: "failed", failure });
        await this.store.audit(run.run_id, spec.id, "source_completed", `Source ${source.id || adapter.id} failed.`, failure);
      }
    }
    return records;
  }

  buildPlan(spec, sources, recalledMemory) {
    return {
      schema_version: "across-loop-plan/1.0",
      spec_id: spec.id,
      source_count: sources.length,
      recalled_memory_count: recalledMemory.length,
      actions: spec.used_adapters.actions,
      outputs: spec.outputs
    };
  }

  async runActions(spec, run, sources, recalledMemory) {
    const actions = [];
    let gates = [];
    const runtimeBudget = createRuntimeBudgetGuard(spec, run);
    for (const actionId of spec.used_adapters.actions || []) {
      const adapter = this.registry.getAction(actionId);
      if (!adapter) throw new LoopFailure({ code: FAILURE_CODES.CAPABILITY_MISSING, failedState: "running", message: `Missing action adapter ${actionId}.` });
      assertRuntimeBudgetCanStart(runtimeBudget, actions, actionId);
      const startedAt = new Date().toISOString();
      await this.store.audit(run.run_id, spec.id, "action_started", `Action ${actionId} started.`, { adapter: actionId });
      await this.writeEvidenceSnapshot({
        spec,
        run,
        sources,
        actions: [...actions, runningActionRecord(actionId, actionId, startedAt, spec)],
        gates,
        memory: { recalled: recalledMemory, written: [] }
      });
      let action;
      try {
        action = await withRuntimeTimeout(adapter.run({
          spec,
          run,
          sources,
          actions,
          gates,
          recalledMemory,
          orchestratorClient: this.orchestratorClient,
          contextClient: this.contextClient
        }), runtimeTimeoutForAction(runtimeBudget, actionId), actionId);
      } catch (error) {
        const failure = failureFromError(error, "running");
        failure.adapter_id = failure.adapter_id || actionId;
        action = {
          id: actionId,
          adapter: actionId,
          status: "failed",
          started_at: startedAt,
          completed_at: new Date().toISOString(),
          autonomy_level: spec.autonomy?.level ?? 0,
          inputs: [],
          outputs: [],
          result: { status: "failed" },
          failure
        };
        actions.push(action);
        await this.store.audit(run.run_id, spec.id, "action_completed", `Action ${actionId} failed.`, { adapter: actionId, status: "failed", failure });
        await this.writeEvidenceSnapshot({
          spec,
          run,
          sources,
          actions,
          gates: gates.length ? gates : extractGates(actions),
          memory: { recalled: recalledMemory, written: [] },
          failure
        });
        const wrapped = new LoopFailure({
          code: failure.code || FAILURE_CODES.ADAPTER_INVALID_OUTPUT,
          failedState: failure.failed_state || "running",
          adapterId: actionId,
          message: failure.message || `Action ${actionId} failed.`,
          causedBy: failure.caused_by || [],
          evidenceRefs: failure.evidence_refs || [],
          retryable: failure.retryable
        });
        wrapped.partialActions = actions;
        wrapped.partialGates = gates.length ? gates : extractGates(actions);
        throw wrapped;
      }
      actions.push(action);
      if (action.adapter === "quality_gate_evaluation") gates = action.result.gates || [];
      await this.store.audit(run.run_id, spec.id, "action_completed", `Action ${actionId} completed.`, { adapter: actionId, status: action.status });
      await this.writeEvidenceSnapshot({
        spec,
        run,
        sources,
        actions,
        gates: gates.length ? gates : extractGates(actions),
        memory: { recalled: recalledMemory, written: [] }
      });
      if (action.status === "failed" && action.failure && action.adapter !== "semantic_alignment_review") {
        const failure = new LoopFailure({
          code: action.failure.code || FAILURE_CODES.ADAPTER_INVALID_OUTPUT,
          failedState: "running",
          adapterId: actionId,
          message: action.failure.message || `Action ${actionId} failed.`
        });
        failure.partialActions = actions;
        failure.partialGates = gates.length ? gates : extractGates(actions);
        throw failure;
      }
      assertRuntimeBudgetAfterAction(runtimeBudget, actions, gates);
      if (action.adapter === "candidate_ecosystem_validation" && action.status !== "passed") {
        const repairActions = await this.repairCandidateValidation({
          spec,
          run,
          sources,
          recalledMemory,
          actions,
          gates,
          runtimeBudget
        });
        actions.push(...repairActions);
        const latestValidation = lastActionByAdapter(actions, "candidate_ecosystem_validation");
        if (latestValidation?.status !== "passed") {
          const failure = new LoopFailure({
            code: latestValidation?.failure?.code || FAILURE_CODES.GATE_FAILED,
            failedState: "running",
            adapterId: "candidate_ecosystem_validation",
            message: latestValidation?.failure?.message || "Candidate validation failed after repair attempts."
          });
          failure.partialActions = actions;
          failure.partialGates = gates.length ? gates : extractGates(actions);
          throw failure;
        }
      }
      if (action.adapter === "semantic_alignment_review" && action.status !== "passed") {
        const repairActions = await this.repairCandidateSemanticReview({
          spec,
          run,
          sources,
          recalledMemory,
          actions,
          gates,
          runtimeBudget
        });
        actions.push(...repairActions);
        const latestReview = [...actions].reverse().find((item) => item.adapter === "semantic_alignment_review");
        const latestValidation = lastActionByAdapter(actions, "candidate_ecosystem_validation");
        if (latestValidation?.status && latestValidation.status !== "passed") {
          const failure = new LoopFailure({
            code: latestValidation?.failure?.code || FAILURE_CODES.GATE_FAILED,
            failedState: "running",
            adapterId: "candidate_ecosystem_validation",
            message: latestValidation?.failure?.message || "Candidate validation failed during semantic repair."
          });
          failure.partialActions = actions;
          failure.partialGates = gates.length ? gates : extractGates(actions);
          throw failure;
        }
        if (latestReview?.status !== "passed") {
          const failure = new LoopFailure({
            code: latestReview?.failure?.code || FAILURE_CODES.GATE_FAILED,
            failedState: "running",
            adapterId: "semantic_alignment_review",
            message: latestReview?.failure?.message || "Semantic alignment review failed after repair attempts."
          });
          failure.partialActions = actions;
          failure.partialGates = gates.length ? gates : extractGates(actions);
          throw failure;
        }
      }
    }
    return actions;
  }

  async repairCandidateValidation({ spec, run, sources, recalledMemory, actions, gates, runtimeBudget }) {
    const maxRepairs = boundedRepairLimit(spec, Number(
      spec.pack_config?.candidate_validation?.max_repairs
        ?? spec.pack_config?.code_iteration?.max_validation_repairs
        ?? 1
    ));
    const supplemental = [];
    for (;;) {
      const currentActions = [...actions, ...supplemental];
      const previousRepairs = currentActions.filter((action) => action.id === "host_code_iteration_repair").length;
      const latestValidation = [...currentActions].reverse().find((action) => action.adapter === "candidate_ecosystem_validation");
      const hasFailedCommand = latestValidation?.result?.commands?.some((item) => item?.status !== "passed");
      if (!maxRepairs || previousRepairs >= maxRepairs || !hasFailedCommand) break;

      const repairAttempt = previousRepairs + 1;
      for (const [actionId, label] of [
        ["host_code_iteration", "host_code_iteration_repair"],
        ["candidate_ecosystem_diff", "candidate_ecosystem_diff_repair"],
        ["candidate_ecosystem_validation", "candidate_ecosystem_validation_repair"]
      ]) {
        const action = await this.runSupplementalAction(actionId, {
          spec,
          run,
          sources,
          actions: [...actions, ...supplemental],
          gates,
          recalledMemory,
          orchestratorClient: this.orchestratorClient,
          contextClient: this.contextClient,
          runtimeBudget
        }, label, repairAttempt);
        supplemental.push(action);
        if (action.status === "failed" && action.failure) {
          const failure = new LoopFailure({
            code: action.failure.code || FAILURE_CODES.ADAPTER_INVALID_OUTPUT,
            failedState: "running",
            adapterId: label,
            message: action.failure.message || `Action ${label} failed.`
          });
          failure.partialActions = [...actions, ...supplemental];
          failure.partialGates = gates.length ? gates : extractGates([...actions, ...supplemental]);
          throw failure;
        }
        if (actionId === "candidate_ecosystem_validation" && action.status === "passed") break;
      }
    }
    return supplemental;
  }

  async repairCandidateSemanticReview({ spec, run, sources, recalledMemory, actions, gates, runtimeBudget }) {
    const maxRepairs = boundedRepairLimit(spec, Number(
      spec.pack_config?.semantic_review?.max_repairs
        ?? spec.pack_config?.candidate_validation?.max_semantic_repairs
        ?? 2
    ));
    const supplemental = [];
    for (;;) {
      const currentActions = [...actions, ...supplemental];
      const previousRepairs = currentActions.filter((action) => action.id === "host_code_iteration_semantic_repair").length;
      const latestReview = [...currentActions].reverse().find((action) => action.adapter === "semantic_alignment_review");
      if (!maxRepairs || previousRepairs >= maxRepairs || latestReview?.status === "passed") break;

      const repairAttempt = previousRepairs + 1;
      for (const [actionId, label] of [
        ["host_code_iteration", "host_code_iteration_semantic_repair"],
        ["candidate_ecosystem_diff", "candidate_ecosystem_diff_semantic_repair"],
        ["candidate_ecosystem_validation", "candidate_ecosystem_validation_semantic_repair"],
        ["semantic_alignment_review", "semantic_alignment_review_repair"]
      ]) {
        const action = await this.runSupplementalAction(actionId, {
          spec,
          run,
          sources,
          actions: [...actions, ...supplemental],
          gates,
          recalledMemory,
          orchestratorClient: this.orchestratorClient,
          contextClient: this.contextClient,
          runtimeBudget
        }, label, repairAttempt);
        supplemental.push(action);
        if (action.status === "failed" && action.failure && actionId !== "semantic_alignment_review") {
          const failure = new LoopFailure({
            code: action.failure.code || FAILURE_CODES.ADAPTER_INVALID_OUTPUT,
            failedState: "running",
            adapterId: label,
            message: action.failure.message || `Action ${label} failed.`
          });
          failure.partialActions = [...actions, ...supplemental];
          failure.partialGates = gates.length ? gates : extractGates([...actions, ...supplemental]);
          throw failure;
        }
        if (actionId === "candidate_ecosystem_validation" && action.status !== "passed") break;
        if (actionId === "semantic_alignment_review" && action.status === "passed") break;
      }
    }
    return supplemental;
  }

  async runSupplementalAction(actionId, context, label, repairAttempt) {
    const adapter = this.registry.getAction(actionId);
    if (!adapter) throw new LoopFailure({ code: FAILURE_CODES.CAPABILITY_MISSING, failedState: "running", message: `Missing action adapter ${actionId}.` });
    assertRuntimeBudgetCanStart(context.runtimeBudget, context.actions, actionId);
    const startedAt = new Date().toISOString();
    await this.store.audit(context.run.run_id, context.spec.id, "action_started", `Action ${label} started.`, { adapter: actionId, label, repair_attempt: repairAttempt });
    await this.writeEvidenceSnapshot({
      spec: context.spec,
      run: context.run,
      sources: context.sources,
      actions: [...context.actions, runningActionRecord(label, actionId, startedAt, context.spec, repairAttempt)],
      gates: context.gates,
      memory: { recalled: context.recalledMemory, written: [] }
    });
    try {
      const action = await withRuntimeTimeout(adapter.run(context), runtimeTimeoutForAction(context.runtimeBudget, actionId), actionId);
      const completed = {
        ...action,
        id: label,
        result: {
          ...(action.result || {}),
          repair_attempt: repairAttempt
        }
      };
      await this.store.audit(context.run.run_id, context.spec.id, "action_completed", `Action ${label} completed.`, { adapter: actionId, label, status: completed.status, repair_attempt: repairAttempt });
      await this.writeEvidenceSnapshot({
        spec: context.spec,
        run: context.run,
        sources: context.sources,
        actions: [...context.actions, completed],
        gates: context.gates,
        memory: { recalled: context.recalledMemory, written: [] }
      });
      assertRuntimeBudgetAfterAction(context.runtimeBudget, [...context.actions, completed], context.gates);
      return completed;
    } catch (error) {
      const failure = failureFromError(error, "running");
      failure.adapter_id = failure.adapter_id || label;
      const action = {
        id: label,
        adapter: actionId,
        status: "failed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        autonomy_level: context.spec?.autonomy?.level ?? 0,
        inputs: [],
        outputs: [],
        result: { status: "failed", repair_attempt: repairAttempt },
        failure
      };
      await this.store.audit(context.run.run_id, context.spec.id, "action_completed", `Action ${label} failed.`, { adapter: actionId, label, status: "failed", failure, repair_attempt: repairAttempt });
      await this.writeEvidenceSnapshot({
        spec: context.spec,
        run: context.run,
        sources: context.sources,
        actions: [...context.actions, action],
        gates: context.gates.length ? context.gates : extractGates([...context.actions, action]),
        memory: { recalled: context.recalledMemory, written: [] },
        failure
      });
      return action;
    }
  }

  async writeOutputs(spec, run, context) {
    const outputs = [];
    const report = context.actions.find((action) => action.adapter === "report_generation")?.result?.markdown || context;
    for (const output of spec.outputs || []) {
      const adapter = this.registry.getOutput(output.type);
      if (!adapter) throw new LoopFailure({ code: FAILURE_CODES.CAPABILITY_MISSING, failedState: "collecting_evidence", message: `Missing output adapter ${output.type}.` });
      if (output.type === "context_memory") continue;
      const payload = payloadForOutput(output, context, report);
      const record = await adapter.write({ output, payload, run });
      outputs.push(record);
    }
    return outputs;
  }
}

function applyRuntimeModelOverrides(spec, overrides) {
  if (!overrides || typeof overrides !== "object") return spec;
  const next = JSON.parse(JSON.stringify(spec));
  next.pack_config = next.pack_config || {};
  const normalized = normalizeModelOverrides(overrides);
  if (normalized.builder) {
    next.pack_config.builder_model_policy = {
      ...(next.pack_config.builder_model_policy || {}),
      ...normalized.builder,
      role: normalized.builder.role || "loop_engineer"
    };
  }
  if (normalized.reviewer) {
    next.pack_config.reviewer_model_policy = {
      ...(next.pack_config.reviewer_model_policy || {}),
      ...normalized.reviewer,
      role: normalized.reviewer.role || "independent_reviewer",
      require_distinct_from_builder: normalized.reviewer.require_distinct_from_builder !== false
    };
  }
  if (normalized.research) {
    next.pack_config.research_model_policy = {
      ...(next.pack_config.research_model_policy || {}),
      ...normalized.research,
      role: normalized.research.role || "loop_research"
    };
  }
  next.pack_config.runtime_model_overrides = normalized;
  return next;
}

function normalizeModelOverrides(overrides) {
  const source = overrides.role_model_policies || overrides.roles || overrides;
  return {
    builder: normalizeRoleModelOverride(source.builder || source.loop_engineer || source.developer),
    reviewer: normalizeRoleModelOverride(source.reviewer || source.independent_reviewer || source.acceptance),
    research: normalizeRoleModelOverride(source.research || source.researcher)
  };
}

function normalizeRoleModelOverride(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = {};
  for (const key of ["agent_id", "agent", "provider", "provider_id", "model", "model_id", "temperature", "max_tokens", "timeout_ms", "role", "required", "require_distinct_from_builder"]) {
    if (value[key] !== undefined && value[key] !== null && String(value[key]).trim() !== "") {
      normalized[key] = value[key];
    }
  }
  if (!normalized.provider && normalized.provider_id) normalized.provider = normalized.provider_id;
  if (!normalized.model && normalized.model_id) normalized.model = normalized.model_id;
  if (!normalized.agent_id && normalized.agent) normalized.agent_id = normalized.agent;
  return Object.keys(normalized).length ? normalized : null;
}

function createRuntimeBudgetGuard(spec, run) {
  return {
    policy: normalizeRuntimePolicy(spec),
    startedAtMs: Date.parse(run?.started_at || new Date().toISOString())
  };
}

function assertRuntimeBudgetCanStart(runtimeBudget, actions, adapterId) {
  if (!runtimeBudget) return;
  const usage = runtimeBudgetUsage(actions);
  const breaches = runtimeBudgetBreaches(runtimeBudget, usage);
  if (isModelBackedAdapter(adapterId) && usage.model_calls >= runtimeBudget.policy.budget.max_model_calls) {
    breaches.push({
      id: "max_model_calls",
      message: `Runtime model-call budget exhausted before ${adapterId}.`
    });
  }
  if (breaches.length) throw runtimeBudgetFailure(breaches, usage);
}

function assertRuntimeBudgetAfterAction(runtimeBudget, actions, gates) {
  if (!runtimeBudget) return;
  const usage = runtimeBudgetUsage(actions);
  const breaches = runtimeBudgetBreaches(runtimeBudget, usage);
  if (!breaches.length) return;
  const failure = runtimeBudgetFailure(breaches, usage);
  failure.partialActions = actions;
  failure.partialGates = gates?.length ? gates : extractGates(actions);
  throw failure;
}

function runtimeBudgetBreaches(runtimeBudget, usage) {
  const policy = runtimeBudget.policy;
  const elapsedMs = Math.max(0, Date.now() - runtimeBudget.startedAtMs);
  const breaches = [];
  if (elapsedMs > policy.timeouts.total_run_timeout_ms) {
    breaches.push({
      id: "total_run_timeout_ms",
      message: `Runtime total timeout exceeded: ${elapsedMs}ms > ${policy.timeouts.total_run_timeout_ms}ms.`
    });
  }
  if (usage.model_calls > policy.budget.max_model_calls) {
    breaches.push({
      id: "max_model_calls",
      message: `Runtime model-call budget exceeded: ${usage.model_calls} > ${policy.budget.max_model_calls}.`
    });
  }
  if (usage.candidate_repairs > policy.budget.max_candidate_repairs) {
    breaches.push({
      id: "max_candidate_repairs",
      message: `Runtime candidate-repair budget exceeded: ${usage.candidate_repairs} > ${policy.budget.max_candidate_repairs}.`
    });
  }
  return breaches;
}

function runtimeBudgetFailure(breaches, usage) {
  const ids = breaches.map((item) => item.id).join(", ");
  return new LoopFailure({
    code: FAILURE_CODES.RUNTIME_BUDGET_EXCEEDED,
    failedState: "running",
    message: `Runtime budget exceeded (${ids}).`,
    causedBy: breaches.map((item) => ({ code: item.id, message: item.message })),
    evidenceRefs: ["runtime_budget"],
    retryable: false
  });
}

function runtimeTimeoutForAction(runtimeBudget, adapterId) {
  if (!runtimeBudget) return null;
  const { adapter_timeout_ms, model_timeout_ms } = runtimeBudget.policy.timeouts;
  return isModelBackedAdapter(adapterId)
    ? Math.min(adapter_timeout_ms, model_timeout_ms)
    : adapter_timeout_ms;
}

function isModelBackedAdapter(adapterId) {
  return MODEL_BACKED_ACTIONS.has(adapterId);
}

function boundedRepairLimit(spec, configuredLimit) {
  const runtimeLimit = normalizeRuntimePolicy(spec).budget.max_candidate_repairs;
  if (!Number.isFinite(configuredLimit)) return runtimeLimit;
  return Math.max(0, Math.min(configuredLimit, runtimeLimit));
}

function withRuntimeTimeout(promise, timeoutMs, adapterId) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new LoopFailure({
        code: FAILURE_CODES.ADAPTER_TIMEOUT,
        failedState: "running",
        adapterId,
        message: `Action ${adapterId} exceeded runtime timeout ${timeoutMs}ms.`,
        evidenceRefs: ["runtime_policy.timeouts"],
        retryable: true
      }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function extractGates(actions) {
  const gateAction = actions.find((action) => action.adapter === "quality_gate_evaluation");
  return gateAction?.result?.gates || [];
}

function lastActionByAdapter(actions, adapter) {
  return [...actions].reverse().find((action) => action.adapter === adapter);
}

function runningActionRecord(id, adapter, startedAt, spec, repairAttempt = null) {
    const record = {
    id,
    adapter,
    status: "running",
    started_at: startedAt,
    completed_at: null,
    autonomy_level: spec?.autonomy?.level ?? 0,
    role: roleForAdapter(adapter),
    inputs: [],
    outputs: [],
    result: null
  };
  if (repairAttempt !== null) record.repair_attempt = repairAttempt;
  return record;
}

function collectRisks(actions, gates, failure) {
  const risks = [];
  const latestActionByAdapter = new Map();
  for (const action of actions) {
    latestActionByAdapter.set(action.adapter, action);
  }
  for (const action of latestActionByAdapter.values()) {
    if (action.status === "attention") risks.push({ source: action.adapter, severity: "medium", summary: `${action.adapter} needs attention.` });
  }
  for (const gate of gates) {
    if (gate.status !== "passed") risks.push({ source: gate.id, severity: gate.required ? "high" : "medium", summary: gate.reason });
  }
  if (failure) risks.push({ source: failure.code, severity: "high", summary: failure.message });
  return risks;
}

function payloadForOutput(output, context, report) {
  if (output.type === "markdown_report") return report;
  if (output.type === "media_storyboard") return buildStoryboard(context);
  if (output.type === "video_draft_manifest") return buildVideoDraftManifest(context);
  return context;
}

function buildStoryboard(context) {
  return {
    schema_version: "across-media-storyboard/1.0",
    scenes: context.sources.map((source, index) => ({
      id: `scene-${index + 1}`,
      title: source.result?.title || source.id,
      narration: `Summarize ${source.result?.title || source.id}.`,
      source_refs: [`sources/${source.id}`]
    }))
  };
}

function buildVideoDraftManifest(context) {
  return {
    schema_version: "across-video-draft-manifest/1.0",
    scenes: buildStoryboard(context).scenes,
    timing_hints: { target_seconds: 90 },
    citations: context.sources.map((source) => ({ source_id: source.id, ref: `sources/${source.id}` })),
    publish_required_autonomy_level: 5
  };
}

function pausedFailure(scope, id) {
  return new LoopFailure({
    code: FAILURE_CODES.ADAPTER_DISABLED,
    failedState: "validating_spec",
    message: `${scope} ${id} is paused by kill switch.`,
    recovery: {
      type: "manual_review",
      description: "Review the kill switch state before running this loop.",
      requires_user_action: true
    },
    retryable: false
  });
}
