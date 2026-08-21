import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapter-registry.js";

function memoryActionContext({ required, contextClient }) {
  return {
    spec: {
      id: required ? "required-memory" : "optional-memory",
      memory: { required }
    },
    run: { run_id: "run-memory-boundary" },
    actions: [],
    gates: [],
    contextClient
  };
}

test("optional memory degrades when Context is not configured", async () => {
  const action = new AdapterRegistry().getAction("memory_write_candidate");
  const result = await action.run(memoryActionContext({ required: false, contextClient: null }));

  assert.equal(result.status, "attention");
  assert.equal(result.result.memory.status, "skipped");
  assert.equal(result.result.memory.mode, "optional-context-unavailable");
});

test("optional memory degrades when Context fails at runtime", async () => {
  const action = new AdapterRegistry().getAction("memory_write_candidate");
  const contextClient = {
    available: () => true,
    rememberLoop: async () => {
      throw new Error("context command failed");
    }
  };
  const result = await action.run(memoryActionContext({ required: false, contextClient }));

  assert.equal(result.status, "attention");
  assert.equal(result.result.memory.status, "skipped");
  assert.equal(result.result.memory.mode, "optional-context-unavailable");
  assert.match(result.result.memory.warning, /context command failed/);
});

test("required memory fails when Context is unavailable", async () => {
  const action = new AdapterRegistry().getAction("memory_write_candidate");

  await assert.rejects(
    action.run(memoryActionContext({ required: true, contextClient: null })),
    (error) => error?.code === "context.unavailable"
  );
});

test("required memory propagates a Context runtime failure", async () => {
  const action = new AdapterRegistry().getAction("memory_write_candidate");
  const contextClient = {
    available: () => true,
    rememberLoop: async () => {
      const error = new Error("required context failed");
      error.code = "context.unavailable";
      throw error;
    }
  };

  await assert.rejects(
    action.run(memoryActionContext({ required: true, contextClient })),
    (error) => error?.code === "context.unavailable"
  );
});
