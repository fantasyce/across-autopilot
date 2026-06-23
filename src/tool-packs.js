export const TOOL_PACK_SCHEMA = "across-autopilot-tool-pack-registry/1.0";

const TOOL_PACKS = Object.freeze([
  {
    id: "trigger_ingestion",
    title: "Trigger Ingestion",
    capability_refs: ["runtime.trigger_queue"],
    owner: "across-autopilot",
    boundary: "wake_only",
    inputs: ["trigger_type", "payload", "idempotency_key", "not_before"],
    outputs: ["trigger_queue_item", "payload_hash", "replay_metadata"],
    input_schema: {
      type: "object",
      required: ["type"],
      properties: {
        type: { enum: ["manual", "cron", "webhook", "orchestrator_event", "memory_pending", "file_change", "daemon"] },
        payload: { type: "object" },
        idempotency_key: { type: "string" },
        not_before: { type: "string" }
      }
    },
    output_schema: {
      type: "object",
      required: ["trigger_id", "status", "trigger_event"],
      properties: {
        trigger_id: { type: "string" },
        status: { enum: ["pending", "claimed", "completed", "failed"] },
        trigger_event: { type: "object" }
      }
    },
    model_role: "decide whether the trigger should wake an existing LoopSpec",
    deterministic_role: "deduplicate payloads, persist queue state, and preserve replay evidence"
  },
  {
    id: "capability_preflight",
    title: "Capability Preflight",
    capability_refs: ["runtime.capability_preflight", "runtime.runtime_policy", "runtime.tool_pack_registry"],
    owner: "across-autopilot",
    boundary: "pre_run_gate",
    inputs: ["required_capabilities", "runtime_policy", "registered_adapters"],
    outputs: ["missing_capabilities", "runtime_policy_summary", "execution_allowed"],
    input_schema: {
      type: "object",
      required: ["required_capabilities"],
      properties: {
        required_capabilities: { type: "array" },
        runtime_policy: { type: "object" }
      }
    },
    output_schema: {
      type: "object",
      required: ["status", "missing_capabilities"],
      properties: {
        status: { enum: ["passed", "failed"] },
        missing_capabilities: { type: "array" },
        runtime_policy: { type: "object" }
      }
    },
    model_role: "explain what capability is missing and suggest a bounded fallback plan only after deterministic denial",
    deterministic_role: "block runs before source discovery when required capabilities or runtime policies are unavailable"
  },
  {
    id: "git_repo_inspection",
    title: "Git Repository Inspection",
    capability_refs: ["source.github_repo", "source.directory", "action.read_only_analysis"],
    owner: "across-autopilot",
    boundary: "read_only",
    inputs: ["repository_path", "file_globs", "max_files"],
    outputs: ["file_inventory", "manifest_summary", "git_baseline"],
    input_schema: {
      type: "object",
      required: ["repository_path"],
      properties: {
        repository_path: { type: "string" },
        file_globs: { type: "array" },
        max_files: { type: "number" }
      }
    },
    output_schema: {
      type: "object",
      required: ["file_inventory", "git_baseline"],
      properties: {
        file_inventory: { type: "array" },
        manifest_summary: { type: "object" },
        git_baseline: { type: "object" }
      }
    },
    model_role: "choose what to inspect and interpret the result",
    deterministic_role: "read repository files, git status, and manifests through bounded adapters"
  },
  {
    id: "repo_quality_inspection",
    title: "Repository Quality Inspection",
    capability_refs: ["source.github_repo", "source.directory", "action.manifest_inspection", "action.read_only_analysis"],
    owner: "across-autopilot",
    boundary: "read_only",
    inputs: ["repository_path", "manifests", "lockfiles", "source_inventory"],
    outputs: ["manifest_summary", "lockfile_summary", "repo_quality_findings"],
    input_schema: {
      type: "object",
      required: ["repository_path"],
      properties: {
        repository_path: { type: "string" },
        manifests: { type: "array" },
        lockfiles: { type: "array" }
      }
    },
    output_schema: {
      type: "object",
      required: ["manifest_summary"],
      properties: {
        manifest_summary: { type: "object" },
        repo_quality_findings: { type: "array" }
      }
    },
    model_role: "interpret repository maintainability signals and choose review focus",
    deterministic_role: "extract manifests, lockfiles, and bounded inventory evidence without mutating the repo"
  },
  {
    id: "dependency_security_review",
    title: "Dependency Security Review",
    capability_refs: ["action.manifest_inspection", "action.dependency_risk_check"],
    owner: "across-autopilot",
    boundary: "read_only_manifest_scan",
    inputs: ["dependency_manifests", "lockfiles", "install_scripts"],
    outputs: ["dependency_risks", "unpinned_dependencies", "script_risks"],
    input_schema: {
      type: "object",
      required: ["dependency_manifests"],
      properties: {
        dependency_manifests: { type: "array" },
        acceptable_script_commands: { type: "array" }
      }
    },
    output_schema: {
      type: "object",
      required: ["risks"],
      properties: {
        risks: { type: "array" },
        status: { enum: ["passed", "attention", "failed"] }
      }
    },
    model_role: "decide whether dependency risk should change the candidate plan",
    deterministic_role: "flag missing lockfiles, unpinned dependencies, and dangerous install scripts"
  },
  {
    id: "license_policy_scan",
    title: "License Policy Scan",
    capability_refs: ["action.license_check", "action.manifest_inspection"],
    owner: "across-autopilot",
    boundary: "read_only_license_scan",
    inputs: ["license_files", "package_manifests", "acceptable_licenses"],
    outputs: ["detected_licenses", "unacceptable_licenses"],
    input_schema: {
      type: "object",
      required: ["acceptable_licenses"],
      properties: {
        acceptable_licenses: { type: "array" },
        license_files: { type: "array" }
      }
    },
    output_schema: {
      type: "object",
      required: ["licenses", "status"],
      properties: {
        licenses: { type: "array" },
        status: { enum: ["passed", "failed"] }
      }
    },
    model_role: "interpret license compatibility impact for promotion",
    deterministic_role: "extract declared licenses and enforce the LoopSpec license allowlist"
  },
  {
    id: "source_research_digest",
    title: "Source Research Digest",
    capability_refs: ["source.url", "source.rss", "source.github_search", "action.source_digest"],
    owner: "across-autopilot",
    boundary: "network_adapter_scoped",
    inputs: ["source_records", "query", "recall_context"],
    outputs: ["research_signals", "source_refs"],
    input_schema: {
      type: "object",
      required: ["source_records"],
      properties: {
        source_records: { type: "array" },
        query: { type: "string" },
        recall_context: { type: "array" }
      }
    },
    output_schema: {
      type: "object",
      required: ["research_signals"],
      properties: {
        research_signals: { type: "array" },
        source_refs: { type: "array" }
      }
    },
    model_role: "judge relevance and novelty",
    deterministic_role: "normalize fetched source records into compact evidence"
  },
  {
    id: "candidate_workspace",
    title: "Candidate Workspace",
    capability_refs: ["action.candidate_ecosystem_acquire", "action.host_code_iteration", "action.candidate_ecosystem_diff"],
    owner: "across-autopilot",
    boundary: "candidate_only_mutation",
    inputs: ["candidate_manifest", "allowed_patch_paths", "validation_feedback"],
    outputs: ["candidate_diff", "patch_records"],
    input_schema: {
      type: "object",
      required: ["candidate_manifest", "allowed_patch_paths"],
      properties: {
        candidate_manifest: { type: "object" },
        allowed_patch_paths: { type: "array" },
        validation_feedback: { type: "array" }
      }
    },
    output_schema: {
      type: "object",
      required: ["candidate_diff"],
      properties: {
        candidate_diff: { type: "object" },
        patch_records: { type: "array" }
      }
    },
    model_role: "design and repair B candidate code changes",
    deterministic_role: "copy A into B/C workspaces and enforce path boundaries"
  },
  {
    id: "model_generated_fallback_plan",
    title: "Model Generated Fallback Plan",
    capability_refs: ["action.product_iteration_strategy", "action.candidate_ecosystem_validation", "action.semantic_alignment_review"],
    owner: "across-autopilot",
    boundary: "admitted_plan_only",
    inputs: ["source_signals", "recalled_memory", "path_policy", "target_repos"],
    outputs: ["candidate_targets", "selected_iteration", "admission"],
    input_schema: {
      type: "object",
      required: ["source_signals", "path_policy"],
      properties: {
        source_signals: { type: "array" },
        recalled_memory: { type: "array" },
        path_policy: { type: "object" },
        target_repos: { type: "array" }
      }
    },
    output_schema: {
      type: "object",
      required: ["selected_iteration", "admission"],
      properties: {
        candidate_targets: { type: "array" },
        selected_iteration: { type: "object" },
        admission: { type: "object" }
      }
    },
    model_role: "prepare a bounded candidate plan when no fixed target catalog or specialized tool exists",
    deterministic_role: "admit only safe repos, paths, validation commands, and review gates before B mutation"
  },
  {
    id: "validation_harness",
    title: "Validation Harness",
    capability_refs: ["action.candidate_ecosystem_validation", "action.candidate_app_lifecycle", "action.candidate_self_hosting_probe"],
    owner: "across-autopilot",
    boundary: "command_allowlist",
    inputs: ["validation_commands", "candidate_runtime_home"],
    outputs: ["validation_results", "candidate_app_lifecycle", "self_hosting_probe"],
    input_schema: {
      type: "object",
      required: ["validation_commands"],
      properties: {
        validation_commands: { type: "array" },
        candidate_runtime_home: { type: "string" }
      }
    },
    output_schema: {
      type: "object",
      required: ["validation_results"],
      properties: {
        validation_results: { type: "array" },
        candidate_app_lifecycle: { type: "object" },
        self_hosting_probe: { type: "object" }
      }
    },
    model_role: "use validation feedback to plan repairs",
    deterministic_role: "run declared commands and candidate app lifecycle probes"
  },
  {
    id: "independent_review",
    title: "Independent Review",
    capability_refs: ["action.semantic_alignment_review", "action.quality_gate_evaluation", "action.promotion_report_generation"],
    owner: "across-autopilot",
    boundary: "review_only",
    inputs: ["strategy", "diff", "validation", "candidate_evidence"],
    outputs: ["blocking_reasons", "promotion_recommendation", "review_package"],
    input_schema: {
      type: "object",
      required: ["strategy", "diff", "validation"],
      properties: {
        strategy: { type: "object" },
        diff: { type: "object" },
        validation: { type: "object" },
        candidate_evidence: { type: "object" }
      }
    },
    output_schema: {
      type: "object",
      required: ["promotion_recommendation"],
      properties: {
        blocking_reasons: { type: "array" },
        promotion_recommendation: { enum: ["review", "reject"] },
        review_package: { type: "object" }
      }
    },
    model_role: "critique whether the B result matches the product direction",
    deterministic_role: "enforce builder/reviewer separation and required gates"
  },
  {
    id: "candidate_diff_quality",
    title: "Candidate Diff Quality",
    capability_refs: ["action.candidate_ecosystem_diff", "action.semantic_alignment_review", "action.promotion_report_generation"],
    owner: "across-autopilot",
    boundary: "read_only_candidate_review",
    inputs: ["candidate_diff", "changed_files", "validation_results"],
    outputs: ["quality_findings", "reviewer_scores", "promotion_package", "source_ref_pins"],
    input_schema: {
      type: "object",
      required: ["candidate_diff"],
      properties: {
        candidate_diff: { type: "object" },
        changed_files: { type: "array" },
        validation_results: { type: "object" }
      }
    },
    output_schema: {
      type: "object",
      required: ["quality_findings", "promotion_package"],
      properties: {
        quality_findings: { type: "array" },
        reviewer_scores: { type: "object" },
        promotion_package: { type: "object" },
        source_ref_pins: { type: "object" }
      }
    },
    model_role: "interpret whether quality signals still support a reviewable product change",
    deterministic_role: "detect test-only changes, suspicious generated code, pytest test dependencies, source-ref pinning gaps, and promotion-package gaps"
  },
  {
    id: "promotion_attestation",
    title: "Promotion Attestation",
    capability_refs: ["runtime.evidence_integrity", "runtime.promotion_attestation"],
    owner: "across-autopilot",
    boundary: "review_artifact_only",
    inputs: ["promotion_package", "source_ref_pins", "reviewer_scores", "evidence_hashes"],
    outputs: ["attestation_digest", "signing_status", "human_review_packet"],
    input_schema: {
      type: "object",
      required: ["promotion_package", "source_ref_pins"],
      properties: {
        promotion_package: { type: "object" },
        source_ref_pins: { type: "object" },
        signing_key_ref: { type: "string" }
      }
    },
    output_schema: {
      type: "object",
      required: ["digest", "signing_status"],
      properties: {
        digest: { type: "string" },
        signing_status: { enum: ["signed", "unsigned_review_only"] }
      }
    },
    model_role: "decide whether the attested package is coherent enough for human PR review",
    deterministic_role: "hash provenance and expose signing status without enabling unattended merge or release"
  },
  {
    id: "evidence_integrity",
    title: "Evidence Integrity",
    capability_refs: ["runtime.evidence_integrity", "runtime.role_orchestration"],
    owner: "across-autopilot",
    boundary: "read_only_evidence",
    inputs: ["evidence_sections", "audit_events", "role_records"],
    outputs: ["section_hashes", "audit_chain_tip", "role_separation"],
    input_schema: {
      type: "object",
      required: ["evidence_sections", "audit_events"],
      properties: {
        evidence_sections: { type: "object" },
        audit_events: { type: "array" },
        role_records: { type: "array" }
      }
    },
    output_schema: {
      type: "object",
      required: ["section_hashes", "audit_chain_tip"],
      properties: {
        section_hashes: { type: "object" },
        audit_chain_tip: { type: "string" },
        role_separation: { type: "object" }
      }
    },
    model_role: "inspect evidence integrity gaps and decide whether review can proceed",
    deterministic_role: "hash evidence sections, chain audit events, and expose role separation"
  }
]);

export function listToolPacks() {
  return TOOL_PACKS.map((pack) => ({ ...pack, capability_refs: [...pack.capability_refs] }));
}

export function buildToolPackRegistry(registry = null) {
  const adapterCapabilities = registry?.capabilities ? registry.capabilities() : { sources: [], actions: [], outputs: [] };
  const available = new Set([
    ...asArray(adapterCapabilities.sources),
    ...asArray(adapterCapabilities.actions),
    ...asArray(adapterCapabilities.outputs),
    ...asArray(adapterCapabilities.runtime)
  ]);
  return {
    schema_version: TOOL_PACK_SCHEMA,
    packs: listToolPacks().map((pack) => {
      const missing = pack.capability_refs.filter((capability) => !available.has(capability));
      return {
        ...pack,
        available: missing.length === 0,
        missing_capabilities: missing
      };
    })
  };
}

export function toolPackIdsForTarget(target) {
  const text = [
    target?.id,
    target?.summary,
    target?.goal,
    ...asArray(target?.allowed_patch_paths)
  ].join(" ").toLowerCase();
  const ids = new Set();
  ids.add("capability_preflight");
  if (text.includes("tool") || text.includes("mcp") || text.includes("capabil")) ids.add("git_repo_inspection").add("candidate_workspace");
  if (text.includes("research") || text.includes("source")) ids.add("source_research_digest");
  if (text.includes("repo") || text.includes("manifest")) ids.add("repo_quality_inspection");
  if (text.includes("depend") || text.includes("security")) ids.add("dependency_security_review");
  if (text.includes("license")) ids.add("license_policy_scan");
  if (text.includes("contract") || text.includes("timeline") || text.includes("backlog")) ids.add("git_repo_inspection").add("source_research_digest");
  if (text.includes("review") || text.includes("quality") || text.includes("gate")) ids.add("independent_review").add("candidate_diff_quality");
  if (text.includes("diff") || text.includes("promotion") || text.includes("candidate")) ids.add("candidate_diff_quality").add("promotion_attestation");
  ids.add("validation_harness");
  return [...ids].sort();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
