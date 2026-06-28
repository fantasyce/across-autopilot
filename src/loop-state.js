import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { componentDataHome } from "./paths.js";
import { stableJson, sortJson, asArray } from "./json-utils.js";
import { listToolPacks, toolPackIdsForTarget } from "./tool-packs.js";

export const LOOP_STATE_SCHEMA = "across-autopilot-loop-state/1.0";

export const AAA_PRODUCT_CONTEXT_FILES = Object.freeze([
  "README.md",
  "AGENTS.md",
  "across.product.json"
]);

export const CONFORMANCE_TARGET_BLUEPRINTS = Object.freeze([
  {
    id: "tool_pack_policy",
    summary: "Add a helper that evaluates whether autonomous work used stable Tool Packs instead of ad-hoc scripts.",
    keywords: ["tool", "tools", "mcp", "skill", "workflow", "script", "capability", "adapter", "plugin"],
    target_repo: "across-agents-assistant",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_tool_pack_policy.py",
      "backend/tests/test_autopilot_tool_pack_policy.py"
    ],
    context_files: [...AAA_PRODUCT_CONTEXT_FILES],
    validation_commands: [
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: ["-m", "py_compile", "backend/src/across_agents_assistant/autopilot_tool_pack_policy.py", "backend/tests/test_autopilot_tool_pack_policy.py"],
        timeout_ms: 30000
      },
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: [
          "-c",
          "import sys, runpy; sys.path.insert(0, 'backend/src'); ns=runpy.run_path('backend/tests/test_autopilot_tool_pack_policy.py'); tests=[v for k,v in ns.items() if k.startswith('test_') and callable(v)]; assert tests, 'no test functions found'; [test() for test in tests]"
        ],
        timeout_ms: 30000
      },
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: [
          "-c",
          "import sys; sys.path.insert(0, 'backend/src'); from across_agents_assistant.autopilot_tool_pack_policy import evaluate_tool_pack_candidate; result=evaluate_tool_pack_candidate({'tool_packs':['git_repo_inspection','validation_harness'], 'ad_hoc_scripts': []}); assert result['recommendation'] in {'implement','review'}; assert result['tool_pack_count'] == 2"
        ],
        timeout_ms: 30000
      }
    ],
    semantic_review: {
      require_model_backed: true,
      require_selected_target_change: true,
      forbidden_changed_path_patterns: [
        "loop_engineering_candidate.py",
        "test_loop_engineering_candidate.py"
      ],
      reject_self_proof_only: true,
      minimum_validation_commands: 3,
      required_summary_keywords: ["tool", "pack"],
      independent_reviewer_required: true
    },
    risk: "low"
  },
  {
    id: "loop_contract_policy",
    summary: "Add a helper that summarizes Loop Contract, artifact, backlog, and timeline readiness.",
    keywords: ["contract", "artifact", "artifacts", "timeline", "backlog", "memory", "log", "state"],
    target_repo: "across-agents-assistant",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_loop_contract_policy.py",
      "backend/tests/test_autopilot_loop_contract_policy.py"
    ],
    context_files: [...AAA_PRODUCT_CONTEXT_FILES],
    validation_commands: [
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: ["-m", "py_compile", "backend/src/across_agents_assistant/autopilot_loop_contract_policy.py", "backend/tests/test_autopilot_loop_contract_policy.py"],
        timeout_ms: 30000
      },
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: [
          "-c",
          "import sys, runpy; sys.path.insert(0, 'backend/src'); ns=runpy.run_path('backend/tests/test_autopilot_loop_contract_policy.py'); tests=[v for k,v in ns.items() if k.startswith('test_') and callable(v)]; assert tests, 'no test functions found'; [test() for test in tests]"
        ],
        timeout_ms: 30000
      },
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: [
          "-c",
          "import sys; sys.path.insert(0, 'backend/src'); from across_agents_assistant.autopilot_loop_contract_policy import summarize_loop_contract_state; result=summarize_loop_contract_state({'artifacts':[{}], 'backlog':[{}], 'timeline':[{}]}); assert result['status'] == 'ready'"
        ],
        timeout_ms: 30000
      }
    ],
    semantic_review: {
      require_model_backed: true,
      require_selected_target_change: true,
      forbidden_changed_path_patterns: [
        "loop_engineering_candidate.py",
        "test_loop_engineering_candidate.py"
      ],
      reject_self_proof_only: true,
      minimum_validation_commands: 3,
      required_summary_keywords: ["contract", "state"],
      independent_reviewer_required: true
    },
    risk: "low"
  },
  {
    id: "independent_reviewer_policy",
    summary: "Add a helper that checks builder/reviewer separation before promotion review.",
    keywords: ["review", "reviewer", "verify", "verification", "gate", "quality", "acceptance", "promotion"],
    target_repo: "across-agents-assistant",
    allowed_patch_paths: [
      "backend/src/across_agents_assistant/autopilot_reviewer_policy.py",
      "backend/tests/test_autopilot_reviewer_policy.py"
    ],
    context_files: [...AAA_PRODUCT_CONTEXT_FILES],
    validation_commands: [
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: ["-m", "py_compile", "backend/src/across_agents_assistant/autopilot_reviewer_policy.py", "backend/tests/test_autopilot_reviewer_policy.py"],
        timeout_ms: 30000
      },
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: [
          "-c",
          "import sys, runpy; sys.path.insert(0, 'backend/src'); ns=runpy.run_path('backend/tests/test_autopilot_reviewer_policy.py'); tests=[v for k,v in ns.items() if k.startswith('test_') and callable(v)]; assert tests, 'no test functions found'; [test() for test in tests]"
        ],
        timeout_ms: 30000
      },
      {
        repo: "across-agents-assistant",
        command: "python3",
        args: [
          "-c",
          "import sys; sys.path.insert(0, 'backend/src'); from across_agents_assistant.autopilot_reviewer_policy import review_builder_candidate; result=review_builder_candidate({'builder_role':'loop_engineer','reviewer_role':'independent_reviewer','changed_files':['x'], 'validation_status':'passed'}); assert result['recommendation'] == 'review'"
        ],
        timeout_ms: 30000
      }
    ],
    semantic_review: {
      require_model_backed: true,
      require_selected_target_change: true,
      forbidden_changed_path_patterns: [
        "loop_engineering_candidate.py",
        "test_loop_engineering_candidate.py"
      ],
      reject_self_proof_only: true,
      minimum_validation_commands: 3,
      required_summary_keywords: ["reviewer", "builder"],
      independent_reviewer_required: true
    },
    risk: "low"
  }
]);

export function stateRoot(env = process.env) {
  return join(componentDataHome("across-autopilot", env), "loop-state");
}

export async function prepareAutonomousLoopState({ spec, run, sources = [], recalledMemory = [], env = process.env }) {
  const root = stateRoot(env);
  const specId = safeSegment(spec.id);
  const artifactsDir = join(root, "artifacts", specId);
  const contractsDir = join(root, "contracts", specId);
  const logsDir = join(root, "logs");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(contractsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  const recentGlobalTimeline = await readJsonl(join(logsDir, "global-timeline.jsonl"), 10);
  const recentLoopTimeline = await readJsonl(join(contractsDir, "timeline.jsonl"), 20);
  const sourceSignals = buildSourceSignals(sources);
  const contract = buildContract({ spec, run, sourceSignals, recalledMemory, recentGlobalTimeline, recentLoopTimeline });
  const seedTargets = seedTargetCatalog(spec);
  const backlog = rankBacklog({
    spec,
    sourceSignals,
    recalledMemory,
    recentGlobalTimeline,
    previousBacklog: await readOptionalJson(join(contractsDir, "backlog.json"), []),
    seedTargets
  });
  const artifact = {
    schema_version: "across-autopilot-source-signals/1.0",
    spec_id: spec.id,
    run_id: run.run_id,
    generated_at: new Date().toISOString(),
    source_count: sources.length,
    signals: sourceSignals
  };
  const timelineEntry = {
    schema_version: "across-autopilot-global-timeline-event/1.0",
    at: new Date().toISOString(),
    run_id: run.run_id,
    spec_id: spec.id,
    type: "autonomous_backlog_ranked",
    summary: seedTargets.length
      ? `Ranked ${backlog.length} autonomous self-iteration candidate(s).`
      : "Prepared open autonomous self-iteration state for model-generated candidates.",
    selected_target_id: backlog[0]?.id || null
  };

  await writeJson(join(artifactsDir, "source-signals.json"), artifact);
  await writeJson(join(contractsDir, "contract.json"), contract);
  await writeJson(join(contractsDir, "backlog.json"), backlog);
  await writeFile(join(contractsDir, "README.md"), renderContractReadme(contract, backlog), "utf8");
  await appendJsonl(join(contractsDir, "timeline.jsonl"), timelineEntry);
  await appendJsonl(join(logsDir, "global-timeline.jsonl"), timelineEntry);

  return {
    schema_version: LOOP_STATE_SCHEMA,
    root,
    artifacts_dir: artifactsDir,
    contract_dir: contractsDir,
    global_timeline_path: join(logsDir, "global-timeline.jsonl"),
    artifact_paths: {
      source_signals: join(artifactsDir, "source-signals.json")
    },
    contract_paths: {
      readme: join(contractsDir, "README.md"),
      contract: join(contractsDir, "contract.json"),
      backlog: join(contractsDir, "backlog.json"),
      timeline: join(contractsDir, "timeline.jsonl")
    },
    source_signals: sourceSignals,
    contract,
    backlog,
    recent_global_timeline: recentGlobalTimeline,
    recent_loop_timeline: recentLoopTimeline,
    target_generation: targetGenerationPolicy(spec),
    tool_packs: listToolPacks()
  };
}

export async function recordGeneratedAutonomousBacklog({ state, spec, run, candidates = [], selectedTargetId = null }) {
  const normalized = asArray(candidates).map((item, index) => ({
    id: String(item.id || item.target_id || `generated-${index + 1}`),
    status: item.status || "ready",
    score: Number(item.score || (asArray(candidates).length - index)),
    generated_from: item.generated_from || "model_generated",
    source_refs: asArray(item.source_refs).map(String),
    tool_packs: asArray(item.tool_packs).map(String),
    target_repo: String(item.target_repo || spec.pack_config?.target_repo || "across-agents-assistant"),
    summary: String(item.summary || item.goal || "Model-generated autonomous candidate."),
    goal: String(item.goal || item.summary || spec.description || spec.name),
    allowed_patch_paths: asArray(item.allowed_patch_paths).map(String),
    context_files: asArray(item.context_files).map(String),
    validation_commands: asArray(item.validation_commands),
    semantic_review: item.semantic_review || {},
    risk: String(item.risk || "medium")
  }));
  if (!normalized.length || !state?.contract_paths?.backlog) return normalized;
  await writeJson(state.contract_paths.backlog, normalized);
  await writeFile(state.contract_paths.readme, renderContractReadme(state.contract, normalized), "utf8");
  const timelineEntry = {
    schema_version: "across-autopilot-global-timeline-event/1.0",
    at: new Date().toISOString(),
    run_id: run.run_id,
    spec_id: spec.id,
    type: "autonomous_backlog_generated",
    summary: `Admitted ${normalized.length} model-generated autonomous self-iteration candidate(s).`,
    selected_target_id: selectedTargetId || normalized[0]?.id || null
  };
  await appendJsonl(state.contract_paths.timeline, timelineEntry);
  await appendJsonl(state.global_timeline_path, timelineEntry);
  return normalized;
}

export function autonomousTargetsFromBacklog(backlog) {
  return asArray(backlog).map((item) => ({
    id: item.id,
    target_repo: item.target_repo,
    summary: item.summary,
    goal: item.goal,
    allowed_patch_paths: item.allowed_patch_paths,
    context_files: item.context_files,
    validation_commands: item.validation_commands,
    semantic_review: item.semantic_review,
    risk: item.risk,
    source_refs: item.source_refs,
    score: item.score,
    tool_packs: item.tool_packs,
    generated_from: item.generated_from
  }));
}

function buildContract({ spec, run, sourceSignals, recalledMemory, recentGlobalTimeline, recentLoopTimeline }) {
  return {
    schema_version: "across-autopilot-loop-contract/1.0",
    spec_id: spec.id,
    run_id: run.run_id,
    goal: spec.pack_config?.research_strategy?.goal || spec.description || spec.name,
    workflow: [
      "Read source signals, recalled memory, loop timeline, and global timeline.",
      "Rank a dynamic backlog of bounded B-candidate product improvements.",
      "Use the host model to select one iteration.",
      "Let builder modify B only, then validate and run independent review.",
      "Write evidence and pending memory; do not merge or release."
    ],
    backlog_policy: {
      dynamic: true,
      selection_inputs: ["artifacts", "loop_contract", "global_timeline", "source_signals", "recalled_memory"],
      generation_mode: targetGenerationPolicy(spec).mode,
      allow_model_generated_targets: targetGenerationPolicy(spec).allow_model_generated_targets,
      seed_candidate_count: seedTargetCatalog(spec).length,
      minimum_candidates: targetGenerationPolicy(spec).minimum_candidates
    },
    timeline: {
      global_recent_count: recentGlobalTimeline.length,
      loop_recent_count: recentLoopTimeline.length
    },
    recalled_memory_count: recalledMemory.length,
    signal_keywords: uniqueStrings(sourceSignals.flatMap((signal) => signal.keywords)).slice(0, 20)
  };
}

function buildSourceSignals(sources) {
  return asArray(sources).map((source) => {
    const result = source.result || {};
    const text = [
      source.id,
      source.adapter,
      result.title,
      result.name,
      result.excerpt,
      result.content,
      result.summary,
      ...asArray(result.files).map((file) => `${file.path} ${file.content || ""}`),
      ...asArray(result.repositories).map((repo) => `${repo.id || ""} ${repo.name || ""} ${repo.description || ""}`)
    ].join(" ").toLowerCase();
    const keywords = uniqueStrings(
      seedTargetCatalog({ pack_config: { research_strategy: { conformance_fixture: true } } })
        .flatMap((target) => target.keywords.filter((keyword) => text.includes(keyword)))
    );
    return {
      id: source.id,
      adapter: source.adapter,
      status: source.status,
      title: result.title || result.name || source.id,
      keywords,
      excerpt: String(result.excerpt || result.content || result.summary || "").slice(0, 1000)
    };
  });
}

function rankBacklog({ spec, sourceSignals, recalledMemory, recentGlobalTimeline, previousBacklog, seedTargets = [] }) {
  const signalText = [
    spec.pack_config?.research_strategy?.goal,
    spec.description,
    ...sourceSignals.flatMap((signal) => [signal.title, signal.excerpt, ...signal.keywords]),
    ...asArray(recalledMemory).map((memory) => `${memory.text || memory.summary || ""}`),
    ...asArray(recentGlobalTimeline).map((event) => `${event.summary || ""} ${event.selected_target_id || ""}`),
    ...asArray(previousBacklog).map((item) => `${item.id || ""} ${item.status || ""}`)
  ].join(" ").toLowerCase();
  return asArray(seedTargets).map((blueprint, index) => {
    const keywordHits = blueprint.keywords.filter((keyword) => signalText.includes(keyword)).length;
    const recentSelectionCount = asArray(recentGlobalTimeline)
      .filter((event) => event.spec_id === spec.id && event.selected_target_id === blueprint.id)
      .length;
    const recencyPenalty = recentSelectionCount * 100;
    const score = (keywordHits * 10) + (asArray(seedTargets).length - index) - recencyPenalty;
    const generatedFrom = keywordHits ? "source_signals" : "architecture_baseline";
    return {
      id: blueprint.id,
      status: "ready",
      score,
      generated_from: generatedFrom,
      source_refs: sourceSignals.filter((signal) => intersects(signal.keywords, blueprint.keywords)).map((signal) => signal.id),
      tool_packs: toolPackIdsForTarget(blueprint),
      target_repo: blueprint.target_repo,
      summary: blueprint.summary,
      goal: `${blueprint.summary} Use the current loop signals and architecture contract to implement a bounded B-only AAA product improvement.`,
      allowed_patch_paths: [...blueprint.allowed_patch_paths],
      context_files: [...blueprint.context_files],
      validation_commands: blueprint.validation_commands.map((command) => ({ ...command, args: [...command.args] })),
      semantic_review: { ...blueprint.semantic_review },
      risk: blueprint.risk
    };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function targetGenerationPolicy(spec) {
  const policy = spec.pack_config?.research_strategy || {};
  const explicitMode = String(policy.target_generation || policy.generation_mode || "").trim();
  const declaredTargets = asArray(policy.candidate_targets);
  const conformance = policy.conformance_fixture === true || explicitMode === "blueprint" || explicitMode === "catalog";
  const open = policy.open_backlog === true
    || policy.allow_model_generated_targets === true
    || explicitMode === "model"
    || (policy.autonomous === true && policy.dynamic_backlog === true && declaredTargets.length === 0 && !conformance);
  return {
    mode: conformance ? "conformance_catalog" : open ? "model_generated" : declaredTargets.length ? "declared_catalog" : "model_generated",
    allow_model_generated_targets: open || (!conformance && declaredTargets.length === 0),
    conformance_fixture: conformance,
    minimum_candidates: Number(policy.minimum_candidates || (open ? 3 : Math.max(1, declaredTargets.length || CONFORMANCE_TARGET_BLUEPRINTS.length)))
  };
}

function seedTargetCatalog(spec) {
  const policy = spec.pack_config?.research_strategy || {};
  const declaredTargets = asArray(policy.candidate_targets);
  if (declaredTargets.length) return declaredTargets;
  const generation = targetGenerationPolicy(spec);
  return generation.conformance_fixture ? CONFORMANCE_TARGET_BLUEPRINTS : [];
}

function renderContractReadme(contract, backlog) {
  const lines = [
    `# ${contract.spec_id} Loop Contract`,
    "",
    `Run: ${contract.run_id}`,
    "",
    "## Goal",
    contract.goal,
    "",
    "## Workflow",
    ...contract.workflow.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Backlog",
    ...asArray(backlog).map((item) => `- ${item.id}: score=${item.score}; ${item.summary}`),
    "",
    "## Timeline",
    `- Global recent events: ${contract.timeline.global_recent_count}`,
    `- Loop recent events: ${contract.timeline.loop_recent_count}`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stableJson(value)}\n`, "utf8");
}

async function readOptionalJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(sortJson(value))}\n`, "utf8");
}

async function readJsonl(path, limit) {
  if (!existsSync(path)) return [];
  try {
    const text = await readFile(path, "utf8");
    const records = [];
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // Older development builds wrote pretty JSON into .jsonl files.
      }
    }
    return records.slice(-limit);
  } catch {
    return [];
  }
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return asArray(left).some((item) => rightSet.has(item));
}

function uniqueStrings(items) {
  return [...new Set(asArray(items).map((item) => String(item || "").trim()).filter(Boolean))];
}

function safeSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
