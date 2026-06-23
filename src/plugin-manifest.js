import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPONENT_ID,
  componentCacheHome,
  componentConfigHome,
  componentDataHome,
  componentLogHome,
  componentRunHome,
  ecosystemBinDir,
  ecosystemHome,
  pluginRoot
} from "./paths.js";
import { loadState } from "./state.js";

const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export async function renderPluginManifest(options = {}) {
  const env = options.env || process.env;
  const homeEnv = options.acrossHome ? { ...env, ACROSS_HOME: options.acrossHome } : env;
  const acrossHome = resolve(ecosystemHome(homeEnv));
  const envWithHome = { ...homeEnv, ACROSS_HOME: acrossHome };
  const pluginRootPath = resolve(options.pluginRoot || pluginRoot(envWithHome));
  const binDir = resolve(options.binDir || ecosystemBinDir(envWithHome));
  const installDir = resolve(options.installDir || join(pluginRootPath, COMPONENT_ID));
  const commandPath = resolve(options.commandPath || join(binDir, "across-autopilot"));
  const packageJson = await readPackageJson(options.sourceRoot || PACKAGE_ROOT);

  return {
    schemaVersion: "1.0",
    pluginApiVersion: "2026-06-10",
    id: COMPONENT_ID,
    displayName: "Across Autopilot",
    kind: "autonomous-workflow",
    version: packageJson.version || "0.0.0",
    description: "Controlled autonomous iteration controller for the Across ecosystem.",
    capabilities: {
      autonomousReview: true,
      stableCandidatePromotion: true,
      candidatePlanning: true,
      promotionReports: true,
      loopSpecValidation: true,
      loopSupervisor: true,
      adapterRegistry: true,
      evidenceEnvelope: true,
      evidenceIntegrity: true,
      roleEvidence: true,
      aggregateTelemetry: true,
      triggerQueue: true,
      triggerIdempotency: true,
      toolPackSchemas: true,
      externalEmbedding: true,
      ecosystemResearch: true,
      agentLoopExecutionDelegation: true,
      contextMemoryCandidates: true,
      localFirst: true
    },
    compatibility: {
      requiredHostVersion: ">=0.9.0",
      pluginApiVersion: "2026-06-10",
      compatiblePluginApiVersions: ["2026-06-10"]
    },
    permissions: {
      filesystem: [
        { path: "~/.across/data/across-autopilot", access: "read-write", reason: "Autopilot state, reviews, and candidate reports" },
        { path: "~/.across/plugins/across-autopilot", access: "read", reason: "Managed plugin runtime" }
      ],
      network: [
        { access: "outbound", reason: "Optional source availability checks and future web research" }
      ],
      secrets: [
        { name: "OPENAI_API_KEY", optional: true, reason: "Optional future live research; v0.1 works without it" }
      ]
    },
    diagnostics: {
      startupSafe: true,
      startsProcess: false,
      statusCommandSafeAtStartup: true,
      mutatesRepositoriesByDefault: false,
      autoReleaseEnabled: false
    },
    lifecycle: {
      install: {
        hostManaged: true,
        command: commandPath,
        args: ["install", "host-plugin"],
        idempotent: true
      },
      upgrade: {
        hostManaged: true,
        strategy: "reinstall"
      },
      repair: {
        hostManaged: true,
        strategy: "reinstall"
      },
      uninstall: {
        hostManaged: true,
        command: commandPath,
        args: ["uninstall", "host-plugin"],
        removesRuntime: true,
        preservesData: true
      }
    },
    entrypoints: {
      cli: { command: commandPath },
      mcp: { command: commandPath, args: ["mcp"], transport: "stdio" },
      status: { command: commandPath, args: ["plugin-status", "--json"] },
      review: { command: commandPath, args: ["review", "--json"] },
      candidatePlan: { command: commandPath, args: ["candidate-plan", "--json"] },
      promotionReport: { command: commandPath, args: ["promotion-report", "--json"] },
      loopValidate: { command: commandPath, args: ["loop", "validate", "--json"] },
      loopRun: { command: commandPath, args: ["loop", "run", "--json"] },
      loopEnqueueTrigger: { command: commandPath, args: ["loop", "enqueue-trigger", "--json"] },
      loopTriggerQueue: { command: commandPath, args: ["loop", "trigger-queue", "--json"] },
      loopRunTrigger: { command: commandPath, args: ["loop", "run-trigger", "--json"] },
      loopStatus: { command: commandPath, args: ["loop", "status", "--json"] },
      loopEvidence: { command: commandPath, args: ["loop", "evidence", "--json"] },
      loopEvents: { command: commandPath, args: ["loop", "events", "--json"] },
      loopTelemetry: { command: commandPath, args: ["loop", "telemetry", "--json"] }
    },
    protocols: {
      cli: { command: commandPath },
      mcp: {
        transport: "stdio",
        tools: {
          getAutopilotStatus: "get_autopilot_status",
          validateLoopSpec: "validate_loop_spec",
          dryRunLoop: "dry_run_loop",
          runLoop: "run_loop",
          enqueueLoopTrigger: "enqueue_loop_trigger",
          getLoopTriggerQueue: "get_loop_trigger_queue",
          runNextLoopTrigger: "run_next_loop_trigger",
          getLoopRunStatus: "get_loop_run_status",
          getLoopRunEvidence: "get_loop_run_evidence",
          getLoopRunEvents: "get_loop_run_events",
          cancelLoopRun: "cancel_loop_run",
          getLoopTelemetry: "get_loop_telemetry"
        },
        resources: true
      },
      a2a: {
        role: "autonomous-iteration-controller",
        discoveryReady: true
      }
    },
    integrations: {
      executionEngine: "across-orchestrator",
      memoryProvider: "across-context",
      hostControlPlane: "across-agents-assistant"
    },
    paths: {
      plugin: installDir,
      bin: binDir,
      data: componentDataHome(COMPONENT_ID, envWithHome),
      config: componentConfigHome(COMPONENT_ID, envWithHome),
      run: componentRunHome(COMPONENT_ID, envWithHome),
      logs: componentLogHome(COMPONENT_ID, envWithHome),
      cache: componentCacheHome(COMPONENT_ID, envWithHome)
    },
    environment: {
      ecosystemHome: "ACROSS_HOME",
      dataOverride: "ACROSS_AUTOPILOT_HOME",
      pluginRoot: "ACROSS_PLUGIN_HOME",
      binHome: "ACROSS_BIN_HOME"
    }
  };
}

export async function renderPluginStatus(options = {}) {
  const manifest = await renderPluginManifest(options);
  const manifestPath = join(manifest.paths.plugin, "manifest.json");
  const commandExists = await pathExists(manifest.entrypoints.cli.command);
  const manifestExists = await pathExists(manifestPath);
  const dataExists = await pathExists(manifest.paths.data);
  const state = await loadState(options);
  const installed = commandExists || manifestExists;

  return {
    pluginId: COMPONENT_ID,
    status: installed ? "installed" : "not_installed",
    installed,
    available: commandExists,
    manifestPath,
    manifestExists,
    command: manifest.entrypoints.cli.command,
    commandExists,
    dataPath: manifest.paths.data,
    dataExists,
    stableSlot: state.stable_slot,
    candidateSlot: state.candidate_slot,
    autonomyLevel: state.autonomy_level,
    protocols: Object.keys(manifest.protocols),
    capabilities: manifest.capabilities,
    install: {
      installable: true,
      command: "across-autopilot install host-plugin",
      installDir: manifest.paths.plugin
    },
    lifecycle: {
      actions: ["install", "upgrade", "repair", "uninstall"],
      preservesDataOnUninstall: true
    }
  };
}

export async function renderHealth(options = {}) {
  const state = await loadState(options);
  return {
    status: "ok",
    pluginId: COMPONENT_ID,
    autonomyLevel: state.autonomy_level,
    stableSlot: state.stable_slot,
    candidateSlot: state.candidate_slot,
    candidateCount: state.candidates.length,
    timestamp: new Date().toISOString()
  };
}

async function readPackageJson(sourceRoot) {
  try {
    return JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
