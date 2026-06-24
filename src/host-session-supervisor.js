import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sanitizedSubprocessEnv } from "./process-client.js";

export const HOST_SESSION_SUPERVISION_SCHEMA = "across-host-session-supervision/1.0";
export const HOST_COMPLETION_CONTRACT_SCHEMA = "across-host-completion-contract/1.0";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 20 * 1024 * 1024;

export async function superviseAgentPluginSession(options = {}) {
  const cwd = resolve(String(options.cwd || options.projectRoot || options.project_root || process.cwd()));
  const validationContract = options.validation_contract || options.validationContract || null;
  const completionContract = normalizeCompletionContract({
    ...(options.completion_contract || options.completionContract || {}),
    validation_contract: validationContract
  });
  const initial = normalizeCommandSpec(options.initial_command || options.initialCommand || options.command, "initial_command");
  const resume = options.resume_command || options.resumeCommand
    ? normalizeCommandSpec(options.resume_command || options.resumeCommand, "resume_command")
    : null;
  const maxAttempts = clampInt(options.max_attempts ?? options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 6);
  const timeoutMs = clampInt(options.timeout_ms ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 900_000);
  const startedAt = new Date().toISOString();
  const attempts = [];
  let sessionId = null;
  let completion = await evaluateCompletionContract({ cwd, contract: completionContract });

  if (!completion.passed) {
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const kind = attemptNumber === 1 ? "initial" : "continuation";
      const commandSpec = kind === "initial" ? initial : resume;
      if (!commandSpec) break;
      const continuationPrompt = buildContinuationPrompt({
        cwd,
        attemptNumber,
        maxAttempts,
        sessionId,
        completion,
        completionContract
      });
      const materialized = materializeCommandSpec(commandSpec, {
        cwd,
        session_id: sessionId || "",
        continuation_prompt: continuationPrompt
      });
      const result = await runCommand(materialized, { cwd, timeoutMs });
      const observedSessionId = sessionIdFromOutput(`${result.stdout}\n${result.stderr}`);
      if (observedSessionId) sessionId = observedSessionId;
      completion = await evaluateCompletionContract({ cwd, contract: completionContract });
      attempts.push({
        attempt: attemptNumber,
        kind,
        command: redactCommand(materialized.argv),
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
        session_id: sessionId,
        stdout_path: materialized.stdout_path || null,
        stderr_path: materialized.stderr_path || null,
        stdout_tail: boundedTail(result.stdout),
        stderr_tail: boundedTail(result.stderr),
        completion_status: completion.status,
        completion_passed: completion.passed,
        failure_count: completion.failures.length
      });
      if (completion.passed) break;
      if (kind === "initial" && !resume) break;
    }
  }

  return {
    schema_version: HOST_SESSION_SUPERVISION_SCHEMA,
    status: completion.passed ? "passed" : "failed",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    cwd,
    session_id: sessionId,
    max_attempts: maxAttempts,
    attempt_count: attempts.length,
    continuation_count: attempts.filter((attempt) => attempt.kind === "continuation").length,
    completion_contract: completionContract,
    completion,
    attempts
  };
}

export function normalizeCompletionContract(contract = {}) {
  const source = contract && typeof contract === "object" && !Array.isArray(contract) ? contract : {};
  const validation = source.validation_contract || source.validationContract || null;
  const requiredFiles = [
    ...array(source.required_files || source.requiredFiles),
    ...array(source.required_artifacts || source.requiredArtifacts)
  ].map(String);
  const jsonValues = array(source.required_json_values || source.requiredJsonValues).map(normalizeJsonValueExpectation);
  const observedActions = array(source.required_observed_actions || source.requiredObservedActions).map(normalizeObservedActionExpectation);
  return {
    schema_version: String(source.schema_version || source.schemaVersion || HOST_COMPLETION_CONTRACT_SCHEMA),
    required_files: unique(requiredFiles),
    required_json_values: jsonValues,
    required_observed_actions: observedActions,
    validation_contract: validation && typeof validation === "object" && !Array.isArray(validation) ? validation : null
  };
}

export async function evaluateCompletionContract({ cwd = process.cwd(), contract = {} } = {}) {
  const root = resolve(String(cwd || process.cwd()));
  const failures = [];
  const warnings = [];
  const checks = [];
  const normalized = normalizeCompletionContract(contract);
  for (const file of normalized.required_files) {
    const path = safePath(root, file);
    const passed = Boolean(path && await isFile(path));
    checks.push({ type: "required_file", path: file, passed });
    if (!passed) failures.push({ type: "required_file", path: file, message: "required file is missing" });
  }
  if (normalized.validation_contract) {
    const artifactResult = await evaluateValidationContract(root, normalized.validation_contract);
    checks.push(...artifactResult.checks);
    failures.push(...artifactResult.failures);
    warnings.push(...artifactResult.warnings);
  }
  for (const expectation of normalized.required_json_values) {
    const result = await checkJsonValue(root, expectation);
    checks.push(result.check);
    if (!result.check.passed) failures.push(result.failure);
  }
  for (const expectation of normalized.required_observed_actions) {
    const result = await checkObservedAction(root, expectation);
    checks.push(result.check);
    if (!result.check.passed) failures.push(result.failure);
  }
  return {
    status: failures.length ? "failed" : "passed",
    passed: failures.length === 0,
    check_count: checks.length,
    failure_count: failures.length,
    warning_count: warnings.length,
    failures,
    warnings,
    checks
  };
}

async function evaluateValidationContract(root, contract) {
  const failures = [];
  const warnings = [];
  const checks = [];
  for (const artifact of contractArtifacts(contract)) {
    const pathValue = String(artifact.path || artifact.file || "");
    const path = safePath(root, pathValue);
    const required = artifact.required !== false;
    const present = Boolean(path && await isFile(path));
    checks.push({ type: "artifact_presence", path: pathValue, passed: present || !required });
    if (!present) {
      if (required) failures.push({ type: "artifact_presence", path: pathValue, message: "required artifact is missing" });
      continue;
    }
    const kind = String(artifact.type || inferArtifactType(pathValue));
    if (kind === "json") {
      const parsed = await readJson(path);
      checks.push({ type: "json_parse", path: pathValue, passed: !parsed.error });
      if (parsed.error) {
        failures.push({ type: "json_parse", path: pathValue, message: parsed.error });
        continue;
      }
      for (const key of array(artifact.required_keys || artifact.requiredKeys).map(String)) {
        const passed = Object.prototype.hasOwnProperty.call(parsed.value || {}, key);
        checks.push({ type: "json_required_key", path: pathValue, key, passed });
        if (!passed) failures.push({ type: "json_required_key", path: pathValue, key, message: "required JSON key is missing" });
      }
    } else if (kind === "csv") {
      const csv = await readCsv(path);
      checks.push({ type: "csv_parse", path: pathValue, passed: !csv.error });
      if (csv.error) {
        failures.push({ type: "csv_parse", path: pathValue, message: csv.error });
        continue;
      }
      const expectedColumns = array(artifact.columns).map(String);
      if (expectedColumns.length) {
        const passed = sameArray(csv.columns, expectedColumns);
        checks.push({ type: "csv_columns", path: pathValue, passed, expected: expectedColumns, actual: csv.columns });
        if (!passed) failures.push({ type: "csv_columns", path: pathValue, message: "CSV columns do not match contract" });
      }
      const rowCount = artifact.row_count ?? artifact.rowCount;
      if (rowCount !== undefined) {
        const expected = Number(rowCount);
        const passed = csv.rows.length === expected;
        checks.push({ type: "csv_row_count", path: pathValue, passed, expected, actual: csv.rows.length });
        if (!passed) failures.push({ type: "csv_row_count", path: pathValue, message: "CSV row count does not match contract" });
      }
      const minRows = artifact.min_rows ?? artifact.minRows;
      if (minRows !== undefined) {
        const expected = Number(minRows);
        const passed = csv.rows.length >= expected;
        checks.push({ type: "csv_min_rows", path: pathValue, passed, expected, actual: csv.rows.length });
        if (!passed) failures.push({ type: "csv_min_rows", path: pathValue, message: "CSV has fewer rows than contract minimum" });
      }
      const sortSpecs = array(artifact.sort || artifact.sort_order || artifact.sortOrder);
      if (sortSpecs.length) {
        const result = checkCsvSortOrder(csv.rows, sortSpecs);
        checks.push({ type: "csv_sort_order", path: pathValue, ...result.check });
        if (!result.check.passed) failures.push({ type: "csv_sort_order", path: pathValue, message: result.message });
      }
      for (const expectation of array(artifact.row_expectations || artifact.rowExpectations)) {
        const result = checkCsvRowExpectation(csv.rows, expectation);
        checks.push({ type: "csv_row_expectation", path: pathValue, ...result.check });
        if (!result.check.passed) failures.push({ type: "csv_row_expectation", path: pathValue, message: result.message });
      }
    } else if (kind === "markdown" || kind === "text") {
      const text = await readFile(path, "utf8");
      for (const needle of array(artifact.must_include || artifact.mustInclude).map(String)) {
        const passed = text.includes(needle);
        checks.push({ type: "text_must_include", path: pathValue, value: needle, passed });
        if (!passed) failures.push({ type: "text_must_include", path: pathValue, value: needle, message: "required text is missing" });
      }
      for (const needle of array(artifact.must_not_include || artifact.mustNotInclude).map(String)) {
        const passed = !text.includes(needle);
        checks.push({ type: "text_must_not_include", path: pathValue, value: needle, passed });
        if (!passed) failures.push({ type: "text_must_not_include", path: pathValue, value: needle, message: "forbidden text is present" });
      }
    }
  }
  return { failures, warnings, checks };
}

async function checkJsonValue(root, expectation) {
  const path = safePath(root, expectation.path);
  if (!path || !await isFile(path)) {
    return {
      check: { type: "json_value", path: expectation.path, pointer: expectation.pointer, passed: false },
      failure: { type: "json_value", path: expectation.path, pointer: expectation.pointer, message: "JSON artifact is missing" }
    };
  }
  const parsed = await readJson(path);
  if (parsed.error) {
    return {
      check: { type: "json_value", path: expectation.path, pointer: expectation.pointer, passed: false },
      failure: { type: "json_value", path: expectation.path, pointer: expectation.pointer, message: parsed.error }
    };
  }
  const actual = getJsonPointer(parsed.value, expectation.pointer);
  const passed = deepEqualJson(actual, expectation.equals);
  return {
    check: { type: "json_value", path: expectation.path, pointer: expectation.pointer, expected: expectation.equals, actual, passed },
    failure: { type: "json_value", path: expectation.path, pointer: expectation.pointer, message: "JSON value does not match" }
  };
}

async function checkObservedAction(root, expectation) {
  const path = safePath(root, expectation.path);
  if (!path || !await isFile(path)) {
    return {
      check: { type: "observed_action", path: expectation.path, action_type: expectation.action_type, passed: false },
      failure: { type: "observed_action", path: expectation.path, action_type: expectation.action_type, message: "audit JSON is missing" }
    };
  }
  const parsed = await readJson(path);
  const actions = Array.isArray(parsed.value?.observed_actions) ? parsed.value.observed_actions : [];
  const passed = actions.some((action) => (action?.action_type || action?.type) === expectation.action_type);
  return {
    check: { type: "observed_action", path: expectation.path, action_type: expectation.action_type, passed },
    failure: { type: "observed_action", path: expectation.path, action_type: expectation.action_type, message: "observed action is missing" }
  };
}

function normalizeCommandSpec(value, name) {
  if (Array.isArray(value)) return { argv: value.map(String) };
  if (value && typeof value === "object") {
    const argv = array(value.argv || value.command).map(String);
    if (!argv.length) throw new Error(`${name}.argv is required`);
    return {
      argv,
      stdin: value.stdin === undefined ? undefined : String(value.stdin),
      stdin_path: value.stdin_path || value.stdinPath ? String(value.stdin_path || value.stdinPath) : undefined,
      stdout_path: value.stdout_path || value.stdoutPath ? String(value.stdout_path || value.stdoutPath) : undefined,
      stderr_path: value.stderr_path || value.stderrPath ? String(value.stderr_path || value.stderrPath) : undefined
    };
  }
  throw new Error(`${name} must be an argv array or command object`);
}

function materializeCommandSpec(spec, context) {
  return {
    argv: spec.argv.map((item) => template(item, context)),
    stdin: spec.stdin === undefined ? undefined : template(spec.stdin, context),
    stdin_path: spec.stdin_path ? template(spec.stdin_path, context) : undefined,
    stdout_path: spec.stdout_path ? template(spec.stdout_path, context) : undefined,
    stderr_path: spec.stderr_path ? template(spec.stderr_path, context) : undefined
  };
}

async function runCommand(spec, { cwd, timeoutMs }) {
  let stdin = spec.stdin;
  if (spec.stdin_path) stdin = await readFile(resolve(cwd, spec.stdin_path), "utf8");
  const [bin, ...args] = spec.argv;
  const child = spawn(bin, args, {
    cwd,
    env: sanitizedSubprocessEnv(process.env),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    if (stdoutSize < OUTPUT_LIMIT) {
      stdout.push(chunk);
      stdoutSize += chunk.length;
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderrSize < OUTPUT_LIMIT) {
      stderr.push(chunk);
      stderrSize += chunk.length;
    }
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  clearTimeout(timer);
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  if (spec.stdout_path) await writeTextFile(resolve(cwd, spec.stdout_path), stdoutText);
  if (spec.stderr_path) await writeTextFile(resolve(cwd, spec.stderr_path), stderrText);
  return {
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    stdout: stdoutText,
    stderr: stderrText
  };
}

function buildContinuationPrompt({ cwd, attemptNumber, maxAttempts, sessionId, completion, completionContract }) {
  const failures = completion.failures.slice(0, 12).map((failure) => {
    const path = failure.path ? ` path=${failure.path}` : "";
    const detail = failure.key || failure.value || failure.action_type || failure.pointer || "";
    return `- ${failure.type}${path}${detail ? ` detail=${detail}` : ""}: ${failure.message}`;
  }).join("\n");
  const requiredFiles = completionContract.required_files.map((item) => `- ${item}`).join("\n");
  return [
    "Continue the same task now. This continuation was generated automatically by Across Autopilot because the host session ended before the completion contract passed.",
    `Workspace: ${cwd}`,
    sessionId ? `Session id: ${sessionId}` : null,
    `Attempt: ${attemptNumber} of ${maxAttempts}`,
    "",
    "Do not stop at a plan or task list. Execute the work, write or repair the required artifacts, start/run the Orchestrator loop if required by the task, and do not finish until the completion contract passes.",
    requiredFiles ? `Required files:\n${requiredFiles}` : null,
    failures ? `Current completion failures:\n${failures}` : null,
    "",
    "When validating with Orchestrator, pass the original validation contract and ensure the host-declared check action passes before final output."
  ].filter(Boolean).join("\n");
}

function sessionIdFromOutput(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const candidates = [
        parsed.session_id,
        parsed.sessionId,
        parsed.message?.session_id,
        parsed.result?.session_id
      ].filter(Boolean);
      if (candidates.length) return String(candidates[0]);
    } catch {
      continue;
    }
  }
  return null;
}

function contractArtifacts(contract) {
  const raw = contract?.artifacts || contract?.required_artifacts || contract?.requiredArtifacts || [];
  if (typeof raw === "string") return [{ path: raw, required: true }];
  return array(raw).map((item) => typeof item === "string" ? { path: item, required: true } : { ...item });
}

function normalizeJsonValueExpectation(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    path: String(item.path || ""),
    pointer: String(item.pointer || item.json_pointer || item.jsonPointer || ""),
    equals: item.equals
  };
}

function normalizeObservedActionExpectation(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    path: String(item.path || "outputs/workflow_audit.json"),
    action_type: String(item.action_type || item.actionType || item.type || "")
  };
}

function checkCsvSortOrder(rows, specs) {
  const order = array(specs).map(normalizeCsvSortSpec).filter((spec) => spec.field);
  if (!order.length) {
    return { check: { sort: [], passed: false }, message: "CSV sort contract does not include a field" };
  }
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (compareCsvRows(previous, current, order) > 0) {
      return {
        check: {
          sort: order,
          passed: false,
          violation: {
            previous_row: index - 1,
            current_row: index,
            previous: pickSortFields(previous, order),
            current: pickSortFields(current, order)
          }
        },
        message: `CSV is not sorted by ${describeSortOrder(order)}`
      };
    }
  }
  return { check: { sort: order, passed: true }, message: "" };
}

function normalizeCsvSortSpec(spec) {
  const item = spec && typeof spec === "object" ? spec : {};
  return {
    field: String(item.field || ""),
    direction: String(item.direction || "asc").toLowerCase() === "desc" ? "desc" : "asc",
    numeric: item.numeric === true || item.numeric === "true"
  };
}

function compareCsvRows(left, right, order) {
  for (const spec of order) {
    const comparison = compareCsvCell(left?.[spec.field], right?.[spec.field], spec.numeric);
    if (comparison !== 0) return spec.direction === "desc" ? -comparison : comparison;
  }
  return 0;
}

function compareCsvCell(left, right, numeric) {
  if (numeric) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber < rightNumber) return -1;
      if (leftNumber > rightNumber) return 1;
      return 0;
    }
  }
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function describeSortOrder(order) {
  return order.map((spec) => `${spec.field} ${spec.direction}`).join(", ");
}

function pickSortFields(row, order) {
  return Object.fromEntries(order.map((spec) => [spec.field, row?.[spec.field]]));
}

function checkCsvRowExpectation(rows, expectation) {
  const match = expectation?.match || {};
  const expect = expectation?.expect || {};
  const row = rows.find((candidate) => Object.entries(match).every(([key, value]) => String(candidate[key]) === String(value)));
  if (!row) return { check: { match, passed: false }, message: "matching CSV row not found" };
  for (const [key, value] of Object.entries(expect)) {
    if (String(row[key]) !== String(value)) {
      return { check: { match, key, expected: String(value), actual: String(row[key]), passed: false }, message: `CSV row expectation failed for ${key}` };
    }
  }
  return { check: { match, passed: true }, message: "" };
}

async function readCsv(path) {
  try {
    const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.length);
    if (!lines.length) return { columns: [], rows: [], error: null };
    const columns = parseCsvLine(lines[0]);
    const rows = [];
    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line);
      const row = {};
      columns.forEach((column, index) => {
        row[column] = values[index] ?? "";
      });
      rows.push(row);
    }
    return { columns, rows, error: null };
  } catch (error) {
    return { columns: [], rows: [], error: String(error.message || error) };
  }
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\"" && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

async function readJson(path) {
  try {
    return { value: JSON.parse(await readFile(path, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: String(error.message || error) };
  }
}

function getJsonPointer(value, pointer) {
  if (!pointer || pointer === "/") return value;
  let current = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (current && typeof current === "object") current = current[key];
    else return undefined;
  }
  return current;
}

function safePath(root, value) {
  if (!value) return null;
  const target = resolve(root, String(value));
  return target.startsWith(`${root}/`) || target === root ? target : null;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function writeTextFile(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

function template(value, context) {
  return String(value)
    .replaceAll("{cwd}", context.cwd)
    .replaceAll("{session_id}", context.session_id)
    .replaceAll("{continuation_prompt}", context.continuation_prompt);
}

function redactCommand(argv) {
  return argv.map((item) => /key|token|secret/i.test(item) ? "[redacted]" : item);
}

function inferArtifactType(path) {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".csv")) return "csv";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "markdown";
  return "text";
}

function array(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sameArray(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function deepEqualJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function boundedTail(value, limit = 4000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}
