import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const exec = promisify(execFile);

test("mcp server exposes help", async () => {
  const { stdout } = await exec("node", [join(process.cwd(), "src", "mcp-server.js"), "--help"]);
  assert.match(stdout, /Usage: across-autopilot mcp/);
});

