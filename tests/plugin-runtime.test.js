import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

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
  assert.equal(manifest.compatibility.requiredHostVersion, ">=0.8.29");
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

test("cli candidate lifecycle persists state", async () => {
  const acrossHome = await mkdtemp(join(tmpdir(), "across-autopilot-state-"));
  const env = { ...process.env, ACROSS_HOME: acrossHome };

  const created = JSON.parse((await exec("node", [
    cli,
    "create-candidate",
    "--goal",
    "Update docs",
    "--target-product",
    "across-agents-assistant",
    "--json"
  ], { env })).stdout);

  assert.equal(created.status, "planned");

  const status = JSON.parse((await exec("node", [cli, "status", "--json"], { env })).stdout);
  assert.equal(status.candidate_slot.candidate_id, created.candidate_id);
  assert.equal(status.candidates.length, 1);
});

