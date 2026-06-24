import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateCompletionContract, superviseAgentPluginSession } from "../src/host-session-supervisor.js";

test("host session supervisor automatically continues an incomplete host run", async () => {
  const root = await mkdtemp(join(tmpdir(), "across-host-session-supervisor-"));
  const hostScript = join(root, "host-agent.mjs");
  await writeFile(hostScript, `
import { mkdirSync, writeFileSync } from "node:fs";
const mode = process.argv[2];
const session = process.argv[3] || "session-auto-1";
console.log(JSON.stringify({ type: "system", session_id: session }));
if (mode === "resume") {
  mkdirSync("outputs", { recursive: true });
  writeFileSync("outputs/report.csv", "id,score\\nA-1,10\\n");
  writeFileSync("outputs/memo.md", "A-1 score is 10 and ready.\\n");
  writeFileSync("outputs/workflow_audit.json", JSON.stringify({
    loop_id: "loop-test",
    business_contract_check_completed: true,
    observed_actions: [
      { action_type: "business_contract_check" },
      { action_type: "final_output" }
    ],
    validation_evidence: { passed: true }
  }, null, 2));
}
`, "utf8");

  const result = await superviseAgentPluginSession({
    cwd: root,
    initial_command: {
      argv: ["node", hostScript, "initial"],
      stdout_path: "logs/initial.jsonl"
    },
    resume_command: {
      argv: ["node", hostScript, "resume", "{session_id}"],
      stdin: "{continuation_prompt}",
      stdout_path: "logs/resume.jsonl"
    },
    validation_contract: {
      schema_version: "across-validation-contract/1.0",
      check_action: "business_contract_check",
      artifacts: [
        {
          path: "outputs/report.csv",
          type: "csv",
          columns: ["id", "score"],
          row_count: 1,
          row_expectations: [{ match: { id: "A-1" }, expect: { score: "10" } }]
        },
        {
          path: "outputs/memo.md",
          type: "markdown",
          must_include: ["A-1", "10"],
          must_not_include: ["bad"]
        },
        {
          path: "outputs/workflow_audit.json",
          type: "json",
          required_keys: ["loop_id", "business_contract_check_completed"]
        }
      ]
    },
    completion_contract: {
      schema_version: "across-host-completion-contract/1.0",
      required_files: [
        "outputs/report.csv",
        "outputs/memo.md",
        "outputs/workflow_audit.json"
      ],
      required_json_values: [
        { path: "outputs/workflow_audit.json", pointer: "/business_contract_check_completed", equals: true }
      ],
      required_observed_actions: [
        { path: "outputs/workflow_audit.json", action_type: "business_contract_check" },
        { path: "outputs/workflow_audit.json", action_type: "final_output" }
      ]
    },
    max_attempts: 3,
    timeout_ms: 10_000
  });

  assert.equal(result.schema_version, "across-host-session-supervision/1.0");
  assert.equal(result.status, "passed");
  assert.equal(result.session_id, "session-auto-1");
  assert.equal(result.attempt_count, 2);
  assert.equal(result.continuation_count, 1);
  assert.equal(result.attempts[0].completion_passed, false);
  assert.equal(result.attempts[1].completion_passed, true);
  assert.equal(result.completion.failure_count, 0);
  assert.match(await readFile(join(root, "logs", "resume.jsonl"), "utf8"), /session-auto-1/);
});

test("host session supervisor validates CSV sort specs as a lexicographic key list", async () => {
  const root = await mkdtemp(join(tmpdir(), "across-host-session-sort-"));
  await writeFile(join(root, "report.csv"), [
    "account_id,risk_score,arr_usd",
    "A-101,100,420000",
    "A-103,100,350000",
    "A-107,92,500000",
    "A-109,90,200000"
  ].join("\n"));

  const contract = {
    validation_contract: {
      schema_version: "across-validation-contract/1.0",
      check_action: "business_contract_check",
      artifacts: [
        {
          path: "report.csv",
          type: "csv",
          columns: ["account_id", "risk_score", "arr_usd"],
          row_count: 4,
          sort: [
            { field: "risk_score", direction: "desc", numeric: true },
            { field: "arr_usd", direction: "desc", numeric: true }
          ]
        }
      ]
    }
  };

  const passing = await evaluateCompletionContract({ cwd: root, contract });
  assert.equal(passing.status, "passed");

  await writeFile(join(root, "report.csv"), [
    "account_id,risk_score,arr_usd",
    "A-103,100,350000",
    "A-101,100,420000",
    "A-107,92,500000",
    "A-109,90,200000"
  ].join("\n"));
  const failing = await evaluateCompletionContract({ cwd: root, contract });
  assert.equal(failing.status, "failed");
  assert.match(failing.failures[0].message, /risk_score desc, arr_usd desc/);
});
