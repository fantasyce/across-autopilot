export const AGENT_PLUGIN_SCHEMA = "across-agent-plugin/1.0";
export const AGENT_PLUGIN_PLAN_SCHEMA = "across-autopilot-agent-plugin-plan/1.0";
export const VALIDATION_CONTRACT_SCHEMA = "across-validation-contract/1.0";
export const HOST_COMPLETION_CONTRACT_SCHEMA = "across-host-completion-contract/1.0";

const TRUST_BOUNDARIES = new Set([
  "read_only",
  "candidate_workspace",
  "host_approved_mutation",
  "network_only",
  "manual_only"
]);

export function normalizeAgentPluginManifest(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("agent plugin manifest must be a JSON object");
  }
  const schema = payload.schema_version || payload.schemaVersion || AGENT_PLUGIN_SCHEMA;
  if (schema !== AGENT_PLUGIN_SCHEMA) {
    throw new Error(`unsupported agent plugin schema: ${schema}`);
  }
  const pluginId = required(payload.plugin_id || payload.id, "plugin_id");
  const agent = object(payload.agent);
  const agentId = required(agent.id || payload.agent_id || pluginId, "agent.id");
  const entrypoints = normalizeEntrypoints(object(payload.entrypoints));
  const trust = normalizeTrust(object(payload.trust));
  return {
    schema_version: AGENT_PLUGIN_SCHEMA,
    plugin_id: pluginId,
    display_name: String(payload.display_name || payload.displayName || agent.name || pluginId),
    version: String(payload.version || "0.0.0"),
    kind: String(payload.kind || "agent-plugin"),
    agent: {
      id: agentId,
      name: String(agent.name || payload.display_name || pluginId),
      vendor: String(agent.vendor || payload.vendor || "unknown")
    },
    protocols: normalizeProtocols(payload.protocols, entrypoints),
    capabilities: array(payload.capabilities).slice(0, 32).map(normalizeCapability),
    entrypoints,
    trust,
    context: {
      pack_id: String(object(payload.context).pack_id || object(payload.context).packId || pluginId),
      tags: array(object(payload.context).tags).map(String).slice(0, 12)
    },
    health: object(payload.health)
  };
}

export function enforceAgentPluginTrustPolicy(manifest, runtimePolicy = {}) {
  const plugin = normalizeAgentPluginManifest(manifest);
  const failures = [];
  const warnings = [];
  if (plugin.trust.secrets_included) {
    failures.push("agent plugin manifest must not include secrets");
  }
  if (!TRUST_BOUNDARIES.has(plugin.trust.mutation_boundary)) {
    failures.push(`unsupported mutation boundary: ${plugin.trust.mutation_boundary}`);
  }
  if (plugin.trust.mutation_boundary !== "read_only" && runtimePolicy.requireHumanApprovalForMutation !== false && !plugin.trust.requires_human_approval) {
    failures.push("mutating agent plugins require human approval");
  }
  const run = plugin.entrypoints.run;
  if (!run) {
    warnings.push("run entrypoint is not configured; Autopilot can plan but cannot dispatch this plugin yet");
  }
  for (const capability of plugin.capabilities) {
    if (array(runtimePolicy.disallowedCapabilities).includes(capability.id)) {
      failures.push(`capability is disallowed by runtime policy: ${capability.id}`);
    }
  }
  return {
    status: failures.length ? "failed" : warnings.length ? "attention" : "passed",
    failures,
    warnings,
    checks: [
      { id: "no_secrets", status: plugin.trust.secrets_included ? "failed" : "passed" },
      { id: "mutation_boundary", status: TRUST_BOUNDARIES.has(plugin.trust.mutation_boundary) ? "passed" : "failed", boundary: plugin.trust.mutation_boundary },
      { id: "human_approval_gate", status: plugin.trust.mutation_boundary === "read_only" || plugin.trust.requires_human_approval ? "passed" : "failed" },
      { id: "run_entrypoint", status: run ? "passed" : "attention" }
    ]
  };
}

export function buildAgentPluginRunPlan({ manifest, goal = "", runtimePolicy = {}, trigger = "manual", validationContract = null } = {}) {
  const plugin = normalizeAgentPluginManifest(manifest);
  const trust = enforceAgentPluginTrustPolicy(plugin, runtimePolicy);
  const mutating = plugin.trust.mutation_boundary !== "read_only";
  const validation = normalizeValidationContract(validationContract, { plugin, goal });
  const requiredToolPacks = [
    "capability_preflight",
    mutating ? "candidate_workspace" : "source_research_digest",
    "validation_harness",
    "independent_review"
  ];
  const auditArtifactPath = selectAuditArtifactPath(validation.artifacts);
  const requiredJsonValues = validation.artifacts
    .filter((artifact) => isJsonArtifact(artifact))
    .flatMap((artifact) => array(artifact.required_keys)
      .filter((key) => key === `${validation.check_action}_completed`)
      .map((key) => ({ path: artifact.path, pointer: `/${escapeJsonPointer(key)}`, equals: true })));
  return {
    schema_version: AGENT_PLUGIN_PLAN_SCHEMA,
    plugin_schema_version: AGENT_PLUGIN_SCHEMA,
    status: trust.status,
    trigger,
    goal: String(goal || ""),
    agent_plugin: {
      plugin_id: plugin.plugin_id,
      agent_id: plugin.agent.id,
      display_name: plugin.display_name,
      version: plugin.version,
      vendor: plugin.agent.vendor
    },
    required_tool_packs: requiredToolPacks,
    trust_policy: trust,
    execution: {
      adapter: "agent_plugin",
      dry_run: true,
      entrypoint: plugin.entrypoints.run ? "run" : null,
      command_configured: Boolean(plugin.entrypoints.run),
      shell_execution: false,
      credentials_stay_with_host: true,
      mutation_boundary: plugin.trust.mutation_boundary,
      human_approval_required: plugin.trust.requires_human_approval
    },
    context: {
      provider: "across-context",
      pack_id: plugin.context.pack_id,
      tags: [`agent-plugin:${plugin.plugin_id}`, `agent:${plugin.agent.id}`, ...plugin.context.tags]
    },
    loop_contract: {
      recommended_action_plan: ["memory_search", "task_dispatch", validation.check_action, "quality_gate", "final_output"],
      check_action: validation.check_action,
      validation_contract_schema: VALIDATION_CONTRACT_SCHEMA,
      failure_behavior: "block_final_output_until_validation_passes",
      recovery_hint: "On validation failure, dispatch remediation and rerun the check before final_output."
    },
    host_completion_contract: {
      schema_version: HOST_COMPLETION_CONTRACT_SCHEMA,
      required_milestones: [
        "context_recalled",
        "agent_plugin_validated",
        "autopilot_plan_created",
        "required_artifacts_written",
        "orchestrator_loop_started",
        `${validation.check_action}_passed`,
        "final_output_ready"
      ],
      required_files: validation.artifacts.map((artifact) => artifact.path).filter(Boolean),
      required_json_values: requiredJsonValues,
      required_observed_actions: [
        { path: auditArtifactPath, action_type: validation.check_action },
        { path: auditArtifactPath, action_type: "final_output" }
      ],
      supervision: {
        owner: "across-autopilot",
        behavior: "detect_missing_milestones_and_issue_continuation",
        max_attempts_default: 3,
        human_resume_required: false
      }
    },
    validation_contract: validation,
    evidence_contract: {
      required: ["agent_plugin", "trust_policy", "execution", "context", "required_tool_packs", "validation_contract", "host_completion_contract"],
      promotion_requires_human_review: true
    }
  };
}

export function normalizeValidationContract(contract, { plugin = null, goal = "" } = {}) {
  const base = contract && typeof contract === "object" && !Array.isArray(contract) ? contract : {};
  const schema = base.schema_version || base.schemaVersion || VALIDATION_CONTRACT_SCHEMA;
  if (schema !== VALIDATION_CONTRACT_SCHEMA) {
    throw new Error(`unsupported validation contract schema: ${schema}`);
  }
  const checkAction = String(base.check_action || base.checkAction || "business_contract_check");
  if (!/^[a-z][a-z0-9_]{0,63}_check$/.test(checkAction)) {
    throw new Error("validation contract check_action must be a host-declared *_check action");
  }
  const artifacts = array(base.artifacts || base.required_artifacts || base.requiredArtifacts)
    .slice(0, 50)
    .map(normalizeArtifactContract);
  return {
    schema_version: VALIDATION_CONTRACT_SCHEMA,
    mode: artifacts.length ? "host_supplied" : "template",
    check_action: checkAction,
    goal: String(goal || ""),
    agent_plugin_id: plugin?.plugin_id || null,
    artifacts,
    accepted_check_types: [
      "artifact_presence",
      "json_parse",
      "json_required_key",
      "csv_parse",
      "csv_columns",
      "csv_row_count",
      "csv_min_rows",
      "csv_sort_order",
      "csv_row_expectation",
      "text_must_include",
      "text_must_not_include",
      "host_review_required"
    ],
    default_checks: [
      { id: "required_artifacts_present", type: "artifact_presence", severity: "blocking" },
      { id: "structured_artifacts_parse", type: "json_or_csv_parse", severity: "blocking" },
      { id: "cross_artifact_consistency", type: "host_review_required", severity: "blocking" },
      { id: "domain_rule_assertions", type: "host_supplied_assertions", severity: "blocking" }
    ],
    host_responsibilities: [
      "Provide artifact-specific expectations when domain correctness matters.",
      "Use row_expectations or a host validator for formulas, scoring policies, ranking rules, and narrative consistency.",
      "Treat validation failure as blocking until remediation produces passing evidence."
    ],
    evidence_schema_version: "across-validation-evidence/1.0",
    failure_behavior: "blocking"
  };
}

function normalizeArtifactContract(value) {
  if (typeof value === "string") {
    return { path: value, required: true };
  }
  const item = object(value);
  const normalized = {
    path: required(item.path || item.file, "artifact.path"),
    required: item.required === undefined ? true : Boolean(item.required),
    type: item.type ? String(item.type) : undefined,
    columns: array(item.columns || item.expected_columns || item.expectedColumns).map(String),
    row_count: item.row_count ?? item.rowCount,
    min_rows: item.min_rows ?? item.minRows,
    sort: array(item.sort || item.sort_order || item.sortOrder).map((spec) => object(spec)),
    row_expectations: array(item.row_expectations || item.rowExpectations).map((expectation) => object(expectation)),
    required_keys: array(item.required_keys || item.requiredKeys).map(String),
    must_include: array(item.must_include || item.mustInclude).map(String),
    must_not_include: array(item.must_not_include || item.mustNotInclude).map(String)
  };
  return Object.fromEntries(
    Object.entries(normalized).filter(([, entryValue]) => {
      if (Array.isArray(entryValue)) return entryValue.length > 0;
      return entryValue !== undefined && entryValue !== null && entryValue !== "";
    })
  );
}

function selectAuditArtifactPath(artifacts) {
  const jsonArtifacts = artifacts.filter((artifact) => isJsonArtifact(artifact));
  const auditLikeArtifact = jsonArtifacts.find((artifact) => {
    const keys = array(artifact.required_keys).map(String);
    return keys.includes("observed_actions") || keys.includes("loop_id") || keys.some((key) => key.endsWith("_completed"));
  });
  return (auditLikeArtifact || jsonArtifacts[0])?.path || "outputs/workflow_audit.json";
}

function isJsonArtifact(artifact) {
  return String(artifact.type || "").toLowerCase() === "json" || String(artifact.path || "").endsWith(".json");
}

function escapeJsonPointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function normalizeCapability(value) {
  if (typeof value === "string") return { id: value, kind: "agent_capability", risk: "low" };
  const item = object(value);
  return {
    id: required(item.id, "capability.id"),
    kind: String(item.kind || "agent_capability"),
    risk: String(item.risk || "low"),
    description: String(item.description || "")
  };
}

function normalizeEntrypoints(entrypoints) {
  return Object.fromEntries(
    Object.entries(entrypoints).map(([name, entrypoint]) => {
      if (!entrypoint || typeof entrypoint !== "object" || Array.isArray(entrypoint)) {
        throw new Error(`entrypoint ${name} must be an object`);
      }
      const item = object(entrypoint);
      if (item.command !== undefined) {
        return [name, { command: commandList(item), transport: String(item.transport || "stdio") }];
      }
      if (item.url !== undefined) {
        const url = String(item.url || "");
        if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost") && !url.startsWith("https://")) {
          throw new Error(`entrypoint ${name} url must be localhost or https`);
        }
        return [name, { url, transport: String(item.transport || "http") }];
      }
      throw new Error(`entrypoint ${name} must define command or url`);
    })
  );
}

function commandList(entrypoint) {
  const command = Array.isArray(entrypoint.command)
    ? entrypoint.command.map(String)
    : [String(entrypoint.command || ""), ...array(entrypoint.args).map(String)];
  const clean = command.filter(Boolean);
  if (!clean.length) throw new Error("entrypoint command is required");
  if (["sh", "bash", "zsh", "fish"].includes(clean[0]) && clean.some((item) => ["-c", "-lc", "-ic"].includes(item))) {
    throw new Error("agent plugin entrypoints must not use shell command strings");
  }
  return clean.slice(0, 24);
}

function normalizeTrust(trust) {
  const boundary = String(trust.mutation_boundary || trust.boundary || "read_only");
  if (!TRUST_BOUNDARIES.has(boundary)) throw new Error(`unsupported mutation boundary: ${boundary}`);
  return {
    mutation_boundary: boundary,
    requires_human_approval: trust.requires_human_approval === undefined ? boundary !== "read_only" : Boolean(trust.requires_human_approval),
    secrets_included: Boolean(trust.secrets_included),
    network_access: String(trust.network_access || "host_policy"),
    credential_boundary: String(trust.credential_boundary || "host_owned")
  };
}

function normalizeProtocols(protocols, entrypoints) {
  const values = Array.isArray(protocols)
    ? protocols.map(String)
    : Object.entries(object(protocols)).filter(([, enabled]) => enabled).map(([key]) => String(key));
  for (const entrypoint of Object.values(entrypoints)) {
    if (entrypoint.transport) values.push(String(entrypoint.transport));
  }
  return [...new Set(values.length ? values : ["agent-plugin"])].sort();
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
