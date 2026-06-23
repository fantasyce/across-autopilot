import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nowIso, sortJson } from "./json-utils.js";

export async function appendAuditEvent(path, event) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(sortJson(event))}\n`, "utf8");
  return event;
}

export async function readAuditEvents(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function buildAuditEvent({ sequence, runId, specId, type, actor = "autopilot", summary, payload = {}, correlationId = null, now = new Date() }) {
  return {
    event_id: `evt-${String(sequence).padStart(6, "0")}`,
    sequence,
    run_id: runId,
    spec_id: specId,
    timestamp: nowIso(now),
    correlation_id: correlationId || runId,
    actor,
    type,
    summary: summary || type,
    payload
  };
}
