import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { componentDataHome } from "./paths.js";
import { appendAuditEvent, buildAuditEvent, readAuditEvents } from "./audit-log.js";
import { compactTimestamp, stableJson } from "./json-utils.js";
import { normalizeTriggerEvent } from "./trigger-queue.js";

export class RunStore {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.root = resolve(options.root || join(componentDataHome("across-autopilot", this.env), "runs"));
    this.registryPath = resolve(options.registryPath || join(componentDataHome("across-autopilot", this.env), "registry.json"));
    this.controlPath = resolve(options.controlPath || join(componentDataHome("across-autopilot", this.env), "control.json"));
  }

  async createRun(spec, { now = new Date(), trigger = "manual" } = {}) {
    const runId = `run-${compactTimestamp(now)}-${spec.id}`;
    const dir = this.runDir(runId);
    await mkdir(join(dir, "sandbox"), { recursive: true });
    await mkdir(join(dir, "outputs"), { recursive: true });
    const triggerEvent = normalizeTriggerEvent(trigger, spec, now);
    const run = {
      schema_version: "across-autopilot-run/1.0",
      run_id: runId,
      spec_id: spec.id,
      state: "created",
      status: "running",
      trigger: triggerEvent.type,
      trigger_event: triggerEvent,
      attempt: 1,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      started_at: null,
      completed_at: null,
      sandbox: join(dir, "sandbox"),
      outputs_dir: join(dir, "outputs"),
      orchestrator_tasks: [],
      memory_ids: [],
      failure: null,
      warnings: []
    };
    await this.writeJson(join(dir, "spec.json"), spec);
    await this.writeJson(join(dir, "run.json"), run);
    await this.writeJson(join(dir, "plan.json"), {});
    await this.writeJson(join(dir, "evidence.json"), {});
    await this.audit(runId, spec.id, "run_created", "Run created.", { trigger: triggerEvent });
    return run;
  }

  runDir(runId) {
    return join(this.root, runId);
  }

  async loadRun(runId) {
    return this.readJson(join(this.runDir(runId), "run.json"));
  }

  async loadSpec(runId) {
    return this.readJson(join(this.runDir(runId), "spec.json"));
  }

  async updateRun(runId, patch) {
    const run = await this.loadRun(runId);
    const next = { ...run, ...patch, updated_at: new Date().toISOString() };
    await this.writeJson(join(this.runDir(runId), "run.json"), next);
    return next;
  }

  async transition(runId, state, summary, payload = {}) {
    const run = await this.updateRun(runId, { state });
    await this.audit(runId, run.spec_id, `state_${state}`, summary || `State changed to ${state}.`, payload);
    return run;
  }

  async writePlan(runId, plan) {
    await this.writeJson(join(this.runDir(runId), "plan.json"), plan);
    return plan;
  }

  async writeEvidence(runId, evidence) {
    await this.writeJson(join(this.runDir(runId), "evidence.json"), evidence);
    return evidence;
  }

  async loadEvidence(runId) {
    return this.readJson(join(this.runDir(runId), "evidence.json"));
  }

  async audit(runId, specId, type, summary, payload = {}) {
    const events = await readAuditEvents(join(this.runDir(runId), "audit.jsonl"));
    const event = buildAuditEvent({
      sequence: events.length + 1,
      runId,
      specId,
      type,
      summary,
      payload
    });
    return appendAuditEvent(join(this.runDir(runId), "audit.jsonl"), event);
  }

  async events(runId, { afterSequence = null } = {}) {
    const events = await readAuditEvents(join(this.runDir(runId), "audit.jsonl"));
    if (afterSequence === null || afterSequence === undefined) return events;
    return events.filter((event) => Number(event.sequence || 0) > Number(afterSequence));
  }

  async listRuns() {
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(this.root, { withFileTypes: true });
      const runs = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          runs.push(await this.loadRun(entry.name));
        } catch {
          continue;
        }
      }
      return runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    } catch {
      return [];
    }
  }

  async registerSpec(spec, sourcePath = null) {
    const registry = await this.loadRegistry();
    const record = {
      id: spec.id,
      name: spec.name,
      schema_version: spec.schema_version,
      source_path: sourcePath,
      registered_at: new Date().toISOString(),
      paused: false
    };
    registry.specs = [record, ...(registry.specs || []).filter((item) => item.id !== spec.id)];
    await this.writeJson(this.registryPath, registry);
    return record;
  }

  async loadRegistry() {
    try {
      const registry = await this.readJson(this.registryPath);
      registry.specs = Array.isArray(registry.specs) ? registry.specs : [];
      return registry;
    } catch {
      return { schema_version: "across-autopilot-registry/1.0", specs: [] };
    }
  }

  async loadControl() {
    try {
      return await this.readJson(this.controlPath);
    } catch {
      return {
        schema_version: "across-autopilot-control/1.0",
        global_paused: false,
        paused_specs: [],
        paused_adapters: [],
        quarantined_outputs: []
      };
    }
  }

  async saveControl(control) {
    await this.writeJson(this.controlPath, {
      schema_version: "across-autopilot-control/1.0",
      global_paused: Boolean(control.global_paused),
      paused_specs: Array.isArray(control.paused_specs) ? control.paused_specs : [],
      paused_adapters: Array.isArray(control.paused_adapters) ? control.paused_adapters : [],
      quarantined_outputs: Array.isArray(control.quarantined_outputs) ? control.quarantined_outputs : []
    });
    return this.loadControl();
  }

  async setSpecPaused(specId, paused) {
    const control = await this.loadControl();
    const ids = new Set(control.paused_specs || []);
    if (paused) ids.add(specId);
    else ids.delete(specId);
    return this.saveControl({ ...control, paused_specs: [...ids].sort() });
  }

  async setAdapterPaused(adapterId, paused) {
    const control = await this.loadControl();
    const ids = new Set(control.paused_adapters || []);
    if (paused) ids.add(adapterId);
    else ids.delete(adapterId);
    return this.saveControl({ ...control, paused_adapters: [...ids].sort() });
  }

  async quarantineOutput(runId, outputId) {
    const control = await this.loadControl();
    const entry = { run_id: runId, output_id: outputId, quarantined_at: new Date().toISOString() };
    await this.audit(runId, (await this.loadRun(runId)).spec_id, "output_quarantined", "Output quarantined.", entry);
    return this.saveControl({
      ...control,
      quarantined_outputs: [entry, ...(control.quarantined_outputs || [])]
    });
  }

  async writeJson(path, payload) {
    await mkdir(dirname(resolve(path)), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${stableJson(payload)}\n`, "utf8");
    await rename(tmp, path);
  }

  async readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
  }

  async clear() {
    await rm(this.root, { recursive: true, force: true });
  }
}
