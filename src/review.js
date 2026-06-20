import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";

const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
export const DEFAULT_SOURCES = join(PACKAGE_ROOT, "sources", "autopilot-sources.json");

export async function loadSources(path = DEFAULT_SOURCES) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  return sources
    .filter((source) => source && source.id && source.name && source.url)
    .map((source) => ({
      id: String(source.id),
      name: String(source.name),
      url: String(source.url),
      area: String(source.area || "general")
    }));
}

export async function fetchSourceStatuses(sources, options = {}) {
  if (!options.fetch) {
    return sources.map((source) => ({ ...source, status: "not_checked", last_modified: "" }));
  }
  const timeoutMs = Number(options.timeoutMs || 5000);
  const statuses = [];
  for (const source of sources) {
    statuses.push(await fetchOneSource(source, timeoutMs));
  }
  return statuses;
}

export function buildReview({ sources, statuses, mode = "local", now = new Date() }) {
  const unavailable = statuses.filter((source) => source.status === "unavailable");
  const focusAreas = [...new Set(sources.map((source) => source.area))].sort();
  const candidateBacklog = [
    {
      id: "autopilot-readonly-radar",
      title: "Keep Autopilot in read-only radar mode until review noise is low",
      target_product: "across-autopilot",
      risk: "low",
      autonomy_level: 1
    },
    {
      id: "autopilot-promotion-evidence",
      title: "Require promotion evidence before any candidate becomes stable",
      target_product: "across-autopilot",
      risk: "medium",
      autonomy_level: 1
    }
  ];
  return {
    schema_version: "across-autopilot-review/1.0",
    generated_at: now.toISOString(),
    mode,
    source_count: sources.length,
    focus_areas: focusAreas,
    source_statuses: statuses,
    findings: [
      {
        id: "stable-candidate-control",
        severity: "required",
        summary: "Use stable/candidate slots so the running stable controller does not modify or approve itself."
      },
      {
        id: "execution-owned-by-orchestrator",
        severity: "required",
        summary: "Delegate implementation work to Across Orchestrator rather than embedding task execution in Autopilot."
      },
      {
        id: "memory-owned-by-context",
        severity: "required",
        summary: "Persist review summaries and decisions through Across Context instead of storing raw chat transcripts."
      }
    ],
    candidate_backlog: candidateBacklog,
    risk_summary: unavailable.length
      ? `${unavailable.length} sources unavailable during this review.`
      : "No source availability risks recorded.",
    automation_policy: {
      default_autonomy_level: 1,
      allowed_without_human_approval: ["report", "candidate_plan", "draft_issue"],
      blocked_without_human_approval: ["merge", "release", "secrets", "signing", "protocol_runtime_change"]
    },
    memory_write_candidates: [
      {
        schema: "across-autopilot-memory/1.0",
        status: "pending",
        scope: "global",
        text: `Autopilot review ${now.toISOString()} covered ${sources.length} sources across ${focusAreas.join(", ")}.`,
        tags: ["autopilot", "ecosystem-review"]
      }
    ]
  };
}

export function renderReviewMarkdown(review) {
  const lines = [
    "# Across Autopilot Review",
    "",
    `Generated at: ${review.generated_at}`,
    `Mode: ${review.mode}`,
    `Sources: ${review.source_count}`,
    "",
    "## Findings",
    ""
  ];
  for (const finding of review.findings) {
    lines.push(`- ${finding.severity}: ${finding.summary}`);
  }
  lines.push("", "## Candidate Backlog", "");
  for (const candidate of review.candidate_backlog) {
    lines.push(`- ${candidate.id}: ${candidate.title} (${candidate.target_product}, ${candidate.risk})`);
  }
  lines.push("", "## Source Status", "");
  for (const source of review.source_statuses) {
    lines.push(`- ${source.name}: ${source.status}`);
    lines.push(`  - ${source.url}`);
  }
  lines.push("", "## Automation Policy", "");
  lines.push(`- Default autonomy level: ${review.automation_policy.default_autonomy_level}`);
  lines.push(`- Blocked without approval: ${review.automation_policy.blocked_without_human_approval.join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

export async function writeReview(review, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderReviewMarkdown(review), "utf8");
  return outputPath;
}

function fetchOneSource(source, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL(source.url);
    const client = url.protocol === "http:" ? http : https;
    const request = client.request(
      url,
      {
        method: "HEAD",
        timeout: timeoutMs,
        headers: {
          "User-Agent": "AcrossAutopilot/0.1",
          "Accept": "text/html,application/json,text/plain;q=0.8,*/*;q=0.5"
        }
      },
      (response) => {
        response.resume();
        resolve({
          ...source,
          status: String(response.statusCode || "unknown"),
          last_modified: response.headers["last-modified"] || ""
        });
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({ ...source, status: "unavailable", last_modified: "", error: "Timeout" });
    });
    request.on("error", (error) => {
      resolve({ ...source, status: "unavailable", last_modified: "", error: error.name });
    });
    request.end();
  });
}

