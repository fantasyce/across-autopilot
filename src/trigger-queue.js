import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { componentDataHome } from "./paths.js";
import { compactTimestamp, stableJson } from "./json-utils.js";

export const TRIGGER_QUEUE_SCHEMA = "across-autopilot-trigger-queue/1.0";
export const TRIGGER_EVENT_SCHEMA = "across-autopilot-trigger-event/1.0";

export class TriggerQueue {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.path = resolve(options.triggerQueuePath || join(componentDataHome("across-autopilot", this.env), "trigger-queue.json"));
  }

  async enqueue(spec, trigger = {}, { now = new Date(), notBefore = null } = {}) {
    const queue = await this.load();
    const event = normalizeTriggerEvent(trigger, spec, now);
    const idempotencyKey = String(trigger.idempotency_key || event.idempotency_key || defaultIdempotencyKey(spec, event));
    const existing = queue.items.find((item) => item.idempotency_key === idempotencyKey && ["pending", "claimed", "running"].includes(item.status));
    if (existing) {
      return {
        ...existing,
        duplicate: true
      };
    }
    const item = {
      schema_version: "across-autopilot-trigger-queue-item/1.0",
      trigger_id: `trg-${compactTimestamp(now)}-${sha256(`${spec.id}:${idempotencyKey}`).slice(0, 12)}`,
      spec_id: spec.id,
      spec_source: trigger.spec_source || spec.id,
      spec_snapshot: spec,
      status: "pending",
      idempotency_key: idempotencyKey,
      not_before: new Date(notBefore || trigger.not_before || now).toISOString(),
      enqueued_at: now.toISOString(),
      claimed_at: null,
      completed_at: null,
      run_id: null,
      failure: null,
      trigger_event: event
    };
    queue.items = [item, ...queue.items].slice(0, 500);
    await this.save(queue);
    return item;
  }

  async list() {
    return this.load();
  }

  async claim(triggerId, { now = new Date() } = {}) {
    const queue = await this.load();
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0) return null;
    const item = queue.items[index];
    if (item.status !== "pending") return null;
    const claimed = {
      ...item,
      status: "claimed",
      claimed_at: now.toISOString()
    };
    queue.items[index] = claimed;
    await this.save(queue);
    return claimed;
  }

  async claimNext({ now = new Date() } = {}) {
    const queue = await this.load();
    const due = queue.items
      .filter((item) => item.status === "pending" && new Date(item.not_before).getTime() <= now.getTime())
      .sort((a, b) => String(a.not_before).localeCompare(String(b.not_before)) || String(a.enqueued_at).localeCompare(String(b.enqueued_at)));
    if (!due.length) return null;
    return this.claim(due[0].trigger_id, { now });
  }

  async complete(triggerId, patch = {}) {
    const queue = await this.load();
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0) return null;
    const next = {
      ...queue.items[index],
      ...patch,
      completed_at: new Date().toISOString()
    };
    queue.items[index] = next;
    await this.save(queue);
    return next;
  }

  async load() {
    try {
      const queue = JSON.parse(await readFile(this.path, "utf8"));
      return normalizeQueue(queue);
    } catch {
      return normalizeQueue({});
    }
  }

  async save(queue) {
    const normalized = normalizeQueue(queue);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${stableJson(normalized)}\n`, "utf8");
    await rename(tmp, this.path);
    return normalized;
  }
}

export function normalizeTriggerEvent(trigger, spec, now = new Date()) {
  const base = typeof trigger === "object" && trigger !== null
    ? { ...trigger }
    : { type: trigger || spec.trigger?.type || "manual" };
  const type = String(base.type || spec.trigger?.type || "manual");
  const payload = base.payload && typeof base.payload === "object" ? base.payload : parsePayloadJson(base.payload_json);
  const payloadJson = stableJson(payload);
  return {
    schema_version: TRIGGER_EVENT_SCHEMA,
    type,
    source: String(base.source || type),
    actor: String(base.actor || "local-user"),
    received_at: now.toISOString(),
    payload_hash: sha256(payloadJson),
    replayable: base.replayable !== false,
    replay_hint: base.replay_hint || null,
    idempotency_key: base.idempotency_key || null,
    payload
  };
}

function normalizeQueue(queue) {
  return {
    schema_version: TRIGGER_QUEUE_SCHEMA,
    updated_at: new Date().toISOString(),
    items: Array.isArray(queue.items) ? queue.items : []
  };
}

function defaultIdempotencyKey(spec, event) {
  return `${spec.id}:${event.type}:${event.source}:${event.payload_hash}`;
}

function parsePayloadJson(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}
