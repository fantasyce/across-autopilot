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
