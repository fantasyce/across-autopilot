import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { AutopilotSupervisor } from "../src/supervisor.js";
import { AdapterRegistry, registerBuiltIns } from "../src/adapter-registry.js";
import { acquireCandidateEcosystem, buildCandidatePromotionEvidence, candidateConfig, candidateEcosystemDiff, candidateRuntimePreflight, ecosystemGateStatus, runCandidateAppLifecycle, runHostCodeIteration, runProductIterationStrategy, semanticAlignmentReview, validateCandidateEcosystem } from "../src/candidate-ecosystem.js";
import { prepareAutonomousLoopState } from "../src/loop-state.js";
import { diagnosePlatformSelfRepair, renderTriggerPayloadSource } from "../src/platform-self-repair.js";
import { RunStore } from "../src/run-store.js";
import { runJsonCommand } from "../src/process-client.js";
import { buildToolPackRegistry } from "../src/tool-packs.js";
import { buildRoleEvidence } from "../src/roles.js";
import { buildEvidenceEnvelope } from "../src/evidence.js";
import { TriggerQueue } from "../src/trigger-queue.js";

const exec = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

  assert.match(config.runtime_home, /\/\.across\/c\/c-[a-f0-9]{12}$/);
  assert.equal(config.app_home, join(config.runtime_home, "aaa"));
  assert.ok(
    Buffer.byteLength(socketPath, "utf8") < 100,
    `candidate app socket path must stay short for macOS Python AF_UNIX startup: ${socketPath.length}`
  );
  assert.equal(config.runtime_preflight.status, "passed");
  assert.ok(config.runtime_preflight.socket_path_bytes < config.runtime_preflight.max_socket_path_bytes);
  assert.equal(config.runtime_preflight.single_instance_required, true);
  assert.equal(config.runtime_preflight.cleanup_required, true);
});

test("candidate source defaults prefer development repos over installed plugin siblings", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-source-defaults-"));
  const previousCwd = process.cwd();
  const previousEnv = snapshotEnv(["HOME", "ACROSS_HOME"]);
  try {
    process.env.HOME = home;
    process.env.ACROSS_HOME = join(home, ".across");
    await mkdir(join(home, ".across/plugins/across-autopilot"), { recursive: true });
    for (const id of ["across-orchestrator", "across-context"]) {
      await mkdir(join(home, ".across/plugins", id), { recursive: true });
      await createGitSource(join(home, "Documents/projects", id), { "README.md": `# ${id}\n` });
    }
    await createGitSource(join(home, "Documents/projects/across-agents-assistant"), { "README.md": "# AAA\n" });
    await createGitSource(join(home, "Documents/projects/across-autopilot"), { "README.md": "# Autopilot\n" });
    process.chdir(join(home, ".across/plugins/across-autopilot"));

    const config = candidateConfig(
      { id: "aaa-autonomous-self-iteration", pack_config: { candidate_ecosystem: { mode: "snapshot", repos: [] } } },
      { run_id: "run-source-defaults" },
      { ...process.env }
    );

    for (const repo of config.repos) {
      assert.equal(repo.source, join(home, "Documents/projects", repo.id));
    }
  } finally {
    process.chdir(previousCwd);
    restoreEnv(previousEnv);
    await rm(home, { recursive: true, force: true });
  }
});

test("candidate source defaults use source mirrors in product mode", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-product-source-mirrors-"));
  const previousCwd = process.cwd();
  const previousEnv = snapshotEnv(["HOME", "ACROSS_HOME", "ACROSS_AUTOPILOT_PRODUCT_MODE", "ACROSS_AGENTS_PRODUCT_MODE"]);
  try {
    process.env.HOME = home;
    process.env.ACROSS_HOME = join(home, ".across");
    process.env.ACROSS_AUTOPILOT_PRODUCT_MODE = "1";
    await mkdir(join(home, ".across/plugins/across-autopilot"), { recursive: true });
    for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
      await createGitSource(join(home, "Documents/projects", id), { "README.md": `# dev ${id}\n` });
      await createGitSource(join(home, ".across/source-mirrors", id), { "README.md": `# mirror ${id}\n` });
    }
    process.chdir(join(home, ".across/plugins/across-autopilot"));

    const config = candidateConfig(
      { id: "aaa-autonomous-self-iteration", pack_config: { candidate_ecosystem: { mode: "snapshot", repos: [] } } },
      { run_id: "run-product-source-mirrors" },
      { ...process.env }
    );

    for (const repo of config.repos) {
      assert.equal(repo.source, join(home, ".across/source-mirrors", repo.id));
    }
  } finally {
    process.chdir(previousCwd);
    restoreEnv(previousEnv);
    await rm(home, { recursive: true, force: true });
  }
});

test("AAA self-iteration URL sources are covered by the network allowlist", async () => {
  for (const specName of ["aaa-autonomous-self-iteration.loop.json", "aaa-research-driven-self-iteration.loop.json"]) {
    const spec = JSON.parse(await readFile(join(repoRoot, "examples", specName), "utf8"));
    const allowlist = new Set(spec.actions?.network_policy?.allowlist || []);
    const sources = collectUrlSources(spec.sources);
    assert.ok(sources.length > 0, `${specName} should declare URL sources`);
    if (!allowlist.size) continue;
    for (const source of sources) {
      for (const url of [source.url, ...(source.fallback_urls || []), ...(source.fallbackUrls || [])].filter(Boolean)) {
        const hostname = new URL(url).hostname;
        assert.ok(allowlist.has(hostname), `${specName} network allowlist must include ${hostname}`);
      }
    }
  }
});

test("source digest marks unavailable sources without claiming they were reviewed", async () => {
  const registry = new AdapterRegistry();
  registerBuiltIns(registry);
  const adapter = registry.getAction("source_digest");

  const action = await adapter.run({
    spec: { id: "source-digest-test", autonomy: { level: 3 } },
    sources: [
      {
        id: "manual",
        adapter: "manual_input",
        status: "passed",
        result: { title: "Manual signal", content: "reviewed" }
      },
      {
        id: "openai-agents-architecture-signal",
        adapter: "url",
        status: "failed",
        title: "OpenAI Agents SDK architecture signal",
        url: "https://developers.openai.com/api/docs/guides/agents",
        failure: { code: "source.unreachable", retryable: true }
      }
    ],
    recalledMemory: []
  });

  assert.equal(action.status, "attention");
  assert.equal(action.result.reviewed_source_count, 1);
  assert.equal(action.result.unavailable_sources[0].id, "openai-agents-architecture-signal");
  assert.equal(action.result.digest[0].status, "reviewed");
  assert.equal(action.result.digest[1].status, "unavailable");
  assert.match(action.result.digest[1].summary, /Source unavailable/);
});

test("url source adapter times out stalled fetches", async () => {
  const registry = new AdapterRegistry();
  registerBuiltIns(registry);
  const adapter = registry.getSource("url");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options = {}) => new Promise((_, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  try {
    await assert.rejects(
      adapter.run({
        spec: { id: "url-timeout-test" },
        source: { id: "stalled", url: "https://example.invalid/stalled", timeout_ms: 100 },
        run: {}
      }),
      (error) => {
        assert.equal(error.code, "source.unreachable");
        assert.match(error.message, /timed out/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("url source adapter times out stalled response bodies", async () => {
  const registry = new AdapterRegistry();
  registerBuiltIns(registry);
  const adapter = registry.getSource("url");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("aborted body");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  try {
    await assert.rejects(
      adapter.run({
        spec: { id: "url-body-timeout-test" },
        source: { id: "stalled-body", url: "https://example.invalid/stalled-body", timeout_ms: 100 },
        run: {}
      }),
      (error) => {
        assert.equal(error.code, "source.unreachable");
        assert.match(error.message, /timed out/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("url source adapter hard-times out response bodies that ignore abort", async () => {
  const registry = new AdapterRegistry();
  registerBuiltIns(registry);
  const adapter = registry.getSource("url");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: () => new Promise(() => {})
  });
  try {
    await assert.rejects(
      adapter.run({
        spec: { id: "url-body-hard-timeout-test" },
        source: { id: "abort-ignored-body", url: "https://example.invalid/abort-ignored-body", timeout_ms: 100 },
        run: {}
      }),
      (error) => {
        assert.equal(error.code, "source.unreachable");
        assert.match(error.message, /timed out/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("url source adapter retries transient HTTP failures", async () => {
  const registry = new AdapterRegistry();
  registerBuiltIns(registry);
  const adapter = registry.getSource("url");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, _options = {}) => {
    calls += 1;
    if (calls === 1) {
      return new Response("blocked", { status: 403 });
    }
    return new Response("research signal", { status: 200 });
  };
  try {
    const action = await adapter.run({
      spec: { id: "url-retry-test" },
      source: { id: "transient", url: "https://example.test/source", timeout_ms: 1000, retries: 1 },
      run: {}
    });
    assert.equal(action.status, "passed");
    assert.equal(action.result.status_code, 200);
    assert.equal(action.result.excerpt, "research signal");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("url source adapter can use fallback urls", async () => {
  const registry = new AdapterRegistry();
  registerBuiltIns(registry);
  const adapter = registry.getSource("url");
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, _options = {}) => {
    urls.push(String(url));
    if (String(url).includes("primary")) {
      return new Response("not found", { status: 404 });
    }
    return new Response("fallback signal", { status: 200 });
  };
  try {
    const action = await adapter.run({
      spec: { id: "url-fallback-test" },
      source: {
        id: "fallback-source",
        url: "https://example.test/primary",
        fallback_urls: ["https://example.test/fallback"],
        timeout_ms: 1000,
        retries: 0
      },
      run: {}
    });
    assert.equal(action.status, "passed");
    assert.equal(action.result.url, "https://example.test/fallback");
    assert.equal(action.result.excerpt, "fallback signal");
    assert.deepEqual(urls, ["https://example.test/primary", "https://example.test/fallback"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("candidate ecosystem git snapshot ignores inherited hostile git environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-hostile-git-env-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, { "README.md": `# ${id}\n` });
    repos.push({ id, source });
  }

  const previousEnv = snapshotEnv([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0"
  ]);
  Object.assign(process.env, {
    GIT_DIR: join(home, "not-a-repo", ".git"),
    GIT_WORK_TREE: join(home, "not-a-worktree"),
    GIT_INDEX_FILE: join(home, "missing-index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false"
  });
  try {
    const result = await acquireCandidateEcosystem({
      spec: {
        id: "hostile-git-env-snapshot",
        pack_config: {
          candidate_ecosystem: {
            repos
          }
        }
      },
      run: { run_id: "run-hostile-git-env-snapshot" },
      env: {
        ...process.env,
        ACROSS_HOME: home
      }
    });

    assert.equal(result.status, "passed");
    const aaaTarget = result.repos.find((repo) => repo.id === "across-agents-assistant").target;
    assert.equal(await readFile(join(aaaTarget, "README.md"), "utf8"), "# across-agents-assistant\n");
    assert.match(result.repos.find((repo) => repo.id === "across-agents-assistant").source_head_pre, /^fs:[a-f0-9]{64}$/);
  } finally {
    restoreEnv(previousEnv);
  }
});

test("candidate ecosystem records dirty source fingerprint without porcelain status", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-dirty-source-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, { "README.md": `# ${id}\n` });
    repos.push({ id, source });
  }
  const aaaSource = repos.find((repo) => repo.id === "across-agents-assistant").source;
  await writeFile(join(aaaSource, "README.md"), "# across-agents-assistant\n\nDirty before loop.\n", "utf8");
  await writeFile(join(aaaSource, "UNTRACKED.md"), "not yet reviewed\n", "utf8");

  const result = await acquireCandidateEcosystem({
    spec: {
      id: "dirty-source-fingerprint",
      pack_config: {
        candidate_ecosystem: {
          repos
        }
      }
    },
    run: { run_id: "run-dirty-source-fingerprint" },
    env: {
      ...process.env,
      ACROSS_HOME: home
    }
  });

  const aaaRecord = result.repos.find((repo) => repo.id === "across-agents-assistant");
  assert.match(aaaRecord.source_status_pre, /^fs:[a-f0-9]{64}\nfiles:\d+$/);
  const unchanged = await validateCandidateEcosystem({
    spec: { id: "dirty-source-fingerprint", pack_config: { candidate_ecosystem: { repos } } },
    run: { run_id: "run-dirty-source-fingerprint" },
    actions: [{ adapter: "candidate_ecosystem_acquire", result }],
    env: {
      ...process.env,
      ACROSS_HOME: home
    }
  });
  assert.equal(unchanged.source_unchanged.unchanged, true);
});

test("candidate ecosystem source fingerprint only covers copied snapshot roots", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-snapshot-roots-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, { "README.md": `# ${id}\n` });
    repos.push({ id, source });
  }
  const aaaSource = repos.find((repo) => repo.id === "across-agents-assistant").source;
  await mkdir(join(aaaSource, "ignored-top-level"), { recursive: true });
  await writeFile(join(aaaSource, "ignored-top-level", "draft.txt"), "not part of candidate snapshot\n", "utf8");
  await mkdir(join(aaaSource, "backend", "src"), { recursive: true });
  await writeFile(join(aaaSource, "backend", "src", "product.py"), "VALUE = 'copied'\n", "utf8");
  await mkdir(join(aaaSource, "backend", ".venv"), { recursive: true });
  await writeFile(join(aaaSource, "backend", ".venv", "should-not-copy.txt"), "local environment artifact\n", "utf8");

  const spec = {
    id: "snapshot-roots-fingerprint",
    pack_config: { candidate_ecosystem: { repos } }
  };
  const run = { run_id: "run-snapshot-roots-fingerprint" };
  const env = { ...process.env, ACROSS_HOME: home };
  const result = await acquireCandidateEcosystem({ spec, run, env });
  const aaaTarget = result.repos.find((repo) => repo.id === "across-agents-assistant").target;
  assert.equal(await fileExists(join(aaaTarget, "backend", "src", "product.py")), true);
  assert.equal(await fileExists(join(aaaTarget, "backend", ".venv", "should-not-copy.txt")), false);
  assert.equal(await fileExists(join(aaaTarget, "ignored-top-level", "draft.txt")), false);

  await writeFile(join(aaaSource, "ignored-top-level", "draft.txt"), "changed outside copied snapshot roots\n", "utf8");
  const validated = await validateCandidateEcosystem({
    spec,
    run,
    actions: [{ adapter: "candidate_ecosystem_acquire", result }],
    env
  });
  assert.equal(validated.source_unchanged.unchanged, true);
});

test("candidate validation smokes AAA backend API imports for runtime Python changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-aaa-api-smoke-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, id === "across-agents-assistant" ? {
      "README.md": "# AAA\n",
      "backend/src/across_agents_assistant/__init__.py": "",
      "backend/src/across_agents_assistant/api_server.py": "from across_agents_assistant.autopilot_workbench import build_autopilot_workbench_snapshot\nAPP_READY = True\n",
      "backend/src/across_agents_assistant/autopilot_workbench.py": "def build_autopilot_workbench_snapshot():\n    return {}\n"
    } : {
      "README.md": `# ${id}\n`
    });
    repos.push({ id, source });
  }

  const spec = {
    id: "aaa-api-smoke",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      candidate_validation: { commands: [] }
    }
  };
  const run = { run_id: "run-aaa-api-smoke" };
  const env = { ...process.env, ACROSS_HOME: home };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });
  const aaaTarget = acquired.repos.find((repo) => repo.id === "across-agents-assistant").target;
  await writeFile(
    join(aaaTarget, "backend", "src", "across_agents_assistant", "autopilot_workbench.py"),
    "OTHER_EXPORT = True\n",
    "utf8"
  );

  const diff = await candidateEcosystemDiff({
    spec,
    run,
    actions: [{ adapter: "candidate_ecosystem_acquire", result: acquired }],
    env
  });
  const validated = await validateCandidateEcosystem({
    spec,
    run,
    actions: [
      { adapter: "candidate_ecosystem_acquire", result: acquired },
      { adapter: "candidate_ecosystem_diff", result: diff }
    ],
    env
  });
  const smoke = validated.commands.find((command) => command.implicit && command.summary === "AAA backend API import contract smoke");

  assert.equal(validated.status, "attention");
  assert.ok(smoke);
  assert.equal(smoke.status, "failed");
  assert.match(smoke.stderr, /build_autopilot_workbench_snapshot|ImportError/);
});

test("candidate validation records Python runtime incompatibility diagnostics", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-python-diagnostic-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await createGitSource(repo, {
    "README.md": "# AAA\n",
    "backend/src/across_agents_assistant/__init__.py": ""
  });

  const spec = {
    id: "python-runtime-diagnostic",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_validation: {
        commands: [
          {
            repo: "across-agents-assistant",
            command: "python3",
            args: [
              "-c",
              "raise TypeError(\"unsupported operand type(s) for |: '_GenericAlias' and 'NoneType'\")"
            ]
          }
        ]
      }
    }
  };
  const validation = await validateCandidateEcosystem({
    spec,
    run: { run_id: "run-python-runtime-diagnostic" },
    actions: [{
      adapter: "candidate_ecosystem_acquire",
      result: { repos: [{ id: "across-agents-assistant", target: repo }] }
    }],
    env: { ...process.env, ACROSS_HOME: home }
  });
  const failed = validation.commands.find((command) => command.command === "python3");

  assert.equal(validation.status, "attention");
  assert.ok(failed);
  assert.equal(failed.diagnostic.failure_kind, "python_version_incompatible");
  assert.match(failed.diagnostic.failure_summary, /newer than the validation Python runtime/);
});

test("candidate validation rejects undeclared AAA backend runtime imports", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-aaa-runtime-deps-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, id === "across-agents-assistant" ? {
      "README.md": "# AAA\n",
      "backend/requirements.txt": "fastapi>=0.138.2\nuvicorn>=0.49.0\n",
      "backend/requirements_no_pyobjc.txt": "fastapi>=0.138.2\nuvicorn>=0.49.0\n",
      "backend/src/across_agents_assistant/__init__.py": "",
      "backend/src/across_agents_assistant/api_server.py": "from fastapi import FastAPI\nAPP_READY = True\n"
    } : {
      "README.md": `# ${id}\n`
    });
    repos.push({ id, source });
  }

  const spec = {
    id: "aaa-runtime-deps",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      candidate_validation: { commands: [] }
    }
  };
  const run = { run_id: "run-aaa-runtime-deps" };
  const env = { ...process.env, ACROSS_HOME: home };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });
  const aaaTarget = acquired.repos.find((repo) => repo.id === "across-agents-assistant").target;
  await writeFile(
    join(aaaTarget, "backend", "src", "across_agents_assistant", "api_server.py"),
    "from fastapi import FastAPI\nfrom flask import Flask\nAPP_READY = True\n",
    "utf8"
  );

  const diff = await candidateEcosystemDiff({
    spec,
    run,
    actions: [{ adapter: "candidate_ecosystem_acquire", result: acquired }],
    env
  });
  const validated = await validateCandidateEcosystem({
    spec,
    run,
    actions: [
      { adapter: "candidate_ecosystem_acquire", result: acquired },
      { adapter: "candidate_ecosystem_diff", result: diff }
    ],
    env
  });
  const smoke = validated.commands.find((command) => (
    command.implicit && command.summary === "AAA backend runtime dependency import contract smoke"
  ));

  assert.equal(validated.status, "attention");
  assert.ok(smoke);
  assert.equal(smoke.status, "failed");
  assert.match(smoke.stderr, /undeclared AAA backend runtime import\(s\).*flask/);
  assert.doesNotMatch(smoke.stderr, /fastapi in/);
});

test("candidate validation allows stdlib AAA backend runtime imports", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-aaa-stdlib-runtime-deps-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, id === "across-agents-assistant" ? {
      "README.md": "# AAA\n",
      "backend/requirements.txt": "fastapi>=0.138.2\n",
      "backend/requirements_no_pyobjc.txt": "fastapi>=0.138.2\n",
      "backend/src/across_agents_assistant/__init__.py": "",
      "backend/src/across_agents_assistant/api_server.py": "APP_READY = True\n"
    } : {
      "README.md": `# ${id}\n`
    });
    repos.push({ id, source });
  }

  const spec = {
    id: "aaa-stdlib-runtime-deps",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      candidate_validation: { commands: [] }
    }
  };
  const run = { run_id: "run-aaa-stdlib-runtime-deps" };
  const env = { ...process.env, ACROSS_HOME: home };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });
  const aaaTarget = acquired.repos.find((repo) => repo.id === "across-agents-assistant").target;
  await writeFile(
    join(aaaTarget, "backend", "src", "across_agents_assistant", "api_server.py"),
    "import ast\nAPP_READY = bool(ast.parse('value = 1'))\n",
    "utf8"
  );

  const diff = await candidateEcosystemDiff({
    spec,
    run,
    actions: [{ adapter: "candidate_ecosystem_acquire", result: acquired }],
    env
  });
  const validated = await validateCandidateEcosystem({
    spec,
    run,
    actions: [
      { adapter: "candidate_ecosystem_acquire", result: acquired },
      { adapter: "candidate_ecosystem_diff", result: diff }
    ],
    env
  });
  const smoke = validated.commands.find((command) => (
    command.implicit && command.summary === "AAA backend runtime dependency import contract smoke"
  ));

  assert.ok(smoke);
  assert.equal(smoke.status, "passed");
  assert.doesNotMatch(smoke.stderr, /ast in/);
});

test("candidate validation rejects missing exports from changed AAA runtime imports", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-aaa-runtime-imports-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, id === "across-agents-assistant" ? {
      "README.md": "# AAA\n",
      "backend/requirements.txt": "fastapi>=0.138.2\nuvicorn>=0.49.0\n",
      "backend/requirements_no_pyobjc.txt": "fastapi>=0.138.2\nuvicorn>=0.49.0\n",
      "backend/src/across_agents_assistant/__init__.py": "",
      "backend/src/across_agents_assistant/api_server.py": "from fastapi import FastAPI\nAPP_READY = True\n",
      "backend/src/across_agents_assistant/autopilot_workbench.py": "def snapshot():\n  return {'status': 'source'}\n"
    } : {
      "README.md": `# ${id}\n`
    });
    repos.push({ id, source });
  }

  const spec = {
    id: "aaa-runtime-imports",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      candidate_validation: { commands: [] }
    }
  };
  const run = { run_id: "run-aaa-runtime-imports" };
  const env = { ...process.env, ACROSS_HOME: home };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });
  const aaaTarget = acquired.repos.find((repo) => repo.id === "across-agents-assistant").target;
  await writeFile(
    join(aaaTarget, "backend", "src", "across_agents_assistant", "autopilot_mcp_tool_registry.py"),
    "def evaluate_candidate_signal():\n  return {'status': 'generic'}\n",
    "utf8"
  );
  await writeFile(
    join(aaaTarget, "backend", "src", "across_agents_assistant", "autopilot_workbench.py"),
    "def snapshot():\n  from .autopilot_mcp_tool_registry import MCPToolRegistry\n  return {'registry': MCPToolRegistry}\n",
    "utf8"
  );

  const diff = await candidateEcosystemDiff({
    spec,
    run,
    actions: [{ adapter: "candidate_ecosystem_acquire", result: acquired }],
    env
  });
  const validated = await validateCandidateEcosystem({
    spec,
    run,
    actions: [
      { adapter: "candidate_ecosystem_acquire", result: acquired },
      { adapter: "candidate_ecosystem_diff", result: diff }
    ],
    env
  });
  const smoke = validated.commands.find((command) => (
    command.implicit && command.summary === "AAA backend API import contract smoke"
  ));

  assert.equal(validated.status, "attention");
  assert.ok(smoke);
  assert.equal(smoke.status, "failed");
  assert.match(smoke.stderr, /missing internal API import\(s\)/);
  assert.match(smoke.stderr, /autopilot_workbench\.py/);
  assert.match(smoke.stderr, /autopilot_mcp_tool_registry\.MCPToolRegistry/);
});

test("candidate validation rejects undefined AAA backend top-level runtime names", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-aaa-top-level-names-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, id === "across-agents-assistant" ? {
      "README.md": "# AAA\n",
      "backend/requirements.txt": "fastapi>=0.138.2\nuvicorn>=0.49.0\n",
      "backend/requirements_no_pyobjc.txt": "fastapi>=0.138.2\nuvicorn>=0.49.0\n",
      "backend/src/across_agents_assistant/__init__.py": "",
      "backend/src/across_agents_assistant/api_server.py": "from fastapi import FastAPI\napp = FastAPI()\n"
    } : {
      "README.md": `# ${id}\n`
    });
    repos.push({ id, source });
  }

  const spec = {
    id: "aaa-top-level-names",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      candidate_validation: { commands: [] }
    }
  };
  const run = { run_id: "run-aaa-top-level-names" };
  const env = { ...process.env, ACROSS_HOME: home };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });
  const aaaTarget = acquired.repos.find((repo) => repo.id === "across-agents-assistant").target;
  await writeFile(
    join(aaaTarget, "backend", "src", "across_agents_assistant", "api_server.py"),
    "from fastapi import FastAPI\napp = FastAPI()\nif _app is not None and _app.router is not None:\n    pass\n",
    "utf8"
  );

  const diff = await candidateEcosystemDiff({
    spec,
    run,
    actions: [{ adapter: "candidate_ecosystem_acquire", result: acquired }],
    env
  });
  const validated = await validateCandidateEcosystem({
    spec,
    run,
    actions: [
      { adapter: "candidate_ecosystem_acquire", result: acquired },
      { adapter: "candidate_ecosystem_diff", result: diff }
    ],
    env
  });
  const smoke = validated.commands.find((command) => (
    command.implicit && command.summary === "AAA backend top-level name contract smoke"
  ));

  assert.equal(validated.status, "attention");
  assert.ok(smoke);
  assert.equal(smoke.status, "failed");
  assert.match(smoke.stderr, /undefined AAA backend top-level reference\(s\).*api_server\.py:_app/);
});

test("candidate validation smokes AAA product entrypoint calls", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-aaa-entrypoint-smoke-"));
  const sourceRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourceRoot, id);
    await createGitSource(source, id === "across-agents-assistant" ? {
      "README.md": "# AAA\n",
      "backend/src/across_agents_assistant/__init__.py": "",
      "backend/src/across_agents_assistant/api_server.py": "APP_READY = True\n",
      "backend/src/across_agents_assistant/autopilot_workbench.py": "def build_autopilot_workbench_snapshot(**kwargs):\n    return {'summary': {}, 'sections': {}}\n",
      "backend/src/across_agents_assistant/autopilot_tool_pack_registry.py": "def tool_pack_registry_snapshot():\n    return {'status': 'passed'}\n",
      "backend/src/across_agents_assistant/loop_engineering_capability_pack.py": "def loop_engineering_capability_pack(source_signals=None):\n    return {'status': 'source'}\n"
    } : {
      "README.md": `# ${id}\n`
    });
    repos.push({ id, source });
  }

  const spec = {
    id: "aaa-entrypoint-smoke",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      candidate_validation: { commands: [] }
    }
  };
  const run = { run_id: "run-aaa-entrypoint-smoke" };
  const env = { ...process.env, ACROSS_HOME: home };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });
  const aaaTarget = acquired.repos.find((repo) => repo.id === "across-agents-assistant").target;
  await writeFile(
    join(aaaTarget, "backend", "src", "across_agents_assistant", "loop_engineering_capability_pack.py"),
    "def loop_engineering_capability_pack(source_signals=None):\n"
      + "    from .autopilot_tool_pack_registry import tool_pack_registry_snapshot\n"
      + "    return {'tool_pack_registry': tool_pack_registry_snapshot(['unexpected'])}\n",
    "utf8"
  );

  const diff = await candidateEcosystemDiff({
    spec,
    run,
    actions: [{ adapter: "candidate_ecosystem_acquire", result: acquired }],
    env
  });
  const validated = await validateCandidateEcosystem({
    spec,
    run,
    actions: [
      { adapter: "candidate_ecosystem_acquire", result: acquired },
      { adapter: "candidate_ecosystem_diff", result: diff }
    ],
    env
  });
  const smoke = validated.commands.find((command) => (
    command.implicit && command.summary === "AAA backend product entrypoint smoke"
  ));

  assert.equal(validated.status, "attention");
  assert.ok(smoke);
  assert.equal(smoke.status, "failed");
  assert.match(smoke.stderr, /TypeError|positional argument/);
});

test("candidate ecosystem product snapshot preserves executable root files", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-product-file-mode-"));
  const previousEnv = snapshotEnv(["ACROSS_AUTOPILOT_PRODUCT_MODE"]);
  const sourceRoot = join(home, "sources");
  const repos = [];
  try {
    process.env.ACROSS_AUTOPILOT_PRODUCT_MODE = "1";
    for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
      const source = join(sourceRoot, id);
      await createGitSource(source, { "README.md": `# ${id}\n` });
      repos.push({ id, source });
    }
    const aaaSource = repos.find((repo) => repo.id === "across-agents-assistant").source;
    await writeFile(join(aaaSource, "build_app.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await chmod(join(aaaSource, "build_app.sh"), 0o755);

    const result = await acquireCandidateEcosystem({
      spec: { id: "product-file-mode", pack_config: { candidate_ecosystem: { repos } } },
      run: { run_id: "run-product-file-mode" },
      env: { ...process.env, ACROSS_HOME: home }
    });
    const aaaTarget = result.repos.find((repo) => repo.id === "across-agents-assistant").target;
    const mode = (await stat(join(aaaTarget, "build_app.sh"))).mode & 0o777;
    assert.equal((mode & 0o111) !== 0, true);
  } finally {
    restoreEnv(previousEnv);
    await rm(home, { recursive: true, force: true });
  }
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

test("research strategy sends empty candidate model lease object when none is configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-empty-model-lease-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await mkdir(repo, { recursive: true });
  const command = join(home, "host-research-empty-lease.js");
  await writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
const request = JSON.parse(args[args.indexOf("--request-json") + 1]);
if (!request.candidate_model_lease || typeof request.candidate_model_lease !== "object" || Array.isArray(request.candidate_model_lease)) {
  throw new Error("candidate_model_lease must be an object");
}
if (Object.keys(request.candidate_model_lease).length !== 0) {
  throw new Error("empty candidate_model_lease expected when no lease is configured");
}
process.stdout.write(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "empty-lease",
  candidate_model_lease: request.candidate_model_lease,
  decision: "implement",
  selected_target_id: "empty-lease-target",
  summary: "Select target with empty lease.",
  selected_iteration: {
    target_id: "empty-lease-target",
    target_repo: "across-agents-assistant",
    goal: "Add empty lease coverage.",
    allowed_patch_paths: ["backend/src/across_agents_assistant/empty_lease.py"],
    validation_commands: [],
    semantic_review: { minimum_validation_commands: 0 },
    risk: "low"
  },
  rejected_directions: []
}));
`, "utf8");

  const env = {
    ...process.env,
    ACROSS_HOME: home,
    ACROSS_AAA_HOST_RESEARCH_COMMAND: JSON.stringify(["node", command])
  };
  try {
    const result = await runProductIterationStrategy({
      spec: {
        id: "empty-model-lease",
        description: "Verify no configured model lease still sends an object.",
        pack_config: {
          target_repo: "across-agents-assistant",
          research_strategy: {
            candidate_targets: [{
              id: "empty-lease-target",
              target_repo: "across-agents-assistant",
              goal: "Add empty lease coverage.",
              allowed_patch_paths: ["backend/src/across_agents_assistant/empty_lease.py"],
              validation_commands: [],
              semantic_review: { minimum_validation_commands: 0 }
            }]
          }
        }
      },
      run: { run_id: "run-empty-model-lease" },
      sources: [],
      recalledMemory: [],
      actions: [{
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-empty-model-lease",
          repos: [{ id: "across-agents-assistant", target: repo, source: repo }],
          four_repo_manifest: true
        }
      }],
      env
    });

    assert.equal(result.status, "passed");
    assert.deepEqual(result.candidate_model_lease, {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("host code iteration repair records attention when patches make no changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-noop-repair-"));
  const sourcesRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourcesRoot, id);
    const files = id === "across-agents-assistant"
      ? { "backend/src/across_agents_assistant/capability.py": "VALUE = 'unchanged'\n" }
      : { "README.md": `# ${id}\n` };
    await createGitSource(source, files);
    repos.push({ id, source });
  }
  const hostCommand = join(home, "host-code-noop.js");
  await writeFile(hostCommand, `#!/usr/bin/env node
const args = process.argv.slice(2);
const request = JSON.parse(args[args.indexOf("--request-json") + 1]);
if (!request.validation_feedback.length) throw new Error("expected validation feedback");
process.stdout.write(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "noop-builder",
  summary: "No-op repair",
  patches: [{ path: "backend/src/across_agents_assistant/capability.py", mode: "overwrite", content: "VALUE = 'unchanged'\\n" }]
}));
`, "utf8");
  const env = {
    ...process.env,
    ACROSS_HOME: home,
    ACROSS_AAA_HOST_CODE_COMMAND: JSON.stringify(["node", hostCommand])
  };
  const run = { run_id: "run-noop-repair" };
  const spec = {
    id: "noop-repair-spec",
    description: "Verify no-op repairs do not consume validation repair loops silently.",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      allowed_patch_paths: ["backend/src/across_agents_assistant/capability.py"],
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
            goal: "Repair unchanged capability helper.",
            target_repo: "across-agents-assistant",
            allowed_patch_paths: ["backend/src/across_agents_assistant/capability.py"]
          }
        }
      },
      {
        adapter: "candidate_ecosystem_validation",
        status: "attention",
        result: {
          commands: [{
            command: "python3",
            args: ["-c", "raise AssertionError('still broken')"],
            status: "failed",
            diagnostic: { failure_kind: "candidate_test_assertion" }
          }]
        }
      }
    ]
  });

  assert.equal(result.status, "attention");
  assert.equal(result.noop_repair.reason, "repair_patches_made_no_file_changes");
  assert.equal(result.noop_repair.unresolved_feedback_kind, "candidate_test_assertion");
  assert.equal(result.changed_files.length, 0);
});

test("host code iteration trims trailing whitespace in source patches", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trim-source-"));
  const sourcesRoot = join(home, "sources");
  const repos = [];
  for (const id of ["across-agents-assistant", "across-orchestrator", "across-context", "across-autopilot"]) {
    const source = join(sourcesRoot, id);
    const files = id === "across-agents-assistant"
      ? { "backend/src/across_agents_assistant/capability.py": "VALUE = 'old'\n" }
      : { "README.md": `# ${id}\n` };
    await createGitSource(source, files);
    repos.push({ id, source });
  }
  const hostCommand = join(home, "host-code-trailing.js");
  await writeFile(hostCommand, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "trailing-builder",
  summary: "Trailing whitespace patch",
  patches: [{ path: "backend/src/across_agents_assistant/capability.py", mode: "overwrite", content: "VALUE = 'new'   \\nif True:\\t\\n    FLAG = True\\t\\n" }]
}));
`, "utf8");
  const env = {
    ...process.env,
    ACROSS_HOME: home,
    ACROSS_AAA_HOST_CODE_COMMAND: JSON.stringify(["node", hostCommand])
  };
  const run = { run_id: "run-trim-source" };
  const spec = {
    id: "trim-source-spec",
    description: "Verify generated source patches are normalized before quality gates.",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos },
      allowed_patch_paths: ["backend/src/across_agents_assistant/capability.py"],
      validation_commands: []
    },
    model_policy: { required: true }
  };
  const acquired = await acquireCandidateEcosystem({ spec, run, env });

  try {
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
              goal: "Apply normalized capability helper.",
              target_repo: "across-agents-assistant",
              allowed_patch_paths: ["backend/src/across_agents_assistant/capability.py"]
            }
          }
        }
      ]
    });
    const aaaRepo = acquired.repos.find((repo) => repo.id === "across-agents-assistant");
    const content = await readFile(join(aaaRepo.target, "backend/src/across_agents_assistant/capability.py"), "utf8");

    assert.equal(result.status, "passed");
    assert.doesNotMatch(content, /[ \t]+$/m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
  assert.equal(preflight.max_socket_path_bytes, 100);
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
  assert.ok(packIds.includes("self_iteration_quality_snapshot"));
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

test("trigger queue recovers an expired claimed item after a host interruption", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-recovery-"));
  const queue = new TriggerQueue({
    env: { ...process.env, ACROSS_HOME: home },
    defaultClaimLeaseMs: 1_000,
    claimLeaseGraceMs: 0
  });
  const spec = minimalSpec({
    id: "recoverable-queued-loop",
    actions: ["manifest_inspection"],
    outputs: ["noop_output"]
  });
  const enqueuedAt = new Date("2026-07-20T02:00:00.000Z");
  const trigger = await queue.enqueue(spec, { type: "cron", payload: { reason: "lease-recovery" } }, { now: enqueuedAt });
  const claimed = await queue.claim(trigger.trigger_id, { now: enqueuedAt });

  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.claim_attempt_count, 1);
  assert.equal(claimed.claim_lease_expires_at, "2026-07-20T02:00:01.000Z");

  const recovered = await queue.list({ now: new Date("2026-07-20T02:00:02.000Z") });
  const recoveredItem = recovered.items.find((item) => item.trigger_id === trigger.trigger_id);
  assert.equal(recoveredItem.status, "pending");
  assert.equal(recoveredItem.recovery_count, 1);
  assert.equal(recoveredItem.last_recovery_reason, "claim_lease_expired");

  const reclaimed = await queue.claimNext({ now: new Date("2026-07-20T02:00:03.000Z") });
  assert.equal(reclaimed.trigger_id, trigger.trigger_id);
  assert.equal(reclaimed.status, "claimed");
  assert.equal(reclaimed.claim_attempt_count, 2);
});

test("trigger queue uses a short preparation lease and renews it for execution", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-renew-"));
  const queue = new TriggerQueue({
    env: { ...process.env, ACROSS_HOME: home },
    defaultClaimLeaseMs: 120_000,
    claimLeaseGraceMs: 0
  });
  const spec = minimalSpec({ id: "lease-renew-loop", actions: ["manifest_inspection"], outputs: ["noop_output"] });
  const claimedAt = new Date("2026-07-20T02:30:00.000Z");
  const trigger = await queue.enqueue(spec, { type: "cron" }, { now: claimedAt });
  const claimed = await queue.claim(trigger.trigger_id, { now: claimedAt, leaseMs: 30_000 });
  assert.equal(claimed.claim_lease_expires_at, "2026-07-20T02:30:30.000Z");

  const renewed = await queue.renewClaim(trigger.trigger_id, { now: new Date("2026-07-20T02:30:10.000Z") });
  assert.equal(renewed.execution_started_at, "2026-07-20T02:30:10.000Z");
  assert.equal(renewed.claim_lease_expires_at, "2026-07-20T02:32:10.000Z");
});

test("trigger queue releases preparation failures with bounded retry metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-release-"));
  const queue = new TriggerQueue({ env: { ...process.env, ACROSS_HOME: home } });
  const spec = minimalSpec({
    id: "preparation-retry-loop",
    actions: ["manifest_inspection"],
    outputs: ["noop_output"]
  });
  const now = new Date("2026-07-20T03:00:00.000Z");
  const trigger = await queue.enqueue(spec, { type: "cron" }, { now });
  await queue.claim(trigger.trigger_id, { now });
  const released = await queue.release(trigger.trigger_id, {
    now,
    retryAfterMs: 30_000,
    failure: { code: "source_mirror_refresh_failed", retryable: true }
  });

  assert.equal(released.status, "pending");
  assert.equal(released.claimed_at, null);
  assert.equal(released.claim_lease_expires_at, null);
  assert.equal(released.not_before, "2026-07-20T03:00:30.000Z");
  assert.equal(released.preparation_failure_count, 1);
  assert.equal(released.preparation_retry_exhausted, false);
  assert.equal(released.last_release_reason, "source_mirror_refresh_failed");
  assert.equal((await queue.claimNext({ now: new Date("2026-07-20T03:00:29.000Z") })), null);
  assert.equal((await queue.claimNext({ now: new Date("2026-07-20T03:00:31.000Z") })).trigger_id, trigger.trigger_id);
});

test("trigger queue stops retrying after the bounded preparation failure budget", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-release-budget-"));
  const queue = new TriggerQueue({
    env: { ...process.env, ACROSS_HOME: home },
    maxPreparationFailures: 2,
    maxPreparationBackoffMs: 60_000
  });
  const spec = minimalSpec({ id: "bounded-preparation-loop", actions: ["manifest_inspection"], outputs: ["noop_output"] });
  const firstAt = new Date("2026-07-20T04:00:00.000Z");
  const trigger = await queue.enqueue(spec, { type: "cron" }, { now: firstAt });
  await queue.claim(trigger.trigger_id, { now: firstAt });
  const first = await queue.release(trigger.trigger_id, {
    now: firstAt,
    retryAfterMs: 30_000,
    failure: { code: "source_mirror_refresh_failed", retryable: true }
  });
  assert.equal(first.status, "pending");
  assert.equal(first.not_before, "2026-07-20T04:00:30.000Z");

  const secondAt = new Date("2026-07-20T04:00:31.000Z");
  await queue.claim(trigger.trigger_id, { now: secondAt });
  const exhausted = await queue.release(trigger.trigger_id, {
    now: secondAt,
    retryAfterMs: 30_000,
    failure: { code: "source_mirror_refresh_failed", retryable: true }
  });
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.preparation_failure_count, 2);
  assert.equal(exhausted.preparation_retry_exhausted, true);
  assert.equal(exhausted.failure.retryable, false);
  assert.equal(exhausted.completed_at, secondAt.toISOString());
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
  assert.equal(completed.platform_self_repair.eligible, false);
  assert.equal(completed.platform_self_repair.reason, "platform self-repair is not enabled for this run");
});

test("platform self-repair diagnosis redacts trigger payload secrets", () => {
  const source = renderTriggerPayloadSource({
    auto_platform_self_repair: true,
    api_key: "sk-secret",
    transcript: "raw conversation",
    platform_self_repair_case: {
      category: "validation_gap",
      goal: "Validation finding was recorded but not promoted into a blocking command."
    }
  });

  assert.equal(source.kind, "trigger_payload");
  assert.equal(source.payload.api_key, "[redacted]");
  assert.equal(source.payload.transcript, "[redacted]");
  assert.equal(source.content.includes("sk-secret"), false);
  assert.equal(source.content.includes("raw conversation"), false);
  const diagnosis = diagnosePlatformSelfRepair({
    spec: { id: "aaa-autonomous-self-iteration", failure_policy: { platform_self_repair: { enabled: true } } },
    failedRun: {
      run_id: "run-redacted",
      spec_id: "aaa-autonomous-self-iteration",
      trigger_event: { payload: source.payload },
      failure: { code: "gate.failed", message: "candidate_quality finding was not blocking validation" }
    },
    evidence: { actions: [], gates: [] }
  });
  assert.equal(diagnosis.eligible, true);
  assert.equal(diagnosis.category, "validation_gap");
});

test("product iteration strategy forwards redacted trigger payload context", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-trigger-context-"));
  const commandPath = join(home, "research-command.js");
  await writeFile(commandPath, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
if (request.product_context.trigger_payload.target_repo !== "across-autopilot") {
  throw new Error("missing trigger target_repo");
}
if (request.product_context.trigger_payload.target_id !== "autopilot-self-repair-replay-fixture") {
  throw new Error("missing trigger target_id");
}
if (request.product_context.trigger_payload.api_key !== "[redacted]") {
  throw new Error("trigger api_key was not redacted");
}
console.log(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "trigger-context-decision",
  summary: "Repair Autopilot self-repair router",
  rationale: "Trigger payload target_repo points to Autopilot.",
  decision: "implement",
  selected_target_id: "autopilot-self-repair-replay-fixture",
  candidate_targets: [{
    id: "autopilot-self-repair-replay-fixture",
    target_repo: "across-autopilot",
    goal: "Repair self-repair routing",
    allowed_patch_paths: ["src/platform-self-repair.js", "tests/platform-self-repair.test.js"],
    validation_commands: [
      { repo: "across-autopilot", command: "node", args: ["--test", "tests/platform-self-repair.test.js"] },
      { repo: "across-autopilot", command: "node", args: ["src/cli.js", "loop", "validate", "--spec", "aaa-platform-self-repair", "--json"] },
      { repo: "across-autopilot", command: "npm", args: ["test", "--", "--runInBand"] }
    ],
    semantic_review: { minimum_validation_commands: 2 },
    source_refs: ["failed-loop-trigger"],
    tool_packs: ["platform_failure_router"],
    generated_from: "trigger_payload",
    risk: "medium"
  }],
  selected_iteration: {
    target_id: "autopilot-self-repair-replay-fixture",
    target_repo: "across-autopilot",
    goal: "Repair self-repair routing",
    allowed_patch_paths: ["src/platform-self-repair.js", "tests/platform-self-repair.test.js"],
    validation_commands: [
      { repo: "across-autopilot", command: "node", args: ["--test", "tests/platform-self-repair.test.js"] },
      { repo: "across-autopilot", command: "node", args: ["src/cli.js", "loop", "validate", "--spec", "aaa-platform-self-repair", "--json"] }
    ],
    semantic_review: { minimum_validation_commands: 2 },
    source_refs: ["failed-loop-trigger"],
    tool_packs: ["platform_failure_router"],
    generated_from: "trigger_payload",
    risk: "medium"
  }
}));
`, "utf8");
  const previousEnv = snapshotEnv(["ACROSS_AAA_HOST_RESEARCH_COMMAND", "ACROSS_HOME"]);
  Object.assign(process.env, {
    ACROSS_HOME: home,
    ACROSS_AAA_HOST_RESEARCH_COMMAND: JSON.stringify(["node", commandPath])
  });
  try {
    const spec = {
      id: "aaa-platform-self-repair",
      name: "AAA Platform Self Repair",
      description: "Repair platform gap.",
      pack_config: {
        target_repo: "across-autopilot",
        research_strategy: {
          candidate_targets: [{
            id: "autopilot-self-repair-replay-fixture",
            target_repo: "across-autopilot",
            goal: "Repair self-repair routing",
            allowed_patch_paths: ["src/platform-self-repair.js", "tests/platform-self-repair.test.js"],
            validation_commands: [
              { repo: "across-autopilot", command: "node", args: ["--test", "tests/platform-self-repair.test.js"] },
              { repo: "across-autopilot", command: "node", args: ["src/cli.js", "loop", "validate", "--spec", "aaa-platform-self-repair", "--json"] }
            ],
            semantic_review: { minimum_validation_commands: 2 },
            tool_packs: ["platform_failure_router"],
            risk: "medium"
          }]
        }
      }
    };
    const result = await runProductIterationStrategy({
      spec,
      run: {
        run_id: "run-trigger-context",
        trigger_event: {
          payload: {
            target_id: "autopilot-self-repair-replay-fixture",
            target_repo: "across-autopilot",
            api_key: "secret"
          }
        }
      },
      sources: [],
      recalledMemory: [],
      actions: [{
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-trigger-context",
          repos: [{ id: "across-autopilot", target: home }],
          model_lease: { secrets_included: false, raw_credentials_allowed: false }
        }
      }]
    });

    assert.equal(result.status, "passed");
    assert.equal(result.selected_iteration.target_repo, "across-autopilot");
  } finally {
    restoreEnv(previousEnv);
    await rm(home, { recursive: true, force: true });
  }
});

test("failed platform loop enqueues a supervised self-repair trigger", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-self-repair-"));
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
    id: "aaa-autonomous-self-iteration-router-fixture",
    actions: ["orchestrator_task_dispatch"],
    outputs: ["noop_output"]
  });
  spec.failure_policy.platform_self_repair = {
    enabled: true,
    repair_spec: "aaa-platform-self-repair",
    promotion_only: true
  };
  const trigger = await supervisor.enqueueTrigger(spec, {
    type: "daemon",
    source: "self-repair-fixture",
    actor: "test",
    payload: {
      auto_platform_self_repair: true,
      platform_self_repair_case: {
        category: "supervisor_gap",
        goal: "Trigger queue failure did not create a platform self-repair candidate.",
        expected_after_repair: "failed trigger includes platform_self_repair evidence and queued repair run"
      }
    }
  });

  const dispatched = await supervisor.runQueuedTrigger(trigger.trigger_id);
  const queue = await supervisor.triggerQueueStatus();
  const completed = queue.items.find((item) => item.trigger_id === trigger.trigger_id);
  const repair = queue.items.find((item) => item.spec_id === "aaa-platform-self-repair");
  const failedRun = await store.loadRun(dispatched.run.run_id);
  const events = await store.events(dispatched.run.run_id);

  assert.equal(dispatched.status, "failed");
  assert.equal(completed.platform_self_repair.diagnosis.eligible, true);
  assert.equal(completed.platform_self_repair.diagnosis.category, "supervisor_gap");
  assert.equal(completed.platform_self_repair.diagnosis.target_id, "autopilot-self-repair-replay-fixture");
  assert.equal(repair.status, "pending");
  assert.equal(repair.trigger_event.payload.failure_category, "supervisor_gap");
  assert.equal(repair.trigger_event.payload.target_id, "autopilot-self-repair-replay-fixture");
  assert.equal(repair.trigger_event.payload.replay_contract.required, true);
  assert.equal(failedRun.platform_self_repair.diagnosis.repair_spec_id, "aaa-platform-self-repair");
  assert.equal(events.some((event) => event.type === "platform_self_repair_queued"), true);
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
  assert.ok(diffQualityPack.outputs.includes("normalized_findings"));
  assert.ok(diffQualityPack.outputs.includes("push_receipt"));
  assert.ok(Object.hasOwn(diffQualityPack.output_schema.properties, "normalized_findings"));
  assert.ok(Object.hasOwn(diffQualityPack.output_schema.properties, "push_receipt"));
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

test("autonomous candidate validation can complete with explicit rejected-candidate evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-rejected-candidate-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const registry = new AdapterRegistry({ store });
  let lifecycleCalled = false;
  registerBuiltIns(registry);
  registry.registerAction({
    id: "candidate_ecosystem_validation",
    async run() {
      return {
        id: "candidate_ecosystem_validation",
        adapter: "candidate_ecosystem_validation",
        status: "attention",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        inputs: [],
        outputs: [],
        result: {
          status: "attention",
          commands: [{
            repo: "across-agents-assistant",
            command: "python3",
            args: ["-c", "raise AssertionError('bad candidate')"],
            status: "failed",
            stderr: "AssertionError: bad candidate",
            diagnostic: {
              failure_kind: "candidate_test_assertion",
              failure_summary: "Candidate tests or assertions failed."
            }
          }]
        },
        failure: { code: "gate.failed", message: "Candidate ecosystem validation failed." }
      };
    }
  });
  registry.registerAction({
    id: "candidate_app_lifecycle",
    async run() {
      lifecycleCalled = true;
      return {
        id: "candidate_app_lifecycle",
        adapter: "candidate_app_lifecycle",
        status: "passed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        inputs: [],
        outputs: [],
        result: { status: "passed" }
      };
    }
  });
  const supervisor = new AutopilotSupervisor({
    store,
    registry,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const spec = minimalSpec({
    id: "rejected-candidate-loop",
    actions: ["candidate_ecosystem_validation", "candidate_app_lifecycle"],
    outputs: ["json_artifact"]
  });
  spec.pack_config = {
    candidate_validation: {
      max_repairs: 0,
      complete_on_rejected_candidate: true
    }
  };

  const { run, evidence } = await supervisor.run(spec);
  const rejected = evidence.actions.find((action) => action.adapter === "candidate_rejected");

  assert.equal(run.status, "completed");
  assert.equal(lifecycleCalled, false);
  assert.ok(rejected);
  assert.equal(rejected.result.status, "rejected");
  assert.equal(rejected.result.promotion_ready, false);
  assert.equal(rejected.result.failed_command_count, 1);
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
  assert.deepEqual(run.orchestrator_tasks, ["task-daily-news-brief", "loop-daily-news-brief"]);
  assert.deepEqual(run.memory_ids, ["mem-new"]);
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
  const promotion = evidence.actions.find((action) => action.adapter === "promotion_report_generation").result;
  assert.equal(promotion.promotion_ready, true);
  assert.equal(promotion.normalized_findings.length, 0);
  assert.equal(promotion.push_receipt.schema_version, "across-autopilot-push-receipt/1.0");
  assert.equal(promotion.push_receipt.gate_verdict, "pass");
  assert.match(promotion.push_receipt.evidence_hash, /^[a-f0-9]{64}$/);
  assert.equal(evidence.gates.every((gate) => gate.status === "passed"), true);
  const reportPath = evidence.outputs.find((output) => output.id === "markdown_report").path;
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /## Candidate Diff/);
  assert.match(report, /## Model Decision/);
  assert.match(report, /## Promotion/);
  assert.match(report, /PR-ready: checks passed with no blocking findings/);
});

test("report generation renders ecosystem candidate diff and validation sections", async () => {
  const registry = new AdapterRegistry();
  registerBuiltIns(registry);
  const report = await registry.getAction("report_generation").run({
    spec: {
      id: "ecosystem-report",
      name: "Ecosystem Report",
      description: "Render ecosystem candidate evidence.",
      autonomy: { level: 3 },
      pack_config: { mutation_policy: "candidate_workspace_only" }
    },
    sources: [],
    actions: [
      {
        id: "diff",
        adapter: "candidate_ecosystem_diff",
        status: "passed",
        result: {
          changed_files: ["backend/src/across_agents_assistant/agent_workspace_readiness.py"],
          changed_file_count: 1
        }
      },
      {
        id: "validation",
        adapter: "candidate_ecosystem_validation",
        status: "passed",
        result: {
          commands: [{ command: "python", args: ["-m", "pytest"], status: "passed" }]
        }
      },
      {
        id: "promotion",
        adapter: "promotion_report_generation",
        status: "passed",
        result: {
          promotion_ready: true,
          next_step: "Review candidate.",
          normalized_findings: [],
          push_receipt: {
            pr_ready_summary: "PR-ready: checks passed with no blocking findings.",
            evidence_hash: "a".repeat(64)
          }
        }
      }
    ],
    gates: [{ id: "promotion_report_ready", status: "passed", reason: "Promotion report says candidate is ready." }]
  });

  assert.match(report.result.markdown, /## Candidate Diff/);
  assert.match(report.result.markdown, /agent_workspace_readiness\.py/);
  assert.match(report.result.markdown, /## Candidate Validation/);
  assert.match(report.result.markdown, /python -m pytest: passed/);
  assert.match(report.result.markdown, /Evidence hash: a{64}/);
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
    "AGENTS.md": "# AAA Agent Instructions\n",
    "across.product.json": "{}\n",
    "backend/src/across_agents_assistant/__init__.py": "",
    "build/ignored-artifact.txt": "must not enter B\n",
    "backend/tests/.keep": ""
  });
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
    assert.equal(await fileExists(join(aaaCandidate, "AGENTS.md")), true);
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
    "AGENTS.md": "# AAA Agent Instructions\n",
    "across.product.json": "{}\n",
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
    "AGENTS.md": "# AAA Agent Instructions\nTool Pack Registry\nLoop Contract\nIndependent Reviewer\n",
    "across.product.json": "{}\n",
    "backend/src/across_agents_assistant/__init__.py": "",
    "backend/src/across_agents_assistant/api_server.py": "AUTOPILOT_SELF_ITERATION_FEATURES = []\n",
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
      "backend/src/across_agents_assistant/api_server.py",
      "backend/src/across_agents_assistant/autopilot_tool_pack_policy.py",
      "backend/tests/test_autopilot_tool_pack_policy.py"
    ],
    context_files: ["AGENTS.md"],
    validation_commands: [
      { repo: "across-agents-assistant", command: "python3", args: ["-m", "py_compile", "backend/src/across_agents_assistant/api_server.py", "backend/src/across_agents_assistant/autopilot_tool_pack_policy.py", "backend/tests/test_autopilot_tool_pack_policy.py"], timeout_ms: 30000 },
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
if (!request.allowed_patch_paths.includes("backend/src/across_agents_assistant/api_server.py")) {
  throw new Error("expected existing AAA integration surface");
}
if (request.model_policy?.agent_id !== "codex") throw new Error("expected selected builder agent");
if (request.model_policy?.model !== "codex") throw new Error("expected selected builder model");
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "local-agent",
  model: "codex",
  decision_hash: "fake-autonomous-code",
  summary: "Add Tool Pack policy helper",
  patches: [
    {
      path: "backend/src/across_agents_assistant/api_server.py",
      mode: "overwrite",
      content: "AUTOPILOT_SELF_ITERATION_FEATURES = ['autopilot_tool_pack_policy']\\n"
    },
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
if (request.builder_model?.model !== "codex") {
  throw new Error("expected builder model evidence");
}
if (request.model_policy?.agent_id !== "codex") throw new Error("expected selected reviewer agent");
if (request.model_policy?.model !== "codex") throw new Error("expected selected reviewer model");
console.log(JSON.stringify({
  schema_version: "across-host-review-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "local-agent",
  model: "codex",
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
      content: "Stable Tool Packs, guardrails, context engineering, and local Codex reviewer roles should guide autonomous iteration."
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
        builder: { agent_id: "codex", provider: "local-agent", model: "codex" },
        reviewer: { agent_id: "codex", provider: "local-agent", model: "codex", require_distinct_from_builder: false }
      }
    });

    assert.equal(run.status, "completed");
    const strategy = evidence.actions.find((action) => action.adapter === "product_iteration_strategy").result;
    assert.equal(strategy.autonomous, true);
    assert.ok(strategy.autonomous_state.contract_paths.readme.endsWith("README.md"));
    assert.ok(strategy.autonomous_state.artifact_paths.quality_snapshot.endsWith("quality-snapshot.json"));
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
    assert.equal(evidence.candidate.independent_reviewer.model, "codex");
    assert.equal(evidence.candidate.independent_reviewer.model_separation.required, false);
    assert.equal(evidence.candidate.independent_reviewer.model_separation.status, "not_required");
    assert.ok(evidence.candidate.changed_files.includes("across-agents-assistant/backend/src/across_agents_assistant/api_server.py"));
    assert.ok(evidence.candidate.changed_files.includes("across-agents-assistant/backend/src/across_agents_assistant/autopilot_tool_pack_policy.py"));
    assert.ok(evidence.gates.find((gate) => gate.id === "dynamic_backlog_ready" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "candidate_app_lifecycle_passed" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "independent_reviewer_passed" && gate.status === "passed"));
    assert.ok(evidence.gates.find((gate) => gate.id === "distinct_reviewer_model_passed" && gate.status === "passed"));
    assert.equal(await fileExists(strategy.autonomous_state.contract_paths.backlog), true);
    assert.equal(await fileExists(strategy.autonomous_state.global_timeline_path), true);
    assert.equal(await fileExists(strategy.autonomous_state.artifact_paths.quality_snapshot), true);
    const qualitySnapshot = JSON.parse(await readFile(strategy.autonomous_state.artifact_paths.quality_snapshot, "utf8"));
    assert.equal(qualitySnapshot.schema_version, "across-autopilot-self-iteration-quality-snapshot/1.0");
    assert.equal(qualitySnapshot.status, "ready");
    assert.ok(qualitySnapshot.tool_pack_status.packs.some((pack) => pack.id === "self_iteration_quality_snapshot"));
    assert.ok(qualitySnapshot.review_hints.length > 0);
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
  await writeFile(join(repo, "backend", "src", "across_agents_assistant", "api_server.py"), "APP_READY = True\n", "utf8");
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
    assert.ok(rendered.some((command) => command.includes("api_server.py")));
    assert.ok(rendered.some((command) => command.includes("runpy.run_path")));
  } finally {
    restoreEnv(previousEnv);
  }
});

test("strategy admission filters generated pytest validation commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-pytest-validation-command-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await mkdir(join(repo, "backend", "src", "across_agents_assistant"), { recursive: true });
  await mkdir(join(repo, "backend", "tests"), { recursive: true });
  await writeFile(join(repo, "backend", "src", "across_agents_assistant", "__init__.py"), "", "utf8");
  await writeFile(join(repo, "backend", "src", "across_agents_assistant", "api_server.py"), "APP_READY = True\n", "utf8");
  const commandPath = join(home, "host-research-pytest-command.js");
  await writeFile(commandPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "pytest-command",
  decision: "implement",
  selected_target_id: "pytest-validation-command",
  summary: "Select target with unavailable pytest validation",
  selected_iteration: {
    target_id: "pytest-validation-command",
    target_repo: "across-agents-assistant",
    goal: "Add a candidate helper.",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_pytest_command.py",
      "backend/tests/test_autopilot_pytest_command.py"
    ],
    validation_commands: [
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: ["-m", "pytest", "backend/tests/test_autopilot_pytest_command.py", "-q"]
      }
    ],
    semantic_review: { minimum_validation_commands: 2 },
    source_refs: ["pytest-validation-fixture"],
    tool_packs: ["validation_harness"],
    generated_from: "model_generated",
    risk: "low"
  },
  candidate_targets: [{
    id: "pytest-validation-command",
    target_repo: "across-agents-assistant",
    summary: "Add candidate helper.",
    goal: "Add a candidate helper.",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_pytest_command.py",
      "backend/tests/test_autopilot_pytest_command.py"
    ],
    validation_commands: [
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: ["-m", "pytest", "backend/tests/test_autopilot_pytest_command.py", "-q"]
      }
    ],
    semantic_review: { minimum_validation_commands: 2 },
    source_refs: ["pytest-validation-fixture"],
    tool_packs: ["validation_harness"],
    generated_from: "model_generated",
    risk: "low"
  }],
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
        id: "pytest-validation-command",
        name: "Pytest Validation Command",
        used_adapters: { actions: ["candidate_ecosystem_acquire", "product_iteration_strategy"] },
        pack_config: {
          target_repo: "across-agents-assistant",
          model_policy: { required: true },
          research_strategy: { autonomous: true }
        }
      },
      run: { run_id: "run-pytest-validation-command" },
      sources: [],
      actions: [{
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-pytest-validation-command",
          repos: [{ id: "across-agents-assistant", target: repo, source: repo }],
          four_repo_manifest: true
        }
      }],
      recalledMemory: [],
      env: process.env
    });

    const rendered = strategy.selected_iteration.validation_commands.map((command) => [command.command, ...command.args].join(" "));
    assert.equal(rendered.some((command) => command.includes("-m pytest")), false);
    assert.ok(rendered.some((command) => command.includes("git diff --check")));
    assert.ok(rendered.some((command) => command.includes("py_compile")));
    assert.ok(rendered.some((command) => command.includes("runpy.run_path('backend/tests/test_autopilot_pytest_command.py')")));
  } finally {
    restoreEnv(previousEnv);
    await rm(home, { recursive: true, force: true });
  }
});

test("candidate diff flags brittle dynamic list assertions in self-iteration tests", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-brittle-list-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await createGitSource(repo, {
    "backend/src/across_agents_assistant/api_server.py": "APP_READY = True\n"
  });
  const testPath = join(repo, "backend", "tests", "test_dynamic_gate_readiness.py");
  await mkdir(dirname(testPath), { recursive: true });
  await writeFile(testPath, [
    "def test_dynamic_gate_gap():",
    "    summary = {'promotion_readiness_required_evidence_gap': ['promotion_attestation']}",
    "    assert summary['promotion_readiness_required_evidence_gap'] == [",
    "        'promotion_attestation',",
    "    ]",
    ""
  ].join("\n"), "utf8");

  try {
    const spec = { id: "aaa-autonomous-self-iteration-brittle-list", pack_config: {} };
    const run = { run_id: "run-brittle-list" };
    const acquireAction = {
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-brittle-list",
          repos: [{ id: "across-agents-assistant", target: repo, source: repo }]
        }
      };
    const env = { ...process.env, ACROSS_HOME: home };
    const diff = await candidateEcosystemDiff({
      spec,
      run,
      actions: [acquireAction],
      env
    });

    const findings = diff.repos[0].quality_findings;
    const finding = findings.find((item) => item.id === "brittle_dynamic_list_assertion");
    assert.equal(finding?.severity, "error");
    assert.match(finding.message, /stable invariants/);
    assert.equal(diff.repos[0].normalized_findings.some((item) => item.id === "brittle_dynamic_list_assertion"), true);

    const validation = await validateCandidateEcosystem({
      spec,
      run,
      actions: [
        acquireAction,
        { adapter: "candidate_ecosystem_diff", result: diff }
      ],
      env
    });
    const qualityCommand = validation.commands.find((item) => item.command === "candidate_quality");
    assert.equal(validation.status, "attention");
    assert.equal(qualityCommand?.status, "failed");
    assert.equal(qualityCommand.quality_findings[0].id, "brittle_dynamic_list_assertion");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("candidate diff permits resilient dynamic membership assertions", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-resilient-list-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await createGitSource(repo, {
    "backend/src/across_agents_assistant/api_server.py": "APP_READY = True\n"
  });
  const testPath = join(repo, "backend", "tests", "test_dynamic_gate_readiness.py");
  await mkdir(dirname(testPath), { recursive: true });
  await writeFile(testPath, [
    "SUPPORTED_STATUSES = ['ready', 'attention', 'blocked']",
    "",
    "def test_dynamic_gate_gap():",
    "    summary = {'promotion_readiness_required_evidence_gap': ['promotion_attestation']}",
    "    gap = set(summary['promotion_readiness_required_evidence_gap'])",
    "    assert {'promotion_attestation'}.issubset(gap)",
    "    assert len(gap) >= 1",
    "",
    "def test_static_contract_exact_list_is_allowed():",
    "    assert SUPPORTED_STATUSES == [",
    "        'ready',",
    "        'attention',",
    "        'blocked',",
    "    ]",
    ""
  ].join("\n"), "utf8");

  try {
    const diff = await candidateEcosystemDiff({
      spec: { id: "aaa-autonomous-self-iteration-resilient-list", pack_config: {} },
      run: { run_id: "run-resilient-list" },
      actions: [{
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-resilient-list",
          repos: [{ id: "across-agents-assistant", target: repo, source: repo }]
        }
      }],
      env: { ...process.env, ACROSS_HOME: home }
    });

    assert.equal(diff.repos[0].quality_findings.some((item) => item.id === "brittle_dynamic_list_assertion"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("platform self-repair replay target does not add full npm test implicitly", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-platform-replay-validation-"));
  const repo = join(home, "candidate", "across-autopilot");
  await mkdir(join(repo, "tests"), { recursive: true });
  const commandPath = join(home, "host-research-platform-replay.js");
  await writeFile(commandPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-research-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-researcher",
  decision_hash: "platform-replay",
  decision: "implement",
  selected_target_id: "autopilot-self-repair-replay-fixture",
  summary: "Select platform self-repair replay fixture",
  selected_iteration: {
    target_id: "autopilot-self-repair-replay-fixture",
    target_repo: "across-autopilot",
    goal: "Add platform replay coverage.",
    allowed_patch_paths: ["tests/platform-self-repair.test.js"],
    validation_commands: [
      { repo: "across-autopilot", command: "node", args: ["--test", "tests/platform-self-repair.test.js"] },
      { repo: "across-autopilot", command: "node", args: ["src/cli.js", "loop", "validate", "--spec", "aaa-platform-self-repair", "--json"] }
    ],
    semantic_review: { minimum_validation_commands: 2, allow_replay_fixture_only: true, reject_test_only_change: false },
    risk: "high"
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
        id: "aaa-platform-self-repair",
        name: "AAA Platform Self Repair",
        pack_config: {
          target_repo: "across-autopilot",
          model_policy: { required: true },
          research_strategy: {
            candidate_targets: [{
              id: "autopilot-self-repair-replay-fixture",
              target_repo: "across-autopilot",
              goal: "Add platform replay coverage.",
              allowed_patch_paths: ["tests/platform-self-repair.test.js"],
              validation_commands: [
                { repo: "across-autopilot", command: "node", args: ["--test", "tests/platform-self-repair.test.js"] },
                { repo: "across-autopilot", command: "node", args: ["src/cli.js", "loop", "validate", "--spec", "aaa-platform-self-repair", "--json"] }
              ],
              semantic_review: { minimum_validation_commands: 2, allow_replay_fixture_only: true, reject_test_only_change: false },
              tool_packs: ["replay_fixture"],
              risk: "high"
            }]
          }
        }
      },
      run: { run_id: "run-platform-replay-validation" },
      sources: [],
      actions: [{
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-platform-replay-validation",
          repos: [{ id: "across-autopilot", target: repo, source: repo }],
          four_repo_manifest: true
        }
      }],
      recalledMemory: [],
      env: process.env
    });

    const rendered = strategy.selected_iteration.validation_commands.map((command) => [command.command, ...command.args].join(" "));
    assert.ok(rendered.some((command) => command.includes("node --test tests/platform-self-repair.test.js")));
    assert.ok(rendered.some((command) => command.includes("loop validate --spec aaa-platform-self-repair")));
    assert.equal(rendered.some((command) => command.includes("npm test")), false);
  } finally {
    restoreEnv(previousEnv);
    await rm(home, { recursive: true, force: true });
  }
});

test("platform self-repair trigger target bypasses host research command", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-platform-trigger-target-"));
  const autopilotRepo = join(home, "candidate", "across-autopilot");
  await mkdir(join(autopilotRepo, "tests"), { recursive: true });
  const commandPath = join(home, "host-research-should-not-run.js");
  await writeFile(commandPath, `#!/usr/bin/env node
throw new Error("host research command should not run for explicit trigger target");
`, "utf8");

  const previousEnv = snapshotEnv(["ACROSS_AAA_HOST_RESEARCH_COMMAND", "ACROSS_HOME"]);
  Object.assign(process.env, {
    ACROSS_AAA_HOST_RESEARCH_COMMAND: JSON.stringify(["node", commandPath]),
    ACROSS_HOME: home
  });
  try {
    const strategy = await runProductIterationStrategy({
      spec: {
        id: "aaa-platform-self-repair",
        name: "AAA Platform Self Repair",
        pack_config: {
          target_repo: "across-autopilot",
          research_strategy: {
            deterministic_trigger_target: true,
            candidate_targets: [{
              id: "aaa-host-runtime-repair",
              target_repo: "across-agents-assistant",
              goal: "Repair host runtime timeout policy.",
              allowed_patch_paths: [
                "backend/src/across_agents_assistant/api_server.py",
                "backend/tests/test_api_autopilot.py"
              ],
              context_files: ["backend/src/across_agents_assistant/api_server.py"],
              validation_commands: [
                { repo: "across-agents-assistant", command: "python3", args: ["-m", "py_compile", "backend/src/across_agents_assistant/api_server.py"] },
                { repo: "across-agents-assistant", command: "python3", args: ["-m", "pytest", "backend/tests/test_api_autopilot.py", "-q"] }
              ],
              semantic_review: { minimum_validation_commands: 2 },
              tool_packs: ["host_runtime_replay"],
              risk: "high",
              score: 90
            }]
          }
        }
      },
      run: {
        run_id: "run-platform-trigger-target",
        trigger_event: {
          payload: {
            target_id: "aaa-host-runtime-repair",
            target_repo: "across-agents-assistant"
          }
        }
      },
      sources: [],
      actions: [{
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-platform-trigger-target",
          repos: [{ id: "across-autopilot", target: autopilotRepo, source: autopilotRepo }],
          four_repo_manifest: true
        }
      }],
      recalledMemory: [],
      env: process.env
    });

    assert.equal(strategy.status, "passed");
    assert.equal(strategy.deterministic_trigger_target, true);
    assert.equal(strategy.model_backed, false);
    assert.equal(strategy.provider, "deterministic");
    assert.equal(strategy.selected_target_id, "aaa-host-runtime-repair");
    assert.equal(strategy.selected_iteration.target_repo, "across-agents-assistant");
  } finally {
    restoreEnv(previousEnv);
    await rm(home, { recursive: true, force: true });
  }
});

test("research strategy gate accepts admitted fallback target after deferred decision", () => {
  const [passed, reason] = ecosystemGateStatus("research_iteration_strategy_ready", {
    actions: [
      {
        adapter: "product_iteration_strategy",
        status: "attention",
        result: {
          status: "attention",
          decision: "defer",
          admission: { status: "passed" },
          selected_iteration: {
            target_id: "autopilot-self-repair-replay-fixture",
            target_repo: "across-autopilot",
            goal: "Add deterministic platform self-repair replay coverage."
          }
        }
      },
      {
        adapter: "host_code_iteration",
        status: "passed",
        result: { changed_files: ["across-autopilot/tests/platform-self-repair.test.js"] }
      }
    ]
  });

  assert.equal(passed, true);
  assert.match(reason, /admitted product iteration/);
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
    "AGENTS.md": "# AAA Agent Instructions\n",
    "across.product.json": "{}\n",
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
if (count > 0 && !request.validation_feedback[0].diagnostic?.failure_kind) throw new Error("repair attempt must include validation diagnostics");
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

test("host code iteration applies marker upsert patches idempotently", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-upsert-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  const rel = "backend/src/across_agents_assistant/autopilot_workbench.py";
  await mkdir(dirname(join(repo, rel)), { recursive: true });
  await writeFile(
    join(repo, rel),
    "def existing_workbench():\n"
      + "    return 'ok'\n\n"
      + "# ACROSS ITERATION TELEMETRY START\n"
      + "def stale_iteration_telemetry_snapshot():\n"
      + "    return {'status': 'stale'}\n"
      + "# ACROSS ITERATION TELEMETRY END\n"
      + "# ACROSS ITERATION TELEMETRY START\n"
      + "def broken_iteration_telemetry_snapshot():\n"
      + "    return {'status': 'broken'}\n"
      + "# ACROSS ITERATION TELEMETRY END\n",
    "utf8"
  );

  const command = join(home, "host-code-upsert.js");
  await writeFile(command, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-loop-engineer",
  decision_hash: "fake-upsert",
  summary: "Add workbench telemetry bridge",
  patches: [{
    path: ${JSON.stringify(rel)},
    mode: "upsert_between_markers",
    marker_start: "# ACROSS ITERATION TELEMETRY START",
    marker_end: "# ACROSS ITERATION TELEMETRY END",
    content: "def build_iteration_telemetry_snapshot():\\n    return {'status': 'ready'}\\n"
  }]
}));
`, "utf8");

  const spec = {
    id: "upsert-test",
    pack_config: {
      target_repo: "across-agents-assistant",
      code_iteration: {
        command: JSON.stringify(["node", command]),
        allowed_patch_paths: [rel]
      }
    }
  };
  const actions = [
    {
      adapter: "candidate_ecosystem_acquire",
      result: {
        repos: [{ id: "across-agents-assistant", target: repo }],
        model_lease: {}
      }
    },
    {
      adapter: "product_iteration_strategy",
      result: {
        selected_iteration: {
          target_id: "workbench-telemetry",
          target_repo: "across-agents-assistant",
          goal: "Add workbench telemetry bridge.",
          allowed_patch_paths: [rel],
          validation_commands: []
        }
      }
    }
  ];

  await runHostCodeIteration({ spec, run: { run_id: "run-upsert" }, actions, env: process.env });
  await runHostCodeIteration({ spec, run: { run_id: "run-upsert" }, actions, env: process.env });

  const content = await readFile(join(repo, rel), "utf8");
  assert.match(content, /def existing_workbench/);
  assert.match(content, /def build_iteration_telemetry_snapshot/);
  assert.doesNotMatch(content, /stale_iteration_telemetry_snapshot/);
  assert.doesNotMatch(content, /broken_iteration_telemetry_snapshot/);
  assert.equal((content.match(/ACROSS ITERATION TELEMETRY START/g) || []).length, 1);
  assert.equal((content.match(/ACROSS ITERATION TELEMETRY END/g) || []).length, 1);
});

test("host code iteration restores destructive entrypoint rewrites before repair patches", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-entrypoint-restore-"));
  const source = join(home, "source", "across-agents-assistant");
  const repo = join(home, "candidate", "across-agents-assistant");
  const rel = "backend/src/across_agents_assistant/api_server.py";
  const sourceContent = "from fastapi import FastAPI\n\napp = FastAPI()\n\nORIGINAL_API = True\n";
  await mkdir(dirname(join(source, rel)), { recursive: true });
  await mkdir(dirname(join(repo, rel)), { recursive: true });
  await writeFile(join(source, rel), sourceContent, "utf8");
  await writeFile(join(repo, rel), "\"\"\"truncated api replacement\"\"\"\nBROKEN = True\n", "utf8");

  const command = join(home, "host-code-restore.js");
  await writeFile(command, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
const api = readFileSync(join(request.candidate_workspace, ${JSON.stringify(rel)}), "utf8");
if (!api.includes("ORIGINAL_API = True")) {
  console.error("source baseline was not restored before repair");
  process.exit(1);
}
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: "fake-host",
  model: "fake-loop-engineer",
  decision_hash: "fake-restore",
  summary: "Append bounded API marker after restoring source baseline",
  patches: [{
    path: ${JSON.stringify(rel)},
    mode: "append",
    content: "\\n# ACROSS RESTORE TEST START\\ndef restored_marker():\\n    return ORIGINAL_API\\n# ACROSS RESTORE TEST END\\n"
  }]
}));
`, "utf8");

  const spec = {
    id: "entrypoint-restore-test",
    pack_config: {
      target_repo: "across-agents-assistant",
      candidate_ecosystem: { repos: [{ id: "across-agents-assistant", source }] },
      code_iteration: {
        command: JSON.stringify(["node", command]),
        allowed_patch_paths: [rel]
      }
    }
  };
  const actions = [
    {
      adapter: "candidate_ecosystem_acquire",
      result: {
        repos: [{ id: "across-agents-assistant", target: repo, source }],
        model_lease: {}
      }
    },
    {
      adapter: "product_iteration_strategy",
      result: {
        selected_iteration: {
          target_id: "restore-entrypoint",
          target_repo: "across-agents-assistant",
          goal: "Restore destructive API entrypoint rewrite before repair.",
          allowed_patch_paths: [rel],
          validation_commands: []
        }
      }
    },
    {
      adapter: "candidate_ecosystem_validation",
      result: {
        status: "attention",
        commands: [{
          repo: "across-agents-assistant",
          command: "candidate_quality",
          status: "failed",
          stderr: `destructive_product_entrypoint_rewrite: ${rel}: line 1: destructive rewrite`,
          diagnostic: { failure_kind: "candidate_quality_failure" },
          quality_findings: [{
            id: "destructive_product_entrypoint_rewrite",
            severity: "error",
            path: rel,
            line: 1,
            message: "candidate rewrites a critical product entrypoint"
          }]
        }]
      }
    }
  ];

  const result = await runHostCodeIteration({ spec, run: { run_id: "run-entrypoint-restore" }, actions, env: process.env });
  const content = await readFile(join(repo, rel), "utf8");
  assert.equal(result.pre_repair_resets.length, 1);
  assert.equal(result.pre_repair_resets[0].mode, "restore_source_baseline");
  assert.match(content, /ORIGINAL_API = True/);
  assert.match(content, /def restored_marker/);
  assert.doesNotMatch(content, /truncated api replacement/);
});

test("host code iteration recovers local agent timeout with bounded fallback patches", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-code-timeout-fallback-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await createGitSource(repo, {
    "backend/src/across_agents_assistant/api_server.py": "def existing_api():\n    return {'status': 'ok'}\n"
  });

  const command = join(home, "host-code-timeout.js");
  await writeFile(command, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "failed",
  status_code: 504,
  error: "local agent codex timed out after 900.3s: idle_timeout"
}));
process.exit(1);
`, "utf8");

  const productPath = "backend/src/across_agents_assistant/autopilot_research_timeout_recovery.py";
  const testPath = "backend/tests/test_autopilot_research_timeout_recovery.py";
  const apiPath = "backend/src/across_agents_assistant/api_server.py";
  const result = await runHostCodeIteration({
    spec: {
      id: "aaa-autonomous-self-iteration",
      pack_config: {
        target_repo: "across-agents-assistant",
        code_iteration: {
          command: JSON.stringify(["node", command]),
          allowed_patch_paths: [apiPath, productPath, testPath]
        },
        builder_model_policy: {
          allow_host_validation_repair_fallback: true
        }
      }
    },
    run: { run_id: "run-code-timeout-fallback" },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: {
          repos: [{ id: "across-agents-assistant", target: repo }],
          model_lease: {}
        }
      },
      {
        adapter: "product_iteration_strategy",
        result: {
          selected_iteration: {
            target_id: "autonomous-research-timeout-recovery",
            target_repo: "across-agents-assistant",
            goal: "Add product-integrated timeout recovery evidence.",
            allowed_patch_paths: [apiPath, productPath, testPath],
            validation_commands: []
          }
        }
      }
    ],
    env: process.env
  });

  assert.equal(result.status, "passed");
  assert.equal(result.model_backed, false);
  assert.equal(result.host_validation_repair_fallback, true);
  assert.equal(result.timeout_recovery.kind, "local_agent_timeout");
  assert.ok(result.changed_files.includes(`across-agents-assistant/${apiPath}`));
  assert.ok(result.changed_files.includes(`across-agents-assistant/${productPath}`));
  assert.ok(result.changed_files.includes(`across-agents-assistant/${testPath}`));

  const helper = await readFile(join(repo, productPath), "utf8");
  const api = await readFile(join(repo, apiPath), "utf8");
  const tests = await readFile(join(repo, testPath), "utf8");
  assert.match(helper, /def summarize_research_timeout_recovery/);
  assert.match(api, /build_autopilot_research_timeout_recovery_snapshot/);
  assert.match(tests, /def test_timeout_signal_is_recoverable/);
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

test("candidate app lifecycle allows empty llm status when no candidate model lease is present", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-app-lifecycle-no-lease-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  const script = join(home, "fake-candidate-app-lifecycle-no-lease.sh");
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
printf '{"status":"passed","candidate_id":"cand-app-no-lease","bundle_id":"app.acrossagents.assistant.candidate.cand-app-no-lease","app_path":"%s","runtime_home":"%s","app_home":"%s","socket_path":"%s/run/across-agents.sock","socket_path_bytes":70,"cleaned_up":true,"crash_reports":[],"health":{"status":"ok"},"llm_status":{}}\\n' "$app" "$runtime" "$home_arg" "$home_arg" > "$out"
`, "utf8");
  await exec("chmod", ["+x", script]);

  const result = await runCandidateAppLifecycle({
    spec: {
      id: "candidate-app-lifecycle-no-lease",
      pack_config: {
        candidate_app_lifecycle: { required: true, command: JSON.stringify(["bash", script]) }
      }
    },
    run: { run_id: "run-candidate-app-lifecycle-no-lease", outputs_dir: join(home, "outputs") },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "cand-app-no-lease",
          base_dir: join(home, "candidate"),
          runtime_home: join(home, "runtime"),
          app_home: join(home, "runtime", "aaa"),
          app_dir: join(home, "candidate-apps", "cand-app-no-lease"),
          runtime_preflight: { status: "passed", socket_path: join(home, "runtime", "aaa", "run", "across-agents.sock"), socket_path_bytes: 70 },
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
  assert.equal(result.health.status, "ok");
  assert.equal(result.llm_status, null);
});

test("candidate app lifecycle failure includes backend log tails", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-app-lifecycle-failure-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  const script = join(home, "fake-candidate-app-lifecycle-fail.sh");
  await mkdir(repo, { recursive: true });
  await writeFile(script, `#!/bin/sh
app_home=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-home) app_home="$2"; shift 2 ;;
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$app_home/logs" "$(dirname "$out")"
printf '{"status":"failed","error":"outer lifecycle failed"}\\n' > "$out"
printf 'startup prefix\\nreal backend crash tail: ImportError: cannot import name MCPToolRegistry\\n' > "$app_home/logs/backend_stdout.log"
printf 'outer stderr tail\\n' >&2
exit 7
`, "utf8");
  await exec("chmod", ["+x", script]);

  const result = await runCandidateAppLifecycle({
    spec: {
      id: "candidate-app-lifecycle-failure",
      pack_config: {
        candidate_app_lifecycle: { required: true, command: JSON.stringify(["bash", script]) }
      }
    },
    run: { run_id: "run-candidate-app-lifecycle-failure", outputs_dir: join(home, "outputs") },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "cand-app-failure",
          base_dir: join(home, "candidate"),
          runtime_home: join(home, "runtime"),
          app_home: join(home, "runtime", "aaa"),
          app_dir: join(home, "candidate-apps", "cand-app-failure"),
          runtime_preflight: { status: "passed", socket_path: join(home, "runtime", "aaa", "run", "across-agents.sock"), socket_path_bytes: 80 },
          repos: [{ id: "across-agents-assistant", target: repo }]
        }
      },
      {
        adapter: "candidate_ecosystem_diff",
        result: {
          changed_files: ["across-agents-assistant/backend/src/across_agents_assistant/autopilot_workbench.py"]
        }
      }
    ],
    env: { ...process.env, ACROSS_HOME: home }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, 7);
  assert.match(result.failure.message, /outer stderr tail/);
  assert.match(result.failure.message, /real backend crash tail/);
  assert.match(result.failure.backend_stdout_tail, /MCPToolRegistry/);
  assert.match(result.failure.output_json_tail, /outer lifecycle failed/);
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
  assert.equal(ready.normalized_findings.length, 0);
  assert.equal(ready.push_receipt.gate_verdict, "pass");
  assert.equal(ready.push_receipt.pr_ready_summary, "PR-ready: checks passed with no blocking findings.");
  assert.equal(ready.promotion_package.push_receipt.evidence_hash, ready.push_receipt.evidence_hash);

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
  assert.equal(missingPins.push_receipt.gate_verdict, "fail");
  assert.match(missingPins.push_receipt.pr_ready_summary, /Not PR-ready/);
  assert.ok(missingPins.promotion_package.known_risks.some((risk) => risk.source === "source_ref_pins"));
});

test("candidate promotion evidence exposes normalized findings and push receipt for blocking quality", () => {
  const promotion = buildCandidatePromotionEvidence({
    spec: { id: "normalized-findings" },
    run: { run_id: "run-normalized-findings" },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-normalized-findings",
          mode: "snapshot",
          four_repo_manifest: true,
          repos: [
            { id: "across-agents-assistant", source_head_pre: "a", source_git: true },
            { id: "across-autopilot", source_head_pre: "a", source_git: true },
            { id: "across-context", source_head_pre: "a", source_git: true },
            { id: "across-orchestrator", source_head_pre: "a", source_git: true }
          ]
        }
      },
      {
        adapter: "candidate_ecosystem_diff",
        result: {
          changed_files: ["across-autopilot/src/cli.js"],
          repos: [{
            id: "across-autopilot",
            changed_file_count: 1,
            changed_files: ["src/cli.js"],
            quality_findings: [{
              id: "unsafe_shell_execution",
              severity: "error",
              path: "src/cli.js",
              line: 10,
              message: "candidate code must not introduce shell execution"
            }]
          }]
        }
      },
      {
        adapter: "candidate_ecosystem_validation",
        result: {
          status: "attention",
          commands: [{
            repo: "across-autopilot",
            command: "candidate_quality",
            status: "failed",
            quality_findings: [{
              id: "unsafe_shell_execution",
              severity: "error",
              path: "src/cli.js",
              line: 10,
              message: "candidate code must not introduce shell execution"
            }]
          }],
          source_unchanged: {
            unchanged: true,
            repos: [
              { id: "across-agents-assistant", unchanged: true, head_post: "a" },
              { id: "across-autopilot", unchanged: true, head_post: "a" },
              { id: "across-context", unchanged: true, head_post: "a" },
              { id: "across-orchestrator", unchanged: true, head_post: "a" }
            ]
          }
        }
      },
      { adapter: "candidate_self_hosting_probe", result: { required: false, status: "passed" } },
      { adapter: "semantic_alignment_review", result: { status: "passed", promotion_recommendation: "review", reviewer_independent: true, model_separation: { status: "passed" } } }
    ]
  });

  assert.equal(promotion.promotion_ready, false);
  assert.equal(promotion.normalized_findings.length, 1);
  assert.equal(promotion.normalized_findings[0].state, "blocked");
  assert.equal(promotion.normalized_findings[0].source_gate, "candidate_quality");
  assert.equal(promotion.push_receipt.gate_verdict, "blocked");
  assert.match(promotion.push_receipt.evidence_hash, /^[a-f0-9]{64}$/);
  assert.equal(promotion.promotion_package.normalized_findings[0].id, "unsafe_shell_execution");
});

test("candidate validation carries normalized findings on implicit quality command", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-normalized-validation-"));
  const repo = join(home, "candidate", "across-autopilot");
  await mkdir(repo, { recursive: true });

  const result = await validateCandidateEcosystem({
    spec: { id: "normalized-validation", pack_config: { candidate_validation: { commands: [] } } },
    run: { run_id: "run-normalized-validation" },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: {
          candidate_id: "candidate-normalized-validation",
          repos: [{ id: "across-autopilot", target: repo }]
        }
      },
      {
        adapter: "candidate_ecosystem_diff",
        result: {
          repos: [{
            id: "across-autopilot",
            quality_findings: [{
              id: "placeholder_implementation",
              severity: "error",
              path: "src/index.js",
              line: 1,
              message: "placeholder implementation must be replaced before promotion"
            }]
          }]
        }
      }
    ],
    env: { ...process.env, ACROSS_HOME: home }
  });

  const qualityCommand = result.commands.find((command) => command.command === "candidate_quality");
  assert.equal(result.status, "attention");
  assert.equal(qualityCommand.normalized_findings[0].state, "blocked");
  assert.equal(qualityCommand.normalized_findings[0].source_gate, "candidate_quality");
  assert.equal(qualityCommand.normalized_findings[0].suggested_action, "Repair before promotion.");
});

test("candidate evidence projection exposes normalized findings and push receipt", () => {
  const evidence = buildEvidenceEnvelope({
    spec: { id: "projection-normalized-findings", runtime_policy: {} },
    run: {
      run_id: "run-projection-normalized-findings",
      status: "completed",
      started_at: "2026-07-10T00:00:00Z",
      completed_at: "2026-07-10T00:01:00Z"
    },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        status: "passed",
        result: { candidate_id: "candidate-projection", four_repo_manifest: true }
      },
      {
        adapter: "candidate_ecosystem_diff",
        status: "passed",
        result: {
          changed_files: ["across-autopilot/src/cli.js"],
          repos: [{
            id: "across-autopilot",
            changed_files: ["src/cli.js"],
            quality_findings: [{
              id: "long_source_line",
              severity: "warning",
              path: "src/cli.js",
              line: 12,
              message: "long source lines reduce reviewability"
            }]
          }]
        }
      },
      {
        adapter: "candidate_ecosystem_validation",
        status: "passed",
        result: { status: "passed", commands: [] }
      }
    ]
  });

  assert.equal(evidence.candidate.normalized_findings.length, 1);
  assert.equal(evidence.candidate.normalized_findings[0].state, "no_op");
  assert.equal(evidence.candidate.repos[0].normalized_findings[0].id, "long_source_line");
  assert.equal(evidence.candidate.push_receipt.gate_verdict, "pass");
  assert.match(evidence.candidate.push_receipt.evidence_hash, /^[a-f0-9]{64}$/);
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

test("candidate diff flags isolated helper and test without product integration", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-thin-helper-"));
  const repo = join(home, "across-agents-assistant");
  await createGitSource(repo, {
    "backend/src/across_agents_assistant/api_server.py": "def existing_api():\n    return 'ok'\n"
  });
  await mkdir(join(repo, "backend", "src", "across_agents_assistant"), { recursive: true });
  await writeFile(
    join(repo, "backend", "src", "across_agents_assistant", "autopilot_tool_spec_registry.py"),
    "def evaluate_candidate_signal(payload=None):\n    return {'status': 'ready'}\n",
    "utf8"
  );
  await mkdir(join(repo, "backend", "tests"), { recursive: true });
  await writeFile(
    join(repo, "backend", "tests", "test_autopilot_tool_spec_registry.py"),
    "from across_agents_assistant.autopilot_tool_spec_registry import evaluate_candidate_signal\n\n\ndef test_signal_ready():\n    assert evaluate_candidate_signal()['status'] == 'ready'\n",
    "utf8"
  );

  const diff = await candidateEcosystemDiff({
    spec: { id: "aaa-autonomous-self-iteration", pack_config: { target_repo: "across-agents-assistant" } },
    run: { run_id: "run-thin-helper" },
    actions: [{
      adapter: "candidate_ecosystem_acquire",
      result: { repos: [{ id: "across-agents-assistant", target: repo }] }
    }]
  });

  assert.ok(diff.repos[0].quality_findings.some((finding) => (
    finding.id === "unintegrated_candidate_helper"
    && finding.severity === "error"
  )));
  const validation = await validateCandidateEcosystem({
    spec: { id: "aaa-autonomous-self-iteration", pack_config: { target_repo: "across-agents-assistant" } },
    run: { run_id: "run-thin-helper" },
    actions: [
      {
        adapter: "candidate_ecosystem_acquire",
        result: { repos: [{ id: "across-agents-assistant", target: repo }] }
      },
      { adapter: "candidate_ecosystem_diff", result: diff }
    ]
  });
  const qualityFailure = validation.commands.find((command) => command.command === "candidate_quality");
  assert.equal(validation.status, "attention");
  assert.ok(qualityFailure);
  assert.match(qualityFailure.stderr, /unintegrated_candidate_helper/);

  const review = await semanticAlignmentReview({
    spec: {},
    actions: [
      {
        adapter: "product_iteration_strategy",
        result: {
          selected_iteration: {
            target_id: "tool-spec-registry",
            allowed_patch_paths: [
              "backend/src/across_agents_assistant/autopilot_tool_spec_registry.py",
              "backend/tests/test_autopilot_tool_spec_registry.py"
            ]
          }
        }
      },
      { adapter: "host_code_iteration", result: { model_backed: true, summary: "Add tool spec registry helper." } },
      { adapter: "candidate_ecosystem_diff", result: diff },
      { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed" }, { status: "passed" }] } }
    ]
  });

  assert.equal(review.status, "failed");
  assert.ok(review.blocking_reasons.some((reason) => reason.includes("unintegrated_candidate_helper")));
});

test("host code iteration passes operation timeout policy to builder model request", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-code-timeout-policy-"));
  const repo = join(home, "candidate", "across-agents-assistant");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Candidate\n", "utf8");
  const command = join(home, "host-code-timeout-policy.js");
  await writeFile(command, `#!/usr/bin/env node
const request = JSON.parse(process.argv[process.argv.indexOf("--request-json") + 1]);
const policy = request.model_policy || {};
if (policy.timeout_ms !== 2400000 || policy.idle_timeout_ms !== 900000 || policy.max_wall_timeout_ms !== 2400000) {
  console.error(JSON.stringify({ policy }));
  process.exit(1);
}
console.log(JSON.stringify({
  schema_version: "across-host-code-iteration/1.0",
  status: "passed",
  model_backed: true,
  provider: policy.provider,
  model: policy.model,
  decision_hash: "timeout-policy",
  summary: "Append timeout policy proof.",
  patches: [{ path: "README.md", mode: "append", content: "\\nTimeout policy propagated.\\n" }]
}));
`, "utf8");

  const spec = {
    id: "timeout-policy-test",
    pack_config: {
      target_repo: "across-agents-assistant",
      builder_model_policy: {
        agent_id: "codex",
        provider: "local-agent",
        model: "gpt-5.5",
        timeout_ms: 900000,
        idle_timeout_ms: 300000,
        max_wall_timeout_ms: 900000
      },
      code_iteration: {
        command: JSON.stringify(["node", command]),
        allowed_patch_paths: ["README.md"],
        timeout_ms: 2400000,
        idle_timeout_ms: 900000,
        max_wall_timeout_ms: 2400000
      }
    }
  };
  const actions = [
    {
      adapter: "candidate_ecosystem_acquire",
      result: { repos: [{ id: "across-agents-assistant", target: repo }], model_lease: {} }
    },
    {
      adapter: "product_iteration_strategy",
      result: {
        selected_iteration: {
          target_id: "timeout-policy",
          target_repo: "across-agents-assistant",
          goal: "Verify operation timeout policy.",
          allowed_patch_paths: ["README.md"],
          validation_commands: []
        }
      }
    }
  ];

  const result = await runHostCodeIteration({ spec, run: { run_id: "run-timeout-policy" }, actions, env: process.env });

  assert.equal(result.status, "passed");
  assert.equal(result.model_backed, true);
  assert.match(await readFile(join(repo, "README.md"), "utf8"), /Timeout policy propagated/);
});

test("candidate diff blocks destructive product entrypoint rewrites before app lifecycle", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-entrypoint-rewrite-"));
  const repo = join(home, "across-agents-assistant");
  const apiPath = "backend/src/across_agents_assistant/api_server.py";
  await createGitSource(repo, {
    [apiPath]: Array.from({ length: 900 }, (_, index) => `def route_${index}():\n    return ${index}`).join("\n\n") + "\n"
  });
  await writeFile(join(repo, apiPath), "from fastapi import FastAPI\n\napp = FastAPI()\n", "utf8");

  const acquire = {
    adapter: "candidate_ecosystem_acquire",
    result: { repos: [{ id: "across-agents-assistant", target: repo }] }
  };
  const spec = { id: "aaa-autonomous-self-iteration", pack_config: { target_repo: "across-agents-assistant" } };
  const diff = await candidateEcosystemDiff({
    spec,
    run: { run_id: "run-destructive-entrypoint" },
    actions: [acquire]
  });
  const finding = diff.repos[0].quality_findings.find((item) => item.id === "destructive_product_entrypoint_rewrite");

  assert.ok(finding);
  assert.equal(finding.severity, "error");
  assert.equal(finding.path, apiPath);
  assert.match(finding.excerpt, /\+\d+ -\d+/);

  const validation = await validateCandidateEcosystem({
    spec,
    run: { run_id: "run-destructive-entrypoint" },
    actions: [acquire, { adapter: "candidate_ecosystem_diff", result: diff }]
  });
  const qualityFailure = validation.commands.find((command) => command.command === "candidate_quality");
  assert.equal(validation.status, "attention");
  assert.ok(qualityFailure);
  assert.match(qualityFailure.stderr, /destructive_product_entrypoint_rewrite/);
  assert.equal(qualityFailure.diagnostic.failure_kind, "candidate_quality_failure");
});

test("candidate diff blocks destructive capability pack rewrites before repair", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-capability-pack-rewrite-"));
  const repo = join(home, "across-agents-assistant");
  const packPath = "backend/src/across_agents_assistant/loop_engineering_capability_pack.py";
  await createGitSource(repo, {
    [packPath]: Array.from(
      { length: 220 },
      (_, index) => `CAPABILITY_${index} = {'id': 'pack-${index}', 'label': 'Pack ${index}'}`
    ).join("\n") + "\n"
  });
  await writeFile(
    join(repo, packPath),
    Array.from({ length: 40 }, (_, index) => `NEW_CAPABILITY_${index} = {'id': 'new-${index}'}`).join("\n") + "\n",
    "utf8"
  );

  const acquire = {
    adapter: "candidate_ecosystem_acquire",
    result: { repos: [{ id: "across-agents-assistant", target: repo }] }
  };
  const spec = { id: "aaa-autonomous-self-iteration", pack_config: { target_repo: "across-agents-assistant" } };
  const diff = await candidateEcosystemDiff({
    spec,
    run: { run_id: "run-destructive-capability-pack" },
    actions: [acquire]
  });
  const finding = diff.repos[0].quality_findings.find((item) => item.id === "destructive_product_entrypoint_rewrite");

  assert.ok(finding);
  assert.equal(finding.severity, "error");
  assert.equal(finding.path, packPath);
  assert.match(finding.excerpt, /\+\d+ -\d+/);

  const validation = await validateCandidateEcosystem({
    spec,
    run: { run_id: "run-destructive-capability-pack" },
    actions: [acquire, { adapter: "candidate_ecosystem_diff", result: diff }]
  });
  const qualityFailure = validation.commands.find((command) => command.command === "candidate_quality");
  assert.equal(validation.status, "attention");
  assert.ok(qualityFailure);
  assert.match(qualityFailure.stderr, /loop_engineering_capability_pack\.py/);
  assert.equal(qualityFailure.diagnostic.failure_kind, "candidate_quality_failure");
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

test("semantic review allows same local Codex agent when distinct model is not required", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-review-codex-"));
  const reviewCommand = join(home, "codex-reviewer.js");
  await writeFile(reviewCommand, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-review-decision/1.0",
  status: "passed",
  model_backed: true,
  provider: "local-agent",
  model: "codex",
  decision_hash: "same-codex-review",
  recommendation: "review",
  merge_recommendation: "open_review_pr",
  product_value_score: 92,
  maintainability_score: 91,
  risk_score: 8,
  blocking_reasons: []
}));
`, "utf8");
  const review = await semanticAlignmentReview({
    spec: {
      pack_config: {
        semantic_review: {
          minimum_validation_commands: 1,
          require_distinct_model: false,
          independent_reviewer_required: true
        },
        reviewer_model_policy: {
          required: true,
          agent_id: "codex",
          provider: "local-agent",
          model: "codex",
          require_distinct_from_builder: false
        }
      }
    },
    actions: [
      { adapter: "product_iteration_strategy", result: { selected_iteration: { target_id: "product", allowed_patch_paths: ["backend/src/across_agents_assistant/autopilot_product.py"] } } },
      { adapter: "host_code_iteration", result: { model_backed: true, provider: "local-agent", model: "codex", summary: "Add product helper." } },
      { adapter: "candidate_ecosystem_diff", result: { changed_files: ["across-agents-assistant/backend/src/across_agents_assistant/autopilot_product.py"], repos: [] } },
      { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed" }, { status: "passed" }] } }
    ],
    env: { ...process.env, ACROSS_AAA_HOST_REVIEW_COMMAND: JSON.stringify(["node", reviewCommand]) }
  });

  assert.equal(review.status, "passed");
  assert.equal(review.reviewer_independent, true);
  assert.equal(review.model_separation.required, false);
  assert.equal(review.model_separation.status, "not_required");
  assert.equal(review.policy.distinct_model_required, false);
});

test("semantic review sends compact selected iteration to host reviewer", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-review-compact-request-"));
  const reviewCommand = join(home, "reviewer.js");
  const capturePath = join(home, "request.json");
  const longInlineValidation = [
    "import ast",
    "import sys",
    "from pathlib import Path",
    "print('LONG_INLINE_VALIDATION_SENTINEL')",
    "assert Path('backend/src/across_agents_assistant/autopilot_product.py').exists()"
  ].join("\\n");
  await writeFile(reviewCommand, `#!/usr/bin/env node
const fs = require("fs");
const index = process.argv.indexOf("--request-json");
const request = JSON.parse(process.argv[index + 1]);
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(request, null, 2));
console.log(JSON.stringify({
  schema_version: "across-host-review-decision/1.0",
  model_backed: true,
  provider: "local-agent",
  model: "codex",
  decision_hash: "compact-review-request",
  status: "passed",
  recommendation: "review",
  merge_recommendation: "open_review_pr",
  product_value_score: 92,
  maintainability_score: 91,
  risk_score: 8,
  blocking_reasons: []
}));
`, "utf8");

  const review = await semanticAlignmentReview({
    spec: {
      id: "aaa-autonomous-self-iteration",
      pack_config: {
        semantic_review: {
          minimum_validation_commands: 1,
          require_distinct_model: false,
          independent_reviewer_required: true
        },
        reviewer_model_policy: {
          required: true,
          agent_id: "codex",
          provider: "local-agent",
          model: "codex",
          require_distinct_from_builder: false
        }
      }
    },
    run: { run_id: "run-review-compact" },
    actions: [
      {
        adapter: "product_iteration_strategy",
        result: {
          selected_iteration: {
            target_id: "product",
            target_repo: "across-agents-assistant",
            goal: "Add a product helper.",
            allowed_patch_paths: ["backend/src/across_agents_assistant/autopilot_product.py"],
            context_files: ["backend/src/across_agents_assistant/loop_engineering_capability_pack.py"],
            source_refs: ["mcp-tooling-architecture-signal"],
            tool_packs: ["validation_harness", "independent_review"],
            validation_commands: [
              { repo: "across-agents-assistant", command: "python3", args: ["-c", longInlineValidation], timeout_ms: 60000 }
            ],
            semantic_review: {
              minimum_validation_commands: 1,
              require_distinct_model: false,
              independent_reviewer_required: true
            }
          }
        }
      },
      { adapter: "host_code_iteration", result: { model_backed: true, provider: "local-agent", model: "codex", summary: "Add product helper." } },
      { adapter: "candidate_ecosystem_diff", result: { changed_files: ["across-agents-assistant/backend/src/across_agents_assistant/autopilot_product.py"], repos: [] } },
      { adapter: "candidate_ecosystem_validation", result: { status: "passed", commands: [{ status: "passed", command: "python3" }] } }
    ],
    env: { ...process.env, ACROSS_AAA_HOST_REVIEW_COMMAND: JSON.stringify(["node", reviewCommand]), CAPTURE_PATH: capturePath }
  });

  assert.equal(review.status, "passed");
  const captured = JSON.parse(await readFile(capturePath, "utf8"));
  assert.equal(captured.selected_iteration.target_id, "product");
  assert.equal(captured.selected_iteration.validation_command_count, 1);
  assert.equal(captured.selected_iteration.semantic_review.minimum_validation_commands, 1);
  assert.equal(captured.selected_iteration.validation_commands, undefined);
  assert.equal(JSON.stringify(captured).includes("LONG_INLINE_VALIDATION_SENTINEL"), false);
});

test("semantic review accepts host timeout recovered candidate when reviewer times out", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-review-timeout-fallback-"));
  const reviewCommand = join(home, "timeout-reviewer.js");
  await writeFile(reviewCommand, `#!/usr/bin/env node
console.log(JSON.stringify({
  schema_version: "across-host-review-decision/1.0",
  status: "failed",
  status_code: 504,
  error: "local agent codex timed out after 900.3s: idle_timeout"
}));
process.exit(1);
`, "utf8");

  const review = await semanticAlignmentReview({
    spec: {
      pack_config: {
        semantic_review: {
          minimum_validation_commands: 1,
          require_distinct_model: false,
          independent_reviewer_required: true
        },
        reviewer_model_policy: {
          required: true,
          agent_id: "codex",
          provider: "local-agent",
          model: "gpt-5.5",
          require_distinct_from_builder: false
        }
      }
    },
    actions: [
      {
        adapter: "product_iteration_strategy",
        result: {
          selected_iteration: {
            target_id: "autonomous-research-timeout-recovery",
            allowed_patch_paths: [
              "backend/src/across_agents_assistant/api_server.py",
              "backend/src/across_agents_assistant/autopilot_research_timeout_recovery.py",
              "backend/tests/test_autopilot_research_timeout_recovery.py"
            ]
          }
        }
      },
      {
        adapter: "host_code_iteration",
        result: {
          model_backed: false,
          provider: "deterministic",
          model: "host-validation-timeout-recovery",
          host_validation_repair_fallback: true,
          timeout_recovery: { kind: "local_agent_timeout", status_code: 504 },
          summary: "Recovered from a local agent timeout by adding timeout diagnostics."
        }
      },
      {
        adapter: "candidate_ecosystem_diff",
        result: {
          changed_files: [
            "across-agents-assistant/backend/src/across_agents_assistant/api_server.py",
            "across-agents-assistant/backend/src/across_agents_assistant/autopilot_research_timeout_recovery.py",
            "across-agents-assistant/backend/tests/test_autopilot_research_timeout_recovery.py"
          ],
          repos: []
        }
      },
      {
        adapter: "candidate_ecosystem_validation",
        result: { status: "passed", commands: [{ status: "passed" }, { status: "passed" }] }
      }
    ],
    env: { ...process.env, ACROSS_AAA_HOST_REVIEW_COMMAND: JSON.stringify(["node", reviewCommand]) }
  });

  assert.equal(review.status, "passed");
  assert.equal(review.reviewer_independent, true);
  assert.equal(review.reviewer_model_backed, false);
  assert.equal(review.reviewer_timeout_recovery.kind, "local_agent_timeout");
  assert.equal(review.model_separation.required, false);
  assert.ok(review.warnings.some((warning) => warning.includes("timed out")));
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

test("cancel terminates a recorded run executor process", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-cancel-pid-"));
  const store = new RunStore({ env: { ...process.env, ACROSS_HOME: home } });
  const supervisor = new AutopilotSupervisor({
    store,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let run;
  try {
    run = await store.createRun({ id: "cancel-pid-loop" });
    await store.updateRun(run.run_id, { executor: { pid: child.pid, role: "test_executor" } });

    const cancelled = await supervisor.cancel(run.run_id, "test cancellation");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancellation.reason, "test cancellation");
    assert.equal(cancelled.cancellation.termination.attempted, true);
    assert.equal(cancelled.cancellation.termination.killed_pids.includes(child.pid), true);
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  }
});

test("listing runs reconciles a dead executor and releases its claimed trigger", async () => {
  const home = await mkdtemp(join(tmpdir(), "across-autopilot-recover-run-"));
  const env = { ...process.env, ACROSS_HOME: home };
  const store = new RunStore({ env });
  const triggerQueue = new TriggerQueue({ env });
  const supervisor = new AutopilotSupervisor({
    store,
    triggerQueue,
    orchestratorClient: new FakeOrchestrator(),
    contextClient: new FakeContext()
  });
  const now = new Date("2026-07-20T19:00:00.000Z");
  const spec = { id: "recover-interrupted-loop", trigger: { type: "cron" } };
  const triggerEvent = {
    type: "cron",
    source: "test-scheduler",
    idempotency_key: "recover-interrupted-loop:2026-07-20"
  };
  const queued = await triggerQueue.enqueue(spec, triggerEvent, { now });
  await triggerQueue.claim(queued.trigger_id, { now });
  const deadRun = await store.createRun(spec, { now, trigger: triggerEvent });
  await triggerQueue.attachRun(queued.trigger_id, deadRun.run_id);
  await store.updateRun(deadRun.run_id, {
    state: "running",
    status: "running",
    started_at: now.toISOString(),
    executor: { pid: 99_999_999, role: "loop_run", started_at: now.toISOString() }
  });
  await store.writeEvidence(deadRun.run_id, {
    schema_version: "across-loop-evidence/1.0",
    run_id: deadRun.run_id,
    status: "running"
  });
  const liveRun = await store.createRun({ id: "live-loop" }, { now: new Date(now.getTime() + 1_000) });
  await store.updateRun(liveRun.run_id, {
    state: "running",
    status: "running",
    started_at: new Date().toISOString(),
    executor: { pid: process.pid, role: "loop_run", started_at: new Date().toISOString() }
  });

  const runs = await supervisor.listRuns();
  const recovered = runs.find((run) => run.run_id === deadRun.run_id);
  const stillLive = runs.find((run) => run.run_id === liveRun.run_id);
  const evidence = await store.loadEvidence(deadRun.run_id);
  const queue = await triggerQueue.list({ now });
  const retriedTrigger = queue.items.find((item) => item.trigger_id === queued.trigger_id);

  assert.equal(recovered.status, "failed");
  assert.equal(recovered.state, "interrupted");
  assert.equal(recovered.failure.code, "runtime.interrupted");
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.code, "runtime.interrupted");
  assert.equal(retriedTrigger.status, "pending");
  assert.equal(retriedTrigger.last_interrupted_run_id, deadRun.run_id);
  assert.equal(retriedTrigger.execution_interruption_count, 1);
  assert.equal(stillLive.status, "running");
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

function collectUrlSources(value) {
  const sources = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (item?.adapter === "url" || item?.type === "url") sources.push(item);
  }
  return sources;
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
