import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlatformSelfRepairTrigger,
  diagnosePlatformSelfRepair,
  renderTriggerPayloadSource
} from "../src/platform-self-repair.js";

test("platform self-repair supervisor gaps route to the bounded replay fixture target", () => {
  const diagnosis = diagnosePlatformSelfRepair({
    spec: {
      id: "aaa-autonomous-self-iteration",
      failure_policy: { platform_self_repair: { enabled: true } }
    },
    failedRun: {
      run_id: "run-supervisor-gap",
      spec_id: "aaa-autonomous-self-iteration",
      trigger_event: {
        payload: {
          auto_platform_self_repair: true,
          platform_self_repair_case: {
            category: "supervisor_gap",
            goal: "Queue dispatch recorded a platform self-repair routing regression."
          }
        }
      },
      failure: {
        code: "gate.failed",
        message: "self-repair trigger queue dispatch did not expose replay evidence"
      }
    },
    evidence: {
      actions: [],
      gates: [{ id: "self_repair_router", status: "failed", summary: "trigger queue route failed" }]
    }
  });

  assert.equal(diagnosis.eligible, true);
  assert.equal(diagnosis.target_id, "autopilot-self-repair-replay-fixture");
  assert.equal(diagnosis.target_repo, "across-autopilot");
  assert.deepEqual(diagnosis.allowed_patch_paths, [
    "tests/platform-self-repair.test.js"
  ]);
  assert.equal(diagnosis.allowed_patch_paths.includes("src/platform-self-repair.js"), false);
  assert.equal(diagnosis.allowed_patch_paths.includes("src/supervisor.js"), false);
  assert.equal(diagnosis.allowed_patch_paths.includes("src/candidate-ecosystem.js"), false);
  assert.equal(diagnosis.trigger_payload.target_id, diagnosis.target_id);
});

test("platform self-repair trigger payload is safe to expose to the host model", () => {
  const fakeKey = ["local", "key", "fixture"].join("-");
  const privateTranscript = ["private", "transcript"].join(" ");
  const fakeBearer = ["Bearer", "private", "value"].join(" ");
  const source = renderTriggerPayloadSource({
    auto_platform_self_repair: true,
    api_key: fakeKey,
    raw_transcript: privateTranscript,
    nested: {
      authorization: fakeBearer
    },
    platform_self_repair_case: {
      category: "validation_gap",
      goal: "Validation gap should become a bounded repair candidate."
    }
  });
  assert.equal(source.payload.api_key, "[redacted]");
  assert.equal(source.payload.raw_transcript, "[redacted]");
  assert.equal(source.payload.nested.authorization, "[redacted]");
  assert.equal(source.content.includes(fakeKey), false);
  assert.equal(source.content.includes(privateTranscript), false);

  const diagnosis = diagnosePlatformSelfRepair({
    spec: { id: "aaa-autonomous-self-iteration" },
    failedRun: {
      run_id: "run-redaction",
      spec_id: "aaa-autonomous-self-iteration",
      trigger_event: { payload: source.payload },
      failure: { code: "gate.failed", message: "validator failed to block bad candidate evidence" }
    },
    evidence: { actions: [], gates: [] }
  });
  const trigger = buildPlatformSelfRepairTrigger(diagnosis);
  const serialized = JSON.stringify(trigger);
  assert.equal(serialized.includes("sk-local-secret"), false);
  assert.equal(serialized.includes("private transcript"), false);
  assert.equal(trigger.payload.target_id, "autopilot-validation-router-repair");
});

test("ordinary candidate failures do not enqueue platform self-repair", () => {
  const diagnosis = diagnosePlatformSelfRepair({
    spec: {
      id: "aaa-autonomous-self-iteration",
      failure_policy: { platform_self_repair: { enabled: true } }
    },
    failedRun: {
      run_id: "run-candidate-failure",
      spec_id: "aaa-autonomous-self-iteration",
      trigger_event: { payload: { auto_platform_self_repair: true } },
      failure: {
        code: "gate.failed",
        message: "pytest failed because candidate implementation assertion failed"
      }
    },
    evidence: {
      actions: [
        {
          adapter: "candidate_ecosystem_validation",
          status: "failed",
          failure: { code: "gate.failed", message: "pytest failed" },
          result: {
            commands: [
              {
                status: "failed",
                command: "python3",
                args: ["-m", "pytest"],
                stderr: "AssertionError: expected candidate behavior"
              }
            ]
          }
        }
      ],
      gates: []
    }
  });

  assert.equal(diagnosis.eligible, false);
  assert.equal(diagnosis.category, "candidate_code_failure");
  assert.equal(diagnosis.status, "not_applicable");
});
