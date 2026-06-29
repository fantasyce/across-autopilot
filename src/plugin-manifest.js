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
  const publicPaths = options.publicPaths === true;
  const manifestCommandPath = publicPaths ? userRelativeAcrossPath(commandPath, envWithHome) : commandPath;
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
      mcpTasksProjection: true,
      externalSkillsRadar: true,
      loopMemoryCompaction: true,
      triggerIdempotency: true,
      toolPackSchemas: true,
      genericAgentPluginRuntime: true,
      agentPluginTrustPolicy: true,
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
        command: manifestCommandPath,
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
        command: manifestCommandPath,
        args: ["uninstall", "host-plugin"],
        removesRuntime: true,
        preservesData: true
      }
    },
    entrypoints: {
      cli: { command: manifestCommandPath },
      mcp: { command: manifestCommandPath, args: ["mcp"], transport: "stdio" },
      status: { command: manifestCommandPath, args: ["plugin-status", "--json"] },
      review: { command: manifestCommandPath, args: ["review", "--json"] },
      candidatePlan: { command: manifestCommandPath, args: ["candidate-plan", "--json"] },
      promotionReport: { command: manifestCommandPath, args: ["promotion-report", "--json"] },
      loopValidate: { command: manifestCommandPath, args: ["loop", "validate", "--json"] },
      loopRun: { command: manifestCommandPath, args: ["loop", "run", "--json"] },
      loopRunAsync: { command: manifestCommandPath, args: ["loop", "run", "--async", "--return-task-id", "--json"] },
      loopTaskStatus: { command: manifestCommandPath, args: ["loop", "task-status", "--json"] },
      skillsRadar: { command: manifestCommandPath, args: ["skills-radar", "--json"] },
      loopMemoryCompact: { command: manifestCommandPath, args: ["loop-memory-compact", "--json"] },
      loopEnqueueTrigger: { command: manifestCommandPath, args: ["loop", "enqueue-trigger", "--json"] },
      loopTriggerQueue: { command: manifestCommandPath, args: ["loop", "trigger-queue", "--json"] },
      loopRunTrigger: { command: manifestCommandPath, args: ["loop", "run-trigger", "--json"] },
      loopStatus: { command: manifestCommandPath, args: ["loop", "status", "--json"] },
      loopEvidence: { command: manifestCommandPath, args: ["loop", "evidence", "--json"] },
      loopEvents: { command: manifestCommandPath, args: ["loop", "events", "--json"] },
      loopTelemetry: { command: manifestCommandPath, args: ["loop", "telemetry", "--json"] },
      agentPluginValidate: { command: manifestCommandPath, args: ["agent-plugin", "validate", "--json"] },
      agentPluginPlan: { command: manifestCommandPath, args: ["agent-plugin", "plan", "--json"] },
      ecosystemRoadmap: { command: manifestCommandPath, args: ["ecosystem-roadmap", "--json"] }
    },
    protocols: {
      cli: { command: manifestCommandPath },
      mcp: {
        transport: "stdio",
        tools: {
          getAutopilotStatus: "get_autopilot_status",
          validateLoopSpec: "validate_loop_spec",
          dryRunLoop: "dry_run_loop",
          runLoop: "run_loop",
          startAsyncLoopTask: "start_async_loop_task",
          getAsyncLoopTask: "get_async_loop_task",
          enqueueLoopTrigger: "enqueue_loop_trigger",
          getLoopTriggerQueue: "get_loop_trigger_queue",
          runNextLoopTrigger: "run_next_loop_trigger",
          getLoopRunStatus: "get_loop_run_status",
          getLoopRunEvidence: "get_loop_run_evidence",
          getLoopRunEvents: "get_loop_run_events",
          cancelLoopRun: "cancel_loop_run",
          getLoopTelemetry: "get_loop_telemetry",
          discoverExternalSkills: "discover_external_skills",
          compactLoopMemory: "compact_loop_memory"
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
      plugin: publicPaths ? userRelativeAcrossPath(installDir, envWithHome) : installDir,
      bin: publicPaths ? userRelativeAcrossPath(binDir, envWithHome) : binDir,
      data: publicPaths ? userRelativeAcrossPath(componentDataHome(COMPONENT_ID, envWithHome), envWithHome) : componentDataHome(COMPONENT_ID, envWithHome),
      config: publicPaths ? userRelativeAcrossPath(componentConfigHome(COMPONENT_ID, envWithHome), envWithHome) : componentConfigHome(COMPONENT_ID, envWithHome),
      run: publicPaths ? userRelativeAcrossPath(componentRunHome(COMPONENT_ID, envWithHome), envWithHome) : componentRunHome(COMPONENT_ID, envWithHome),
      logs: publicPaths ? userRelativeAcrossPath(componentLogHome(COMPONENT_ID, envWithHome), envWithHome) : componentLogHome(COMPONENT_ID, envWithHome),
      cache: publicPaths ? userRelativeAcrossPath(componentCacheHome(COMPONENT_ID, envWithHome), envWithHome) : componentCacheHome(COMPONENT_ID, envWithHome)
    },
    environment: {
      ecosystemHome: "ACROSS_HOME",
      dataOverride: "ACROSS_AUTOPILOT_HOME",
      pluginRoot: "ACROSS_PLUGIN_HOME",
      binHome: "ACROSS_BIN_HOME"
    }
  };
}

function userRelativeAcrossPath(path, env) {
  const home = resolve(env.HOME || process.env.HOME || "");
  const defaultAcrossHome = resolve(home, ".across");
  const resolved = resolve(path);
  if (resolved === defaultAcrossHome) return "~/.across";
  if (resolved.startsWith(`${defaultAcrossHome}/`)) {
    return `~/.across/${resolved.slice(defaultAcrossHome.length + 1)}`;
  }
  return resolved;
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
