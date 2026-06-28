import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

test("README documents conformance/autonomous split and tool pack policy", async () => {
  const readme = await readFile("README.md", "utf8");

  for (const anchor of [
    "AAA's public entrypoints",
    "OPEN_SOURCE_RELEASE_HANDBOOK.md",
    "Conformance LoopSpecs",
    "Autonomous product LoopSpecs",
    "aaa-autonomous-self-iteration",
    "current AI agent and LLM application architecture signals",
    "Tool Pack evidence",
    "policy-safe B-candidate targets",
    "reviewer gate",
    "distinct-model review",
    "model_generated_fallback_plan",
    "role-specific model overrides",
    "Tool Pack Registry",
    "canonical capability source",
    "not become a second plugin manager",
    "Git repository inspection",
    "packaged Candidate App lifecycle"
  ]) {
    assert.ok(readme.includes(anchor), `missing README anchor: ${anchor}`);
  }
});

test("RFC points future work at the reference architecture", async () => {
  const rfc = await readFile("AUTOPILOT_RFC.md", "utf8");

  for (const anchor of [
    "AAA host context lives in AAA's public entrypoints",
    "across.product.json",
    "fixed candidate plans",
    "fuzzy external ecosystem topics",
    "admitted by Autopilot policy",
    "distinct-model acceptance",
    "model-generated fallback",
    "role-specific model overrides",
    "Trigger Layer",
    "Memory and State Layer",
    "Verification and Promotion Layer",
    "not become a second plugin manager"
  ]) {
    assert.ok(rfc.includes(anchor), `missing RFC anchor: ${anchor}`);
  }
});
