import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

export const SKILLS_RADAR_SCHEMA = "across-external-skills-radar/1.0";

export async function discoverExternalSkills(options = {}) {
  const roots = normalizeRoots(options.roots || options.root || defaultSkillRoots());
  const sources = [];
  for (const root of roots) {
    sources.push(await scanSkillRoot(root));
  }
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
      codex_auto_discovery: roots.some((root) => root.endsWith("/.codex/skills")),
      raw_skill_bodies_included: false,
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

async function scanSkillRoot(root) {
  const source = {
    id: sourceId(root),
    root,
    status: "missing",
    skills: []
  };
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return source;
    source.status = "passed";
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(root, entry.name);
      const markdownPath = join(skillPath, "SKILL.md");
      try {
        const text = await readFile(markdownPath, "utf8");
        source.skills.push(summarizeSkill(entry.name, markdownPath, text));
      } catch {
        source.skills.push({
          id: entry.name,
          name: entry.name,
          path: skillPath,
          status: "missing_skill_md",
          summary: ""
        });
      }
    }
  } catch {
    return source;
  }
  return source;
}

function summarizeSkill(id, path, text) {
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
    exports: ["SKILL.md"]
  };
}

function redact(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{16,}/g, "[redacted]");
}

function sourceId(root) {
  if (root.includes(".codex/skills")) return "codex-skills";
  if (root.includes(".claude/skills")) return "claude-code-skills";
  if (root.includes(".qwen/skills")) return "qwen-code-skills";
  return basename(root) || "skills";
}
