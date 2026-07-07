import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FAILURE_CODES } from "./failures.js";
import { ecosystemBinDir } from "./paths.js";

const COMMAND_ARG_LIMIT = 180;
const DIAGNOSTIC_TEXT_LIMIT = 4000;
const MODEL_SECRET_ENV_NAMES = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
  "BAILIAN_API_KEY",
  "MOONSHOT_API_KEY",
  "ZHIPU_API_KEY",
  "VOLCENGINE_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "COHERE_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY"
]);

export function parseCommand(value, fallback) {
  if (!value) return Array.isArray(fallback) ? fallback : [fallback];
  const trimmed = String(value).trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return shellWords(trimmed);
}

export async function runJsonCommand(command, args = [], options = {}) {
  const [bin, ...prefix] = resolveCommand(command, command, options.env || process.env);
  const finalArgs = [...prefix, ...args];
  const env = sanitizedSubprocessEnv(options.env || process.env);
  const commandSummary = commandForDiagnostics(bin, finalArgs);
  try {
    const { stdout, stderr } = await runCommandWithActivityTimeout(bin, finalArgs, {
      env,
      cwd: options.cwd || process.cwd(),
      timeoutMs: options.timeoutMs || 60_000,
      idleTimeoutMs: options.idleTimeoutMs || options.timeout_policy?.idle_timeout_ms,
      maxWallTimeoutMs: options.maxWallTimeoutMs || options.timeout_policy?.max_wall_timeout_ms,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024
    });
    const text = stdout.trim();
    return text ? parseJsonCommandOutput(text, { commandSummary, stderr }) : {};
  } catch (error) {
    throw enrichCommandError(error, { commandSummary });
  }
}

function runCommandWithActivityTimeout(bin, args, options = {}) {
  const maxBuffer = Number(options.maxBuffer || 10 * 1024 * 1024);
  const fallbackTimeoutMs = Number(options.timeoutMs || 60_000);
  const maxWallTimeoutMs = positiveNumber(options.maxWallTimeoutMs, fallbackTimeoutMs);
  const idleTimeoutMs = positiveNumber(options.idleTimeoutMs, fallbackTimeoutMs);
  return new Promise((resolvePromise, rejectPromise) => {
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeoutKind = null;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    const child = spawn(bin, args, {
      env: options.env || process.env,
      cwd: options.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const killForTimeout = (kind) => {
      if (timeoutKind || settled) return;
      timeoutKind = kind;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
    };
    const timer = setInterval(() => {
      const now = Date.now();
      if (maxWallTimeoutMs > 0 && now - startedAt > maxWallTimeoutMs) {
        killForTimeout("max_wall_timeout");
      } else if (idleTimeoutMs > 0 && now - lastActivityAt > idleTimeoutMs) {
        killForTimeout("idle_timeout");
      }
    }, 250);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      lastActivityAt = Date.now();
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      lastActivityAt = Date.now();
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderr.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (timeoutKind) {
        const timeoutMs = timeoutKind === "idle_timeout" ? idleTimeoutMs : maxWallTimeoutMs;
        const error = new Error(`Command ${timeoutKind} after ${timeoutMs}ms`);
        error.code = "ETIMEDOUT";
        error.timeout_kind = timeoutKind;
        error.timeout_ms = timeoutMs;
        error.signal = signal || "SIGTERM";
        error.stdout = stdoutText;
        error.stderr = stderrText;
        finish(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(`${bin} exited with ${code ?? signal}`);
        error.code = code;
        error.signal = signal;
        error.stdout = stdoutText;
        error.stderr = stderrText;
        finish(error);
        return;
      }
      finish(null, { stdout: stdoutText, stderr: stderrText });
    });
  });
}

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Number(fallback || 0);
}

function parseJsonCommandOutput(text, { commandSummary, stderr = "" }) {
  try {
    return JSON.parse(text);
  } catch (error) {
    error.code = FAILURE_CODES.ADAPTER_INVALID_OUTPUT;
    error.command = commandSummary;
    error.stdout = bounded(text);
    error.stderr = bounded(stderr);
    error.message = `Command returned invalid JSON. command=${commandSummary}; stdout=${bounded(text)}`;
    error.caused_by = [{
      type: "command_output",
      command: commandSummary,
      stdout: bounded(text),
      stderr: bounded(stderr)
    }];
    throw error;
  }
}

function enrichCommandError(error, { commandSummary }) {
  const exitCode = error?.code;
  const timedOut = Boolean(error?.killed || error?.signal === "SIGTERM" || /timed out/i.test(String(error?.message || "")));
  const structured = parseMaybeJson(error?.stdout);
  const stdout = bounded(error?.stdout || "");
  const stderr = bounded(error?.stderr || "");
  const structuredMessage = structured
    ? structured.error || structured.detail || structured.message || structured.status || null
    : null;
  const base = timedOut
    ? "Command timed out"
    : structuredMessage
      ? `Command failed with structured error: ${structuredMessage}`
      : "Command failed";

  error.exit_code = typeof exitCode === "number" ? exitCode : null;
  error.signal = error?.signal || null;
  error.timeout_kind = error?.timeout_kind || null;
  error.timeout_ms = error?.timeout_ms || null;
  error.command = commandSummary;
  error.stdout = stdout;
  error.stderr = stderr;
  error.code = timedOut ? FAILURE_CODES.ADAPTER_TIMEOUT : FAILURE_CODES.ADAPTER_INVALID_OUTPUT;
  error.message = [
    base,
    `command=${commandSummary}`,
    error.exit_code !== null ? `exit_code=${error.exit_code}` : null,
    error.signal ? `signal=${error.signal}` : null,
    error.timeout_kind ? `timeout_kind=${error.timeout_kind}` : null,
    error.timeout_ms ? `timeout_ms=${error.timeout_ms}` : null,
    stderr ? `stderr=${stderr}` : null,
    stdout ? `stdout=${stdout}` : null
  ].filter(Boolean).join("; ");
  error.caused_by = [{
    type: "command",
    command: commandSummary,
    exit_code: error.exit_code,
    signal: error.signal,
    timeout_kind: error.timeout_kind,
    timeout_ms: error.timeout_ms,
    stdout,
    stderr,
    structured_output: structured || null
  }];
  return error;
}

export function resolveCommand(value, fallback, env = process.env) {
  const parsed = Array.isArray(value) ? value : parseCommand(value, fallback);
  const [bin, ...prefix] = parsed;
  if (!bin || bin.includes("/")) return parsed;

  const ecosystemCommand = join(ecosystemBinDir(env), bin);
  if (existsSync(ecosystemCommand)) {
    return [ecosystemCommand, ...prefix];
  }
  return parsed;
}

export function sanitizedSubprocessEnv(source = process.env) {
  const contaminated = Object.entries(source).some(([key, value]) => {
    const text = String(value || "");
    return key.startsWith("_PYI")
      || key.startsWith("PYINSTALLER_")
      || key.startsWith("_MEIPASS")
      || text.includes(".app/Contents/Resources/backend")
      || text.includes("/_MEI");
  });
  const env = contaminated ? minimalSubprocessEnv(source) : { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith("_PYI") || key.startsWith("PYINSTALLER_") || key.startsWith("_MEIPASS")) {
      delete env[key];
    } else if (key.startsWith("PYTHON")) {
      delete env[key];
    }
  }
  delete env.__PYVENV_LAUNCHER__;
  delete env.VIRTUAL_ENV;
  for (const key of ["DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "LD_LIBRARY_PATH"]) delete env[key];
  if (source.ACROSS_AAA_HOST_PYTHONPATH) {
    env.PYTHONPATH = source.ACROSS_AAA_HOST_PYTHONPATH;
  }
  for (const key of MODEL_SECRET_ENV_NAMES) {
    delete env[key];
  }
  return env;
}

function minimalSubprocessEnv(source) {
  const allowedExact = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]);
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowedExact.has(key) || key.startsWith("LC_") || key.startsWith("ACROSS_")) {
      env[key] = value;
    }
  }
  env.PATH ||= "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}

function commandForDiagnostics(bin, args) {
  return [bin, ...args].map((part) => {
    const text = String(part);
    if (text.length <= COMMAND_ARG_LIMIT) return shellQuote(text);
    return shellQuote(`${text.slice(0, COMMAND_ARG_LIMIT)}...[truncated ${text.length - COMMAND_ARG_LIMIT} chars]`);
  }).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bounded(value, limit = DIAGNOSTIC_TEXT_LIMIT) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function parseMaybeJson(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shellWords(value) {
  const words = [];
  let current = "";
  let quote = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}
