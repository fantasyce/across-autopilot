#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCandidatePlan, buildPromotionReport, createCandidate, evaluateCandidate } from "./candidates.js";
import { installHostPlugin, uninstallHostPlugin } from "./installers.js";
import { loadBuiltInSpecs } from "./loop-spec.js";
import { renderHealth, renderPluginManifest, renderPluginStatus } from "./plugin-manifest.js";
import { buildReview, fetchSourceStatuses, loadSources, writeReview } from "./review.js";
import { latestCandidate, loadState, recordCandidate, saveState } from "./state.js";
import { AutopilotSupervisor } from "./supervisor.js";

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "status") {
    const parsed = parseArgs(rest);
    return printPayload(await loadState({ env: process.env }), parsed);
  }

  if (command === "loop") {
    return handleLoopCommand(rest);
  }

  if (command === "adapter") {
    return handleAdapterCommand(rest);
  }

  if (command === "review") {
    const parsed = parseArgs(rest);
    if (parsed.json) {
      const supervisor = new AutopilotSupervisor();
      const result = await supervisor.run("github-plugin-radar", { trigger: "legacy-review" });
      return printPayload({
        schema_version: "across-autopilot-legacy-wrapper/1.0",
        command: "review",
        deprecated: true,
        replacement: "across-autopilot loop run --spec examples/github-plugin-radar.loop.json --json",
        run: result.run,
        evidence: result.evidence
      }, parsed);
    }
    const sources = await loadSources(parsed.sources ? resolve(parsed.sources) : undefined);
    const statuses = await fetchSourceStatuses(sources, { fetch: Boolean(parsed.fetch) });
    const review = buildReview({ sources, statuses, mode: parsed.mode || "local" });
    if (parsed.output) {
      await writeReview(review, resolve(parsed.output));
    }
    return printPayload(review, parsed);
  }

  if (command === "candidate-plan") {
    const parsed = parseArgs(rest);
    if (parsed.json) {
      const supervisor = new AutopilotSupervisor();
      return printPayload({
        schema_version: "across-autopilot-legacy-wrapper/1.0",
        command: "candidate-plan",
        deprecated: true,
        replacement: "across-autopilot loop dry-run --spec <built-in pack or user spec> --json",
        dry_run: await supervisor.dryRun(parsed.spec || "github-plugin-radar")
      }, parsed);
    }
    return printPayload(buildCandidatePlan({
      goal: parsed.goal || parsed.positionals.join(" "),
      targetProduct: parsed["target-product"] || parsed.target_product
    }), parsed);
  }

  if (command === "create-candidate") {
    const parsed = parseArgs(rest);
    if (parsed.json) {
      const supervisor = new AutopilotSupervisor();
      const result = await supervisor.run(parsed.spec || "github-plugin-radar", { trigger: "legacy-create-candidate" });
      return printPayload({
        schema_version: "across-autopilot-legacy-wrapper/1.0",
        command: "create-candidate",
        deprecated: true,
        replacement: "across-autopilot loop run --spec <built-in pack or user spec> --json",
        run: result.run,
        evidence: result.evidence
      }, parsed);
    }
    const candidate = createCandidate({
      goal: parsed.goal || parsed.positionals.join(" "),
      targetProduct: parsed["target-product"] || parsed.target_product,
      baseVersion: parsed["base-version"] || parsed.base_version,
      targetVersion: parsed["target-version"] || parsed.target_version
    });
    await recordCandidate(candidate, { env: process.env });
    return printPayload(candidate, parsed);
  }

  if (command === "evaluate-candidate") {
    const parsed = parseArgs(rest);
    if (parsed["run-id"]) {
      const supervisor = new AutopilotSupervisor();
      return printPayload(await supervisor.evidence(parsed["run-id"]), parsed);
    }
    const state = await loadState({ env: process.env });
    const candidate = selectCandidate(state, parsed.candidate);
    const evidence = parsed.evidence ? JSON.parse(await readFile(resolve(parsed.evidence), "utf8")) : candidate.evidence || [];
    const evaluated = evaluateCandidate(candidate, evidence);
    await recordCandidate(evaluated, { env: process.env });
    return printPayload(evaluated, parsed);
  }

  if (command === "promotion-report") {
    const parsed = parseArgs(rest);
    if (parsed["run-id"]) {
      const supervisor = new AutopilotSupervisor();
      const evidence = await supervisor.evidence(parsed["run-id"]);
      return printPayload({
        schema_version: "across-autopilot-promotion-report/2.0",
        run_id: parsed["run-id"],
        readiness: evidence.status === "completed" && !evidence.risks?.length ? "ready" : "attention",
        gates: evidence.gates,
        outputs: evidence.outputs,
        memory: evidence.memory
      }, parsed);
    }
    const state = await loadState({ env: process.env });
    const candidate = selectCandidate(state, parsed.candidate);
    return printPayload(buildPromotionReport(candidate, state.stable_slot), parsed);
  }

  if (command === "plugin-manifest" || command === "agent-card") {
    const parsed = parseArgs(rest);
    return printPayload(await renderPluginManifest(commandOptions(parsed)), parsed);
  }

  if (command === "plugin-status") {
    const parsed = parseArgs(rest);
    return printPayload(await renderPluginStatus(commandOptions(parsed)), parsed);
  }

  if (command === "health") {
    const parsed = parseArgs(rest);
    return printPayload(await renderHealth(commandOptions(parsed)), parsed);
  }

  if (command === "install" && rest[0] === "host-plugin") {
    const parsed = parseArgs(rest.slice(1));
    return printPayload(await installHostPlugin(commandOptions(parsed)), parsed);
  }

  if (command === "uninstall" && rest[0] === "host-plugin") {
    const parsed = parseArgs(rest.slice(1));
    return printPayload(await uninstallHostPlugin(commandOptions(parsed)), parsed);
  }

  if (command === "mcp") {
    await import("./mcp-server.js");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function handleLoopCommand(args) {
  const [subcommand, ...rest] = args;
  const parsed = parseArgs(rest);
  const supervisor = new AutopilotSupervisor();
  const spec = parsed.spec || parsed.positionals[0];
  if (subcommand === "validate") return printPayload(await supervisor.validateSpec(required(spec, "--spec")), parsed);
  if (subcommand === "dry-run") return printPayload(await supervisor.dryRun(required(spec, "--spec"), { modelOverrides: modelOverridesFromParsed(parsed) }), parsed);
  if (subcommand === "run") return printPayload(await supervisor.run(required(spec, "--spec"), { trigger: parsed.trigger || "manual", modelOverrides: modelOverridesFromParsed(parsed) }), parsed);
  if (subcommand === "enqueue-trigger") {
    return printPayload(await supervisor.enqueueTrigger(required(spec, "--spec"), triggerOptions(parsed)), parsed);
  }
  if (subcommand === "trigger-queue") return printPayload(await supervisor.triggerQueueStatus(), parsed);
  if (subcommand === "run-trigger") return printPayload(await supervisor.runQueuedTrigger(parsed["trigger-id"] || null), parsed);
  if (subcommand === "status") return printPayload(await supervisor.status(required(parsed["run-id"], "--run-id")), parsed);
  if (subcommand === "evidence") return printPayload(await supervisor.evidence(required(parsed["run-id"], "--run-id")), parsed);
  if (subcommand === "events") return printPayload(await supervisor.events(required(parsed["run-id"], "--run-id"), { afterSequence: parsed["after-sequence"] ? Number(parsed["after-sequence"]) : null }), parsed);
  if (subcommand === "cancel") return printPayload(await supervisor.cancel(required(parsed["run-id"], "--run-id"), parsed.reason || "cancelled"), parsed);
  if (subcommand === "retry") return printPayload(await supervisor.retry(required(parsed["run-id"], "--run-id")), parsed);
  if (subcommand === "list") return printPayload(await supervisor.listRuns(), parsed);
  if (subcommand === "register") return printPayload(await supervisor.registerSpec(required(spec, "--spec")), parsed);
  if (subcommand === "registry") {
    const registry = await supervisor.store.loadRegistry();
    return printPayload({
      schema_version: "across-autopilot-loop-registry/1.0",
      built_in: await loadBuiltInSpecs(),
      registered: Array.isArray(registry.specs) ? registry.specs : []
    }, parsed);
  }
  if (subcommand === "migrate-spec") return printPayload((await supervisor.validateSpec(required(spec, "--spec"))).migration, parsed);
  if (subcommand === "telemetry") return printPayload(await supervisor.telemetry(), parsed);
  if (subcommand === "pause") return printPayload(await supervisor.setSpecPaused(required(parsed["spec-id"], "--spec-id"), true), parsed);
  if (subcommand === "resume") return printPayload(await supervisor.setSpecPaused(required(parsed["spec-id"], "--spec-id"), false), parsed);
  if (subcommand === "quarantine-output") return printPayload(await supervisor.quarantineOutput(required(parsed["run-id"], "--run-id"), required(parsed.output, "--output")), parsed);
  throw new Error(`Unknown loop command: ${subcommand || ""}`);
}

async function handleAdapterCommand(args) {
  const [subcommand, ...rest] = args;
  const parsed = parseArgs(rest);
  const supervisor = new AutopilotSupervisor();
  if (subcommand === "pause") return printPayload(await supervisor.setAdapterPaused(required(parsed["adapter-id"], "--adapter-id"), true), parsed);
  if (subcommand === "resume") return printPayload(await supervisor.setAdapterPaused(required(parsed["adapter-id"], "--adapter-id"), false), parsed);
  throw new Error(`Unknown adapter command: ${subcommand || ""}`);
}

function selectCandidate(state, candidateId) {
  const candidates = state.candidates || [];
  const candidate = candidateId
    ? candidates.find((item) => item.candidate_id === candidateId)
    : latestCandidate(state);
  if (!candidate) {
    throw new Error("No candidate found. Run create-candidate first.");
  }
  return candidate;
}

function commandOptions(parsed) {
  return {
    acrossHome: parsed["across-home"],
    pluginRoot: parsed["plugin-root"],
    binDir: parsed["bin-dir"],
    env: process.env
  };
}

function modelOverridesFromParsed(parsed) {
  let overrides = {};
  if (parsed["model-overrides-json"]) {
    try {
      overrides = JSON.parse(parsed["model-overrides-json"]);
    } catch (error) {
      throw new Error(`--model-overrides-json must be valid JSON: ${error.message || error}`);
    }
  }
  const builder = compactObject({
    agent_id: parsed["builder-agent"] || parsed["builder-agent-id"],
    provider: parsed["builder-provider"],
    model: parsed["builder-model"]
  });
  const reviewer = compactObject({
    agent_id: parsed["reviewer-agent"] || parsed["reviewer-agent-id"],
    provider: parsed["reviewer-provider"],
    model: parsed["reviewer-model"],
    require_distinct_from_builder: parsed["reviewer-require-distinct"] === undefined
      ? undefined
      : !["0", "false", "no"].includes(String(parsed["reviewer-require-distinct"]).toLowerCase())
  });
  if (Object.keys(builder).length) overrides.builder = { ...(overrides.builder || {}), ...builder };
  if (Object.keys(reviewer).length) overrides.reviewer = { ...(overrides.reviewer || {}), ...reviewer };
  return Object.keys(overrides).length ? overrides : null;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && String(item).trim() !== "")
  );
}

function printPayload(payload, parsed) {
  if (parsed.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.schema_version) {
    console.log(`${payload.schema_version}: ${payload.status || payload.readiness || payload.mode || "ok"}`);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function parseArgs(args) {
  const parsed = { positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (["json", "fetch", "foreground", "follow"].includes(key)) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = args[index + 1] || "";
    index += 1;
  }
  return parsed;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function printHelp() {
  console.log(`Usage: across-autopilot <command> [options]

Commands:
  loop validate --spec path --json
  loop dry-run --spec path --json
  loop run --spec path --json
  loop enqueue-trigger --spec path --type cron --payload-json '{}' --json
  loop trigger-queue --json
  loop run-trigger [--trigger-id id] --json
  loop status --run-id id --json
  loop evidence --run-id id --json
  loop events --run-id id [--follow] --json
  loop cancel --run-id id --json
  loop retry --run-id id --json
  loop list --json
  loop register --spec path --json
  loop registry --json
  loop migrate-spec --spec path --target-schema version --json
  loop telemetry --json
  loop pause --spec-id id --json
  loop resume --spec-id id --json
  adapter pause --adapter-id id --json
  adapter resume --adapter-id id --json
  status --json
  review [--fetch] [--output path] [--json]
  candidate-plan --goal text --target-product product --json
  create-candidate --goal text --target-product product --json
  evaluate-candidate [--candidate id] [--evidence evidence.json] --json
  promotion-report [--candidate id] --json
  plugin-manifest --json
  plugin-status --json
  health --json
  install host-plugin --across-home path
  uninstall host-plugin --across-home path
  mcp
`);
}

function triggerOptions(parsed) {
  return {
    type: parsed.type || parsed.trigger || "manual",
    source: parsed.source || parsed.type || "manual",
    actor: parsed.actor || "local-user",
    payload_json: parsed["payload-json"],
    idempotency_key: parsed["idempotency-key"],
    not_before: parsed["not-before"],
    replay_hint: parsed["replay-hint"]
  };
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
