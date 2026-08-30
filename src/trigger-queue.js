import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { componentDataHome } from "./paths.js";
import { compactTimestamp, stableJson } from "./json-utils.js";

export const TRIGGER_QUEUE_SCHEMA = "across-autopilot-trigger-queue/1.0";
export const TRIGGER_EVENT_SCHEMA = "across-autopilot-trigger-event/1.0";
export const DEFAULT_TRIGGER_CLAIM_LEASE_MS = 2 * 60 * 60 * 1000;
const TRIGGER_CLAIM_LEASE_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PREPARATION_FAILURES = 5;
const DEFAULT_MAX_EXECUTION_INTERRUPTS = 3;
const DEFAULT_MAX_PREPARATION_BACKOFF_MS = 60 * 60 * 1000;

export class TriggerQueue {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.path = resolve(options.triggerQueuePath || join(componentDataHome("across-autopilot", this.env), "trigger-queue.json"));
    this.defaultClaimLeaseMs = positiveNumber(options.defaultClaimLeaseMs) || DEFAULT_TRIGGER_CLAIM_LEASE_MS;
    this.claimLeaseGraceMs = nonNegativeNumber(options.claimLeaseGraceMs) ?? TRIGGER_CLAIM_LEASE_GRACE_MS;
    this.maxPreparationFailures = positiveNumber(options.maxPreparationFailures) || DEFAULT_MAX_PREPARATION_FAILURES;
    this.maxExecutionInterrupts = positiveNumber(options.maxExecutionInterrupts) || DEFAULT_MAX_EXECUTION_INTERRUPTS;
    this.maxPreparationBackoffMs = positiveNumber(options.maxPreparationBackoffMs) || DEFAULT_MAX_PREPARATION_BACKOFF_MS;
  }

  async enqueue(spec, trigger = {}, { now = new Date(), notBefore = null, goalContract = null } = {}) {
    const queue = await this.list({ now });
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
      trigger_event: event,
      goal_contract: goalContract
    };
    queue.items = [item, ...queue.items].slice(0, 500);
    await this.save(queue);
    return item;
  }

  async list({ now = new Date(), recoverExpired = true } = {}) {
    const queue = await this.load();
    if (recoverExpired && this.recoverExpiredClaims(queue, now)) {
      return this.save(queue);
    }
    return queue;
  }

  async claim(triggerId, { now = new Date(), leaseMs = null } = {}) {
    const queue = await this.load();
    this.recoverExpiredClaims(queue, now);
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0) return null;
    const item = queue.items[index];
    if (item.status !== "pending") return null;
    const claimed = this.claimedItem(item, now, leaseMs);
    queue.items[index] = claimed;
    await this.save(queue);
    return claimed;
  }

  async claimNext({ now = new Date(), leaseMs = null } = {}) {
    const queue = await this.load();
    this.recoverExpiredClaims(queue, now);
    const due = queue.items
      .filter((item) => item.status === "pending" && new Date(item.not_before).getTime() <= now.getTime())
      .sort((a, b) => String(a.not_before).localeCompare(String(b.not_before)) || String(a.enqueued_at).localeCompare(String(b.enqueued_at)));
    if (!due.length) return null;
    const index = queue.items.findIndex((item) => item.trigger_id === due[0].trigger_id);
    const claimed = this.claimedItem(queue.items[index], now, leaseMs);
    queue.items[index] = claimed;
    await this.save(queue);
    return claimed;
  }

  async complete(triggerId, patch = {}) {
    const queue = await this.load();
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0) return null;
    const next = {
      ...queue.items[index],
      ...patch,
      claim_lease_expires_at: null,
      completed_at: new Date().toISOString()
    };
    queue.items[index] = next;
    await this.save(queue);
    return next;
  }

  async renewClaim(triggerId, { now = new Date() } = {}) {
    const queue = await this.load();
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0 || queue.items[index].status !== "claimed") return null;
    const item = queue.items[index];
    const renewed = {
      ...item,
      execution_started_at: item.execution_started_at || now.toISOString(),
      claim_lease_expires_at: new Date(now.getTime() + this.claimLeaseMs(item)).toISOString()
    };
    queue.items[index] = renewed;
    await this.save(queue);
    return renewed;
  }

  async attachRun(triggerId, runId) {
    const queue = await this.load();
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0 || queue.items[index].status !== "claimed") return null;
    queue.items[index] = {
      ...queue.items[index],
      run_id: runId,
      execution_started_at: queue.items[index].execution_started_at || new Date().toISOString()
    };
    await this.save(queue);
    return queue.items[index];
  }

  async interruptExecution(triggerId, {
    runId = null,
    failure = null,
    retryAfterMs = 5 * 60 * 1000,
    now = new Date()
  } = {}) {
    const queue = await this.load();
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0 || queue.items[index].status !== "claimed") return null;
    const item = queue.items[index];
    const interruptionCount = Number(item.execution_interruption_count || 0) + 1;
    const exhausted = interruptionCount >= this.maxExecutionInterrupts;
    const baseDelayMs = Math.max(0, nonNegativeNumber(retryAfterMs) ?? 0);
    const delayMs = Math.min(baseDelayMs * (2 ** Math.max(0, interruptionCount - 1)), this.maxPreparationBackoffMs);
    const publicFailure = failure ? { ...failure, retryable: !exhausted } : failure;
    const next = {
      ...item,
      status: exhausted ? "failed" : "pending",
      claimed_at: null,
      claim_lease_expires_at: null,
      execution_started_at: null,
      completed_at: exhausted ? now.toISOString() : null,
      not_before: exhausted ? item.not_before : new Date(now.getTime() + delayMs).toISOString(),
      failure: publicFailure,
      run_id: null,
      last_interrupted_run_id: runId || item.run_id || null,
      execution_interruption_count: interruptionCount,
      execution_retry_exhausted: exhausted,
      last_interrupted_at: now.toISOString(),
      last_interruption_reason: String(failure?.code || "runtime.interrupted")
    };
    queue.items[index] = next;
    await this.save(queue);
    return next;
  }

  async release(triggerId, { failure = null, retryAfterMs = 5 * 60 * 1000, now = new Date() } = {}) {
    const queue = await this.load();
    const index = queue.items.findIndex((item) => item.trigger_id === triggerId);
    if (index < 0) return null;
    const item = queue.items[index];
    if (item.status !== "claimed") return null;
    const preparationFailureCount = Number(item.preparation_failure_count || 0) + 1;
    const exhausted = preparationFailureCount >= this.maxPreparationFailures;
    const baseDelayMs = Math.max(0, nonNegativeNumber(retryAfterMs) ?? 0);
    const delayMs = Math.min(baseDelayMs * (2 ** Math.max(0, preparationFailureCount - 1)), this.maxPreparationBackoffMs);
    const publicFailure = failure ? { ...failure, retryable: !exhausted } : failure;
    const next = {
      ...item,
      status: exhausted ? "failed" : "pending",
      claimed_at: null,
      claim_lease_expires_at: null,
      completed_at: exhausted ? now.toISOString() : null,
      not_before: exhausted ? item.not_before : new Date(now.getTime() + delayMs).toISOString(),
      failure: publicFailure,
      preparation_failure_count: preparationFailureCount,
      preparation_retry_exhausted: exhausted,
      last_released_at: now.toISOString(),
      last_release_reason: String(failure?.code || "preparation_failed")
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

  claimedItem(item, now, requestedLeaseMs = null) {
    const leaseMs = positiveNumber(requestedLeaseMs) || this.claimLeaseMs(item);
    return {
      ...item,
      status: "claimed",
      claimed_at: now.toISOString(),
      claim_lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      claim_attempt_count: Number(item.claim_attempt_count || 0) + 1
    };
  }

  claimLeaseMs(item) {
    const contractedTimeout = positiveNumber(item?.spec_snapshot?.runtime_policy?.timeouts?.total_run_timeout_ms);
    return (contractedTimeout || this.defaultClaimLeaseMs) + this.claimLeaseGraceMs;
  }

  recoverExpiredClaims(queue, now) {
    let changed = false;
    queue.items = queue.items.map((item) => {
      if (item.status !== "claimed") return item;
      const claimedAt = Date.parse(String(item.claimed_at || ""));
      const explicitExpiry = Date.parse(String(item.claim_lease_expires_at || ""));
      const expiresAt = Number.isFinite(explicitExpiry)
        ? explicitExpiry
        : claimedAt + this.claimLeaseMs(item);
      if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) return item;
      changed = true;
      return {
        ...item,
        status: "pending",
        claimed_at: null,
        claim_lease_expires_at: null,
        recovery_count: Number(item.recovery_count || 0) + 1,
        last_recovered_at: now.toISOString(),
        last_recovery_reason: "claim_lease_expired"
      };
    });
    return changed;
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

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
