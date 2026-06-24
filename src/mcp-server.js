#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAgentPluginRunPlan, normalizeAgentPluginManifest } from "./agent-plugin-contract.js";
import { superviseAgentPluginSession } from "./host-session-supervisor.js";
import { AutopilotSupervisor } from "./supervisor.js";
import { loadState } from "./state.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: across-autopilot mcp");
  process.exit(0);
}

const AGENT_PLUGIN_MANIFEST_SCHEMA = {
  type: "object",
  description: "across-agent-plugin/1.0 manifest. Keep arrays flat; do not wrap capabilities, inputs, outputs, or tags in nested arrays.",
  properties: {
    schema_version: { type: "string", enum: ["across-agent-plugin/1.0"] },
    plugin_id: { type: "string", description: "Stable plugin id. Alias: id." },
    id: { type: "string", description: "Alias for plugin_id." },
    display_name: { type: "string" },
    version: { type: "string" },
    agent: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        vendor: { type: "string" }
      }
    },
    agent_id: { type: "string", description: "Alias for agent.id." },
    capabilities: {
      type: "array",
      description: "Flat capability list. Each item may be a string id or an object with id, kind, risk, description.",
      items: {
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              risk: { type: "string" },
              description: { type: "string" }
            },
            required: ["id"]
          }
        ]
      }
    },
    entrypoints: {
      type: "object",
      description: "Map entrypoint names to command or url specs. Use run for dispatch-capable plugins.",
      additionalProperties: {
        type: "object",
        properties: {
          command: {
            type: "array",
            description: "Direct executable argv array, not a shell string. Example: [\"printf\", \"ready\\n\"].",
            items: { type: "string" }
          },
          url: { type: "string", description: "Localhost http URL or https URL." },
          transport: { type: "string", enum: ["stdio", "http"] }
        }
      }
    },
    trust: {
      type: "object",
      properties: {
        mutation_boundary: {
          type: "string",
          enum: ["read_only", "candidate_workspace", "host_approved_mutation", "network_only", "manual_only"]
        },
        requires_human_approval: { type: "boolean" },
        secrets_included: { type: "boolean" },
        network_access: { type: "string" },
        credential_boundary: { type: "string" }
      }
    },
    context: {
      type: "object",
      properties: {
        pack_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      }
    }
  },
  required: ["schema_version", "plugin_id", "entrypoints"]
};

const VALIDATION_CONTRACT_SCHEMA = {
  type: "object",
  description: "across-validation-contract/1.0 generic artifact validation contract. Domain rules are host-supplied; Autopilot does not hard-code business fields.",
  properties: {
    schema_version: { type: "string", enum: ["across-validation-contract/1.0"] },
    check_action: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]{0,63}_check$",
      description: "Host-declared *_check action that should consume this contract, for example business_contract_check."
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          required: { type: "boolean" },
          type: { type: "string", enum: ["json", "csv", "markdown", "text"] },
          columns: { type: "array", items: { type: "string" } },
          row_count: { type: "integer" },
          min_rows: { type: "integer" },
          sort: {
            type: "array",
            description: "Ordered sort keys. The validator compares the full key list lexicographically, so later keys break ties from earlier keys.",
            items: { type: "object" }
          },
          row_expectations: { type: "array", items: { type: "object" } },
          required_keys: { type: "array", items: { type: "string" } },
          must_include: { type: "array", items: { type: "string" } },
          must_not_include: { type: "array", items: { type: "string" } }
        },
        required: ["path"]
      }
    }
  }
};

const HOST_COMMAND_SCHEMA = {
  anyOf: [
    { type: "array", items: { type: "string" } },
    {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" } },
        command: { type: "array", items: { type: "string" } },
        stdin: { type: "string" },
        stdin_path: { type: "string" },
        stdout_path: { type: "string" },
        stderr_path: { type: "string" }
      }
    }
  ]
};

const HOST_COMPLETION_CONTRACT_SCHEMA = {
  type: "object",
  description: "across-host-completion-contract/1.0. Autopilot checks these host-session milestones after each attempt and can issue a continuation when they are missing.",
  properties: {
    schema_version: { type: "string", enum: ["across-host-completion-contract/1.0"] },
    required_files: { type: "array", items: { type: "string" } },
    required_artifacts: { type: "array", items: { type: "string" } },
    required_json_values: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          pointer: { type: "string" },
          equals: {}
        },
        required: ["path", "pointer"]
      }
    },
    required_observed_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          action_type: { type: "string" }
        },
        required: ["action_type"]
      }
    }
  }
};

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
    if (request.method === "initialize") {
      return respond(id, {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {},
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: {
          name: "Across Autopilot",
          version: "0.2.1"
        }
      });
    }
    if (request.method === "notifications/initialized") {
      return;
    }
    const supervisor = new AutopilotSupervisor();
    if (request.method === "tools/list") {
      return respond(id, {
        tools: [
          { name: "get_autopilot_status", description: "Return Across Autopilot stable/candidate status." },
          { name: "validate_loop_spec", description: "Validate a LoopSpec." },
          { name: "dry_run_loop", description: "Dry run a LoopSpec without executing adapters." },
          { name: "run_loop", description: "Run a LoopSpec through the Autopilot supervisor." },
          {
            name: "validate_agent_plugin",
            description: "Validate and normalize an across-agent-plugin/1.0 manifest.",
            inputSchema: {
              type: "object",
              properties: {
                manifest: AGENT_PLUGIN_MANIFEST_SCHEMA,
                manifest_path: { type: "string" }
              }
            }
          },
          {
            name: "plan_agent_plugin_run",
            description: "Build a dry-run Autopilot plan for a generic external agent plugin.",
            inputSchema: {
              type: "object",
              properties: {
                manifest: AGENT_PLUGIN_MANIFEST_SCHEMA,
                manifest_path: { type: "string" },
                goal: { type: "string" },
                trigger: { type: "string" },
                validation_contract: VALIDATION_CONTRACT_SCHEMA,
                validationContract: VALIDATION_CONTRACT_SCHEMA
              }
            }
          },
          {
            name: "supervise_agent_plugin_session",
            description: "Run a generic host-agent session, check completion milestones, and automatically issue continuation attempts when the host exits early or artifacts fail the contract.",
            inputSchema: {
              type: "object",
              properties: {
                cwd: { type: "string" },
                projectRoot: { type: "string" },
                initial_command: HOST_COMMAND_SCHEMA,
                initialCommand: HOST_COMMAND_SCHEMA,
                resume_command: HOST_COMMAND_SCHEMA,
                resumeCommand: HOST_COMMAND_SCHEMA,
                validation_contract: VALIDATION_CONTRACT_SCHEMA,
                validationContract: VALIDATION_CONTRACT_SCHEMA,
                completion_contract: HOST_COMPLETION_CONTRACT_SCHEMA,
                completionContract: HOST_COMPLETION_CONTRACT_SCHEMA,
                max_attempts: { type: "integer", minimum: 1, maximum: 6 },
                timeout_ms: { type: "integer", minimum: 1000, maximum: 900000 }
              },
              required: ["initial_command"]
            }
          },
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
        ].map(withDefaultInputSchema)
      });
    }
    if (request.method === "resources/list") {
      return respond(id, { resources: [] });
    }
    if (request.method === "prompts/list") {
      return respond(id, { prompts: [] });
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
      if (name === "validate_agent_plugin") return respondText(id, normalizeAgentPluginManifest(await loadAgentPluginManifest(args)));
      if (name === "plan_agent_plugin_run") {
        return respondText(id, buildAgentPluginRunPlan({
          manifest: await loadAgentPluginManifest(args),
          goal: args.goal || "",
          trigger: args.trigger || "mcp",
          validationContract: args.validation_contract || args.validationContract
        }));
      }
      if (name === "supervise_agent_plugin_session") return respondText(id, await superviseAgentPluginSession(args));
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

async function loadAgentPluginManifest(args = {}) {
  if (args.manifest) return args.manifest;
  if (args.manifest_path) return JSON.parse(await readFile(resolve(args.manifest_path), "utf8"));
  throw new Error("Required argument missing: manifest or manifest_path.");
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

function withDefaultInputSchema(tool) {
  return {
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    },
    ...tool
  };
}
