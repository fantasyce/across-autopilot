import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const exec = promisify(execFile);

test("mcp server exposes help", async () => {
  const { stdout } = await exec("node", [join(process.cwd(), "src", "mcp-server.js"), "--help"]);
  assert.match(stdout, /Usage: across-autopilot mcp/);
});

test("mcp server returns a parse error for invalid JSON", async () => {
  const child = spawn("node", [join(process.cwd(), "src", "mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP parse error")), 2000);
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(chunk).trim()));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdin.write("{not-json}\n");
    });
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32700);
    assert.equal(response.error.message, "Parse error");
  } finally {
    child.kill();
  }
});

test("mcp server exposes generic agent plugin validation and planning", async () => {
  const child = spawn("node", [join(process.cwd(), "src", "mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const manifest = {
    schema_version: "across-agent-plugin/1.0",
    plugin_id: "demo.echo-agent",
    display_name: "Demo Echo Agent",
    version: "1.0.0",
    agent: { id: "demo-echo", name: "Demo Echo", vendor: "tests" },
    capabilities: [{ id: "echo", risk: "low" }],
    entrypoints: { run: { command: ["node", "-e", "console.log('ok')"] } },
    trust: { mutation_boundary: "read_only", secrets_included: false },
    context: { pack_id: "demo.echo-agent", tags: ["demo"] }
  };

  try {
    const responsesPromise = readMcpResponses(child, 9);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } }
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "prompts/list" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "validate_agent_plugin", arguments: { manifest } }
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "plan_agent_plugin_run", arguments: { manifest, goal: "Echo from MCP", trigger: "mcp-test" } }
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "export_workflow_pack", arguments: { pack: "plugin-compatibility-lab-v2" } }
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "get_workflow_pack_trust_receipt", arguments: { pack: "plugin-compatibility-lab-v2" } }
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "get_workflow_pack_frontier_interop", arguments: { pack: "plugin-compatibility-lab-v2" } }
    })}\n`);
    const responses = await responsesPromise;

    assert.equal(responses[0].result.serverInfo.name, "Across Autopilot");
    assert.deepEqual(responses[1].result.resources, []);
    assert.deepEqual(responses[2].result.prompts, []);
    assert.ok(responses[3].result.tools.every((tool) => tool.inputSchema?.type === "object"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "validate_agent_plugin"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "plan_agent_plugin_run"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "supervise_agent_plugin_session"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "export_workflow_pack"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "get_workflow_pack_product_card"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "get_workflow_pack_protocol_readiness"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "get_workflow_pack_trust_receipt"));
    assert.ok(responses[3].result.tools.some((tool) => tool.name === "get_workflow_pack_frontier_interop"));
    const tools = new Map(responses[3].result.tools.map((tool) => [tool.name, tool]));
    const validateManifest = tools.get("validate_agent_plugin").inputSchema.properties.manifest;
    const planManifest = tools.get("plan_agent_plugin_run").inputSchema.properties.manifest;
    assert.equal(validateManifest.properties.schema_version.enum[0], "across-agent-plugin/1.0");
    assert.equal(validateManifest.properties.entrypoints.additionalProperties.properties.command.type, "array");
    assert.match(validateManifest.properties.entrypoints.additionalProperties.properties.command.description, /Direct executable argv array/);
    assert.equal(validateManifest.properties.capabilities.items.anyOf[1].required[0], "id");
    assert.equal(planManifest.properties.entrypoints.additionalProperties.properties.command.type, "array");
    const validationContractSchema = tools.get("plan_agent_plugin_run").inputSchema.properties.validation_contract;
    assert.equal(validationContractSchema.properties.schema_version.enum[0], "across-validation-contract/1.0");
    assert.match(validationContractSchema.properties.check_action.pattern, /_check/);
    assert.ok(validationContractSchema.properties.artifacts.items.properties.row_expectations);
    const supervisionSchema = tools.get("supervise_agent_plugin_session").inputSchema;
    assert.ok(supervisionSchema.properties.initial_command);
    assert.ok(supervisionSchema.properties.resume_command);
    assert.ok(supervisionSchema.properties.completion_contract);
    const normalized = JSON.parse(responses[4].result.content[0].text);
    assert.equal(normalized.schema_version, "across-agent-plugin/1.0");
    assert.equal(normalized.plugin_id, "demo.echo-agent");
    const plan = JSON.parse(responses[5].result.content[0].text);
    assert.equal(plan.schema_version, "across-autopilot-agent-plugin-plan/1.0");
    assert.equal(plan.status, "passed");
    assert.equal(plan.trigger, "mcp-test");
    assert.equal(plan.agent_plugin.plugin_id, "demo.echo-agent");
    assert.equal(plan.validation_contract.schema_version, "across-validation-contract/1.0");
    assert.equal(plan.validation_contract.check_action, "business_contract_check");
    assert.equal(plan.validation_contract.mode, "template");
    assert.deepEqual(plan.loop_contract.recommended_action_plan, [
      "memory_search",
      "task_dispatch",
      "business_contract_check",
      "quality_gate",
      "final_output"
    ]);
    assert.equal(plan.host_completion_contract.schema_version, "across-host-completion-contract/1.0");
    assert.equal(plan.host_completion_contract.supervision.owner, "across-autopilot");
    assert.equal(plan.evidence_contract.required.includes("host_completion_contract"), true);
    const workflowPack = JSON.parse(responses[6].result.content[0].text);
    assert.equal(workflowPack.schema_version, "across-workflow-pack-host-exports/1.0");
    assert.equal(workflowPack.product_card.schema_version, "across-workflow-pack-product-card/1.0");
    assert.equal(workflowPack.trust_receipt.schema_version, "across-agent-team-trust-receipt/1.0");
    assert.equal(workflowPack.frontier_interop.schema_version, "across-workflow-pack-frontier-interop/1.0");
    assert.equal(workflowPack.hosts.codex.type, "codex-plugin-task");
    assert.equal(workflowPack.hosts.claude_code.type, "claude-code-skill-or-mcp-task");
    const trustReceipt = JSON.parse(responses[7].result.content[0].text);
    assert.equal(trustReceipt.schema_version, "across-agent-team-trust-receipt/1.0");
    const frontierInterop = JSON.parse(responses[8].result.content[0].text);
    assert.equal(frontierInterop.schema_version, "across-workflow-pack-frontier-interop/1.0");
    assert.equal(frontierInterop.remote_mcp.transport, "streamable_http");
  } finally {
    child.kill();
  }
});

test("plan_agent_plugin_run accepts a host-supplied generic validation contract", async () => {
  const child = spawn("node", [join(process.cwd(), "src", "mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const manifest = {
    schema_version: "across-agent-plugin/1.0",
    plugin_id: "demo.report-agent",
    agent: { id: "demo.report-agent" },
    capabilities: [{ id: "report", risk: "low" }],
    entrypoints: { run: { command: ["printf", "ok\\n"] } },
    trust: { mutation_boundary: "read_only", secrets_included: false }
  };
  const validation_contract = {
    schema_version: "across-validation-contract/1.0",
    check_action: "business_contract_check",
    artifacts: [
      {
        path: "outputs/report.csv",
        type: "csv",
        columns: ["id", "score"],
        row_count: 2,
        row_expectations: [
          { match: { id: "A-1" }, expect: { score: "10" } }
        ]
      },
      {
        path: "custom/audit.json",
        type: "json",
        required_keys: ["loop_id", "business_contract_check_completed", "observed_actions"]
      }
    ]
  };

  try {
    const responsesPromise = readMcpResponses(child, 2);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } }
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "plan_agent_plugin_run", arguments: { manifest, validation_contract } }
    })}\n`);
    const responses = await responsesPromise;
    const plan = JSON.parse(responses[1].result.content[0].text);
    assert.equal(plan.validation_contract.mode, "host_supplied");
    assert.equal(plan.validation_contract.artifacts[0].path, "outputs/report.csv");
    assert.equal(plan.validation_contract.artifacts[0].row_expectations[0].expect.score, "10");
    assert.equal(plan.evidence_contract.required.includes("validation_contract"), true);
    assert.equal(plan.evidence_contract.required.includes("host_completion_contract"), true);
    assert.equal(plan.host_completion_contract.required_files[0], "outputs/report.csv");
    assert.equal(plan.host_completion_contract.required_observed_actions[0].path, "custom/audit.json");
    assert.deepEqual(plan.host_completion_contract.required_json_values[0], {
      path: "custom/audit.json",
      pointer: "/business_contract_check_completed",
      equals: true
    });
  } finally {
    child.kill();
  }
});

function readMcpResponses(child, expectedCount) {
  return new Promise((resolve, reject) => {
    const responses = [];
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for MCP responses")), 2000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        responses.push(JSON.parse(line));
        if (responses.length === expectedCount) {
          clearTimeout(timer);
          resolve(responses);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
