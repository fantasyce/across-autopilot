import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCommand, sanitizedSubprocessEnv } from "../src/process-client.js";

const exec = promisify(execFile);
const cli = join(process.cwd(), "src", "cli.js");

test("plugin manifest exposes Autopilot host contract", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-manifest-"));
  const { stdout } = await exec("node", [cli, "plugin-manifest", "--json", "--across-home", acrossHome]);
  const manifest = JSON.parse(stdout);

  assert.equal(manifest.id, "across-autopilot");
  assert.equal(manifest.kind, "autonomous-workflow");
  assert.equal(manifest.capabilities.stableCandidatePromotion, true);
  assert.equal(manifest.integrations.executionEngine, "across-orchestrator");
  assert.equal(manifest.integrations.memoryProvider, "across-context");
  assert.equal(manifest.compatibility.requiredHostVersion, ">=0.9.0");
  assert.equal(manifest.paths.data, join(acrossHome, "data", "across-autopilot"));
});

test("host-plugin install writes wrapper and manifest", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-install-"));
  const env = { ...process.env, ACROSS_HOME: acrossHome };

  const before = JSON.parse((await exec("node", [cli, "plugin-status", "--json"], { env })).stdout);
  assert.equal(before.installed, false);

  await exec("node", [cli, "install", "host-plugin", "--across-home", acrossHome], { env });
  const command = join(acrossHome, "bin", "across-autopilot");
  const after = JSON.parse((await exec(command, ["plugin-status", "--json"], { env })).stdout);
  const manifest = JSON.parse(await readFile(join(acrossHome, "plugins", "across-autopilot", "manifest.json"), "utf8"));

  assert.equal(after.installed, true);
  assert.equal(after.available, true);
  assert.equal(after.candidateSlot, null);
  assert.equal(manifest.entrypoints.review.args[0], "review");

  await exec(command, ["uninstall", "host-plugin", "--across-home", acrossHome], { env });
  const uninstalled = JSON.parse((await exec("node", [cli, "plugin-status", "--json"], { env })).stdout);
  assert.equal(uninstalled.installed, false);
});

test("cli loop validation exposes built-in LoopSpec", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-state-"));
  const env = { ...process.env, ACROSS_HOME: acrossHome };

  const registry = JSON.parse((await exec("node", [
    cli,
    "loop",
    "registry",
    "--json"
  ], { env })).stdout);
  const builtInIds = registry.built_in.map((spec) => spec.id);
  assert.deepEqual(builtInIds.sort(), ["aaa-autonomous-self-iteration", "aaa-release-readiness-gate", "aaa-research-driven-self-iteration", "aaa-self-iteration-product", "daily-news-brief", "github-plugin-radar"]);
  assert.equal(registry.built_in.find((spec) => spec.id === "github-plugin-radar").title, "GitHub Plugin Radar");
  assert.equal(registry.built_in.some((spec) => spec.spec), false);
  assert.equal(Array.isArray(registry.registered), true);

  const validation = JSON.parse((await exec("node", [
    cli,
    "loop",
    "validate",
    "--spec",
    "github-plugin-radar",
    "--json"
  ], { env })).stdout);

  assert.equal(validation.schema_version, "across-loop-validation/1.0");
  assert.equal(validation.valid, true);
  assert.equal(validation.spec_id, "github-plugin-radar");

  const dryRun = JSON.parse((await exec("node", [
    cli,
    "loop",
    "dry-run",
    "--spec",
    "daily-news-brief",
    "--json"
  ], { env })).stdout);
  assert.equal(dryRun.schema_version, "across-loop-dry-run/1.0");
  assert.ok(dryRun.used_adapters.outputs.includes("video_draft_manifest"));
});

test("ecosystem commands resolve from ACROSS_HOME bin without shell PATH", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-bin-"));
  const binDir = join(acrossHome, "bin");
  const commandPath = join(binDir, "across-orchestrator");
  await mkdir(binDir, { recursive: true });
  await writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(commandPath, 0o755);

  const resolved = resolveCommand(null, ["across-orchestrator"], { ...process.env, ACROSS_HOME: acrossHome, PATH: "/usr/bin" });

  assert.deepEqual(resolved, [commandPath]);
});

test("subprocess environment strips packaged host Python contamination", () => {
  const env = sanitizedSubprocessEnv({
    ACROSS_HOME: "/tmp/across",
    ACROSS_AAA_HOST_MODEL_COMMAND: "[\"backend\", \"autopilot-model-decision\"]",
    ACROSS_AAA_HOST_PYTHONPATH: "/tmp/aaa-host-src",
    MINIMAX_API_KEY: "should-not-reach-candidate",
    OPENAI_API_KEY: "should-not-reach-candidate",
    PATH: "/usr/bin",
    _PYI_ARCHIVE_FILE: "/Applications/Host.app/Contents/Resources/backend/backend",
    PYINSTALLER_RESET_ENVIRONMENT: "1",
    PYTHONHOME: "/Applications/Host.app/Contents/Resources/backend/_internal",
    PYTHONPATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    PYTHONUNBUFFERED: "1",
    __PYVENV_LAUNCHER__: "/Applications/Host.app/Contents/Resources/backend/backend",
    VIRTUAL_ENV: "/Applications/Host.app/Contents/Resources/backend",
    DYLD_LIBRARY_PATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    DYLD_FALLBACK_LIBRARY_PATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    LD_LIBRARY_PATH: "/Applications/Host.app/Contents/Resources/backend/_internal",
    UNRELATED_PACKAGED_STATE: "should-not-leak"
  });

  assert.equal(env.ACROSS_HOME, "/tmp/across");
  assert.equal(env.ACROSS_AAA_HOST_MODEL_COMMAND, "[\"backend\", \"autopilot-model-decision\"]");
  assert.equal(env.ACROSS_AAA_HOST_PYTHONPATH, "/tmp/aaa-host-src");
  assert.equal(env.MINIMAX_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env._PYI_ARCHIVE_FILE, undefined);
  assert.equal(env.PYINSTALLER_RESET_ENVIRONMENT, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONPATH, "/tmp/aaa-host-src");
  assert.equal(env.PYTHONUNBUFFERED, undefined);
  assert.equal(env.__PYVENV_LAUNCHER__, undefined);
  assert.equal(env.VIRTUAL_ENV, undefined);
  assert.equal(env.DYLD_LIBRARY_PATH, undefined);
  assert.equal(env.DYLD_FALLBACK_LIBRARY_PATH, undefined);
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.UNRELATED_PACKAGED_STATE, undefined);
});
