#!/usr/bin/env node
import { buildCandidatePlan } from "./candidates.js";
import { buildReview, fetchSourceStatuses, loadSources } from "./review.js";
import { loadState } from "./state.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: across-autopilot mcp");
  process.exit(0);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    await handleLine(line);
  }
});

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const id = request.id ?? null;
  try {
    if (request.method === "tools/list") {
      return respond(id, {
        tools: [
          { name: "get_autopilot_status", description: "Return Across Autopilot stable/candidate status." },
          { name: "generate_autopilot_review", description: "Generate a conservative ecosystem review." },
          { name: "create_autopilot_candidate_plan", description: "Create a stable/candidate iteration plan." }
        ]
      });
    }
    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      if (name === "get_autopilot_status") {
        return respondText(id, await loadState());
      }
      if (name === "generate_autopilot_review") {
        const sources = await loadSources();
        const statuses = await fetchSourceStatuses(sources, { fetch: Boolean(args.fetch) });
        return respondText(id, buildReview({ sources, statuses, mode: "mcp" }));
      }
      if (name === "create_autopilot_candidate_plan") {
        return respondText(id, buildCandidatePlan(args));
      }
    }
    respond(id, {});
  } catch (error) {
    respondError(id, error);
  }
}

function respondText(id, payload) {
  respond(id, {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) }
    ]
  });
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error.message || error) } })}\n`);
}

