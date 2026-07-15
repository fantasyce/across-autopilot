import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

export const SKILLS_RADAR_SCHEMA = "across-external-skills-radar/1.0";
export const TRUST_ASSESSMENT_SCHEMA = "across-trust-assessment/1.0";
export const CAPABILITY_RESOLUTION_SCHEMA = "across-capability-resolution/1.0";

const MAX_SCAN_FILES = 200;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(["", ".md", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".sh", ".bash", ".zsh", ".toml"]);

const TRUST_RULES = [
  {
    id: "prompt_override_or_hidden_instructions",
    category: "instruction_integrity",
    severity: "high",
    score: 45,
    message: "Attempts to override higher-priority instructions or conceal operative instructions.",
    patterns: [
      /\b(?:ignore|disregard|override|bypass)\b.{0,100}\b(?:(?:previous|prior|higher[- ]priority)\s+(?:system\s+)?(?:instructions?|prompts?|messages?|rules?)|(?:system|developer)\s+(?:instructions?|prompts?|messages?|rules?))\b/gi,
      /\b(?:do not|never)\b.{0,60}\b(?:reveal|disclose|mention|show)\b.{0,60}\b(?:instruction|prompt|rule|directive)\b/gi,
      /(?:display\s*:\s*none|visibility\s*:\s*hidden).{0,120}(?:instruction|prompt|tool)/gi,
      /<!--[\s\S]{0,500}\b(?:ignore|override|instruction|prompt|must obey)\b[\s\S]{0,500}?-->/gi,
      /[\u200B-\u200F\u2060\uFEFF]/g
    ]
  },
  {
    id: "secret_harvesting",
    category: "credential_safety",
    severity: "critical",
    score: 50,
    message: "Reads, collects, or searches for credentials or secret-bearing stores.",
    patterns: [
      /process\.env(?:\[['"][^'"\]]*(?:key|token|secret|password|credential)[^'"\]]*['"]\]|\.[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)/gi,
      /(?:~\/\.ssh|\.aws\/credentials|\.config\/gcloud\/credentials|login\.keychain|security\s+find-(?:generic|internet)-password)/gi,
      /\b(?:collect|harvest|extract|steal|exfiltrate|upload|send)\b.{0,80}\b(?:secret|token|password|credential|api[_ -]?key|private[_ -]?key)\b/gi
    ]
  },
  {
    id: "external_transmission",
    category: "network_boundary",
    severity: "medium",
    score: 20,
    message: "Can transmit local data to an external network destination.",
    patterns: [
      /\b(?:curl|wget)\b[^\n]*(?:https?:\/\/|--data|-d\s|--upload-file|-T\s)/gi,
      /\b(?:fetch|axios\.(?:post|put|patch)|requests\.(?:post|put|patch)|http\.request)\s*\([^\n]{0,160}https?:\/\//gi,
      /\b(?:webhook|exfiltrat|upload)\b.{0,100}https?:\/\//gi,
      /["'](?:url|endpoint|webhook)["']\s*:\s*["']https?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$))/gi
    ]
  },
  {
    id: "unsafe_shell_or_eval",
    category: "code_execution",
    severity: "high",
    score: 45,
    message: "Uses dynamic evaluation, shell execution, or destructive privileged commands.",
    patterns: [
      /(?:^|[^.\w])eval\s*\(|new\s+Function\s*\(|child_process\.(?:exec|execSync)\s*\(/gi,
      /\bshell\s*:\s*true\b|\b(?:bash|sh|zsh)\s+-c\b/gi,
      /\brm\s+-rf\s+(?:\/|~|\$HOME)\b|\bchmod\s+(?:-R\s+)?777\b|\bsudo\b/gi
    ]
  },
  {
    id: "unpinned_remote_install",
    category: "supply_chain",
    severity: "high",
    score: 40,
    message: "Installs or executes remote code without an immutable version or digest.",
    patterns: [
      /\b(?:curl|wget)\b[^\n]{0,240}(?:https?:\/\/)[^\n|;]*(?:\||;)\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/gi,
      /\b(?:pip|pip3)\s+install\s+(?:git\+|https?:\/\/)[^\s]+/gi,
      /\bnpx\s+(?:--yes|-y\s+)?(?!(?:not|command|is|was|will|can|could|should)\b)(?![^\s]+@(?:\d|sha256:))[^\s@]+(?:\s|$)/gi,
      /\bnpm\s+(?:install|i)\s+(?![^\s]+@(?:\d|sha256:))(?:--global\s+|-g\s+)?[a-z0-9@][^\s]*/gi
    ]
  },
  {
    id: "excessive_permissions",
    category: "least_privilege",
    severity: "high",
    score: 35,
    message: "Requests broad filesystem, network, execution, or host permissions.",
    patterns: [
      /\b(?:full disk access|unrestricted network|entire filesystem)\b/gi,
      /["'](?:permissions?|scopes?)["']\s*:\s*(?:["']\*["']|\[[^\]]*["']\*["'][^\]]*\])/gi,
      /["']path["']\s*:\s*["'](?:\/|~|\$HOME)["'][\s\S]{0,160}["']access["']\s*:\s*["']read-write["']/gi
    ]
  },
  {
    id: "memory_poisoning",
    category: "memory_integrity",
    severity: "high",
    score: 45,
    message: "Attempts to persist untrusted instructions or alter durable agent memory without review.",
    patterns: [
      /\b(?:write|append|inject|persist|store)\b.{0,100}\b(?:AGENTS\.md|CLAUDE\.md|MEMORY\.md|memory_summary\.md|long[- ]term memory|system prompt)\b/gi,
      /\b(?:poison|tamper|silently modify|without (?:review|approval))\b.{0,100}\b(?:memory|context|instructions?|AGENTS\.md)\b/gi
    ]
  },
  {
    id: "mcp_tool_poisoning",
    category: "tool_integrity",
    severity: "critical",
    score: 50,
    message: "Attempts to make MCP tool metadata or tool output override host policy or inject instructions.",
    patterns: [
      /\b(?:MCP|tool)\b.{0,100}\b(?:poison|spoof|override|inject|hidden instruction)\b/gi,
      /\btools\/list\b.{0,120}\b(?:override|instruction|system prompt|trusted)\b/gi,
      /\btool (?:output|result|description)\b.{0,100}\b(?:must be obeyed|override|higher priority|system instruction)\b/gi
    ]
  }
];

export async function discoverExternalSkills(options = {}) {
  const roots = normalizeRoots(options.roots || options.root || defaultSkillRoots());
  const sources = [];
  for (const root of roots) sources.push(await scanSkillRoot(root, options));
  const skills = sources.flatMap((source) => source.skills.map((skill) => ({ ...skill, source_id: source.id })));
  return {
    schema_version: SKILLS_RADAR_SCHEMA,
    status: "passed",
    roots,
    sources,
    skills,
    summary: {
      source_count: sources.length,
      skill_count: skills.length,
      trusted_skill_count: skills.filter((skill) => skill.trust_assessment?.recommendation === "allow").length,
      review_skill_count: skills.filter((skill) => skill.trust_assessment?.recommendation === "review").length,
      blocked_skill_count: skills.filter((skill) => skill.trust_assessment?.recommendation === "block").length,
      codex_auto_discovery: roots.some((root) => root.endsWith("/.codex/skills")),
      raw_skill_bodies_included: false,
      secrets_included: false
    }
  };
}

export async function assessCapabilityTrust(input, options = {}) {
  if (typeof input === "string") {
    const path = resolve(String(input).replace(/^~/, homedir()));
    const info = await lstat(path);
    if (info.isDirectory()) return assessSkillDirectory(path, options);
    const text = await readFile(path, "utf8");
    if (extname(path).toLowerCase() === ".json") {
      return assessPluginManifest(JSON.parse(text), { ...options, sourceName: basename(path) });
    }
    return buildTrustAssessment("file", basename(path), scanRecords([{ path: basename(path), text }]), {}, normalizeProvenance(options.provenance));
  }
  return assessPluginManifest(input, options);
}

export async function assessSkillDirectory(path, options = {}) {
  const root = resolve(path);
  const records = await readTextRecords(root, options);
  return buildTrustAssessment("skill_directory", basename(root), scanRecords(records), {
    files_scanned: records.length,
    scan_truncated: records.truncated === true
  }, normalizeProvenance(options.provenance || inferSkillProvenance(root, options)));
}

export function assessPluginManifest(manifest, options = {}) {
  const normalized = manifest && typeof manifest === "object" ? manifest : {};
  const id = cleanId(normalized.plugin_id || normalized.id || normalized.name || options.sourceName || "plugin-manifest");
  const text = safeManifestText(normalized);
  return buildTrustAssessment("plugin_manifest", id, scanRecords([{ path: options.sourceName || "manifest", text }]), {
    files_scanned: 1,
    scan_truncated: false
  }, normalizeProvenance(options.provenance));
}

export function resolveCapabilities(input = {}) {
  const requirements = normalizeRequirements(input.workflow_requirements || input.requirements || []);
  const providers = normalizeProviders(input.available_manifests || input.manifests || input.available_capabilities || input.available || []);
  const plan = [];
  const decisions = [];
  const rejected = [];

  for (const requirement of requirements) {
    const candidates = [];
    for (const provider of providers) {
      const capability = provider.capabilities.find((item) => capabilityMatches(requirement, item));
      if (!capability) continue;
      const reasons = unsafeReasons(provider, capability, requirement);
      if (reasons.length > 0) {
        rejected.push({ requirement_id: requirement.id, provider_id: provider.id, capability_id: capability.id, reasons });
        continue;
      }
      candidates.push({
        provider,
        capability,
        rank: provider.risk_score * 1000 + capability.risk_score * 100 + provider.cost_score * 10 + capability.cost_score
      });
    }

    if (candidates.length === 0) {
      if (requirement.required) {
        decisions.push({
          requirement_id: requirement.id,
          type: "blocked",
          reason: "no_safe_capability",
          message: "No healthy, trusted capability satisfies this required workflow requirement."
        });
      }
      continue;
    }

    candidates.sort((left, right) => left.rank - right.rank || left.provider.id.localeCompare(right.provider.id) || left.capability.id.localeCompare(right.capability.id));
    const best = candidates[0];
    const tied = candidates.filter((candidate) => candidate.rank === best.rank);
    if (tied.length > 1) {
      decisions.push({
        requirement_id: requirement.id,
        type: "ambiguous",
        reason: "equally_safe_choices",
        message: "Multiple equally safe capabilities require an explicit choice.",
        options: tied.map((candidate) => ({ provider_id: candidate.provider.id, capability_id: candidate.capability.id }))
      });
      continue;
    }

    plan.push({
      requirement_id: requirement.id,
      provider_id: best.provider.id,
      capability_id: best.capability.id,
      entrypoint: best.capability.entrypoint || best.provider.entrypoint || null,
      automatic: true
    });
  }

  const blocked = decisions.some((item) => item.type === "blocked");
  const ambiguous = decisions.some((item) => item.type === "ambiguous");
  return {
    schema_version: CAPABILITY_RESOLUTION_SCHEMA,
    status: blocked ? "blocked" : ambiguous ? "decision_required" : "passed",
    mode: decisions.length > 0 ? "explicit_decision_required" : "automatic",
    zero_configuration: decisions.length === 0,
    requirements,
    plan,
    selected_provider_ids: [...new Set(plan.map((item) => item.provider_id))],
    decision_requirements: decisions,
    rejected_candidates: rejected,
    summary: {
      requirement_count: requirements.length,
      planned_count: plan.length,
      decision_count: decisions.length,
      secrets_included: false
    }
  };
}

export function defaultSkillRoots(env = process.env) {
  const roots = [];
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  roots.push(join(codexHome, "skills"));
  roots.push(join(homedir(), ".claude", "skills"));
  roots.push(join(homedir(), ".qwen", "skills"));
  return roots;
}

function normalizeRoots(value) {
  const roots = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(roots.map((root) => resolve(String(root || "").replace(/^~/, homedir()))).filter(Boolean))];
}

async function scanSkillRoot(root, options = {}) {
  const source = { id: sourceId(root), root, status: "missing", skills: [] };
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) return source;
    source.status = "passed";
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(root, entry.name);
      const markdownPath = join(skillPath, "SKILL.md");
      try {
        const [text, trustAssessment] = await Promise.all([
          readFile(markdownPath, "utf8"),
          assessSkillDirectory(skillPath, { ...options, provenance: inferSkillProvenance(skillPath, options) })
        ]);
        source.skills.push(summarizeSkill(entry.name, markdownPath, text, trustAssessment));
      } catch {
        source.skills.push({ id: entry.name, name: entry.name, path: skillPath, status: "missing_skill_md", summary: "" });
      }
    }
  } catch {
    return source;
  }
  return source;
}

function summarizeSkill(id, path, text, trustAssessment) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = (lines.find((line) => line.startsWith("# ")) || "").replace(/^#\s+/, "") || id;
  const summary = redact(lines.find((line) => !line.startsWith("#") && !line.startsWith("-")) || "");
  return {
    id,
    name: title,
    path,
    status: "passed",
    summary: summary.slice(0, 240),
    format: "agentskills.io-compatible-directory",
    exports: ["SKILL.md"],
    trust_assessment: trustAssessment
  };
}

async function readTextRecords(root, options) {
  const records = [];
  let totalBytes = 0;
  let truncated = false;
  const maxFiles = Number(options.maxFiles || MAX_SCAN_FILES);
  const maxBytes = Number(options.maxBytes || MAX_SCAN_BYTES);

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (records.length >= maxFiles || totalBytes >= maxBytes) {
        truncated = true;
        return;
      }
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let text;
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const remaining = maxBytes - totalBytes;
      const bounded = text.slice(0, Math.max(0, remaining));
      totalBytes += Buffer.byteLength(bounded);
      records.push({ path: relative(root, path), text: bounded });
      if (bounded.length < text.length) truncated = true;
    }
  }

  await visit(root);
  records.truncated = truncated;
  return records;
}

function scanRecords(records) {
  const findings = [];
  for (const rule of TRUST_RULES) {
    const locations = [];
    const contextCounts = {};
    let matchCount = 0;
    for (const record of records) {
      for (const pattern of rule.patterns) {
        pattern.lastIndex = 0;
        for (const match of record.text.matchAll(pattern)) {
          matchCount += 1;
          const context = matchContext(record, match.index || 0);
          contextCounts[context] = (contextCounts[context] || 0) + 1;
          if (locations.length < 5) locations.push({ path: record.path, line: lineNumber(record.text, match.index || 0), context });
        }
      }
    }
    if (matchCount > 0) {
      const activeMatchCount = ["executable", "active_configuration", "skill_instruction"].reduce((sum, context) => sum + (contextCounts[context] || 0), 0);
      const effectiveRiskScore = activeMatchCount > 0 ? rule.score : Math.min(15, Math.max(5, Math.round(rule.score * 0.2)));
      findings.push({
        rule_id: rule.id,
        category: rule.category,
        severity: rule.severity,
        confidence: activeMatchCount > 0 ? "high" : "low",
        risk_score: effectiveRiskScore,
        base_risk_score: rule.score,
        message: rule.message,
        match_count: matchCount,
        active_match_count: activeMatchCount,
        evidence_match_count: matchCount - activeMatchCount,
        contexts: contextCounts,
        locations
      });
    }
  }
  return findings;
}

function buildTrustAssessment(targetType, targetId, findings, scan = {}, provenance = normalizeProvenance()) {
  const riskScore = Math.min(100, findings.reduce((sum, finding) => sum + finding.risk_score, 0));
  const severity = riskScore >= 75 ? "critical" : riskScore >= 40 ? "high" : riskScore >= 20 ? "medium" : riskScore > 0 ? "low" : "none";
  const activeStrongFindings = findings.filter((finding) => finding.active_match_count > 0 && ["high", "critical"].includes(finding.severity));
  const criticalActiveFinding = activeStrongFindings.some((finding) => finding.severity === "critical");
  const evidenceOnly = findings.length > 0 && findings.every((finding) => finding.active_match_count === 0);
  const recommendation = criticalActiveFinding || activeStrongFindings.length >= 2
    ? "block"
    : riskScore === 0 || (evidenceOnly && provenance.trusted)
      ? "allow"
      : "review";
  const recommendationReasons = recommendation === "block"
    ? [criticalActiveFinding ? "critical_active_behavior" : "multiple_strong_active_signals"]
    : recommendation === "allow" && evidenceOnly && findings.length > 0
      ? ["trusted_provenance", "documentation_or_example_evidence_only"]
      : recommendation === "review"
        ? [evidenceOnly ? "unverified_documentation_evidence" : "active_signal_requires_review"]
        : ["no_indicators_detected"];
  return {
    schema_version: TRUST_ASSESSMENT_SCHEMA,
    assessment_type: "static",
    target: { type: targetType, id: cleanId(targetId) },
    status: "completed",
    risk_score: riskScore,
    severity,
    recommendation,
    recommendation_reasons: recommendationReasons,
    findings,
    provenance,
    scan: {
      files_scanned: scan.files_scanned ?? 1,
      scan_truncated: scan.scan_truncated === true,
      raw_content_included: false,
      secrets_included: false
    }
  };
}

function matchContext(record, index) {
  if (record.context) return record.context;
  const path = String(record.path || "");
  const extension = extname(path).toLowerCase();
  if (/(?:^|\/)(?:tests?|__tests__|fixtures?|examples?)(?:\/|$)/i.test(path)) return "test_or_fixture";
  if (extension === ".md" || extension === ".mdx") {
    if (insideMarkdownFence(record.text, index) || insideMarkdownInlineCode(record.text, index)) return "code_example";
    return basename(path).toLowerCase() === "skill.md" ? "skill_instruction" : "documentation";
  }
  if (/(?:^|\/)references?(?:\/|$)/i.test(path) || [".txt", ".rst"].includes(extension)) return "documentation";
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".sh", ".bash", ".zsh"].includes(extension)) return "executable";
  return "active_configuration";
}

function insideMarkdownFence(text, index) {
  const prefix = text.slice(0, index);
  const fences = prefix.match(/^\s*```/gm) || [];
  return fences.length % 2 === 1;
}

function insideMarkdownInlineCode(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const lineEndIndex = text.indexOf("\n", index);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const before = text.slice(lineStart, index);
  const after = text.slice(index, lineEnd);
  return (before.match(/`/g) || []).length % 2 === 1 && after.includes("`");
}

function inferSkillProvenance(path, options = {}) {
  if (options.trustedProvenance === true) return { source: "caller_trusted", trusted: true };
  if (options.trustedProvenance === false) return { source: "caller_unverified", trusted: false };
  const resolved = resolve(path);
  const localRoots = [join(homedir(), ".codex", "skills"), join(homedir(), ".claude", "skills"), join(homedir(), ".qwen", "skills")].map((root) => resolve(root));
  if (localRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) return { source: "local_installed_skill", trusted: true };
  if (resolved.includes("/.codex/plugins/cache/openai-")) return { source: "first_party_plugin_cache", trusted: true };
  return { source: "unverified_path", trusted: false };
}

function normalizeProvenance(value = {}) {
  if (value === true) return { source: "caller_trusted", trusted: true };
  if (!value || typeof value !== "object") return { source: "unverified", trusted: false };
  return { source: cleanId(value.source || "unverified"), trusted: value.trusted === true };
}

function safeManifestText(value) {
  const seen = new WeakSet();
  const serialized = JSON.stringify(value, (key, item) => {
    if (/(?:secret|token|password|credential|api[_-]?key|private[_-]?key)/i.test(key)) return "[redacted]";
    if (["command", "args", "argv"].includes(key) && Array.isArray(item)) return item.map((part) => redact(String(part))).join(" ");
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[circular]";
      seen.add(item);
    }
    return typeof item === "string" ? redact(item) : item;
  }, 2) || "{}";
  return serialized.replace(/\\n/g, "\n");
}

function normalizeRequirements(value) {
  const items = Array.isArray(value) ? value : [value];
  return items.filter(Boolean).map((item, index) => {
    if (typeof item === "string") return { id: cleanId(item), required: true, kind: null, max_risk_score: 19 };
    return {
      id: cleanId(item.id || item.capability || item.name || `requirement-${index + 1}`),
      required: item.required !== false,
      kind: item.kind || null,
      max_risk_score: numericHint(item.max_risk_score ?? item.maxRiskScore, 19)
    };
  });
}

function normalizeProviders(value) {
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item) => item && typeof item === "object").map((item, index) => {
    const id = cleanId(item.plugin_id || item.provider_id || item.id || item.name || `provider-${index + 1}`);
    const capabilities = normalizeCapabilities(item.capabilities || item.capability, item);
    return {
      id,
      capabilities,
      health: normalizeHealth(item.health ?? item.status ?? item.available),
      trust: normalizeTrust(item.trust_assessment || item.trust),
      risk_score: riskHint(item.risk_score ?? item.risk ?? item.risk_hint),
      cost_score: costHint(item.cost_score ?? item.cost ?? item.cost_hint),
      entrypoint: sanitizeEntrypoint(item.entrypoint || item.entrypoints?.run || null)
    };
  });
}

function normalizeCapabilities(value, provider) {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => normalizeCapability(item, provider));
  if (typeof value === "string") return [normalizeCapability(value, provider)];
  if (value && typeof value === "object") {
    return Object.entries(value).filter(([, enabled]) => enabled !== false && enabled != null).map(([id, item]) => normalizeCapability(typeof item === "object" ? { id, ...item } : id, provider));
  }
  if (provider.capability_id) return [normalizeCapability({ id: provider.capability_id, ...provider }, provider)];
  return [];
}

function normalizeCapability(item, provider) {
  if (typeof item === "string") return { id: cleanId(item), kind: null, risk_score: 0, cost_score: 0, entrypoint: null };
  return {
    id: cleanId(item.id || item.capability || item.name),
    kind: item.kind || null,
    risk_score: riskHint(item.risk_score ?? item.risk ?? item.risk_hint),
    cost_score: costHint(item.cost_score ?? item.cost ?? item.cost_hint),
    entrypoint: sanitizeEntrypoint(item.entrypoint || item.command || provider.entrypoints?.[item.id] || null)
  };
}

function normalizeHealth(value) {
  if (value === true) return "healthy";
  if (value === false || value == null) return value === false ? "unhealthy" : "unknown";
  if (typeof value === "object") {
    if (value.healthy === true || value.available === true) return "healthy";
    if (value.healthy === false || value.available === false) return "unhealthy";
  }
  const status = String(value.status || value.state || value).toLowerCase();
  return ["healthy", "passed", "ok", "available", "ready"].includes(status) ? "healthy" : ["failed", "unhealthy", "offline", "unavailable", "blocked"].includes(status) ? "unhealthy" : "unknown";
}

function normalizeTrust(value) {
  if (!value) return { recommendation: "unknown", risk_score: 100 };
  if (value === true) return { recommendation: "allow", risk_score: 0 };
  if (value === false) return { recommendation: "block", risk_score: 100 };
  if (value.assessment && typeof value.assessment === "object") return normalizeTrust(value.assessment);
  const recommendation = String(value.recommendation || value.status || value.level || "unknown").toLowerCase();
  const normalized = ["allow", "trusted", "verified", "passed"].includes(recommendation) ? "allow" : ["block", "blocked", "untrusted", "failed"].includes(recommendation) ? "block" : recommendation === "review" ? "review" : "unknown";
  return { recommendation: normalized, risk_score: numericHint(value.risk_score, normalized === "allow" ? 0 : 100) };
}

function unsafeReasons(provider, capability, requirement) {
  const reasons = [];
  if (provider.health !== "healthy") reasons.push(provider.health === "unhealthy" ? "provider_unhealthy" : "provider_health_unknown");
  if (provider.trust.recommendation !== "allow") reasons.push(provider.trust.recommendation === "block" ? "trust_blocked" : "trust_not_approved");
  if (provider.trust.risk_score > requirement.max_risk_score || provider.risk_score > requirement.max_risk_score || capability.risk_score > requirement.max_risk_score) reasons.push("risk_exceeds_requirement");
  return [...new Set(reasons)];
}

function capabilityMatches(requirement, capability) {
  return requirement.id === capability.id && (!requirement.kind || !capability.kind || requirement.kind === capability.kind);
}

function riskHint(value) {
  if (typeof value === "number") return Math.max(0, Math.min(100, value));
  const levels = { none: 0, low: 10, medium: 35, high: 70, critical: 100 };
  return levels[String(value || "none").toLowerCase()] ?? 0;
}

function costHint(value) {
  if (typeof value === "number") return Math.max(0, value);
  const levels = { free: 0, low: 1, medium: 5, high: 10 };
  return levels[String(value || "free").toLowerCase()] ?? 0;
}

function numericHint(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeEntrypoint(value) {
  if (!value) return null;
  if (typeof value === "string") return { type: "named" };
  if (Array.isArray(value)) return { type: "command" };
  if (typeof value === "object") {
    return {
      type: Array.isArray(value.command) ? "command" : value.url ? "url" : "entrypoint",
      transport: value.transport || null,
    };
  }
  return null;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function redact(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{16,}/g, "[redacted]")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]");
}

function cleanId(value) {
  return redact(String(value || "unknown")).slice(0, 200);
}

function sourceId(root) {
  if (root.includes(".codex/skills")) return "codex-skills";
  if (root.includes(".claude/skills")) return "claude-code-skills";
  if (root.includes(".qwen/skills")) return "qwen-code-skills";
  return basename(root) || "skills";
}
