#!/usr/bin/env node
import { AutopilotSupervisor } from "./supervisor.js";
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
    return respondError(null, { code: -32700, message: "Parse error" });
  }
  const id = request.id ?? null;
  try {
    const supervisor = new AutopilotSupervisor();
    if (request.method === "tools/list") {
      return respond(id, {
        tools: [
          { name: "get_autopilot_status", description: "Return Across Autopilot stable/candidate status." },
          { name: "validate_loop_spec", description: "Validate a LoopSpec." },
          { name: "dry_run_loop", description: "Dry run a LoopSpec without executing adapters." },
          { name: "run_loop", description: "Run a LoopSpec through the Autopilot supervisor." },
          { name: "enqueue_loop_trigger", description: "Persist a replayable trigger for a LoopSpec with idempotency." },
          { name: "get_loop_trigger_queue", description: "Return the durable Autopilot trigger queue." },
          { name: "run_next_loop_trigger", description: "Claim and execute one queued trigger." },
          { name: "get_loop_run_status", description: "Get loop run status." },
          { name: "get_loop_run_evidence", description: "Get loop run evidence envelope." },
          { name: "get_loop_run_events", description: "Get loop run audit events." },
          { name: "cancel_loop_run", description: "Cancel a loop run." },
          { name: "list_loop_specs", description: "List registered and built-in LoopSpecs." },
          { name: "list_loop_runs", description: "List loop runs." },
          { name: "migrate_loop_spec", description: "Migrate and validate a LoopSpec." },
          { name: "get_loop_telemetry", description: "Get aggregate loop telemetry." },
          { name: "set_loop_spec_paused", description: "Pause or resume a LoopSpec." },
          { name: "set_adapter_paused", description: "Pause or resume an adapter." },
          { name: "quarantine_loop_output", description: "Quarantine a generated output." }
        ]
      });
    }
    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      if (name === "get_autopilot_status") {
        return respondText(id, await loadState());
      }
      if (name === "validate_loop_spec") return respondText(id, await supervisor.validateSpec(required(args.spec)));
      if (name === "dry_run_loop") return respondText(id, await supervisor.dryRun(required(args.spec)));
      if (name === "run_loop") return respondText(id, await supervisor.run(required(args.spec)));
      if (name === "enqueue_loop_trigger") return respondText(id, await supervisor.enqueueTrigger(required(args.spec), {
        type: args.type || "manual",
        source: args.source || args.type || "manual",
        actor: args.actor || "mcp-client",
        payload: args.payload || {},
        idempotency_key: args.idempotency_key,
        not_before: args.not_before,
        replay_hint: args.replay_hint
      }));
      if (name === "get_loop_trigger_queue") return respondText(id, await supervisor.triggerQueueStatus());
      if (name === "run_next_loop_trigger") return respondText(id, await supervisor.runQueuedTrigger(args.trigger_id || null));
      if (name === "get_loop_run_status") return respondText(id, await supervisor.status(required(args.run_id)));
      if (name === "get_loop_run_evidence") return respondText(id, await supervisor.evidence(required(args.run_id)));
      if (name === "get_loop_run_events") return respondText(id, await supervisor.events(required(args.run_id), { afterSequence: args.after_sequence }));
      if (name === "cancel_loop_run") return respondText(id, await supervisor.cancel(required(args.run_id), args.reason || "cancelled"));
      if (name === "list_loop_specs") return respondText(id, await supervisor.store.loadRegistry());
      if (name === "list_loop_runs") return respondText(id, await supervisor.listRuns());
      if (name === "migrate_loop_spec") return respondText(id, (await supervisor.validateSpec(required(args.spec))).migration);
      if (name === "get_loop_telemetry") return respondText(id, await supervisor.telemetry());
      if (name === "set_loop_spec_paused") return respondText(id, await supervisor.setSpecPaused(required(args.spec_id), Boolean(args.paused)));
      if (name === "set_adapter_paused") return respondText(id, await supervisor.setAdapterPaused(required(args.adapter_id), Boolean(args.paused)));
      if (name === "quarantine_loop_output") return respondText(id, await supervisor.quarantineOutput(required(args.run_id), required(args.output_id)));
    }
    respond(id, {});
  } catch (error) {
    respondError(id, error);
  }
}

function required(value) {
  if (!value) throw new Error("Required argument missing.");
  return value;
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
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: Number.isInteger(error.code) ? error.code : -32000,
      message: String(error.message || error)
    }
  })}\n`);
}
