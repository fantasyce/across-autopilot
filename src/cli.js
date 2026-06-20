#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCandidatePlan, buildPromotionReport, createCandidate, evaluateCandidate } from "./candidates.js";
import { installHostPlugin, uninstallHostPlugin } from "./installers.js";
import { renderHealth, renderPluginManifest, renderPluginStatus } from "./plugin-manifest.js";
import { buildReview, fetchSourceStatuses, loadSources, writeReview } from "./review.js";
import { latestCandidate, loadState, recordCandidate, saveState } from "./state.js";

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

  if (command === "review") {
    const parsed = parseArgs(rest);
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
    return printPayload(buildCandidatePlan({
      goal: parsed.goal || parsed.positionals.join(" "),
      targetProduct: parsed["target-product"] || parsed.target_product
    }), parsed);
  }

  if (command === "create-candidate") {
    const parsed = parseArgs(rest);
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
    const state = await loadState({ env: process.env });
    const candidate = selectCandidate(state, parsed.candidate);
    const evidence = parsed.evidence ? JSON.parse(await readFile(resolve(parsed.evidence), "utf8")) : candidate.evidence || [];
    const evaluated = evaluateCandidate(candidate, evidence);
    await recordCandidate(evaluated, { env: process.env });
    return printPayload(evaluated, parsed);
  }

  if (command === "promotion-report") {
    const parsed = parseArgs(rest);
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
    if (["json", "fetch"].includes(key)) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = args[index + 1] || "";
    index += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: across-autopilot <command> [options]

Commands:
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

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

