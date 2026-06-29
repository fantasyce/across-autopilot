import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeRuntimePolicy, PACKAGE_ROOT } from "./loop-spec.js";

export const WORKFLOW_PACK_SCHEMA = "across-workflow-pack/1.0";
export const WORKFLOW_PACK_PRODUCT_CARD_SCHEMA = "across-workflow-pack-product-card/1.0";
export const WORKFLOW_PACK_TRUST_RECEIPT_SCHEMA = "across-agent-team-trust-receipt/1.0";
export const WORKFLOW_PACK_PROTOCOL_READINESS_SCHEMA = "across-workflow-pack-protocol-readiness/1.0";
export const WORKFLOW_PACK_FRONTIER_INTEROP_SCHEMA = "across-workflow-pack-frontier-interop/1.0";

const HOST_TARGETS = Object.freeze(["codex", "claude_code", "mcp", "a2a", "across"]);

const FALLBACK_CAPABILITIES = Object.freeze([
  "source.directory",
  "source.github_repo",
  "source.github_search",
  "action.workflow_pack_export",
  "action.manifest_inspection",
  "action.dependency_risk_check",
  "action.license_check",
  "action.compatibility_scoring",
  "action.quality_gate_evaluation",
  "action.product_iteration_strategy",
  "action.host_code_iteration",
  "action.candidate_ecosystem_validation",
  "action.semantic_alignment_review",
  "output.markdown_report",
  "output.json_artifact",
  "memory.pending_summary",
  "runtime.evidence_graph",
  "runtime.workflow_pack_registry"
]);

const MARKET_PROFILES = Object.freeze({
  "repo-quality-copilot": {
    primary_user: "maintainers preparing a release or reviewing dependency drift",
    user_problem: "I need a useful repo health report without pasting the same checklist into every coding agent.",
    job_to_be_done: "Inspect a repository, produce evidence-backed findings, and leave reusable context for future runs.",
    headline: "Run a repo quality check that stops with evidence instead of a vague agent summary.",
    why_now: "Agent output volume is rising, so maintainers need repeatable checks and reviewable receipts.",
    competitive_position: "Use Across as the proof-of-work layer for local agents, not another project board.",
    time_to_value: "under 2 minutes",
    no_model_required: true,
    trust_receipt_title: "Repository Quality Trust Receipt"
  },
  "release-captain": {
    primary_user: "small teams preparing app or plugin releases",
    user_problem: "I need a release gate that remembers exactly what passed before I tag or publish.",
    job_to_be_done: "Turn a release checklist into a repeatable validation loop with human-gated promotion evidence.",
    headline: "Convert a release checklist into an evidence-backed release gate.",
    why_now: "More agent-generated changes create more release risk unless validation is repeatable.",
    competitive_position: "Across complements agent task boards by producing the release evidence they should require.",
    time_to_value: "under 5 minutes",
    no_model_required: true,
    trust_receipt_title: "Release Readiness Trust Receipt"
  },
  "plugin-compatibility-lab-v2": {
    primary_user: "developers adopting external MCP servers, agent plugins, or coding-agent tools",
    user_problem: "I need to know whether this plugin is safe and portable before my agents depend on it.",
    job_to_be_done: "Evaluate host compatibility, trust boundaries, manifests, and evidence before team adoption.",
    headline: "Test an agent plugin before it becomes part of your team workflow.",
    why_now: "MCP and agent plugin ecosystems are expanding faster than teams can manually review them.",
    competitive_position: "Across gives Multica-style agent teams a plugin acceptance gate with portable evidence.",
    time_to_value: "under 3 minutes",
    no_model_required: true,
    trust_receipt_title: "Plugin Adoption Trust Receipt"
  },
  "autonomous-product-iteration": {
    primary_user: "product engineers safely prototyping agent-written improvements",
    user_problem: "I want agents to prototype changes without touching source or claiming success without validation.",
    job_to_be_done: "Create a candidate workspace, mutate only the candidate, validate, review, and stop with promotion evidence.",
    headline: "Let agents prototype product improvements in a candidate workspace with review gates.",
    why_now: "Teams want autonomous coding agents, but trust depends on isolation, validation, and reviewable promotion packages.",
    competitive_position: "Across is the trust layer that makes autonomous work promotable instead of just impressive.",
    time_to_value: "10-20 minutes",
    no_model_required: false,
    trust_receipt_title: "Candidate Promotion Trust Receipt"
  }
});

export const BUILT_IN_WORKFLOW_PACKS = Object.freeze({
  "repo-quality-copilot": {
    schema_version: WORKFLOW_PACK_SCHEMA,
    id: "repo-quality-copilot",
    title: "Repository Quality Copilot",
    description: "Read-only repository quality inspection for release readiness.",
    loop_spec_id: "repo-quality-copilot",
    autonomy_level: 2,
    host_targets: HOST_TARGETS,
    required_capabilities: [
      "source.directory",
      "action.manifest_inspection",
      "action.dependency_risk_check",
      "action.license_check",
      "action.quality_gate_evaluation",
      "output.markdown_report",
      "memory.pending_summary"
    ],
    runtime_policy: readOnlyPolicy("low"),
    boundaries: boundary("none"),
    artifacts: ["run://repo-quality/report.md", "run://repo-quality/evidence.json", "context://pending"]
  },
  "release-captain": {
    schema_version: WORKFLOW_PACK_SCHEMA,
    id: "release-captain",
    title: "Release Captain",
    description: "Release-readiness gate that produces review evidence without publishing.",
    loop_spec_id: "aaa-release-readiness-gate",
    autonomy_level: 2,
    host_targets: HOST_TARGETS,
    required_capabilities: [
      "source.directory",
      "action.manifest_inspection",
      "action.dependency_risk_check",
      "action.quality_gate_evaluation",
      "output.markdown_report",
      "memory.pending_summary"
    ],
    runtime_policy: readOnlyPolicy("release"),
    boundaries: boundary("none"),
    artifacts: ["run://release-readiness/report.md", "run://release-readiness/evidence.json", "context://pending"]
  },
  "plugin-compatibility-lab-v2": {
    schema_version: WORKFLOW_PACK_SCHEMA,
    id: "plugin-compatibility-lab-v2",
    title: "Plugin Compatibility Lab v2",
    description: "Host-neutral plugin compatibility assessment for Codex, Claude Code, MCP, A2A, and AAA.",
    loop_spec_id: "plugin-compatibility-lab-v2",
    autonomy_level: 2,
    host_targets: HOST_TARGETS,
    required_capabilities: [
      "source.directory",
      "action.workflow_pack_export",
      "action.manifest_inspection",
      "action.dependency_risk_check",
      "action.license_check",
      "action.compatibility_scoring",
      "action.quality_gate_evaluation",
      "output.markdown_report",
      "output.json_artifact",
      "memory.pending_summary"
    ],
    runtime_policy: readOnlyPolicy("low"),
    boundaries: boundary("none"),
    artifacts: ["run://plugin-compatibility-lab/report.md", "run://plugin-compatibility-lab/evidence.json", "context://pending"],
    scenario: {
      name: "Generic agent plugin acceptance",
      host_agent_tasks: [
        "Discover plugin capabilities and trust boundaries.",
        "Validate that Codex and Claude Code can consume the same host export shape.",
        "Produce evidence that a read-only workflow completes without model calls or network access."
      ]
    }
  },
  "autonomous-product-iteration": {
    schema_version: WORKFLOW_PACK_SCHEMA,
    id: "autonomous-product-iteration",
    title: "Autonomous Product Iteration",
    description: "Candidate-workspace product iteration with independent review evidence.",
    loop_spec_id: "aaa-autonomous-self-iteration",
    autonomy_level: 3,
    host_targets: HOST_TARGETS,
    required_capabilities: [
      "source.directory",
      "action.product_iteration_strategy",
      "action.host_code_iteration",
      "action.candidate_ecosystem_validation",
      "action.semantic_alignment_review",
      "output.markdown_report",
      "memory.pending_summary"
    ],
    runtime_policy: {
      ...readOnlyPolicy("medium"),
      filesystem_policy: "candidate_workspace_only",
      budget: { max_model_calls: 8, max_candidate_repairs: 3, max_usd: 0 }
    },
    boundaries: boundary("candidate_workspace_only"),
    artifacts: ["run://iteration/report.md", "run://iteration/evidence.json", "context://pending"]
  }
});

export async function loadWorkflowPack(idOrPath) {
  if (BUILT_IN_WORKFLOW_PACKS[idOrPath]) return clone(BUILT_IN_WORKFLOW_PACKS[idOrPath]);
  return JSON.parse(await readFile(resolve(idOrPath), "utf8"));
}

export function listWorkflowPacks({ registry = null } = {}) {
  return {
    schema_version: "across-workflow-pack-registry/1.0",
    package_root: PACKAGE_ROOT,
    packs: Object.values(BUILT_IN_WORKFLOW_PACKS).map((pack) => summarizeWorkflowPack(pack, { registry }))
  };
}

export function summarizeWorkflowPack(pack, { registry = null } = {}) {
  const validation = validateWorkflowPack(pack, { registry, throwOnError: false });
  const productCard = renderWorkflowPackProductCard(pack, { registry });
  const protocolReadiness = renderWorkflowPackProtocolReadiness(pack, { registry });
  return {
    id: pack.id,
    title: pack.title,
    description: pack.description,
    headline: productCard.headline,
    primary_user: productCard.primary_user,
    quickstart: productCard.quickstart,
    schema_version: pack.schema_version,
    loop_spec_id: pack.loop_spec_id,
    autonomy_level: pack.autonomy_level,
    host_targets: pack.host_targets || [],
    market_readiness: productCard.market_readiness,
    protocol_readiness: protocolReadiness.summary,
    runtime_policy: normalizeRuntimePolicy({ runtime_policy: pack.runtime_policy }),
    available: validation.valid,
    missing_capabilities: validation.missing_capabilities,
    status: validation.valid ? "passed" : "attention"
  };
}

export function validateWorkflowPack(pack, { registry = null, throwOnError = true } = {}) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) fail("$", "Workflow pack must be an object.");
  if (pack?.schema_version !== WORKFLOW_PACK_SCHEMA) fail("schema_version", `Expected ${WORKFLOW_PACK_SCHEMA}.`);
  if (!pack?.id || !/^[a-z0-9][a-z0-9-_.]*$/.test(String(pack.id))) fail("id", "id must be a stable lowercase identifier.");
  for (const field of ["title", "description", "loop_spec_id", "host_targets", "required_capabilities", "runtime_policy", "boundaries", "artifacts"]) {
    if (pack?.[field] === undefined) fail(field, "Required field is missing.");
  }
  const hostTargets = asArray(pack?.host_targets).map(String);
  for (const target of hostTargets) {
    if (!HOST_TARGETS.includes(target)) fail("host_targets", `Unsupported host target ${target}.`);
  }
  const required = [...new Set(asArray(pack?.required_capabilities).map(String).filter(Boolean))];
  const available = availableCapabilities(registry);
  const missing = required.filter((capability) => !available.has(capability));
  if (missing.length) fail("required_capabilities", `Missing capabilities: ${missing.join(", ")}`);
  const runtime = normalizeRuntimePolicy({ runtime_policy: pack?.runtime_policy });
  if (runtime.promotion.human_approval_required !== true) fail("runtime_policy.promotion.human_approval_required", "Promotion must require human approval.");
  if (runtime.promotion.merge_release_signing_blocked !== true) fail("runtime_policy.promotion.merge_release_signing_blocked", "Merge, release, and signing must remain blocked.");
  if (pack?.boundaries?.secrets !== "not_allowed") fail("boundaries.secrets", "Workflow packs may not include secrets.");
  const result = {
    schema_version: "across-workflow-pack-validation/1.0",
    valid: errors.length === 0,
    pack_id: pack?.id || null,
    loop_spec_id: pack?.loop_spec_id || null,
    host_targets: hostTargets,
    runtime_policy: runtime,
    missing_capabilities: missing,
    errors
  };
  if (!result.valid && throwOnError) {
    const error = new Error("Workflow pack validation failed.");
    error.validation = result;
    throw error;
  }
  return result;
}

export function workflowPackForLoopSpec(spec) {
  const id = spec?.pack_config?.workflow_pack_id || spec?.workflow_pack_id || spec?.id;
  const pack = BUILT_IN_WORKFLOW_PACKS[id];
  return pack ? clone(pack) : null;
}

export function renderWorkflowPackHostExports(pack, { registry = null } = {}) {
  const validation = validateWorkflowPack(pack, { registry, throwOnError: false });
  const runtimePolicy = normalizeRuntimePolicy({ runtime_policy: pack.runtime_policy });
  const productCard = renderWorkflowPackProductCard(pack, { registry });
  const protocolReadiness = renderWorkflowPackProtocolReadiness(pack, { registry });
  const trustReceipt = renderWorkflowPackTrustReceipt(pack, { registry, productCard, protocolReadiness });
  const frontierInterop = renderWorkflowPackFrontierInterop(pack);
  const hosts = {};
  for (const target of asArray(pack.host_targets)) {
    hosts[target] = hostExportForTarget(target, pack, runtimePolicy, productCard, frontierInterop);
  }
  return {
    schema_version: "across-workflow-pack-host-exports/1.0",
    pack_id: pack.id,
    title: pack.title,
    status: validation.valid ? "passed" : "attention",
    loop_spec_id: pack.loop_spec_id,
    host_targets: asArray(pack.host_targets),
    runtime_policy: runtimePolicy,
    trust_boundary: pack.boundaries,
    required_capabilities: pack.required_capabilities || [],
    missing_capabilities: validation.missing_capabilities,
    product_card: productCard,
    protocol_readiness: protocolReadiness,
    trust_receipt: trustReceipt,
    frontier_interop: frontierInterop,
    hosts
  };
}

export function renderWorkflowPackProductCard(pack, { registry = null } = {}) {
  const validation = validateWorkflowPack(pack, { registry, throwOnError: false });
  const market = marketProfile(pack);
  const hostTargets = asArray(pack.host_targets);
  const quickstart = {
    cli: `across-autopilot loop run --spec ${pack.loop_spec_id} --json`,
    host_prompt: `Run the Across ${pack.title} workflow. Keep the run bounded, preserve the trust receipt, and do not merge, publish, sign, or write secrets.`,
    time_to_value: market.time_to_value,
    no_model_required: Boolean(market.no_model_required)
  };
  const proofPoints = [
    "bounded runtime policy",
    "human-gated promotion",
    "structured evidence receipt",
    "pending memory only",
    "host-neutral export"
  ];
  return {
    schema_version: WORKFLOW_PACK_PRODUCT_CARD_SCHEMA,
    pack_id: pack.id,
    title: pack.title,
    status: validation.valid ? "passed" : "attention",
    headline: market.headline,
    description: pack.description,
    primary_user: market.primary_user,
    user_problem: market.user_problem,
    job_to_be_done: market.job_to_be_done,
    why_now: market.why_now,
    competitive_position: market.competitive_position,
    quickstart,
    outputs: asArray(pack.artifacts).map((artifact) => ({ ref: artifact, purpose: artifactPurpose(artifact) })),
    proof_points: proofPoints,
    host_surfaces: hostTargets.map((target) => hostSurfaceCard(target, pack, quickstart)),
    market_readiness: {
      status: validation.valid && hostTargets.length >= 5 ? "passed" : "attention",
      onboarding_story: "workflow-first",
      agent_readable: true,
      human_readable: true,
      first_value_artifact: asArray(pack.artifacts)[0] || null
    },
    missing_capabilities: validation.missing_capabilities
  };
}

export function renderWorkflowPackTrustReceipt(pack, { registry = null, productCard = null, protocolReadiness = null } = {}) {
  const validation = validateWorkflowPack(pack, { registry, throwOnError: false });
  const card = productCard || renderWorkflowPackProductCard(pack, { registry });
  const readiness = protocolReadiness || renderWorkflowPackProtocolReadiness(pack, { registry });
  return {
    schema_version: WORKFLOW_PACK_TRUST_RECEIPT_SCHEMA,
    receipt_id: `receipt-template:${pack.id}`,
    pack_id: pack.id,
    title: marketProfile(pack).trust_receipt_title,
    status: validation.valid ? "passed" : "attention",
    promise: card.headline,
    acceptance_checklist: [
      { id: "workflow_pack_valid", required: true, status: validation.valid ? "passed" : "attention" },
      { id: "human_promotion_gate", required: true, status: pack.runtime_policy?.promotion?.human_approval_required ? "passed" : "failed" },
      { id: "no_secret_boundary", required: true, status: pack.boundaries?.secrets === "not_allowed" ? "passed" : "failed" },
      { id: "host_neutral_exports", required: true, status: REQUIRED_HOST_TARGETS.every((target) => asArray(pack.host_targets).includes(target)) ? "passed" : "attention" },
      { id: "evidence_graph_expected", required: true, status: "passed" },
      { id: "pending_memory_only", required: true, status: "passed" }
    ],
    evidence_contract: {
      required: ["runtime_policy", "trust_boundary", "host_exports", "evidence_graph", "validation_gates", "otel_genai_spans", "a2a_task_delegation"],
      graph_schema: "across-evidence-graph/1.0",
      memory_policy: "pending_review",
      otel_schema: "across-otel-genai-export/1.0",
      otlp_trace_schema: "otlp-traces-json/1.0",
      a2a_delegation_schema: "across-a2a-task-delegation/2.0",
      a2a_compatible_schemas: ["across-a2a-task-delegation/1.0"],
      projection_contract: "across-external-projection/1.0",
      required_projections: ["mcp_tasks", "a2a", "ag_ui", "remote_mcp_oauth", "otel"]
    },
    protocol_summary: readiness.summary,
    user_visible_outputs: card.outputs,
    review_notes: [
      "This is a receipt template before execution; a completed run must attach run_id, evidence graph, validation gates, and output artifacts.",
      "Merge, release, signing, and active memory writes remain human-gated."
    ]
  };
}

export function renderWorkflowPackProtocolReadiness(pack, { registry = null } = {}) {
  const validation = validateWorkflowPack(pack, { registry, throwOnError: false });
  const hostTargets = asArray(pack.host_targets);
  const checks = [
    protocolCheck("managed_host_wrapper", "passed", "Codex, Claude Code, and Claude Desktop launch through managed ~/.across/bin wrappers."),
    protocolCheck("mcp_stdio", hostTargets.includes("mcp") ? "passed" : "planned", "Local MCP stdio loading works for current coding-agent hosts."),
    protocolCheck("mcp_tasks_contract", hostTargets.includes("mcp") ? "partial" : "planned", "Long-running work is represented as across-async-task/1.0 with the run-store as source of truth; MCP Tasks remains projection-only."),
    protocolCheck("mcp_apps_surface", "planned", "AAA Workbench is the current review UI; MCP Apps-compatible server-rendered UI remains a future deployment surface."),
    protocolCheck("remote_mcp_http_oauth", "passed", "Streamable HTTP/OAuth template requires RFC 8707 resource-bound tokens; production hosting remains host-owned."),
    protocolCheck("a2a_agent_card", hostTargets.includes("a2a") ? "passed" : "planned", "A2A-style task cards are exported for discovery."),
    protocolCheck("a2a_task_delegation", hostTargets.includes("a2a") ? "passed" : "planned", "LF-compatible A2A v2 task/message/artifact delegation envelope is exported for host gateways."),
    protocolCheck("ag_ui_projection", "passed", "Task-card state can be projected to AG-UI events by Orchestrator and surfaced by AAA."),
    protocolCheck("projection_observability", "passed", "Plugin Compatibility Lab v2 scores MCP Tasks, A2A, AG-UI, Remote MCP/OAuth, and OTel projections as observable dimensions."),
    protocolCheck("otel_genai_export", "passed", "Evidence graphs can be converted into OTel/GenAI-style spans and gate-based eval cases."),
    protocolCheck("evidence_receipt", "passed", "Every pack exports a trust receipt template and expects across-evidence-graph/1.0 run evidence."),
    protocolCheck("context_memory_handoff", "passed", "Context stores pending summaries and compact evidence memory without raw transcripts.")
  ];
  const passed = checks.filter((check) => check.status === "passed").length;
  const partial = checks.filter((check) => check.status === "partial").length;
  const score = Math.round(((passed * 2 + partial) / (checks.length * 2)) * 100);
  return {
    schema_version: WORKFLOW_PACK_PROTOCOL_READINESS_SCHEMA,
    pack_id: pack.id,
    status: validation.valid && score >= 70 ? "passed" : "attention",
    summary: {
      score,
      passed_count: passed,
      partial_count: partial,
      planned_count: checks.filter((check) => check.status === "planned").length,
      frontier_ready: score >= 70,
      honest_protocol_claims: true
    },
    checks
  };
}

export function renderWorkflowPackFrontierInterop(pack) {
  return {
    schema_version: WORKFLOW_PACK_FRONTIER_INTEROP_SCHEMA,
    pack_id: pack.id,
    status: "passed",
    remote_mcp: {
      schema_version: "across-remote-mcp-oauth-template/1.0",
      transport: "streamable_http",
      oauth_required: true,
      command: "across-orchestrator remote-mcp-oauth-template --json",
      production_hosting: "host_owned"
    },
    a2a: {
      schema_version: "across-a2a-task-delegation/2.0",
      compatible_schema_versions: ["across-a2a-task-delegation/1.0"],
      profile: "linux-foundation-a2a",
      task_states: ["submitted", "working", "input-required", "completed", "failed", "canceled"],
      command: `across-orchestrator a2a-delegation --payload-json '{"pack_id":"${pack.id}"}' --json`
    },
    mcp_tasks: {
      schema_version: "across-async-task/1.0",
      status: "projection_only",
      command: `across-autopilot loop run --spec ${pack.loop_spec_id} --async --return-task-id --json`,
      source_of_truth: "across-autopilot-run-store"
    },
    ag_ui: {
      schema_version: "across-agui-projection/1.0",
      status: "passed",
      event_source: "orchestrator_loop_event_stream",
      component: "AcrossTaskCard"
    },
    observability: {
      otel_schema: "across-otel-genai-export/1.0",
      otlp_trace_schema: "otlp-traces-json/1.0",
      eval_dataset_schema: "across-eval-dataset/1.0",
      command: "across-orchestrator otel-export --payload-json '<evidence>' --otlp-file /tmp/across-otel-traces.json --json",
      raw_transcripts_included: false
    },
    projections: {
      schema_version: "across-external-projection/1.0",
      dimensions: {
        mcp_tasks: { status: "projection_only", schema_version: "across-async-task/1.0" },
        a2a: { status: "passed", schema_version: "across-a2a-task-delegation/2.0" },
        ag_ui: { status: "passed", schema_version: "across-agui-projection/1.0" },
        remote_mcp_oauth: { status: "passed", schema_version: "across-remote-mcp-oauth-template/1.0" },
        otel: { status: "passed", schema_version: "across-otel-genai-export/1.0" }
      },
      score_weight: "plugin_compatibility_lab_v2"
    }
  };
}

function hostExportForTarget(target, pack, runtimePolicy, productCard, frontierInterop) {
  const shared = {
    pack_id: pack.id,
    loop_spec_id: pack.loop_spec_id,
    runtime_policy: runtimePolicy,
    trust_boundary: pack.boundaries,
    artifacts: pack.artifacts || [],
    product_headline: productCard.headline,
    trust_receipt_required: true,
    frontier_interop: frontierInterop
  };
  if (target === "codex") {
    return {
      ...shared,
      type: "codex-plugin-task",
      invocation: `across-autopilot loop run --spec ${pack.loop_spec_id} --json`,
      instruction_contract: "Use the pack as a read-only or candidate-workspace bounded task. Preserve the trust receipt. Do not merge, publish, sign, or write secrets.",
      task_brief: productCard.quickstart.host_prompt
    };
  }
  if (target === "claude_code") {
    return {
      ...shared,
      type: "claude-code-skill-or-mcp-task",
      invocation: `across-autopilot loop run --spec ${pack.loop_spec_id} --json`,
      instruction_contract: "Load through MCP or local skill instructions; preserve pending memory, trust receipt, and human promotion gates.",
      task_brief: productCard.quickstart.host_prompt
    };
  }
  if (target === "mcp") {
    return {
      ...shared,
      type: "mcp-tool-contract",
      tools: ["validate_loop_spec", "dry_run_loop", "run_loop", "get_loop_run_evidence"],
      resource_hints: [`across-autopilot://workflow-packs/${pack.id}`],
      task_states: ["working", "input_required", "completed", "failed", "cancelled"],
      remote_transport_template: frontierInterop.remote_mcp
    };
  }
  if (target === "a2a") {
    return {
      ...shared,
      type: "a2a-agent-card-task",
      agent_card_skill: pack.id,
      task_lifecycle: ["submitted", "working", "input-required", "completed", "failed", "canceled"],
      task_message: productCard.quickstart.host_prompt,
      artifact_contract: pack.artifacts || [],
      delegation_contract: frontierInterop.a2a
    };
  }
  return {
    ...shared,
    type: "across-host-workflow",
    surfaces: ["AAA Console", "Across Orchestrator", "Across Context"]
  };
}

const REQUIRED_HOST_TARGETS = Object.freeze(["codex", "claude_code", "mcp", "a2a", "across"]);

function marketProfile(pack) {
  return MARKET_PROFILES[pack.id] || {
    primary_user: "teams running repeatable coding-agent workflows",
    user_problem: "I need a bounded agent workflow with evidence and reusable memory.",
    job_to_be_done: "Run a workflow pack, validate outputs, and preserve a trust receipt.",
    headline: pack.description || pack.title,
    why_now: "Agent work needs reviewable evidence before it becomes team workflow.",
    competitive_position: "Across provides host-neutral evidence and memory for agent teams.",
    time_to_value: "under 5 minutes",
    no_model_required: false,
    trust_receipt_title: "Agent Team Trust Receipt"
  };
}

function artifactPurpose(ref) {
  const text = String(ref || "");
  if (text.includes("report")) return "human-readable review artifact";
  if (text.includes("evidence")) return "machine-readable proof artifact";
  if (text.includes("context")) return "pending memory handoff";
  return "workflow output artifact";
}

function hostSurfaceCard(target, pack, quickstart) {
  const labels = {
    codex: "Codex",
    claude_code: "Claude Code",
    mcp: "MCP-capable hosts",
    a2a: "A2A-style agent hosts",
    across: "Across Agents Assistant"
  };
  return {
    target,
    label: labels[target] || target,
    ready: asArray(pack.host_targets).includes(target),
    invocation: target === "mcp" ? "tools/call run_loop" : quickstart.cli
  };
}

function protocolCheck(id, status, description) {
  return { id, status, description };
}

function availableCapabilities(registry) {
  if (!registry) return new Set(FALLBACK_CAPABILITIES);
  const capabilities = registry.capabilities();
  return new Set([
    ...(capabilities.sources || []),
    ...(capabilities.actions || []),
    ...(capabilities.outputs || []),
    ...(capabilities.runtime || []),
    ...(capabilities.tool_packs || []).map((pack) => `tool_pack.${pack.id}`),
    "memory.pending_summary"
  ]);
}

function readOnlyPolicy(riskProfile) {
  return {
    risk_profile: riskProfile,
    network_policy: "none",
    filesystem_policy: "read_only",
    budget: { max_model_calls: 0, max_candidate_repairs: 0, max_usd: 0 },
    promotion: {
      human_approval_required: true,
      merge_release_signing_blocked: true
    }
  };
}

function boundary(mutation) {
  return {
    mutation,
    secrets: "not_allowed",
    raw_transcripts: "not_persisted",
    promotion: "human_only"
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
