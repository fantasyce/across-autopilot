import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stableJson } from "./json-utils.js";

export const CANDIDATE_MODEL_LEASE_SCHEMA = "across-candidate-model-lease/1.0";

const DEFAULT_SCOPES = Object.freeze([
  "model.decide",
  "model.research",
  "model.code_patch",
  "model.review",
  "model.chat"
]);

const COMMAND_KEYS = Object.freeze([
  "model_decision",
  "research_decision",
  "code_iteration",
  "review_decision"
]);

export function candidateModelLeasePath(config) {
  return join(config.runtime_home, "candidate-model-lease.json");
}

export async function writeCandidateModelLease({ config, env = process.env }) {
  const lease = buildCandidateModelLease({ config, env });
  if (!lease) return null;
  const path = candidateModelLeasePath(config);
  await writeFile(path, `${stableJson(lease)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return publicCandidateModelLease(lease, path);
}

export function buildCandidateModelLease({ config, env = process.env }) {
  const template = readLeaseTemplate(env);
  if (!template) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = boundedTtl(template.ttl_seconds ?? template.ttlSeconds ?? 12 * 60 * 60);
  const expiresAt = Number(template.expires_at_unix || template.expiresAtUnix || nowSeconds + ttlSeconds);
  const lease = {
    schema_version: CANDIDATE_MODEL_LEASE_SCHEMA,
    lease_id: safeText(template.lease_id) || `lease-${randomUUID()}`,
    candidate_id: config.candidate_id,
    issued_at_unix: Number(template.issued_at_unix || template.issuedAtUnix || nowSeconds),
    expires_at_unix: expiresAt,
    transport: safeText(template.transport) || "host_command",
    issuer: objectOrDefault(template.issuer, { product: "across-agents-assistant", role: "stable-a" }),
    holder: {
      role: "candidate-b",
      runtime_home: config.runtime_home,
      app_home: config.app_home,
      candidate_root: config.base_dir
    },
    host_socket: safeText(template.host_socket || template.hostSocket),
    host_http_url: safeText(template.host_http_url || template.hostHttpUrl),
    scopes: normalizeScopes(template.scopes),
    commands: normalizeCommands(template.commands),
    policy: {
      secrets_included: false,
      raw_credentials_allowed: false,
      candidate_may_store_raw_credentials: false,
      source_mutation_allowed: false
    }
  };
  assertLeaseSafe(lease);
  const hashInput = { ...lease, lease_hash: undefined };
  lease.lease_hash = createHash("sha256").update(stableJson(hashInput)).digest("hex");
  return lease;
}

export function publicCandidateModelLease(lease, path = null) {
  if (!lease) return null;
  return {
    schema_version: lease.schema_version,
    lease_id: lease.lease_id,
    candidate_id: lease.candidate_id,
    issued_at_unix: lease.issued_at_unix,
    expires_at_unix: lease.expires_at_unix,
    transport: lease.transport,
    scopes: lease.scopes,
    host_socket_configured: Boolean(lease.host_socket),
    host_http_configured: Boolean(lease.host_http_url),
    secrets_included: false,
    raw_credentials_allowed: false,
    lease_hash: lease.lease_hash,
    path
  };
}

export function requestCandidateModelLease(leaseSummary) {
  if (!leaseSummary) return null;
  return {
    schema_version: leaseSummary.schema_version,
    lease_id: leaseSummary.lease_id,
    candidate_id: leaseSummary.candidate_id,
    expires_at_unix: leaseSummary.expires_at_unix,
    transport: leaseSummary.transport,
    scopes: leaseSummary.scopes || [],
    host_socket_configured: Boolean(leaseSummary.host_socket_configured),
    host_http_configured: Boolean(leaseSummary.host_http_configured),
    secrets_included: false,
    raw_credentials_allowed: false,
    lease_hash: leaseSummary.lease_hash || null
  };
}

function readLeaseTemplate(env) {
  const raw = env.ACROSS_AAA_CANDIDATE_MODEL_LEASE_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeScopes(value) {
  const scopes = Array.isArray(value) ? value.map(safeText).filter(Boolean) : [];
  const finalScopes = scopes.length ? scopes : [...DEFAULT_SCOPES];
  return [...new Set(finalScopes)].filter((scope) => DEFAULT_SCOPES.includes(scope));
}

function normalizeCommands(value) {
  if (!value || typeof value !== "object") return {};
  const commands = {};
  for (const key of COMMAND_KEYS) {
    const command = Array.isArray(value[key]) ? value[key].map(safeText).filter(Boolean) : [];
    if (command.length) commands[key] = command;
  }
  return commands;
}

function assertLeaseSafe(lease) {
  if (lease.schema_version !== CANDIDATE_MODEL_LEASE_SCHEMA) {
    throw new Error("candidate model lease has unsupported schema");
  }
  if (!lease.host_socket && !lease.host_http_url) {
    throw new Error("candidate model lease requires host_socket or host_http_url");
  }
  if (lease.host_http_url && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/.*)?$/.test(lease.host_http_url)) {
    throw new Error("candidate model lease host_http_url must be local HTTP");
  }
  const serialized = stableJson(lease);
  if (/(api[_-]?key|secret|token|password|credential)\s*[:=]/i.test(serialized)) {
    throw new Error("candidate model lease must not contain raw credential fields");
  }
  if (lease.policy.secrets_included !== false || lease.policy.raw_credentials_allowed !== false) {
    throw new Error("candidate model lease policy must deny raw credentials");
  }
}

function boundedTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 12 * 60 * 60;
  return Math.max(300, Math.min(parsed, 24 * 60 * 60));
}

function objectOrDefault(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function safeText(value) {
  return String(value ?? "").trim();
}
