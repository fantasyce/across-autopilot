import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { AutopilotSupervisor } from "../src/supervisor.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { acquireCandidateEcosystem, buildCandidatePromotionEvidence, candidateConfig, candidateEcosystemDiff, candidateRuntimePreflight, runCandidateAppLifecycle, runHostCodeIteration, runProductIterationStrategy, semanticAlignmentReview, validateCandidateEcosystem } from "../src/candidate-ecosystem.js";
import { prepareAutonomousLoopState } from "../src/loop-state.js";
import { RunStore } from "../src/run-store.js";
import { runJsonCommand } from "../src/process-client.js";
import { buildToolPackRegistry } from "../src/tool-packs.js";
import { buildRoleEvidence } from "../src/roles.js";

const exec = promisify(execFile);

async function writeFakeCandidateAppLifecycleCommand(home) {
  const command = join(home, "fake-candidate-app-lifecycle.js");
  await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}
const appPath = flag("--app-path");
const outputPath = flag("--output");
const runtimeHome = flag("--runtime-home");
const appHome = flag("--app-home");
const candidateId = flag("--candidate-id");
fs.mkdirSync(appPath, { recursive: true });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({
  schema_version: "across-candidate-app-lifecycle/1.0",
  status: "passed",
  candidate_id: candidateId,
  bundle_id: "app.acrossagents.assistant.candidate." + candidateId.replace(/[^A-Za-z0-9.-]+/g, "-").toLowerCase(),
  app_path: appPath,
  runtime_home: runtimeHome,
  app_home: appHome,
  socket_path: path.join(appHome, "run", "across-agents.sock"),
  socket_path_bytes: Buffer.byteLength(path.join(appHome, "run", "across-agents.sock")),
  cleaned_up: true,
  crash_reports: [],
  health: { status: "ok", app: "candidate" },
  llm_status: {
    available: true,
    availability_source: "candidate_model_lease",
    candidate_model_lease: {
      secrets_included: false,
      raw_credentials_allowed: false
    }
  }
}, null, 2));
`, "utf8");
  return ["node", command];
}

test("candidate runtime defaults to short app-safe paths", () => {
  const env = { ...process.env, HOME: "/Users/tester", ACROSS_HOME: "/Users/tester/.across" };
  const run = { run_id: "run-20260621T103300Z-aaa-research-driven-self-iteration" };
  const config = candidateConfig({ id: "aaa-research-driven-self-iteration", pack_config: {} }, run, env);
  const socketPath = join(config.app_home, "run", "across-agents.sock");

  assert.match(config.runtime_home, /\/\.across\/c\/20260621T103300Z-[a-f0-9]{8}$/);
  assert.equal(config.app_home, join(config.runtime_home, "aaa"));
  assert.ok(socketPath.length < 100, `candidate app socket path must stay short for macOS Unix sockets: ${socketPath.length}`);
  assert.equal(config.runtime_preflight.status, "passed");
  assert.equal(config.runtime_preflight.single_instance_required, true);
  assert.equal(config.runtime_preflight.cleanup_required, true);
});

test("candidate ecosystem receives a non-secret host model lease", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-model-lease-"));
  const sourcesRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourcesRoot, id);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), `# ${id}\n`, "utf8");
    repos.push({ id, source });
  }
  const env = {
    ...process.env,
    ACROSS_HOME: home,
    MINIMAX_API_KEY: "must-not-be-written",
    ACROSS_AAA_CANDIDATE_MODEL_LEASE_JSON: JSON.stringify({
      schema_version: "across-candidate-model-lease/1.0",
      host_socket: join(home, "run", "stable-a.sock"),
      scopes: ["model.code_patch", "model.review", "model.chat"],
      commands: {
        code_iteration: ["aaa", "autopilot-code-iteration"],
        review_decision: ["aaa", "autopilot-review-decision"]
      },
      policy: { secrets_included: false, raw_credentials_allowed: false }
    })
  };
  const acquired = await acquireCandidateEcosystem({
    spec: { id: "lease-spec", pack_config: { candidate_ecosystem: { repos } } },
    run: { run_id: "run-model-lease" },
    env
  });
  const leaseText = await readFile(acquired.model_lease.path, "utf8");
  const manifest = JSON.parse(await readFile(acquired.manifest_path, "utf8"));

  assert.equal(acquired.model_lease.schema_version, "across-candidate-model-lease/1.0");
  assert.equal(acquired.model_lease.secrets_included, false);
  assert.equal(acquired.model_lease.raw_credentials_allowed, false);
  assert.equal(leaseText.includes("must-not-be-written"), false);
  assert.equal(/api[_-]?key/i.test(leaseText), false);
  assert.equal(manifest.model_lease.lease_id, acquired.model_lease.lease_id);
});

test("candidate ecosystem snapshot skips deleted tracked files", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-deleted-tracked-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, { "README.md": `# ${id}\n` });
    repos.push({ id, source });
  }
  const autopilotSource = join(sourceRoot, "across-autopilot");
  await createGitSource(autopilotSource, {
    "README.md": "# Across Autopilot\n",
    ".github/workflows/ci.yml": "name: CI\n",
    "src/cli.js": "console.log('ok');\n"
  });
  await rm(join(autopilotSource, ".github/workflows/ci.yml"));
  repos.push({ id: "across-autopilot", source: autopilotSource });

  const result = await acquireCandidateEcosystem({
    spec: {
      id: "deleted-tracked-snapshot",
      pack_config: {
        candidate_ecosystem: {
          repos
        }
      }
    },
    run: { run_id: "run-20260624T070000Z-deleted-tracked-snapshot" },
    env: {
      ...process.env,
      ACROSS_HOME: home
    }
  });

  const autopilotTarget = result.repos.find((repo) => repo.id === "across-autopilot").target;
  assert.equal(await fileExists(join(autopilotTarget, "README.md")), true);
  assert.equal(await fileExists(join(autopilotTarget, "src/cli.js")), true);
  assert.equal(await fileExists(join(autopilotTarget, ".github/workflows/ci.yml")), false);
});

test("host code iteration receives candidate model lease without provider secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-model-lease-code-"));
  const sourcesRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourcesRoot, id);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), `# ${id}\n`, "utf8");
    repos.push({ id, source });
  }
  const hostCommand = join(home, "host-code-command.js");
  await writeFile(hostCommand, `#!/usr/bin/env node
const args = process.argv.slice(2);
const request = JSON.parse(args[args.indexOf("--request-json") + 1]);
if (process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY) throw new Error("model secret leaked to host command env");
if (!request.candidate_model_lease || request.candidate_model_lease.secrets_included !== false) throw new Error("missing safe candidate model lease");
process.stdout.write(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "lease-builder",
  decision_hash: "decision-hash",
  candidate_model_lease: request.candidate_model_lease,
  summary: "Use candidate model lease.",
  patches: [{ path: "backend/src/across_agents_assistant/lease_candidate.py", mode: "overwrite", content: "VALUE = 'lease-backed'\\n" }]
}));
`, "utf8");
  const env = {
    ...process.env,
    ACROSS_HOME: home,
    ACROSS_AAA_HOST_CODE_COMMAND: JSON.stringify(["node", hostCommand]),
    MINIMAX_API_KEY: "must-not-reach-host-command",
    OPENAI_API_KEY: "must-not-reach-host-command",
    ACROSS_AAA_CANDIDATE_MODEL_LEASE_JSON: JSON.stringify({
      schema_version: "across-candidate-model-lease/1.0",
      host_socket: join(home, "run", "stable-a.sock"),
      scopes: ["model.code_patch"],
      policy: { secrets_included: false, raw_credentials_allowed: false }
    })
  };
  const run = { run_id: "run-model-lease-code" };
  const spec = {
    id: "lease-code-spec",
    description: "Verify candidate model lease reaches host code iteration.",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      allowed_patch_paths: ["backend/src/across_agents_assistant/lease_candidate.py"],
      validation_commands: []
    },
    model_policy: { required: true }
  };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });
  const result = await runHostCodeIteration({
    spec,
    run,
    env,
    actions: [
      { adapter: "candidate_ecosystem_acquire", result: acquired },
      {
        adapter: "product_iteration_strategy",
        result: {
          selected_iteration: {
            goal: "Add lease-backed marker.",
            target_repo: "across-agents-assistant",
            allowed_patch_paths: ["backend/src/across_agents_assistant/lease_candidate.py"]
          }
        }
      }
    ]
  });

  assert.equal(result.status, "passed");
  assert.equal(result.candidate_model_lease.schema_version, "across-candidate-model-lease/1.0");
  assert.equal(result.candidate_model_lease.secrets_included, false);
  assert.deepEqual(result.changed_files, ["across-agents-assistant/backend/src/across_agents_assistant/lease_candidate.py"]);
});

test("JSON command failures preserve bounded stdout and stderr diagnostics", async () => {
  await assert.rejects(
    runJsonCommand(["node", "-e", "console.error('stderr detail'); console.log(JSON.stringify({ status: 'failed', error: 'structured failure detail' })); process.exit(7);"], [], {
      maxBuffer: 1024 * 1024
    }),
    (error) => {
      assert.equal(error.code, "adapter.invalid_output");
      assert.equal(error.exit_code, 7);
      assert.match(error.message, /structured failure detail/);
      assert.match(error.message, /stderr detail/);
      assert.ok(error.caused_by?.[0]?.structured_output);
      assert.equal(error.caused_by[0].exit_code, 7);
      return true;
    }
  );
});

test("candidate runtime preflight rejects socket paths that would crash macOS Network.framework", () => {
  const config = {
    runtime_key: "too-long",
    runtime_home: `/Users/tester/.across/${"x".repeat(120)}`,
    app_home: `/Users/tester/.across/${"x".repeat(120)}/aaa`
  };
  const preflight = candidateRuntimePreflight(config);

  assert.equal(preflight.status, "failed");
  assert.ok(preflight.socket_path_bytes > preflight.max_socket_path_bytes);
  assert.match(preflight.reason, /too long/);
});

test("adapter capabilities expose stable Tool Packs", () => {
  const registry = new AdapterRegistry();
  const capabilities = registry.capabilities();
  const packIds = capabilities.tool_packs.map((pack) => pack.id);

  assert.ok(packIds.includes("git_repo_inspection"));
  assert.ok(packIds.includes("candidate_workspace"));
  assert.ok(packIds.includes("model_generated_fallback_plan"));
  assert.ok(packIds.includes("capability_preflight"));
  assert.ok(packIds.includes("repo_quality_inspection"));
  assert.ok(packIds.includes("dependency_security_review"));
  assert.ok(packIds.includes("license_policy_scan"));
  assert.ok(packIds.includes("validation_harness"));
  assert.ok(packIds.includes("candidate_diff_quality"));
  assert.ok(packIds.includes("promotion_attestation"));
  assert.ok(capabilities.tool_packs.every((pack) => Array.isArray(pack.capability_refs)));
});

test("run store records replayable trigger evidence with payload hash", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const run = await store.createRun({
    id: "triggered-loop",
    trigger: { type: "webhook" }
  }, {
    trigger: {
      type: "webhook",
      source: "github",
      actor: "dependabot",
      payload: { repository: "across-agents-assistant", action: "opened" }
    }
  });

  assert.equal(run.trigger, "webhook");
  assert.equal(run.trigger_event.schema_version, "across-autopilot-trigger-event/1.0");
  assert.equal(run.trigger_event.source, "github");
  assert.equal(run.trigger_event.actor, "dependabot");
  assert.equal(run.trigger_event.payload.repository, "across-agents-assistant");
  assert.match(run.trigger_event.payload_hash, /^[a-f0-9]{64}$/);
});

test("trigger queue deduplicates payloads and dispatches through the supervisor", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-queue-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const registry = new AdapterRegistry({ store });
  registry.registerAction({
    id: "queue_noop_action",
    async run() {
      return {
        id: "queue_noop_action",
        adapter: "queue_noop_action",
        status: "passed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        inputs: [],
        outputs: [],
        result: { ok: true }
      };
    }
  });
  registry.registerOutput({
    id: "noop_output",
    async write() {
      return { id: "noop_output", status: "written", path: null };
    }
  });
  const supervisor = new AutopilotSupervisor({
    store,
    registry,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext(),
    env: { ...process.env, ACROSS_HOME: home }
  });
  const spec = minimalSpec({
    id: "queued-loop",
    actions: ["queue_noop_action"],
    outputs: ["noop_output"]
  });

  const first = await supervisor.enqueueTrigger(spec, {
    type: "webhook",
    source: "github",
    actor: "test",
    payload: { action: "opened" }
  });
  const duplicate = await supervisor.enqueueTrigger(spec, {
    type: "webhook",
    source: "github",
    actor: "test",
    payload: { action: "opened" }
  });
  const queue = await supervisor.triggerQueueStatus();

  assert.equal(first.status, "pending");
  assert.equal(duplicate.duplicate, true);
  assert.equal(queue.items.filter((item) => item.spec_id === "queued-loop").length, 1);

  const dispatched = await supervisor.runQueuedTrigger();
  const completedQueue = await supervisor.triggerQueueStatus();
  const completed = completedQueue.items.find((item) => item.trigger_id === first.trigger_id);

  assert.equal(dispatched.status, "completed");
  assert.equal(dispatched.run.trigger, "webhook");
  assert.equal(dispatched.evidence.integrity.schema_version, "across-autopilot-evidence-integrity/1.0");
  assert.equal(dispatched.evidence.roles.roles.some((role) => role.role === "tool"), true);
  assert.equal(completed.status, "completed");
  assert.equal(completed.run_id, dispatched.run.run_id);
});

test("queued trigger records failure when the dispatched run fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-failure-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const registry = new AdapterRegistry({ store });
  registry.registerOutput({
    id: "noop_output",
    async write() {
      return { id: "noop_output", status: "written", path: null };
    }
  });
  const supervisor = new AutopilotSupervisor({
    store,
    registry,
    orchestratorClient: new FailingOrchestrator(),
    contextClient: new FakeContext(),
    env: { ...process.env, ACROSS_HOME: home }
  });
  const spec = minimalSpec({
    id: "queued-failing-loop",
    actions: ["orchestrator_task_dispatch"],
    outputs: ["noop_output"]
  });
  const trigger = await supervisor.enqueueTrigger(spec, {
    type: "cron",
    payload: { reason: "failure-path" }
  });

  const dispatched = await supervisor.runQueuedTrigger(trigger.trigger_id);
  const queue = await supervisor.triggerQueueStatus();
  const completed = queue.items.find((item) => item.trigger_id === trigger.trigger_id);

  assert.equal(dispatched.status, "failed");
  assert.equal(dispatched.run.status, "failed");
  assert.equal(dispatched.trigger.status, "failed");
  assert.equal(completed.status, "failed");
  assert.equal(completed.failure.code, "orchestrator.task_failed");
});

test("tool pack registry exposes runtime packs and IO schemas", () => {
  const registry = new AdapterRegistry();
  const toolPacks = buildToolPackRegistry(registry);
  const triggerPack = toolPacks.packs.find((pack) => pack.id === "trigger_ingestion");
  const integrityPack = toolPacks.packs.find((pack) => pack.id === "evidence_integrity");
  const diffQualityPack = toolPacks.packs.find((pack) => pack.id === "candidate_diff_quality");
  const preflightPack = toolPacks.packs.find((pack) => pack.id === "capability_preflight");
  const dependencyPack = toolPacks.packs.find((pack) => pack.id === "dependency_security_review");
  const licensePack = toolPacks.packs.find((pack) => pack.id === "license_policy_scan");
  const attestationPack = toolPacks.packs.find((pack) => pack.id === "promotion_attestation");

  assert.equal(triggerPack.available, true);
  assert.equal(integrityPack.available, true);
  assert.equal(diffQualityPack.available, true);
  assert.equal(preflightPack.available, true);
  assert.equal(dependencyPack.available, true);
  assert.equal(licensePack.available, true);
  assert.equal(attestationPack.available, true);
  assert.ok(triggerPack.input_schema.required.includes("type"));
  assert.ok(integrityPack.output_schema.required.includes("audit_chain_tip"));
  assert.ok(diffQualityPack.output_schema.required.includes("promotion_package"));
});

test("runtime policy is validated and missing capabilities fail before adapters run", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-preflight-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const registry = new AdapterRegistry({ store });
  registry.registerOutput({
    id: "noop_output",
    async write() {
      return { id: "noop_output", status: "written", path: null };
    }
  });
  const supervisor = new AutopilotSupervisor({
    store,
    registry,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext(),
    env: { ...process.env, ACROSS_HOME: home }
  });
  const spec = minimalSpec({
    id: "runtime-policy-loop",
    actions: ["read_only_analysis"],
    outputs: ["noop_output"]
  });
  spec.runtime_policy = {
    risk_profile: "high",
    timeouts: {
      total_run_timeout_ms: 300000,
      adapter_timeout_ms: 120000,
      model_timeout_ms: 120000
    },
    budget: {
      max_model_calls: 4,
      max_candidate_repairs: 2,
      max_usd: 0
    },
    network_policy: {
      mode: "allowlist",
      allowlist: ["example.com"]
    },
    filesystem_policy: {
      mode: "run_scoped"
    },
    promotion: {
      human_approval_required: true,
      merge_release_signing_blocked: true
    }
  };

  const dryRun = await supervisor.dryRun(spec);
  assert.equal(dryRun.capability_preflight.status, "passed");
  assert.equal(dryRun.runtime_policy.network_policy.mode, "allowlist");
  assert.equal(dryRun.runtime_policy.promotion.human_approval_required, true);

  const missingSpec = {
    ...spec,
    id: "missing-capability-loop",
    required_capabilities: [...spec.required_capabilities, "runtime.does_not_exist"]
  };
  const { run, evidence } = await supervisor.run(missingSpec);

  assert.equal(run.status, "failed");
  assert.equal(run.failure.code, "capability.missing");
  assert.match(run.failure.message, /runtime\.does_not_exist/);
  assert.equal(evidence.status, "failed");
  assert.ok(evidence.gates.some((gate) => gate.id === "capability.missing"));
});

test("runtime budget blocks model-backed actions before they exceed policy", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-runtime-budget-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const registry = new AdapterRegistry({ store });
  registry.registerOutput({
    id: "noop_output",
    async write() {
      return { id: "noop_output", status: "written", path: null };
    }
  });
  const supervisor = new AutopilotSupervisor({
    store,
    registry,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext(),
    env: { ...process.env, ACROSS_HOME: home }
  });
  const spec = minimalSpec({
    id: "runtime-budget-loop",
    actions: ["host_code_iteration"],
    outputs: ["noop_output"]
  });
  spec.runtime_policy = {
    risk_profile: "high",
    timeouts: {
      total_run_timeout_ms: 300000,
      adapter_timeout_ms: 120000,
      model_timeout_ms: 120000
    },
    budget: {
      max_model_calls: 0,
      max_candidate_repairs: 0,
      max_usd: 0
    },
    network_policy: { mode: "adapter_scoped" },
    filesystem_policy: { mode: "run_scoped" },
    promotion: {
      human_approval_required: true,
      merge_release_signing_blocked: true
    }
  };

  const { run, evidence } = await supervisor.run(spec);

  assert.equal(run.status, "failed");
  assert.equal(run.failure.code, "runtime.budget_exceeded");
  assert.equal(evidence.runtime_budget.status, "failed");
  assert.equal(evidence.runtime_budget.enforcement, "hard");
  assert.equal(evidence.runtime_budget.limits.max_model_calls, 0);
  assert.deepEqual(evidence.runtime_budget.exceeded, ["runtime_guard"]);
  assert.equal(evidence.actions.length, 0);
});

test("manifest inspection feeds deterministic dependency and license review packs", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-deps-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext(),
    env: { ...process.env, ACROSS_HOME: home }
  });
  const spec = minimalSpec({
    id: "dependency-review-loop",
    actions: ["license_check", "manifest_inspection", "dependency_risk_check"],
    outputs: ["json_artifact"]
  });
  spec.pack_config = { acceptable_licenses: ["MIT"] };
  spec.sources = [{
    id: "fixture-repo",
    type: "manual_input",
    adapter: "manual_input",
    fixture: {
      kind: "github_search",
      repositories: [{
        id: "sample",
        license: "MIT",
        files: [{
          path: "package.json",
          content: JSON.stringify({
            name: "sample",
            license: "MIT",
            dependencies: { leftpad: "latest", express: "^4.0.0" },
            scripts: { postinstall: "node scripts/install.js" }
          })
        }]
      }]
    }
  }];

  const { run, evidence } = await supervisor.run(spec);
  const manifest = evidence.actions.find((action) => action.adapter === "manifest_inspection").result;
  const dependency = evidence.actions.find((action) => action.adapter === "dependency_risk_check").result;
  const license = evidence.actions.find((action) => action.adapter === "license_check").result;

  assert.equal(run.status, "completed");
  assert.equal(license.status, "passed");
  assert.equal(manifest.manifest_count, 1);
  assert.equal(manifest.manifests[0].package_manager, "npm");
  assert.ok(dependency.risks.some((risk) => risk.risk === "unpinned_dependency"));
  assert.ok(dependency.risks.some((risk) => risk.risk === "risky_install_script"));
  assert.ok(dependency.risks.some((risk) => risk.risk === "missing_lockfile"));
  assert.equal(dependency.status, "failed");
});

test("evidence envelopes include integrity hashes and role separation", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-integrity-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const registry = new AdapterRegistry({ store });
  registry.registerAction({
    id: "queue_noop_action",
    async run() {
      return {
        id: "queue_noop_action",
        adapter: "queue_noop_action",
        status: "passed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        role: "builder",
        inputs: [],
        outputs: [],
        result: { model_backed: true, decision_hash: "abc123" }
      };
    }
  });
  registry.registerOutput({
    id: "noop_output",
    async write() {
      return { id: "noop_output", status: "written", path: null };
    }
  });
  const supervisor = new AutopilotSupervisor({
    store,
    registry,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext(),
    env: { ...process.env, ACROSS_HOME: home }
  });
  const { evidence } = await supervisor.run(minimalSpec({
    id: "integrity-loop",
    actions: ["queue_noop_action"],
    outputs: ["noop_output"]
  }));

  assert.match(evidence.integrity.root_hash, /^[a-f0-9]{64}$/);
  assert.match(evidence.integrity.section_hashes.actions, /^[a-f0-9]{64}$/);
  assert.match(evidence.integrity.section_hashes.evidence_graph, /^[a-f0-9]{64}$/);
  assert.equal(evidence.evidence_graph.schema_version, "across-evidence-graph/1.0");
  assert.equal(evidence.evidence_graph.nodes.some((node) => node.id === "action:queue_noop_action"), true);
  assert.equal(evidence.integrity.audit_chain.event_count > 0, true);
  assert.ok(evidence.roles.roles.find((role) => role.role === "builder" && role.model_backed));
});

test("role evidence separates repaired terminal status from historical attention", () => {
  const evidence = buildRoleEvidence([
    {
      id: "candidate_ecosystem_validation",
      adapter: "candidate_ecosystem_validation",
      role: "validator",
      status: "attention",
      result: {}
    },
    {
      id: "candidate_ecosystem_validation_repair",
      adapter: "candidate_ecosystem_validation",
      role: "validator",
      status: "passed",
      result: {}
    },
    {
      id: "candidate_self_hosting_probe",
      adapter: "candidate_self_hosting_probe",
      role: "validator",
      status: "passed",
      result: {}
    }
  ]);

  const validator = evidence.roles.find((role) => role.role === "validator");
  assert.equal(validator.status, "passed");
  assert.equal(validator.terminal_status, "passed");
  assert.equal(validator.historical_status, "attention");
  assert.equal(validator.history_contains_attention, true);
});

test("supervisor writes running evidence snapshots for active actions", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-running-evidence-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const registry = new AdapterRegistry({ store });
  let releaseAction;
  const actionReleased = new Promise((resolve) => {
    releaseAction = resolve;
  });
  let actionStarted;
  const actionStartedPromise = new Promise((resolve) => {
    actionStarted = resolve;
  });

  registry.registerAction({
    id: "slow_action",
    async run() {
      actionStarted();
      await actionReleased;
      return {
        id: "slow_action",
        adapter: "slow_action",
        status: "passed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        inputs: [],
        outputs: [],
        result: { ok: true }
      };
    }
  });
  registry.registerOutput({
    id: "noop_output",
    async write() {
      return {
        id: "noop_output",
        type: "noop_output",
        status: "written",
        path: null
      };
    }
  });

  const supervisor = new AutopilotSupervisor({
    store,
    registry,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const spec = {
    schema_version: "across-loop-spec/1.0",
    id: "running-evidence-loop",
    name: "Running Evidence Loop",
    description: "Prove evidence snapshots are live while an action is running.",
    owner: { type: "local_user", id: "test" },
    compatibility: {
      min_autopilot_version: ">=0.1.0",
      required_orchestrator: ">=0.6.18",
      required_context: ">=0.7.8",
      required_host: ">=0.8.29"
    },
    required_capabilities: ["source.manual_input", "action.slow_action", "output.noop_output"],
    trigger: { type: "manual" },
    scope: { project_id: "test", workspace: "." },
    autonomy: { level: 3, requires_human_approval_above: 3 },
    sources: [{ id: "manual", type: "manual_input", adapter: "manual_input", content: "start" }],
    actions: { allowed: ["slow_action"], blocked: ["merge_pr", "release_publish", "sign_artifact", "write_secret"] },
    execute: { engine: "across-orchestrator", mode: "task" },
    outputs: [{ type: "noop_output", to: "run://noop", policy: "create" }],
    gates: [],
    memory: { provider: "across-context", recall: false, remember: false, write_status: "pending" },
    failure_policy: { max_retries: 0, retry_backoff: "linear", continue_on_gate_failure: false, dead_letter: "context_memory" },
    sandbox: { filesystem: "run_scoped", network: "adapter_scoped", env: "minimal" },
    evidence_contract: {
      schema_version: "across-loop-evidence/1.0",
      required_sections: ["sources", "actions", "gates", "outputs", "memory", "audit"]
    },
    used_adapters: { sources: ["manual_input"], actions: ["slow_action"], outputs: ["noop_output"] }
  };

  const runPromise = supervisor.run(spec);
  await actionStartedPromise;
  const [run] = await store.listRuns();
  const runningEvidence = await store.loadEvidence(run.run_id);

  assert.equal(runningEvidence.status, "running");
  assert.ok(runningEvidence.actions.some((action) => action.adapter === "slow_action" && action.status === "running"));
  assert.ok(runningEvidence.audit.some((event) => event.type === "action_started"));

  releaseAction();
  const { evidence } = await runPromise;

  assert.equal(evidence.status, "completed");
  assert.equal(evidence.actions.find((action) => action.adapter === "slow_action").status, "passed");
});

test("autonomous backlog rotates away from recently selected targets", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-backlog-rotation-"));
  const spec = {
    id: "aaa-autonomous-self-iteration",
    name: "AAA Autonomous Self Iteration",
    description: "Use dynamic loop state to choose the next B-only improvement.",
    pack_config: {
      research_strategy: {
        conformance_fixture: true,
        goal: "Prefer stable Tool Packs, persistent artifacts, contracts, backlog, timeline, and independent reviewer gates."
      }
    }
  };
  const sources = [{
    id: "architecture-signal",
    adapter: "manual_input",
    status: "passed",
    result: {
      title: "Architecture signal",
      content: "Stable Tool Packs, persistent artifacts, contracts, backlog, timeline, memory, and independent reviewer gates should guide autonomous iteration."
    }
  }];

  const first = await prepareAutonomousLoopState({
    spec,
    run: { run_id: "run-first" },
    sources,
    env: { ...process.env, ACROSS_HOME: home }
  });
  const second = await prepareAutonomousLoopState({
    spec,
    run: { run_id: "run-second" },
    sources,
    env: { ...process.env, ACROSS_HOME: home }
  });

  assert.equal(first.backlog[0].id, "loop_contract_policy");
  assert.notEqual(second.backlog[0].id, first.backlog[0].id);
  assert.equal(second.recent_global_timeline.length, 1);
});

class FakeOrchestrator {
  async runLoopTask({ spec, run }) {
    const modelDecision = spec.model_policy?.required
      ? {
          schema_version: "across-host-model-decision/1.0",
          model_backed: true,
          provider: "fake-host",
          model: "fake-loop-engineer",
          decision_hash: `decision-${run.run_id}`,
          decision: {
            summary: "Model selected a candidate-only documentation patch.",
            patches: [{
              path: "docs/AAA_SELF_ITERATION_CANDIDATE.md",
              mode: "upsert_between_markers",
              content: `# AAA Self Iteration Candidate\n\nRun: ${run.run_id}\nModel: fake-loop-engineer\n`
            }]
          },
          patches: [{
            path: "docs/AAA_SELF_ITERATION_CANDIDATE.md",
            mode: "upsert_between_markers",
            content: `# AAA Self Iteration Candidate\n\nRun: ${run.run_id}\nModel: fake-loop-engineer\n`
          }]
        }
      : null;
    return {
      task_id: `task-${spec.id}`,
      loop_id: `loop-${spec.id}`,
      status: "completed",
      quality_status: "passed",
      metadata_reflected: true,
      model_backed: Boolean(modelDecision),
      model_decision: modelDecision,
      evidence_refs: [`orchestrator/${run.run_id}/evidence`]
    };
  }
}

class FailingOrchestrator {
  async runLoopTask({ spec }) {
    return {
      task_id: `task-${spec.id}`,
      loop_id: `loop-${spec.id}`,
      status: "failed",
      quality_status: "failed",
      metadata_reflected: true,
      evidence_summary: {
        status: "failed",
        failure: { message: "Host model command failed: invalid JSON" }
      },
      evidence_refs: [`orchestrator/${spec.id}/evidence-summary`]
    };
  }
}

class FakeContext {
  async recall({ spec }) {
    return {
      schema_version: "across-context-loop-recall/1.0",
      provider: "across-context",
      spec_id: spec.id,
      result_count: 1,
      results: [{ memory_id: "mem-prior", text: "prior run", status: "pending" }]
    };
  }

  async rememberLoop({ spec, run }) {
    return {
      schema_version: "across-loop-memory/1.0",
      provider: "across-context",
      spec_id: spec.id,
      run_id: run.run_id,
      status: "accepted_pending",
      memory: { id: "mem-new", status: "pending" }
    };
  }
}

function minimalSpec({ id, actions, outputs }) {
  return {
    schema_version: "across-loop-spec/1.0",
    id,
    name: id,
    description: "Minimal test LoopSpec.",
    owner: { type: "local_user", id: "test" },
    compatibility: {
      min_autopilot_version: ">=0.1.0",
      required_orchestrator: ">=0.6.18",
      required_context: ">=0.7.8",
      required_host: ">=0.8.29"
    },
    required_capabilities: ["source.manual_input", ...actions.map((action) => `action.${action}`), ...outputs.map((output) => `output.${output}`)],
    trigger: { type: "manual" },
    scope: { project_id: "test", workspace: "." },
    autonomy: { level: 3, requires_human_approval_above: 3 },
    sources: [{ id: "manual", type: "manual_input", adapter: "manual_input", content: "queued work" }],
    actions: { allowed: actions, blocked: ["merge_pr", "release_publish", "sign_artifact", "write_secret"] },
    execute: { engine: "across-orchestrator", mode: "task" },
    outputs: outputs.map((output) => ({ type: output, to: `run://${output}.json`, policy: "overwrite" })),
    gates: [],
    memory: { provider: "across-context", recall: false, remember: false, write_status: "pending" },
    failure_policy: { max_retries: 0, retry_backoff: "linear", continue_on_gate_failure: false, dead_letter: "context_memory" },
    sandbox: { filesystem: "run_scoped", network: "adapter_scoped", env: "minimal" },
    evidence_contract: {
      schema_version: "across-loop-evidence/1.0",
      required_sections: ["sources", "actions", "gates", "outputs", "memory", "audit"]
    },
    used_adapters: {
      sources: ["manual_input"],
      actions,
      outputs
    }
  };
}

test("supervisor runs a built-in pack through adapters and evidence envelope", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-loop-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });

  const { run, evidence } = await supervisor.run("daily-news-brief");

  assert.equal(run.status, "completed");
  assert.equal(evidence.schema_version, "across-loop-evidence/1.0");
  assert.equal(evidence.orchestrator.tasks.length, 1);
  assert.equal(evidence.orchestrator.tasks[0].metadata_reflected, true);
  assert.ok(evidence.outputs.some((output) => output.id === "video_draft_manifest"));
  assert.equal(evidence.memory.recalled.length, 1);
  assert.equal(evidence.memory.written[0].status, "accepted_pending");
  assert.ok(evidence.audit.length > 10);

  const manifestOutput = evidence.outputs.find((output) => output.id === "video_draft_manifest");
  const manifest = JSON.parse(await readFile(manifestOutput.path, "utf8"));
  assert.equal(manifest.schema_version, "across-video-draft-manifest/1.0");
});

test("supervisor runs the GitHub plugin radar fixture pack", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-plugin-radar-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });

  const { run, evidence } = await supervisor.run("github-plugin-radar");

  assert.equal(run.status, "completed");
  assert.equal(evidence.schema_version, "across-loop-evidence/1.0");
  assert.equal(evidence.gates.every((gate) => gate.status === "passed"), true);
  assert.equal(evidence.orchestrator.tasks[0].metadata_reflected, true);
  assert.ok(evidence.actions.find((action) => action.adapter === "manifest_inspection").result.manifest_count > 0);
  assert.ok(evidence.outputs.some((output) => output.id === "markdown_report"));
  assert.ok(evidence.outputs.some((output) => output.id === "json_artifact"));
  assert.equal(evidence.memory.written[0].status, "accepted_pending");
});

test("failed gate evidence preserves partial actions and gates", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-partial-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const spec = JSON.parse(await readFile(join("examples", "github-plugin-radar.loop.json"), "utf8"));
  spec.id = "broken-plugin-radar";
  spec.sources[0].repositories[0].files = [];
  const specPath = join(home, "broken-plugin-radar.loop.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

  const { run, evidence } = await supervisor.run(specPath);

  assert.equal(run.status, "failed");
  assert.ok(evidence.actions.some((action) => action.adapter === "manifest_inspection"));
  assert.ok(evidence.gates.some((gate) => gate.id === "manifest_readable" && gate.status === "failed"));
  assert.equal(evidence.orchestrator.tasks[0].metadata_reflected, true);
});

test("github_repo source clones a git repository into the run sandbox", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-git-repo-"));
  const repo = join(home, "sample-plugin");
  await exec("git", ["init", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({
    name: "sample-plugin",
    version: "1.0.0",
    dependencies: { zod: "^3.0.0" }
  }), "utf8");
  await exec("git", ["-C", repo, "add", "package.json"]);
  await exec("git", ["-C", repo, "-c", "user.name=Across Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"]);

  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const spec = JSON.parse(await readFile(join("examples", "github-plugin-radar.loop.json"), "utf8"));
  spec.id = "local-git-plugin-radar";
  spec.sources = [{ id: "sample-plugin", type: "github_repo", adapter: "github_repo", url: repo, max_files: 20 }];
  spec.used_adapters.sources = ["github_repo"];
  const specPath = join(home, "local-git-plugin-radar.loop.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");
  await supervisor.registerSpec(specPath);

  const { run, evidence } = await supervisor.run("local-git-plugin-radar");

  assert.equal(run.status, "completed");
  assert.equal(evidence.sources[0].result.kind, "github_repo");
  assert.ok(evidence.sources[0].result.files.some((file) => file.path === "package.json"));
  assert.ok(evidence.actions.find((action) => action.adapter === "manifest_inspection").result.manifest_count > 0);
  assert.equal(evidence.gates.every((gate) => gate.status === "passed"), true);
});

test("candidate workspace iteration mutates only the candidate copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-candidate-"));
  const source = join(home, "source-repo");
  const candidate = join(home, "candidate-workspaces", "aaa");
  await mkdir(source, { recursive: true });
  await mkdir(candidate, { recursive: true });
  await writeFile(join(source, "README.md"), "# Source\n", "utf8");
  await writeFile(join(candidate, "README.md"), "# Candidate\n", "utf8");
  await exec("git", ["init"], { cwd: candidate });
  await exec("git", ["add", "README.md"], { cwd: candidate });
  await exec("git", ["-c", "user.name=Across Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"], { cwd: candidate });

  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const spec = {
    schema_version: "across-loop-spec/1.0",
    id: "aaa-self-iteration",
    name: "AAA Self Iteration",
    description: "Mutate an AAA candidate workspace without touching the source repository.",
    owner: { type: "local_user", id: "test" },
    compatibility: {
      min_autopilot_version: ">=0.1.0",
      required_orchestrator: ">=0.6.18",
      required_context: ">=0.7.8",
      required_host: ">=0.8.29"
    },
    required_capabilities: [
      "source.directory",
      "action.candidate_workspace_patch",
      "action.orchestrator_task_dispatch",
      "action.candidate_diff_summary",
      "action.candidate_validation",
      "memory.pending_summary"
    ],
    trigger: { type: "manual" },
    scope: { project_id: "aaa", workspace: candidate },
    autonomy: { level: 3, requires_human_approval_above: 3 },
    sources: [{ id: "candidate", type: "directory", adapter: "directory", path: candidate, max_files: 20 }],
    actions: {
      allowed: [
        "file_read",
        "git_read",
        "orchestrator_task_dispatch",
        "candidate_workspace_patch",
        "candidate_diff_summary",
        "candidate_validation",
        "promotion_report_generation",
        "quality_gate_evaluation",
        "report_generation",
        "write_pending_memory"
      ],
      blocked: ["merge_pr", "release_publish", "sign_artifact", "write_secret"]
    },
    execute: { engine: "across-orchestrator", mode: "task" },
    outputs: [
      { type: "markdown_report", to: "run://iteration/report.md", policy: "create" },
      { type: "json_artifact", to: "run://iteration/evidence.json", policy: "overwrite" },
      { type: "context_memory", to: "context://pending", policy: "append" }
    ],
    gates: [
      { id: "model_decision_present", required: true },
      { id: "source_repository_not_targeted", required: true },
      { id: "candidate_has_diff", required: true },
      { id: "candidate_validation_passed", required: true }
    ],
    memory: { provider: "across-context", recall: true, remember: true, write_status: "pending" },
    failure_policy: { max_retries: 0, retry_backoff: "linear", continue_on_gate_failure: false, dead_letter: "context_memory" },
    sandbox: { filesystem: "run_scoped", network: "adapter_scoped", env: "minimal" },
    evidence_contract: {
      schema_version: "across-loop-evidence/1.0",
      required_sections: ["sources", "actions", "gates", "outputs", "memory", "audit"]
    },
    used_adapters: {
      sources: ["directory"],
      actions: [
        "orchestrator_task_dispatch",
        "candidate_workspace_patch",
        "candidate_diff_summary",
        "candidate_validation",
        "promotion_report_generation",
        "quality_gate_evaluation",
        "report_generation",
        "memory_write_candidate"
      ],
      outputs: ["markdown_report", "json_artifact", "context_memory"]
    },
    pack_config: {
      candidate_workspace: candidate,
      source_repository: source,
      mutation_policy: "candidate_workspace_only",
      allowed_patch_paths: ["docs/AAA_SELF_ITERATION_CANDIDATE.md"],
      validation_commands: [{ command: "git", args: ["diff", "--check"], timeout_ms: 30000 }],
    },
    model_policy: {
      required: true,
      allowed_patch_paths: ["docs/AAA_SELF_ITERATION_CANDIDATE.md"],
      context_files: ["README.md"]
    }
  };
  const specPath = join(home, "aaa-self-iteration.loop.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

  const { run, evidence } = await supervisor.run(specPath);

  assert.equal(run.status, "completed");
  assert.equal(await readFile(join(source, "README.md"), "utf8"), "# Source\n");
  const candidateDoc = await readFile(join(candidate, "docs", "AAA_SELF_ITERATION_CANDIDATE.md"), "utf8");
  assert.match(candidateDoc, new RegExp(run.run_id));
  assert.match(candidateDoc, /fake-loop-engineer/);
  assert.equal(evidence.actions.find((action) => action.adapter === "orchestrator_task_dispatch").result.task.model_backed, true);
  assert.equal(evidence.orchestrator.tasks[0].model_backed, true);
  assert.equal(evidence.orchestrator.tasks[0].model_decision.provider, "fake-host");
  assert.equal(evidence.actions.find((action) => action.adapter === "candidate_workspace_patch").result.model_backed, true);
  assert.ok(evidence.actions.find((action) => action.adapter === "candidate_workspace_patch").result.changed_files.includes("docs/AAA_SELF_ITERATION_CANDIDATE.md"));
  assert.ok(evidence.actions.find((action) => action.adapter === "candidate_diff_summary").result.changed_files.includes("docs/AAA_SELF_ITERATION_CANDIDATE.md"));
  assert.equal(evidence.actions.find((action) => action.adapter === "candidate_validation").status, "passed");
  assert.equal(evidence.actions.find((action) => action.adapter === "promotion_report_generation").result.promotion_ready, true);
  assert.equal(evidence.gates.every((gate) => gate.status === "passed"), true);
  const reportPath = evidence.outputs.find((output) => output.id === "markdown_report").path;
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /## Candidate Diff/);
  assert.match(report, /## Model Decision/);
  assert.match(report, /## Promotion/);
});

test("stable controller creates four-repo B candidate and B proves C probe", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-abc-"));
  const sourceRoot = join(home, "sources");
  const aaaSource = join(sourceRoot, "across-agents-assistant");
  const orchestratorSource = join(sourceRoot, "across-orchestrator");
  const contextSource = join(sourceRoot, "across-context");
  await createGitSource(aaaSource, {
    ".gitignore": "build/\nmacOS-Client/.build/\n",
    "README.md": "# AAA Source\n",
    "backend/src/across_agents_assistant/__init__.py": "",
    "build/ignored-artifact.txt": "must not enter B\n",
    "backend/tests/.keep": ""
  });
  await writeFile(join(aaaSource, "CANDIDATE_PRODUCT_PIPELINE_PLAN.md"), "# Candidate Plan\n", "utf8");
  await createGitSource(orchestratorSource, { "README.md": "# Orchestrator Source\n" });
  await createGitSource(contextSource, { "README.md": "# Context Source\n" });

  const hostCommand = join(home, "host-code-command.js");
  await writeFile(hostCommand, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
if (request.model_policy?.direct_patches !== true) {
  throw new Error("expected direct product patch mode");
}
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-loop-engineer",
  decision_hash: "fake-decision",
  summary: "Add semantic product quality review helper",
  patches: [
    {
      path: "backend/src/across_agents_assistant/autopilot_candidate_quality.py",
      mode: "overwrite",
      content: [
        "from __future__ import annotations",
        "",
        "SELF_PROOF_ONLY_PATHS = (",
        "    \\\"loop_engineering_candidate.py\\\",",
        "    \\\"test_loop_engineering_candidate.py\\\",",
        ")",
        "",
        "def evaluate_candidate_product_alignment(evidence):",
        "    changed = list(evidence.get(\\\"changed_files\\\") or [])",
        "    blocking_reasons = []",
        "    if not changed:",
        "        blocking_reasons.append(\\\"candidate has no changed files\\\")",
        "    if changed and all(",
        "        any(token in path for token in SELF_PROOF_ONLY_PATHS)",
        "        for path in changed",
        "    ):",
        "        blocking_reasons.append(\\\"candidate only proves loop execution\\\")",
        "    return {",
        "        \\\"promotion_recommendation\\\": \\\"reject\\\" if blocking_reasons else \\\"review\\\",",
        "        \\\"blocking_reasons\\\": blocking_reasons,",
        "        \\\"changed_file_count\\\": len(changed),",
        "    }"
      ].join("\\n") + "\\n"
    },
    {
      path: "backend/tests/test_autopilot_candidate_quality.py",
      mode: "overwrite",
      content: [
        "from across_agents_assistant.autopilot_candidate_quality import (",
        "    evaluate_candidate_product_alignment,",
        ")",
        "",
        "",
        "def test_alignment_reviews_product_change():",
        "    result = evaluate_candidate_product_alignment({",
        "        \\\"changed_files\\\": [",
        "            \\\"backend/src/across_agents_assistant/autopilot_candidate_quality.py\\\",",
        "        ],",
        "    })",
        "    assert result[\\\"promotion_recommendation\\\"] == \\\"review\\\"",
        "",
        "",
        "def test_alignment_rejects_self_proof_only_change():",
        "    result = evaluate_candidate_product_alignment({",
        "        \\\"changed_files\\\": [",
        "            \\\"backend/src/across_agents_assistant/loop_engineering_candidate.py\\\",",
        "        ],",
        "    })",
        "    assert result[\\\"promotion_recommendation\\\"] == \\\"reject\\\""
      ].join("\\n") + "\\n"
    }
  ]
}));
	`, "utf8");
  const lifecycleCommand = await writeFakeCandidateAppLifecycleCommand(home);

  const previousEnv = snapshotEnv([
    "ACROSS_HOME",
    "ACROSS_AGENTS_ASSISTANT_SOURCE",
    "ACROSS_ORCHESTRATOR_SOURCE",
    "ACROSS_CONTEXT_SOURCE",
    "ACROSS_AUTOPILOT_SOURCE",
    "ACROSS_AAA_HOST_CODE_COMMAND",
    "ACROSS_AAA_CANDIDATE_APP_LIFECYCLE_COMMAND"
  ]);
  Object.assign(process.env, {
    ACROSS_HOME: home,
    ACROSS_AGENTS_ASSISTANT_SOURCE: aaaSource,
    ACROSS_ORCHESTRATOR_SOURCE: orchestratorSource,
    ACROSS_CONTEXT_SOURCE: contextSource,
    ACROSS_AUTOPILOT_SOURCE: process.cwd(),
    ACROSS_AAA_HOST_CODE_COMMAND: JSON.stringify(["node", hostCommand]),
    ACROSS_AAA_CANDIDATE_APP_LIFECYCLE_COMMAND: JSON.stringify(lifecycleCommand)
  });
  try {
    const store = new RunStore({ env: process.env });
    const supervisor = new AutopilotSupervisor({
      store,
      orchestratorClient: new FakeOrchestrator(),
      contextClient: new FakeContext()
    });

    const { run, evidence } = await supervisor.run("aaa-self-iteration-product");

    assert.equal(run.status, "completed");
    assert.equal(evidence.candidate.four_repo_manifest, true);
    assert.equal(evidence.candidate.app_home, join(evidence.candidate.runtime_home, "aaa"));
    assert.equal(evidence.candidate.runtime_preflight.status, "passed");
    assert.equal(evidence.candidate.candidate_app_lifecycle.status, "passed");
    assert.equal(evidence.candidate.candidate_app_lifecycle.cleaned_up, true);
    assert.equal(evidence.candidate.candidate_app_lifecycle.llm_status.availability_source, "candidate_model_lease");
    assert.equal(evidence.candidate.model.backed, true);
    assert.equal(evidence.candidate.self_hosting_probe.required, true);
    assert.equal(evidence.candidate.self_hosting_probe.status, "passed");
    assert.equal(evidence.candidate.semantic_alignment_status, "passed");
    assert.equal(evidence.candidate.semantic_alignment_recommendation, "review");
    assert.equal(evidence.candidate.independent_reviewer.merge_recommendation, "open_review_pr");
    assert.ok(evidence.candidate.independent_reviewer.product_value_score >= 70);
    assert.equal(evidence.candidate.promotion_package.human_approval_required, true);
    assert.equal(evidence.candidate.promotion_package.source_ref_pins.status, "passed");
    assert.equal(evidence.candidate.promotion_package.source_ref_pins.repos.length, 4);
    assert.match(evidence.candidate.promotion_package.recommended_pr.title, /^Review:/);
    assert.equal(evidence.candidate.promotion_package.reviewer_scores.merge_recommendation, "open_review_pr");
    assert.match(evidence.candidate.candidate_root, /candidate-workspaces/);
    assert.match(evidence.candidate.workspace_root, /candidate-workspaces/);
    assert.ok(Array.isArray(evidence.candidate.repos));
    assert.ok(evidence.candidate.repos.find((repo) => repo.id === "across-agents-assistant"));
    assert.deepEqual(evidence.candidate.quality_findings, []);
    assert.deepEqual(evidence.candidate.ignored_generated_artifacts, []);
    assert.equal(evidence.candidate.validation.status, "passed");
    assert.ok(evidence.candidate.validation.command_count >= 2);
    assert.ok(evidence.candidate.changed_files.includes("across-agents-assistant/backend/src/across_agents_assistant/autopilot_candidate_quality.py"));
    assert.ok(evidence.candidate.changed_files.includes("across-agents-assistant/backend/tests/test_autopilot_candidate_quality.py"));
    assert.ok(evidence.gates.find((gate) => gate.id === "four_repo_manifest_written" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "candidate_runtime_preflight_passed" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "candidate_app_lifecycle_passed" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "source_a_unchanged" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "semantic_alignment_passed" && gate.status === "passed"));
    assert.equal(evidence.actions.find((action) => action.adapter === "semantic_alignment_review").status, "passed");
    const acquire = evidence.actions.find((action) => action.adapter === "candidate_ecosystem_acquire").result;
    const aaaCandidate = acquire.repos.find((repo) => repo.id === "across-agents-assistant").target;
    assert.equal(await fileExists(join(aaaCandidate, "CANDIDATE_PRODUCT_PIPELINE_PLAN.md")), true);
    assert.equal(await fileExists(join(aaaCandidate, "build", "ignored-artifact.txt")), false);
    assert.equal(await readFile(join(aaaSource, "README.md"), "utf8"), "# AAA Source\n");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("research-driven self-iteration selects a target before mutating B", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-research-"));
  const sourceRoot = join(home, "sources");
  const aaaSource = join(sourceRoot, "across-agents-assistant");
  const orchestratorSource = join(sourceRoot, "across-orchestrator");
  const contextSource = join(sourceRoot, "across-context");
  await createGitSource(aaaSource, {
    ".gitignore": "build/\n",
    "README.md": "# AAA Source\n",
    "LOOP_ENGINEERING_PLATFORM_PLAN.md": "# Loop Platform\n",
    "CANDIDATE_PRODUCT_PIPELINE_PLAN.md": "# Candidate Plan\n",
    "backend/src/across_agents_assistant/__init__.py": "",
    "backend/tests/.keep": ""
  });
  await createGitSource(orchestratorSource, { "README.md": "# Orchestrator Source\n" });
  await createGitSource(contextSource, { "README.md": "# Context Source\n" });

  const researchCommand = join(home, "host-research-command.js");
  await writeFile(researchCommand, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
if (!request.sources.length) throw new Error("expected research sources");
const target = request.target_catalog.find((item) => item.id === "research_signal_quality");
console.log(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "fake-research-decision",
  decision: "review",
  summary: "Select research-backed candidate scoring",
  rationale: "Agent platforms emphasize traceable evaluations before promotion.",
  selected_target_id: "research_signal_quality",
  rejected_directions: ["auto-merge"],
  selected_iteration: {
    target_id: "research_signal_quality",
    target_repo: "across-agents-assistant",
    goal: target.goal,
    allowed_patch_paths: target.allowed_patch_paths,
    context_files: target.context_files,
    validation_commands: target.validation_commands,
    semantic_review: target.semantic_review,
    source_refs: ["fixture-agent-research"],
    risk: "low"
  }
}));
`, "utf8");

  const codeCommand = join(home, "host-code-command.js");
  await writeFile(codeCommand, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
if (!request.goal.includes("score_research_iteration_candidate")) throw new Error("expected strategy goal");
if (!request.allowed_patch_paths.includes("backend/src/across_agents_assistant/autopilot_research_signal.py")) {
  throw new Error("expected research signal target");
}
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-loop-engineer",
  decision_hash: "fake-code-decision",
  summary: "Add research candidate scoring helper",
  patches: [
    {
      path: "backend/src/across_agents_assistant/autopilot_research_signal.py",
      mode: "overwrite",
      content: "def score_research_iteration_candidate(research_brief):\\n    sources = list(research_brief.get('sources') or [])\\n    validation = list(research_brief.get('validation_commands') or [])\\n    evidence_count = len(sources)\\n    if not evidence_count:\\n        return {'recommendation': 'reject', 'evidence_count': 0, 'blocking_reasons': ['research evidence is missing']}\\n    recommendation = 'implement' if len(validation) >= 1 else 'review'\\n    return {'recommendation': recommendation, 'evidence_count': evidence_count, 'blocking_reasons': []}\\n"
    },
    {
      path: "backend/tests/test_autopilot_research_signal.py",
      mode: "overwrite",
      content: "from across_agents_assistant.autopilot_research_signal import score_research_iteration_candidate\\n\\ndef test_scores_research_candidate():\\n    result = score_research_iteration_candidate({'sources': [{'id': 'openhands'}], 'validation_commands': ['python -m pytest']})\\n    assert result['recommendation'] == 'implement'\\n    assert result['evidence_count'] == 1\\n"
    }
  ]
}));
`, "utf8");

  const previousEnv = snapshotEnv([
    "ACROSS_HOME",
    "ACROSS_AGENTS_ASSISTANT_SOURCE",
    "ACROSS_ORCHESTRATOR_SOURCE",
    "ACROSS_CONTEXT_SOURCE",
    "ACROSS_AUTOPILOT_SOURCE",
    "ACROSS_AAA_HOST_RESEARCH_COMMAND",
    "ACROSS_AAA_HOST_CODE_COMMAND"
  ]);
  Object.assign(process.env, {
    ACROSS_HOME: home,
    ACROSS_AGENTS_ASSISTANT_SOURCE: aaaSource,
    ACROSS_ORCHESTRATOR_SOURCE: orchestratorSource,
    ACROSS_CONTEXT_SOURCE: contextSource,
    ACROSS_AUTOPILOT_SOURCE: process.cwd(),
    ACROSS_AAA_HOST_RESEARCH_COMMAND: JSON.stringify(["node", researchCommand]),
    ACROSS_AAA_HOST_CODE_COMMAND: JSON.stringify(["node", codeCommand])
  });
  try {
    const spec = JSON.parse(await readFile(join("examples", "aaa-research-driven-self-iteration.loop.json"), "utf8"));
    spec.id = "aaa-research-driven-self-iteration-test";
    spec.sources = [
      {
        id: "fixture-agent-research",
        type: "manual_input",
        adapter: "manual_input",
        title: "Agent research fixture",
        content: "Modern coding agents emphasize trace evidence, evals, and human review before promotion."
      }
    ];
    spec.used_adapters.sources = ["manual_input"];
    const specPath = join(home, "aaa-research-driven-self-iteration.loop.json");
    await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

    const store = new RunStore({ env: process.env });
    const supervisor = new AutopilotSupervisor({
      store,
      orchestratorClient: new FakeOrchestrator(),
      contextClient: new FakeContext()
    });

    const { run, evidence } = await supervisor.run(specPath);

    assert.equal(run.status, "completed");
    const strategy = evidence.actions.find((action) => action.adapter === "product_iteration_strategy").result;
    assert.equal(strategy.selected_target_id, "research_signal_quality");
    assert.equal(strategy.model_backed, true);
    assert.equal(evidence.candidate.research_strategy.selected_target_id, "research_signal_quality");
    assert.ok(evidence.candidate.changed_files.includes("across-agents-assistant/backend/src/across_agents_assistant/autopilot_research_signal.py"));
    assert.ok(evidence.gates.find((gate) => gate.id === "research_iteration_strategy_ready" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "semantic_alignment_passed" && gate.status === "passed"));
    const acquire = evidence.actions.find((action) => action.adapter === "candidate_ecosystem_acquire").result;
    const aaaCandidate = acquire.repos.find((repo) => repo.id === "across-agents-assistant").target;
    assert.equal(await readFile(join(aaaSource, "README.md"), "utf8"), "# AAA Source\n");
    assert.equal(await fileExists(join(aaaCandidate, "backend/src/across_agents_assistant/autopilot_research_signal.py")), true);
  } finally {
    restoreEnv(previousEnv);
  }
});

test("autonomous self-iteration builds dynamic backlog and independent reviewer evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-autonomous-"));
  const sourceRoot = join(home, "sources");
  const aaaSource = join(sourceRoot, "across-agents-assistant");
  const orchestratorSource = join(sourceRoot, "across-orchestrator");
  const contextSource = join(sourceRoot, "across-context");
  await createGitSource(aaaSource, {
    ".gitignore": "build/\n",
    "README.md": "# AAA Source\n",
    "LOOP_ENGINEERING_REFERENCE_ARCHITECTURE.md": "# Reference Architecture\nTool Pack Registry\nLoop Contract\nIndependent Reviewer\n",
    "LOOP_ENGINEERING_PLATFORM_PLAN.md": "# Loop Platform\n",
    "CANDIDATE_PRODUCT_PIPELINE_PLAN.md": "# Candidate Plan\n",
    "backend/src/across_agents_assistant/__init__.py": "",
    "backend/tests/.keep": ""
  });
  await createGitSource(orchestratorSource, { "README.md": "# Orchestrator Source\n" });
  await createGitSource(contextSource, { "README.md": "# Context Source\n" });

  const researchCommand = join(home, "host-research-command.js");
  await writeFile(researchCommand, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
if (!request.product_context?.autonomous_loop_state) throw new Error("expected autonomous loop state");
if (request.target_catalog.length !== 0) throw new Error("production autonomous loop should not receive fixed target catalog");
if (request.target_generation?.allow_model_generated_targets !== true) throw new Error("expected generated target permission");
if (request.model_policy?.provider !== "fake-host") throw new Error("expected selected research provider");
const generated = [
  {
    id: "tool-pack-policy-generated",
    target_repo: "across-agents-assistant",
    summary: "Add Tool Pack policy helper from model-generated backlog",
    goal: "Implement evaluate_tool_pack_candidate so autonomous runs can verify stable Tool Pack usage.",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_tool_pack_policy.py",
      "backend/tests/test_autopilot_tool_pack_policy.py"
    ],
    context_files: ["LOOP_ENGINEERING_REFERENCE_ARCHITECTURE.md"],
    validation_commands: [
      { repo: "across-agents-assistant", command: "python3", args: ["-m", "py_compile", "backend/src/across_agents_assistant/autopilot_tool_pack_policy.py", "backend/tests/test_autopilot_tool_pack_policy.py"], timeout_ms: 30000 },
      { repo: "across-agents-assistant", command: "python3", args: ["-c", "import sys, runpy; sys.path.insert(0, 'backend/src'); ns=runpy.run_path('backend/tests/test_autopilot_tool_pack_policy.py'); tests=[v for k,v in ns.items() if k.startswith('test_') and callable(v)]; assert tests; [test() for test in tests]"], timeout_ms: 30000 }
    ],
    semantic_review: { minimum_validation_commands: 2, independent_reviewer_required: true },
    source_refs: ["architecture-signal"],
    tool_packs: ["candidate_workspace", "validation_harness", "independent_review"],
    generated_from: "model_generated",
    score: 98,
    risk: "low"
  },
  {
    id: "loop-memory-review-generated",
    target_repo: "across-agents-assistant",
    summary: "Add memory review helper from model-generated backlog",
    goal: "Implement a helper that summarizes recalled memory usefulness before backlog planning.",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_memory_review.py",
      "backend/tests/test_autopilot_memory_review.py"
    ],
    validation_commands: [
      { repo: "across-agents-assistant", command: "python3", args: ["-m", "py_compile", "backend/src/across_agents_assistant/autopilot_memory_review.py", "backend/tests/test_autopilot_memory_review.py"], timeout_ms: 30000 },
      { repo: "across-agents-assistant", command: "git", args: ["diff", "--check"], timeout_ms: 30000 }
    ],
    semantic_review: { minimum_validation_commands: 2, independent_reviewer_required: true },
    source_refs: ["architecture-signal"],
    tool_packs: ["source_research_digest", "validation_harness"],
    generated_from: "model_generated",
    score: 80,
    risk: "low"
  },
  {
    id: "reviewer-separation-generated",
    target_repo: "across-agents-assistant",
    summary: "Add reviewer separation helper from model-generated backlog",
    goal: "Implement a helper that verifies builder and reviewer evidence separation.",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_reviewer_policy.py",
      "backend/tests/test_autopilot_reviewer_policy.py"
    ],
    validation_commands: [
      { repo: "across-agents-assistant", command: "python3", args: ["-m", "py_compile", "backend/src/across_agents_assistant/autopilot_reviewer_policy.py", "backend/tests/test_autopilot_reviewer_policy.py"], timeout_ms: 30000 },
      { repo: "across-agents-assistant", command: "git", args: ["diff", "--check"], timeout_ms: 30000 }
    ],
    semantic_review: { minimum_validation_commands: 2, independent_reviewer_required: true },
    source_refs: ["architecture-signal"],
    tool_packs: ["independent_review", "validation_harness"],
    generated_from: "model_generated",
    score: 70,
    risk: "low"
  }
];
const target = generated[0];
console.log(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "fake-autonomous-research",
  decision: "review",
  summary: "Select Tool Pack policy because source signals emphasize deterministic tools.",
  rationale: "Tool Pack Registry reduces token waste and stabilizes repeatable git/validation flows.",
  selected_target_id: target.id,
  candidate_targets: generated,
  selected_iteration: {
    target_id: target.id,
    target_repo: target.target_repo,
    goal: target.goal,
    allowed_patch_paths: target.allowed_patch_paths,
    context_files: target.context_files,
    validation_commands: target.validation_commands,
    semantic_review: target.semantic_review,
    source_refs: target.source_refs,
    tool_packs: target.tool_packs,
    generated_from: target.generated_from,
    score: target.score,
    risk: target.risk
  }
}));
`, "utf8");

  const codeCommand = join(home, "host-code-command.js");
  await writeFile(codeCommand, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
if (!request.allowed_patch_paths.includes("backend/src/across_agents_assistant/autopilot_tool_pack_policy.py")) {
  throw new Error("expected dynamic Tool Pack target");
}
if (request.model_policy?.model !== "fake-loop-engineer") throw new Error("expected selected builder model");
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-loop-engineer",
  decision_hash: "fake-autonomous-code",
  summary: "Add Tool Pack policy helper",
  patches: [
    {
      path: "backend/src/across_agents_assistant/autopilot_tool_pack_policy.py",
      mode: "overwrite",
      content: "REQUIRED = {'candidate_workspace', 'validation_harness'}\\n\\ndef evaluate_tool_pack_candidate(candidate):\\n    packs = set(candidate.get('tool_packs') or [])\\n    missing = sorted(REQUIRED - packs)\\n    return {'recommendation': 'review' if missing else 'implement', 'tool_pack_count': len(packs), 'missing_tool_packs': missing}\\n"
    },
    {
      path: "backend/tests/test_autopilot_tool_pack_policy.py",
      mode: "overwrite",
      content: "from across_agents_assistant.autopilot_tool_pack_policy import evaluate_tool_pack_candidate\\n\\ndef test_accepts_required_tool_packs():\\n    result = evaluate_tool_pack_candidate({'tool_packs': ['candidate_workspace', 'validation_harness']})\\n    assert result['recommendation'] == 'implement'\\n\\ndef test_reviews_missing_tool_pack():\\n    result = evaluate_tool_pack_candidate({'tool_packs': ['candidate_workspace']})\\n    assert result['recommendation'] == 'review'\\n"
    }
  ]
}));
`, "utf8");

  const reviewCommand = join(home, "host-review-command.js");
  await writeFile(reviewCommand, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
if (request.builder_model?.model !== "fake-loop-engineer") {
  throw new Error("expected builder model evidence");
}
if (request.model_policy?.model !== "fake-reviewer") throw new Error("expected selected reviewer model");
console.log(JSON.stringify({
  schema_version: "across-host-review-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-reviewer",
  decision_hash: "fake-autonomous-review",
  recommendation: "review",
  merge_recommendation: "open_review_pr",
  product_value_score: 91,
  maintainability_score: 93,
  risk_score: 9,
  blocking_reasons: [],
  human_review_notes: ["human approval is still required before promotion"]
}));
	`, "utf8");
  const lifecycleCommand = await writeFakeCandidateAppLifecycleCommand(home);

  const previousEnv = snapshotEnv([
    "ACROSS_HOME",
    "ACROSS_AGENTS_ASSISTANT_SOURCE",
    "ACROSS_ORCHESTRATOR_SOURCE",
    "ACROSS_CONTEXT_SOURCE",
    "ACROSS_AUTOPILOT_SOURCE",
    "ACROSS_AAA_HOST_RESEARCH_COMMAND",
    "ACROSS_AAA_HOST_CODE_COMMAND",
    "ACROSS_AAA_HOST_REVIEW_COMMAND",
    "ACROSS_AAA_CANDIDATE_APP_LIFECYCLE_COMMAND"
  ]);
  Object.assign(process.env, {
    ACROSS_HOME: home,
    ACROSS_AGENTS_ASSISTANT_SOURCE: aaaSource,
    ACROSS_ORCHESTRATOR_SOURCE: orchestratorSource,
    ACROSS_CONTEXT_SOURCE: contextSource,
    ACROSS_AUTOPILOT_SOURCE: process.cwd(),
    ACROSS_AAA_HOST_RESEARCH_COMMAND: JSON.stringify(["node", researchCommand]),
    ACROSS_AAA_HOST_CODE_COMMAND: JSON.stringify(["node", codeCommand]),
    ACROSS_AAA_HOST_REVIEW_COMMAND: JSON.stringify(["node", reviewCommand]),
    ACROSS_AAA_CANDIDATE_APP_LIFECYCLE_COMMAND: JSON.stringify(lifecycleCommand)
  });
  try {
    const spec = JSON.parse(await readFile(join("examples", "aaa-autonomous-self-iteration.loop.json"), "utf8"));
    spec.id = "aaa-autonomous-self-iteration-test";
    spec.sources = [{
      id: "architecture-signal",
      type: "manual_input",
      adapter: "manual_input",
      title: "Architecture signal",
      content: "Stable Tool Packs, guardrails, context engineering, and distinct reviewer models should guide autonomous iteration."
    }];
    spec.used_adapters.sources = ["manual_input"];
    spec.pack_config.self_hosting_probe.required = false;
    const specPath = join(home, "aaa-autonomous-self-iteration.loop.json");
    await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

    const store = new RunStore({ env: process.env });
    const supervisor = new AutopilotSupervisor({
      store,
      orchestratorClient: new FakeOrchestrator(),
      contextClient: new FakeContext()
    });

    const { run, evidence } = await supervisor.run(specPath, {
      modelOverrides: {
        research: { provider: "fake-host", model: "fake-researcher" },
        builder: { agent_id: "minimax", provider: "fake-host", model: "fake-loop-engineer" },
        reviewer: { agent_id: "minimax", provider: "fake-host", model: "fake-reviewer", require_distinct_from_builder: true }
      }
    });

    assert.equal(run.status, "completed");
    const strategy = evidence.actions.find((action) => action.adapter === "product_iteration_strategy").result;
    assert.equal(strategy.autonomous, true);
    assert.ok(strategy.autonomous_state.contract_paths.readme.endsWith("README.md"));
    assert.ok(strategy.dynamic_backlog.length >= 3);
    assert.equal(strategy.selected_target_id, "tool-pack-policy-generated");
    assert.equal(strategy.candidate_comparison.selected_target_id, "tool-pack-policy-generated");
    assert.ok(strategy.candidate_comparison.candidate_count >= 3);
    assert.ok(strategy.selected_iteration.tool_packs.includes("candidate_workspace"));
    assert.equal(strategy.tool_pack_evidence.packs.find((pack) => pack.id === "model_generated_fallback_plan").model_may_prepare_bounded_plan, true);
    assert.equal(strategy.admission.status, "passed");
    assert.equal(strategy.admission.generated, true);
    assert.equal(evidence.candidate.research_strategy.autonomous, true);
    assert.equal(evidence.candidate.research_strategy.candidate_comparison.selected_target_id, "tool-pack-policy-generated");
    assert.equal(evidence.candidate.candidate_app_lifecycle.status, "passed");
    assert.equal(evidence.candidate.candidate_app_lifecycle.cleaned_up, true);
    assert.equal(evidence.candidate.candidate_app_lifecycle.llm_status.availability_source, "candidate_model_lease");
    assert.ok(evidence.candidate.research_strategy.dynamic_backlog_count >= 3);
    assert.ok(evidence.candidate.research_strategy.tool_packs.includes("candidate_workspace"));
    assert.equal(evidence.candidate.independent_reviewer.independent, true);
    assert.equal(evidence.candidate.independent_reviewer.model, "fake-reviewer");
    assert.equal(evidence.candidate.independent_reviewer.model_separation.status, "passed");
    assert.ok(evidence.candidate.changed_files.includes("across-agents-assistant/backend/src/across_agents_assistant/autopilot_tool_pack_policy.py"));
    assert.ok(evidence.gates.find((gate) => gate.id === "dynamic_backlog_ready" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "candidate_app_lifecycle_passed" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "independent_reviewer_passed" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "distinct_reviewer_model_passed" && gate.status === "passed"));
    assert.equal(await fileExists(strategy.autonomous_state.contract_paths.backlog), true);
    assert.equal(await fileExists(strategy.autonomous_state.global_timeline_path), true);
    assert.equal(await readFile(join(aaaSource, "README.md"), "utf8"), "# AAA Source\n");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("strategy admission replaces invalid python -c validation commands with deterministic fallbacks", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-invalid-validation-command-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await mkdir(join(repo, "backend", "src", "across_agents_assistant"), { recursive: true });
  await mkdir(join(repo, "backend", "tests"), { recursive: true });
  await writeFile(join(repo, "backend", "src", "across_agents_assistant", "__init__.py"), "", "utf8");
  const commandPath = join(home, "host-research-invalid-command.js");
  await writeFile(commandPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "invalid-command",
  decision: "implement",
  selected_target_id: "invalid-validation-command",
  summary: "Select target with invalid validation command",
  selected_iteration: {
    target_id: "invalid-validation-command",
    target_repo: "across-agents-assistant",
    goal: "Add a candidate helper.",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_invalid_command.py",
      "backend/tests/test_autopilot_invalid_command.py"
    ],
    validation_commands: [
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: ["-c", "import tempfile; with tempfile.TemporaryDirectory() as td: print(td)"]
      }
    ],
    semantic_review: { minimum_validation_commands: 2 },
    risk: "low"
  },
  rejected_directions: []
}));
`, "utf8");

  const previousEnv = snapshotEnv(["ACROSS_AAA_HOST_RESEARCH_COMMAND", "ACROSS_HOME"]);
  Object.assign(process.env, {
    ACROSS_AAA_HOST_RESEARCH_COMMAND: JSON.stringify(["node", commandPath]),
    ACROSS_HOME: home
  });
  try {
    const strategy = await runProductIterationStrategy({
      spec: {
        id: "invalid-validation-command",
        name: "Invalid Validation Command",
        pack_config: {
          target_repo: "across-agents-assistant",
          model_policy: { required: true },
          research_strategy: {
            candidate_targets: [{
              id: "invalid-validation-command",
              target_repo: "across-agents-assistant",
              goal: "Add a candidate helper.",
              allowed_patch_paths: [
                "backend/src/across_agents_assistant/autopilot_invalid_command.py",
                "backend/tests/test_autopilot_invalid_command.py"
              ],
              validation_commands: [],
              semantic_review: { minimum_validation_commands: 2 }
            }]
          }
        }
      },
      run: { run_id: "run-invalid-validation-command" },
      sources: [],
      actions: [{
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-invalid-validation-command",
          repos: [{ id: "across-agents-assistant", target: repo, source: repo }],
          four_repo_manifest: true
        }
      }],
      recalledMemory: [],
      env: process.env
    });

    const rendered = strategy.selected_iteration.validation_commands.map((command) => [command.command, ...command.args].join(" "));
    assert.equal(rendered.some((command) => command.includes("with tempfile.TemporaryDirectory")), false);
    assert.ok(rendered.some((command) => command.includes("git diff --check")));
    assert.ok(rendered.some((command) => command.includes("py_compile")));
    assert.ok(rendered.some((command) => command.includes("runpy.run_path")));
  } finally {
    restoreEnv(previousEnv);
  }
});

test("research-driven self-iteration validates generated tests directly", async () => {
  const spec = JSON.parse(await readFile(join("examples", "aaa-research-driven-self-iteration.loop.json"), "utf8"));
  const targets = spec.pack_config.research_strategy.candidate_targets;

  for (const target of targets) {
    const testPaths = target.allowed_patch_paths.filter((path) => path.startsWith("backend/tests/") && path.endsWith(".py"));
    for (const testPath of testPaths) {
      assert.ok(
        target.validation_commands.some((command) => (
          command.command === "python3"
          && command.args?.[0] === "-c"
          && String(command.args?.[1] || "").includes(`runpy.run_path('${testPath}')`)
          && String(command.args?.[1] || "").includes("callable(v)")
        )),
        `${target.id} must execute generated test functions in ${testPath}`
      );
    }
    assert.ok(
      target.semantic_review.minimum_validation_commands >= 3,
      `${target.id} must require compile, direct test execution, and behavioral smoke validation`
    );
  }
});

test("validation failure triggers bounded host code repair", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-research-repair-"));
  const sourceRoot = join(home, "sources");
  const aaaSource = join(sourceRoot, "across-agents-assistant");
  const orchestratorSource = join(sourceRoot, "across-orchestrator");
  const contextSource = join(sourceRoot, "across-context");
  await createGitSource(aaaSource, {
    ".gitignore": "build/\n",
    "README.md": "# AAA Source\n",
    "LOOP_ENGINEERING_PLATFORM_PLAN.md": "# Loop Platform\n",
    "CANDIDATE_PRODUCT_PIPELINE_PLAN.md": "# Candidate Plan\n",
    "backend/src/across_agents_assistant/__init__.py": "",
    "backend/tests/.keep": ""
  });
  await createGitSource(orchestratorSource, { "README.md": "# Orchestrator Source\n" });
  await createGitSource(contextSource, { "README.md": "# Context Source\n" });

  const researchCommand = join(home, "host-research-command.js");
  await writeFile(researchCommand, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
const target = request.target_catalog.find((item) => item.id === "research_signal_quality");
console.log(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "fake-research-decision",
  decision: "implement",
  summary: "Select research-backed candidate scoring",
  rationale: "Research requires validation-backed candidate scoring.",
  selected_target_id: "research_signal_quality",
  selected_iteration: {
    target_id: "research_signal_quality",
    target_repo: "across-agents-assistant",
    goal: target.goal,
    allowed_patch_paths: target.allowed_patch_paths,
    context_files: target.context_files,
    validation_commands: target.validation_commands,
    semantic_review: target.semantic_review,
    source_refs: ["fixture-agent-research"],
    risk: "low"
  }
}));
`, "utf8");

  const codeCommand = join(home, "host-code-command.js");
  await writeFile(codeCommand, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
const counterPath = path.join(${JSON.stringify(home)}, "repair-count.txt");
const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
fs.writeFileSync(counterPath, String(count + 1));
if (count === 0 && request.validation_feedback.length) throw new Error("first attempt should not include validation feedback");
if (count > 0 && !request.validation_feedback.length) throw new Error("repair attempt must include validation feedback");
const helper = count === 0
  ? "def score_research_iteration_candidate(research_brief):\\n    sources = list(research_brief.get('sources') or [])\\n    validation = list(research_brief.get('validation_commands') or [])\\n    relevance = {'high': 1.0, 'medium': 0.6, 'low': 0.3}.get(sources[0].get('relevance', 'low'), 0.0) if sources else 0.0\\n    if not sources or not validation or relevance < 0.3:\\n        return {'recommendation': 'reject', 'evidence_count': len(sources)}\\n    return {'recommendation': 'review', 'evidence_count': len(sources) + len(validation)}\\n"
  : count === 1
  ? "def score_research_iteration_candidate(research_brief):\\n    sources = list(research_brief.get('sources') or [])\\n    validation = list(research_brief.get('validation_commands') or [])\\n    relevance = {'high': 1.0, 'medium': 0.6, 'low': 0.2}.get(sources[0].get('relevance', 'low'), 0.0) if sources else 0.0\\n    if not sources or not validation or relevance < 0.2:\\n        return {'recommendation': 'reject', 'evidence_count': len(sources)}\\n    return {'recommendation': 'review', 'evidence_count': len(sources) + len(validation)}\\n"
  : "def score_research_iteration_candidate(research_brief):\\n    sources = list(research_brief.get('sources') or [])\\n    validation = list(research_brief.get('validation_commands') or [])\\n    relevance = {'high': 1.0, 'medium': 0.6, 'low': 0.2}.get(sources[0].get('relevance', 'low'), 0.0) if sources else 0.0\\n    if not sources or not validation or relevance <= 0.3:\\n        return {'recommendation': 'reject', 'evidence_count': len(sources)}\\n    return {'recommendation': 'review', 'evidence_count': len(sources) + len(validation)}\\n";
const tests = "import os\\nimport sys\\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))\\nfrom across_agents_assistant.autopilot_research_signal import score_research_iteration_candidate\\n\\ndef test_reject_low_relevance():\\n    result = score_research_iteration_candidate({'sources': [{'relevance': 'low'}], 'validation_commands': ['python -m pytest']})\\n    assert result['recommendation'] == 'reject'\\n\\ndef test_review_high_relevance():\\n    result = score_research_iteration_candidate({'sources': [{'relevance': 'high'}], 'validation_commands': ['python -m pytest']})\\n    assert result['recommendation'] == 'review'\\n\\nif __name__ == '__main__':\\n    test_reject_low_relevance()\\n    test_review_high_relevance()\\n";
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-loop-engineer",
  decision_hash: "fake-code-decision-" + count,
  summary: count === 0 ? "Add candidate scoring helper" : "Repair low relevance threshold",
  patches: [
    { path: "backend/src/across_agents_assistant/autopilot_research_signal.py", mode: "overwrite", content: helper },
    { path: "backend/tests/test_autopilot_research_signal.py", mode: "overwrite", content: tests }
  ]
}));
`, "utf8");

  const previousEnv = snapshotEnv([
    "ACROSS_HOME",
    "ACROSS_AGENTS_ASSISTANT_SOURCE",
    "ACROSS_ORCHESTRATOR_SOURCE",
    "ACROSS_CONTEXT_SOURCE",
    "ACROSS_AUTOPILOT_SOURCE",
    "ACROSS_AAA_HOST_RESEARCH_COMMAND",
    "ACROSS_AAA_HOST_CODE_COMMAND"
  ]);
  Object.assign(process.env, {
    ACROSS_HOME: home,
    ACROSS_AGENTS_ASSISTANT_SOURCE: aaaSource,
    ACROSS_ORCHESTRATOR_SOURCE: orchestratorSource,
    ACROSS_CONTEXT_SOURCE: contextSource,
    ACROSS_AUTOPILOT_SOURCE: process.cwd(),
    ACROSS_AAA_HOST_RESEARCH_COMMAND: JSON.stringify(["node", researchCommand]),
    ACROSS_AAA_HOST_CODE_COMMAND: JSON.stringify(["node", codeCommand])
  });
  try {
    const spec = JSON.parse(await readFile(join("examples", "aaa-research-driven-self-iteration.loop.json"), "utf8"));
    spec.id = "aaa-research-driven-self-iteration-repair-test";
    spec.sources = [{
      id: "fixture-agent-research",
      type: "manual_input",
      adapter: "manual_input",
      title: "Agent research fixture",
      content: "Modern coding agents emphasize trace evidence, evals, and human review before promotion."
    }];
    spec.used_adapters.sources = ["manual_input"];
    spec.pack_config.self_hosting_probe.required = false;
    spec.pack_config.candidate_validation = { max_repairs: 3 };
    const specPath = join(home, "aaa-research-driven-self-iteration-repair.loop.json");
    await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

    const store = new RunStore({ env: process.env });
    const supervisor = new AutopilotSupervisor({
      store,
      orchestratorClient: new FakeOrchestrator(),
      contextClient: new FakeContext()
    });
    const { run, evidence } = await supervisor.run(specPath);

    assert.equal(run.status, "completed");
    const validations = evidence.actions.filter((action) => action.adapter === "candidate_ecosystem_validation");
    assert.equal(validations[0].status, "attention");
    assert.equal(validations.at(-1).status, "passed");
    const repairs = evidence.actions.filter((action) => action.id === "host_code_iteration_repair");
    assert.equal(repairs.length, 2);
    assert.deepEqual(repairs.map((action) => action.result.repair_attempt), [1, 2]);
    assert.equal(evidence.candidate.validation_status, "passed");
    assert.equal(evidence.candidate.promotion_ready, true);
    assert.deepEqual(evidence.risks, []);
  } finally {
    restoreEnv(previousEnv);
  }
});

test("semantic alignment review rejects self-proof-only candidate changes", async () => {
  const result = await semanticAlignmentReview({
    spec: {
      pack_config: {
        semantic_review: {
          require_model_backed: true,
          forbidden_changed_path_patterns: ["loop_engineering_candidate.py"],
          reject_self_proof_only: true,
          minimum_validation_commands: 1
        }
      }
    },
    actions: [
      {
        adapter: "host_code_iteration",
        result: {
          status: "passed",
          model_backed: true,
          summary: "Add candidate loop proof helper"
        }
      },
      {
        adapter: "candidate_ecosystem_diff",
        result: {
          status: "passed",
          changed_files: [
            "across-agents-assistant/backend/src/across_agents_assistant/loop_engineering_candidate.py",
            "across-agents-assistant/backend/tests/test_loop_engineering_candidate.py"
          ]
        }
      },
      {
        adapter: "candidate_ecosystem_validation",
        result: {
          status: "passed",
          commands: [{ status: "passed" }]
        }
      }
    ]
  });

  assert.equal(result.status, "failed");
  assert.equal(result.promotion_recommendation, "reject");
  assert.ok(result.blocking_reasons.some((reason) => reason.includes("self") || reason.includes("forbidden")));
});

test("candidate validation injects repo-local Python import paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-validation-pythonpath-"));
  const repo = join(home, "candidate", "across-autopilot");
  await mkdir(join(repo, "src", "across_autopilot"), { recursive: true });
  await writeFile(join(repo, "src", "across_autopilot", "__init__.py"), "", "utf8");
  await writeFile(join(repo, "src", "across_autopilot", "probe.py"), "VALUE = 'ok'\n", "utf8");
  await exec("git", ["init"], { cwd: repo });
  await exec("git", ["add", "src/across_autopilot/__init__.py", "src/across_autopilot/probe.py"], { cwd: repo });
  await exec("git", ["-c", "user.name=Across Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"], { cwd: repo });

  const result = await validateCandidateEcosystem({
    spec: {
      id: "pythonpath-validation",
      pack_config: {
        target_repo: "across-autopilot",
        candidate_validation: {
          commands: [
            {
              repo: "across-autopilot",
              command: "python3",
              args: ["-c", "from across_autopilot.probe import VALUE; assert VALUE == 'ok'"]
            }
          ]
        }
      }
    },
    run: { run_id: "run-pythonpath-validation" },
    actions: [{
      adapter: "candidate_ecosystem_acquire",
      result: {
        candidate_id: "candidate-pythonpath-validation",
        runtime_home: home,
        app_home: join(home, "aaa"),
        runtime_preflight: { status: "passed" },
        repos: [{
          id: "across-autopilot",
          target: repo,
          source: repo,
          head_pre: "head",
          status_pre: ""
        }]
      }
    }],
    env: { ...process.env, ACROSS_HOME: home }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.commands[0].status, "passed");
});

test("candidate app lifecycle runs the host command and records packaged app evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-app-lifecycle-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  const script = join(home, "fake-candidate-app-lifecycle.sh");
  await mkdir(repo, { recursive: true });
  await writeFile(script, `#!/bin/sh
out=""
app=""
runtime=""
home_arg=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --app-path) app="$2"; shift 2 ;;
    --runtime-home) runtime="$2"; shift 2 ;;
    --app-home) home_arg="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$(dirname "$app")" "$(dirname "$out")"
mkdir -p "$app"
printf '{"status":"passed","candidate_id":"cand-app","bundle_id":"app.acrossagents.assistant.candidate.cand-app","app_path":"%s","runtime_home":"%s","app_home":"%s","socket_path":"%s/run/across-agents.sock","socket_path_bytes":80,"cleaned_up":true,"crash_reports":[],"health":{"status":"ok"},"llm_status":{"available":true,"availability_source":"candidate_model_lease","candidate_model_lease":{"secrets_included":false,"raw_credentials_allowed":false}}}\\n' "$app" "$runtime" "$home_arg" "$home_arg" > "$out"
`, "utf8");
  await exec("chmod", ["+x", script]);

  const result = await runCandidateAppLifecycle({
    spec: {
      id: "candidate-app-lifecycle",
      pack_config: {
        candidate_app_lifecycle: { required: true, command: JSON.stringify(["bash", script]) }
      }
    },
    run: { run_id: "run-candidate-app-lifecycle", outputs_dir: join(home, "outputs") },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "cand-app",
          base_dir: join(home, "candidate"),
          runtime_home: join(home, "runtime"),
          app_home: join(home, "runtime", "aaa"),
          app_dir: join(home, "candidate-apps", "cand-app"),
          runtime_preflight: { status: "passed", socket_path: join(home, "runtime", "aaa", "run", "across-agents.sock"), socket_path_bytes: 80 },
          repos: [{ id: "across-agents-assistant", target: repo }]
        }
      },
      {
        adapter: "candidate_ecosystem_diff",
        result: {
          changed_files: ["across-agents-assistant/backend/src/across_agents_assistant/example.py"]
        }
      }
    ],
    env: { ...process.env, ACROSS_HOME: home }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.required, true);
  assert.equal(result.cleaned_up, true);
  assert.match(result.app_path, /Across Agents Assistant Candidate\.app$/);
  assert.equal(result.health.status, "ok");
  assert.equal(result.llm_status.availability_source, "candidate_model_lease");

  const promotion = buildCandidatePromotionEvidence({
    spec: { id: "candidate-app-lifecycle", pack_config: { candidate_app_lifecycle: { required: true } } },
    run: { run_id: "run-candidate-app-lifecycle" },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "cand-app",
          mode: "snapshot",
          four_repo_manifest: true,
          repos: [
            { id: "across-agents-assistant", source_head_pre: "a", head_ref: "b", source_git: true },
            { id: "across-autopilot", source_head_pre: "a", head_ref: "b", source_git: true },
            { id: "across-context", source_head_pre: "a", head_ref: "b", source_git: true },
            { id: "across-orchestrator", source_head_pre: "a", head_ref: "b", source_git: true }
          ]
        }
      },
      { adapter: "candidate_ecosystem_diff", result: { changed_files: ["across-agents-assistant/backend/src/across_agents_assistant/example.py"], repos: [{ id: "across-agents-assistant", changed_files: ["backend/src/across_agents_assistant/example.py"], changed_file_count: 1 }] } },
      { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed" }], source_unchanged: { unchanged: true, repos: [] } } },
      { adapter: "candidate_app_lifecycle", result },
      { adapter: "candidate_self_hosting_probe", result: { required: false, status: "passed" } },
      { adapter: "semantic_alignment_review", result: { status: "passed", promotion_recommendation: "review", reviewer_independent: true, model_separation: { status: "passed" } } }
    ]
  });
  assert.equal(promotion.candidate_app_lifecycle.status, "passed");
  assert.equal(promotion.candidate_app_lifecycle.llm_status.availability_source, "candidate_model_lease");
  assert.equal(promotion.promotion_ready, true);
});

test("required candidate app lifecycle fails clearly when the host command is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-app-lifecycle-missing-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await mkdir(repo, { recursive: true });

  const result = await runCandidateAppLifecycle({
    spec: { id: "candidate-app-lifecycle-missing", pack_config: { candidate_app_lifecycle: { required: true } } },
    run: { run_id: "run-candidate-app-lifecycle-missing", outputs_dir: join(home, "outputs") },
    actions: [{
      adapter: "candidate_ecosystem_acquire",
      result: {
        candidate_id: "cand-app-missing",
        runtime_home: join(home, "runtime"),
        app_home: join(home, "runtime", "aaa"),
        app_dir: join(home, "candidate-apps", "cand-app-missing"),
        runtime_preflight: { status: "passed", socket_path: join(home, "runtime", "aaa", "run", "across-agents.sock"), socket_path_bytes: 80 },
        repos: [{ id: "across-agents-assistant", target: repo }]
      }
    }],
    env: { ...process.env, ACROSS_HOME: home, ACROSS_AAA_CANDIDATE_APP_LIFECYCLE_COMMAND: "" }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.command_configured, false);
  assert.equal(result.failure.code, "capability.missing");
});

test("promotion evidence requires source ref pins before review readiness", () => {
  const repos = ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"].map((id) => ({
    id,
    source: `/source/${id}`,
    target: `/candidate/${id}`,
    mode: "snapshot",
    baseline_ref: `${id}-candidate-base`,
    head_ref: `${id}-candidate-head`,
    source_git: true,
    source_head_pre: `${id}-source-head`,
    source_status_pre: ""
  }));
  const sourceUnchanged = {
    unchanged: true,
    repos: repos.map((repo) => ({
      id: repo.id,
      unchanged: true,
      head_post: repo.source_head_pre
    }))
  };
  const baseActions = [
    {
      adapter: "candidate_ecosystem_acquire",
      result: {
        candidate_id: "candidate-source-pinning",
        mode: "snapshot",
        manifest_path: "/candidate/manifest.json",
        four_repo_manifest: true,
        repos
      }
    },
    {
      adapter: "candidate_ecosystem_diff",
      result: {
        changed_files: ["across-agents-assistant/backend/src/across_agents_assistant/example.py"],
        repos: [{ id: "across-agents-assistant", changed_file_count: 1, changed_files: ["backend/src/across_agents_assistant/example.py"] }]
      }
    },
    { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed" }], source_unchanged: sourceUnchanged } },
    { adapter: "candidate_self_hosting_probe", result: { required: true, status: "passed" } },
    {
      adapter: "semantic_alignment_review",
      result: {
        status: "passed",
        promotion_recommendation: "review",
        reviewer_independent: true,
        model_separation: { status: "passed" }
      }
    }
  ];

  const ready = buildCandidatePromotionEvidence({ spec: { id: "source-pinning" }, run: { run_id: "run-source-pinning" }, actions: baseActions });

  assert.equal(ready.promotion_ready, true);
  assert.equal(ready.promotion_package.source_ref_pins.status, "passed");
  assert.equal(ready.promotion_package.source_ref_pins.repos.length, 4);

  const missingPins = buildCandidatePromotionEvidence({
    spec: { id: "source-pinning" },
    run: { run_id: "run-source-pinning" },
    actions: [{
      ...baseActions[0],
      result: {
        ...baseActions[0].result,
        repos: repos.map((repo) => repo.id === "across-context" ? { ...repo, source_head_pre: "" } : repo)
      }
    }, ...baseActions.slice(1)]
  });

  assert.equal(missingPins.promotion_ready, false);
  assert.equal(missingPins.promotion_package.source_ref_pins.status, "failed");
  assert.ok(missingPins.promotion_package.known_risks.some((risk) => risk.source === "source_ref_pins"));
});

test("candidate diff filters runtime artifacts and semantic review rejects destructive docs rewrite", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-diff-quality-"));
  const repo = join(home, "across-autopilot");
  await createGitSource(repo, {
    "README.md": Array.from({ length: 120 }, (_, index) => `Line ${index + 1}`).join("\n") + "\n"
  });
  await writeFile(join(repo, "README.md"), "# Short rewrite\n\nOne replacement paragraph.\n", "utf8");
  await mkdir(join(repo, "src", "__pycache__"), { recursive: true });
  await writeFile(join(repo, "src", "__pycache__", "artifact.cpython-312.pyc"), "compiled", "utf8");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "feature.js"), "import child_process from 'node:child_process';\n\nexport function value() {\n  if (false) return 0;  \n  child_process.exec('rm -rf /tmp/example');\n  fetch('https://example.com/data');\n  return 1;\n}\n", "utf8");
  await mkdir(join(repo, "tests"), { recursive: true });
  await writeFile(join(repo, "tests", "feature.test.js"), "import pytest\n\n\n\n\n\nexport function testValue() {\n  pytest.fail('not provisioned');\n}\n", "utf8");

  const spec = { pack_config: { target_repo: "across-autopilot" } };
  const acquire = {
    adapter: "candidate_ecosystem_acquire",
    result: { repos: [{ id: "across-autopilot", target: repo }] }
  };
  const diff = await candidateEcosystemDiff({ spec, run: { run_id: "run-quality" }, actions: [acquire] });

  assert.deepEqual(diff.changed_files.sort(), [
    "across-autopilot/README.md",
    "across-autopilot/src/feature.js",
    "across-autopilot/tests/feature.test.js"
  ]);
  assert.equal(diff.repos[0].ignored_generated_artifacts.length, 1);
  assert.ok(diff.repos[0].quality_findings.some((finding) => finding.id === "constant_false_branch"));
  assert.ok(diff.repos[0].quality_findings.some((finding) => finding.id === "pytest_dependency_in_candidate_test"));
  assert.ok(diff.repos[0].quality_findings.some((finding) => finding.id === "excessive_blank_lines" && finding.severity === "error"));
  assert.ok(diff.repos[0].quality_findings.some((finding) => finding.id === "unsafe_shell_execution"));
  assert.ok(diff.repos[0].quality_findings.some((finding) => finding.id === "unbounded_network_call"));
  assert.ok(diff.repos[0].quality_findings.some((finding) => finding.id === "trailing_whitespace" && finding.severity === "error"));

  const review = await semanticAlignmentReview({
    spec,
    actions: [
      { adapter: "product_iteration_strategy", result: { selected_iteration: { target_id: "docs", allowed_patch_paths: ["README.md", "src/feature.js"] } } },
      { adapter: "host_code_iteration", result: { model_backed: true, summary: "Add a feature and update docs." } },
      { adapter: "candidate_ecosystem_diff", result: diff },
      { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed" }] } }
    ]
  });

  assert.equal(review.status, "failed");
  assert.equal(review.merge_recommendation, "repair_before_pr");
  assert.ok(review.product_value_score < 90);
  assert.ok(review.maintainability_score < 70);
  assert.ok(review.blocking_reasons.some((reason) => reason.includes("large documentation rewrite")));
  assert.ok(review.blocking_reasons.some((reason) => reason.includes("suspicious generated code artifact")));
});

test("semantic review rejects test-only candidates and scores reviewer evidence", async () => {
  const review = await semanticAlignmentReview({
    spec: { pack_config: { semantic_review: { minimum_validation_commands: 1 } } },
    actions: [
      { adapter: "product_iteration_strategy", result: { selected_iteration: { target_id: "test-only", allowed_patch_paths: ["tests/test_only.py"] } } },
      { adapter: "host_code_iteration", result: { model_backed: true, summary: "Add tests only." } },
      { adapter: "candidate_ecosystem_diff", result: { changed_files: ["across-agents-assistant/backend/tests/test_only.py"], repos: [] } },
      { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed" }] } }
    ]
  });

  assert.equal(review.status, "failed");
  assert.equal(review.promotion_recommendation, "reject");
  assert.equal(review.merge_recommendation, "repair_before_pr");
  assert.ok(review.blocking_reasons.some((reason) => reason.includes("only changes tests")));
  assert.ok(Number.isInteger(review.product_value_score));
  assert.ok(Number.isInteger(review.maintainability_score));
  assert.ok(Number.isInteger(review.risk_score));
  assert.ok(Array.isArray(review.human_review_notes));
});

test("semantic review requires reviewer model to differ from builder model", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-review-model-"));
  const reviewCommand = join(home, "same-model-reviewer.js");
  await writeFile(reviewCommand, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-review-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-loop-engineer",
  decision_hash: "same-model-review",
  recommendation: "review",
  merge_recommendation: "open_review_pr",
  product_value_score: 90,
  maintainability_score: 90,
  risk_score: 10,
  blocking_reasons: []
}));
`, "utf8");
  const review = await semanticAlignmentReview({
    spec: {
      pack_config: {
        reviewer_model_policy: {
          required: true,
          provider: "fake-host",
          model: "fake-loop-engineer",
          require_distinct_from_builder: true
        }
      }
    },
    actions: [
      { adapter: "product_iteration_strategy", result: { selected_iteration: { target_id: "product", allowed_patch_paths: ["backend/src/across_agents_assistant/autopilot_product.py"] } } },
      { adapter: "host_code_iteration", result: { model_backed: true, provider: "fake-host", model: "fake-loop-engineer", summary: "Add product helper." } },
      { adapter: "candidate_ecosystem_diff", result: { changed_files: ["across-agents-assistant/backend/src/across_agents_assistant/autopilot_product.py"], repos: [] } },
      { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed" }, { status: "passed" }] } }
    ],
    env: { ...process.env, ACROSS_AAA_HOST_REVIEW_COMMAND: JSON.stringify(["node", reviewCommand]) }
  });

  assert.equal(review.status, "failed");
  assert.equal(review.model_separation.status, "failed");
  assert.ok(review.blocking_reasons.some((reason) => reason.includes("Reviewer model must differ")));
});

test("orchestrator dispatch failure preserves evidence and does not patch candidate", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-dispatch-failure-"));
  const source = join(home, "source-repo");
  const candidate = join(home, "candidate-workspaces", "aaa");
  await mkdir(source, { recursive: true });
  await mkdir(candidate, { recursive: true });
  await writeFile(join(source, "README.md"), "# Source\n", "utf8");
  await writeFile(join(candidate, "README.md"), "# Candidate\n", "utf8");
  await exec("git", ["init"], { cwd: candidate });
  await exec("git", ["add", "README.md"], { cwd: candidate });
  await exec("git", ["-c", "user.name=Across Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"], { cwd: candidate });

  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FailingOrchestrator(),
    contextClient: new FakeContext()
  });
  const spec = {
    schema_version: "across-loop-spec/1.0",
    id: "aaa-self-iteration-dispatch-failure",
    name: "AAA Self Iteration Dispatch Failure",
    description: "Verify model-backed dispatch failures stop before candidate mutation.",
    owner: { type: "local_user", id: "test" },
    compatibility: {
      min_autopilot_version: ">=0.1.0",
      required_orchestrator: ">=0.6.18",
      required_context: ">=0.7.8",
      required_host: ">=0.8.29"
    },
    required_capabilities: [
      "source.directory",
      "action.orchestrator_task_dispatch",
      "action.candidate_workspace_patch",
      "memory.pending_summary"
    ],
    trigger: { type: "manual" },
    scope: { project_id: "aaa", workspace: candidate },
    autonomy: { level: 3, requires_human_approval_above: 3 },
    sources: [{ id: "candidate", type: "directory", adapter: "directory", path: candidate, max_files: 20 }],
    actions: {
      allowed: ["orchestrator_task_dispatch", "candidate_workspace_patch", "write_pending_memory"],
      blocked: ["merge_pr", "release_publish", "sign_artifact", "write_secret"]
    },
    execute: { engine: "across-orchestrator", mode: "task" },
    outputs: [{ type: "context_memory", to: "context://pending", policy: "append" }],
    gates: [{ id: "model_decision_present", required: true }],
    memory: { provider: "across-context", recall: true, remember: false, write_status: "pending" },
    failure_policy: { max_retries: 0, retry_backoff: "linear", continue_on_gate_failure: false, dead_letter: "context_memory" },
    sandbox: { filesystem: "run_scoped", network: "adapter_scoped", env: "minimal" },
    evidence_contract: {
      schema_version: "across-loop-evidence/1.0",
      required_sections: ["sources", "actions", "gates", "outputs", "memory", "audit"]
    },
    used_adapters: {
      sources: ["directory"],
      actions: ["orchestrator_task_dispatch", "candidate_workspace_patch"],
      outputs: ["context_memory"]
    },
    pack_config: {
      candidate_workspace: candidate,
      source_repository: source,
      mutation_policy: "candidate_workspace_only",
      allowed_patch_paths: ["docs/AAA_SELF_ITERATION_CANDIDATE.md"]
    },
    model_policy: {
      required: true,
      allowed_patch_paths: ["docs/AAA_SELF_ITERATION_CANDIDATE.md"],
      context_files: ["README.md"]
    }
  };
  const specPath = join(home, "aaa-self-iteration-dispatch-failure.loop.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

  const { run, evidence } = await supervisor.run(specPath);

  assert.equal(run.status, "failed");
  assert.equal(evidence.failure.code, "orchestrator.task_failed");
  assert.equal(evidence.actions.length, 1);
  assert.equal(evidence.actions[0].adapter, "orchestrator_task_dispatch");
  assert.equal(evidence.actions[0].status, "failed");
  assert.equal(evidence.actions.some((action) => action.adapter === "candidate_workspace_patch"), false);
  const status = await exec("git", ["status", "--short"], { cwd: candidate });
  assert.equal(status.stdout.trim(), "");
});

test("kill switch blocks adapter execution before side effects", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-kill-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  await supervisor.setAdapterPaused("source_digest", true);

  const { run, evidence } = await supervisor.run("daily-news-brief");

  assert.equal(run.status, "failed");
  assert.equal(evidence.failure.code, "adapter.disabled");
  assert.equal(evidence.orchestrator.tasks.length, 0);
});

test("telemetry aggregates completed runs without raw source text", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-telemetry-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  await supervisor.run("daily-news-brief");

  const telemetry = await supervisor.telemetry();

  assert.equal(telemetry.schema_version, "across-loop-telemetry/1.0");
  assert.equal(telemetry.by_spec["daily-news-brief"].run_count, 1);
  assert.equal(JSON.stringify(telemetry).includes("AI tooling release notes"), false);
});

test("telemetry aggregates candidate quality, reviewer, repair, and target signals", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-telemetry-candidate-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  let run = await store.createRun({ id: "candidate-loop" }, { now: new Date("2026-06-22T01:00:00Z") });
  run = await store.updateRun(run.run_id, {
    status: "completed",
    started_at: "2026-06-22T01:00:00.000Z",
    completed_at: "2026-06-22T01:00:01.000Z"
  });
  await store.writeEvidence(run.run_id, {
    schema_version: "across-loop-evidence/1.0",
    run_id: run.run_id,
    spec_id: "candidate-loop",
    status: "completed",
    actions: [
      { adapter: "host_code_iteration", status: "passed", result: { repaired_json: true } }
    ],
    gates: [{ id: "candidate_validation_passed", status: "failed" }],
    risks: [{ source: "validation", severity: "high" }],
    candidate: {
      promotion_ready: true,
      research_strategy: { selected_target_id: "tool-pack-quality" },
      independent_reviewer: { merge_recommendation: "open_review_pr" },
      validation: {
        commands: [{ repo: "across-agents-assistant", command: "python3 -m py_compile x.py", status: "failed" }]
      },
      quality_findings: [{ id: "pytest_dependency_in_candidate_test", severity: "error" }]
    },
    memory: { written: [] }
  });

  const telemetry = await supervisor.telemetry();

  assert.equal(telemetry.selected_targets["tool-pack-quality"], 1);
  assert.equal(telemetry.promotion_ready_by_spec["candidate-loop"], 1);
  assert.equal(telemetry.reviewer_recommendations.open_review_pr, 1);
  assert.equal(telemetry.repair_counts.host_code_iteration, 1);
  assert.equal(telemetry.candidate_quality_findings.pytest_dependency_in_candidate_test, 1);
  assert.equal(telemetry.validation_failures["across-agents-assistant:python3 -m py_compile x.py"], 1);
  assert.equal(telemetry.unresolved_risks.validation, 1);
});

test("retry reuses persisted custom LoopSpec instead of built-in id lookup", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-retry-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const customSpec = JSON.parse(await readFile(join("examples", "daily-news-brief.loop.json"), "utf8"));
  customSpec.id = "custom-news-brief";
  customSpec.name = "Custom News Brief";

  const failed = await store.createRun(customSpec, { trigger: "manual" });
  await store.updateRun(failed.run_id, {
    status: "failed",
    state: "discovering_sources",
    failure: {
      code: "source.unreachable",
      retryable: true,
      failed_state: "discovering_sources",
      message: "Temporary source outage.",
      evidence_refs: [],
      caused_by: []
    }
  });

  const retried = await supervisor.retry(failed.run_id);

  assert.equal(retried.run.spec_id, "custom-news-brief");
  assert.equal(retried.run.status, "completed");
  assert.equal(retried.evidence.spec_id, "custom-news-brief");
});

async function createGitSource(root, files) {
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["-c", "user.name=Across Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"], { cwd: root });
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
