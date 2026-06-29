export const ASYNC_TASK_SCHEMA = "across-async-task/1.0";

export function taskIdForRun(runId) {
  return `task-${runId}`;
}

export function runIdForTaskId(taskIdOrRunId) {
  const value = String(taskIdOrRunId || "");
  return value.startsWith("task-run-") ? value.slice("task-".length) : value;
}

export function asyncTaskEnvelope(run, patch = {}) {
  const runId = run?.run_id || patch.run_id || runIdForTaskId(patch.task_id);
  const taskId = patch.task_id || taskIdForRun(runId);
  return {
    schema_version: ASYNC_TASK_SCHEMA,
    task_id: taskId,
    run_id: runId,
    status: patch.status || run?.status || "running",
    state: patch.state || run?.state || "created",
    source_of_truth: "across-autopilot-run-store",
    projection_only: true,
    mcp_tasks_capability: true,
    poll: {
      status_command: `across-autopilot loop task-status --task-id ${taskId} --json`,
      events_command: `across-autopilot loop events --run-id ${runId} --json`
    },
    subscription: {
      mode: "host_poll_or_sse_projection",
      run_store_events: true
    },
    boundaries: {
      raw_transcripts_included: false,
      secrets_included: false,
      product_paths_required: "~/.across"
    },
    ...patch
  };
}
