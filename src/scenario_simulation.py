#!/usr/bin/env python3
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener
import json
import os
import platform
import re
import ssl
import sys
import time


def stable(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    raw = value if isinstance(value, (bytes, bytearray)) else stable(value).encode()
    return sha256(raw).hexdigest()


def normalize(value):
    roles = value.get("roles") if isinstance(value, dict) else None
    if not isinstance(roles, list) or not 2 <= len(roles) <= 64:
        raise ValueError("scenario requires between 2 and 64 roles")
    rounds = int(value.get("rounds", 12))
    seed = int(value.get("seed", 1))
    if not 1 <= rounds <= 10_000 or not 1 <= seed <= 2_147_483_647:
        raise ValueError("scenario rounds or seed is outside its bounded range")
    clean_roles = []
    for role in roles:
        role_id = str(role.get("id") or "")
        if not role_id or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789._-" for ch in role_id):
            raise ValueError("scenario role id is invalid")
        clean_roles.append({
            "id": role_id,
            "label": str(role.get("label") or role_id)[:120],
            "initial_score": float(role.get("initial_score", 0)),
            "volatility": max(0.0, min(float(role.get("volatility", 1)), 100.0)),
            "cooperation_weight": max(-10.0, min(float(role.get("cooperation_weight", 0)), 10.0)),
            "relationships": {str(k): float(v) for k, v in dict(role.get("relationships") or {}).items()},
        })
    mode = "live-model" if value.get("mode") == "live-model" else "no-key"
    policy = dict(value.get("model_policy") or {})
    policy.update({
        "enabled": mode == "live-model",
        "policy": str(policy.get("policy") or ("host-default" if mode == "live-model" else "none")),
        "max_calls": int(policy.get("max_calls", rounds if mode == "live-model" else 0)),
        "max_tokens": int(policy.get("max_tokens", 4096 if mode == "live-model" else 0)),
        "max_concurrency": int(policy.get("max_concurrency", 1)),
        "max_cost_usd": float(policy.get("max_cost_usd", 0)),
        "timeout_seconds": int(policy.get("timeout_seconds", 30)),
    })
    return {
        "schema_version": "across-scenario-simulation-input/1.0",
        "title": str(value.get("title") or "Scenario Simulation")[:120],
        "objective": str(value.get("objective") or "Compare bounded role outcomes under explicit assumptions.")[:1000],
        "roles": clean_roles,
        "rounds": rounds,
        "seed": seed,
        "mode": mode,
        "assumptions": list(map(str, value.get("assumptions") or []))[:32],
        "input_sources": list(map(str, value.get("input_sources") or []))[:64],
        "model_policy": policy,
        "uncertainty_notice": "This is a bounded scenario simulation, not a prediction of the real world.",
    }


def random_stream(seed):
    state = seed & 0xFFFFFFFF
    while True:
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        state &= 0xFFFFFFFF
        yield state / 4294967296


def model_call(scenario, state, round_number, previous_summaries):
    endpoint = os.environ.get("ACROSS_MODEL_GATEWAY_URL", "")
    grant = os.environ.get("ACROSS_MODEL_GRANT_ID", "")
    parsed = urlparse(endpoint)
    if not endpoint or not grant or parsed.scheme not in {"https", "http"} or (parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}):
        raise ValueError("live-model mode requires a task-bound HTTPS Model Grant gateway")
    message = (
        f"Analyze round {round_number} of {scenario['rounds']} for this bounded scenario.\n"
        f"Objective: {scenario['objective']}\n"
        f"Roles: {stable([{'id': role['id'], 'label': role['label']} for role in scenario['roles']])}\n"
        f"Prior round summaries: {stable(previous_summaries[-2:])}\n"
        f"Current numeric state: {stable(state)}\n"
        "Return compact JSON with keys summary, turning_point, role_states, likely_next, recommendation. "
        "turning_point must be escalation, de-escalation, or stable. role_states must contain role, emotion, and action. "
        "Use the same language as the objective and describe concrete interaction behavior, not the numeric scores."
    )
    system_prompt = (
        "You create a concise, uncertainty-aware scenario narrative for a fictional bounded simulation. "
        "No deep analysis is needed. Return the final JSON directly. Do not claim to predict real people, "
        "include secrets, or expose hidden reasoning."
    )
    token_budget = int(os.environ.get("ACROSS_MODEL_MAX_TOKENS", "512"))
    estimated_input_tokens = (len(message) + len(system_prompt) + 3) // 4 + 16
    body = {
        "grant_id": grant,
        "run_id": os.environ["ACROSS_RUN_ID"],
        "job_id": os.environ["ACROSS_JOB_ID"],
        "node_id": os.environ["ACROSS_NODE_ID"],
        "purpose": "scenario_round_annotation",
        "message": message,
        "system_prompt": system_prompt,
        # Reasoning-capable providers can consume a short completion before
        # emitting final content. Keep the call within the provider's bounded
        # 2K completion contract while leaving room for the requested JSON.
        "max_tokens": min(2048, max(16, token_budget - estimated_input_tokens - 64)),
        "token_budget": token_budget,
        "timeout_seconds": int(os.environ.get("ACROSS_MODEL_TIMEOUT_SECONDS", "30")),
        "temperature": 0.2,
    }
    request = Request(endpoint, data=stable(body).encode(), headers={"content-type": "application/json", "accept": "application/json"}, method="POST")
    certificate = os.environ.get("ACROSS_MODEL_TLS_CERTIFICATE", "")
    private_key = os.environ.get("ACROSS_MODEL_TLS_PRIVATE_KEY", "")
    # The Worker-local grant proxy is the only declared network destination.
    # Disable inherited/system proxy discovery so urllib cannot silently route
    # this loopback request through a desktop VPN or HTTP proxy.
    handlers = [ProxyHandler({})]
    if parsed.scheme == "https":
        context = ssl.create_default_context(cafile=os.environ.get("ACROSS_MODEL_TLS_CA") or None)
        if certificate or private_key:
            if not certificate or not private_key:
                raise ValueError("Model Grant mTLS identity is incomplete")
            context.load_cert_chain(certificate, private_key)
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.maximum_version = ssl.TLSVersion.TLSv1_3
        handlers.append(HTTPSHandler(context=context))
    elif certificate or private_key:
        raise ValueError("Model Grant mTLS identity requires HTTPS")
    opener = build_opener(*handlers)
    with opener.open(request, timeout=int(os.environ.get("ACROSS_MODEL_TIMEOUT_SECONDS", "30"))) as response:
        value = json.loads(response.read(2 * 1024 * 1024))
    if value.get("provider_key_exposed") is True:
        raise ValueError("Model Grant gateway exposed a provider credential")
    return value


def safe_text(value, limit=600):
    text = " ".join(str(value or "").replace("\x00", " ").split()).strip()
    return text[:limit]


def model_failure_category(error):
    message = safe_text(error, 300).lower()
    if "timeout" in message or "timed out" in message:
        return "model_timeout"
    if "no final" in message or "empty" in message:
        return "model_empty_response"
    if "budget" in message or "policy" in message:
        return "model_policy_unavailable"
    return "model_provider_unavailable"


def parse_round_narrative(text, round_number, roles):
    cleaned = safe_text(text, 2000)
    candidate = cleaned
    if candidate.startswith("```"):
        candidate = candidate.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        value = json.loads(candidate)
    except (TypeError, ValueError, json.JSONDecodeError):
        value = recover_truncated_narrative(candidate) or {"summary": cleaned}
    if not isinstance(value, dict):
        value = {"summary": cleaned}
    turning_point = safe_text(value.get("turning_point"), 32).lower()
    if turning_point not in {"escalation", "de-escalation", "stable"}:
        turning_point = "stable"
    role_labels = {role["id"]: role["label"] for role in roles}
    role_states = []
    for item in value.get("role_states") or []:
        if not isinstance(item, dict):
            continue
        role = safe_text(item.get("role"), 80)
        if role in role_labels:
            role = role_labels[role]
        if not role:
            continue
        role_states.append({
            "role": role,
            "emotion": safe_text(item.get("emotion"), 120),
            "action": safe_text(item.get("action"), 240),
        })
    return {
        "round": round_number,
        "summary": safe_text(value.get("summary") or cleaned or f"Round {round_number} completed.", 600),
        "turning_point": turning_point,
        "role_states": role_states[:len(roles)],
        "likely_next": safe_text(value.get("likely_next"), 400),
        "recommendation": safe_text(value.get("recommendation"), 400),
    }


def recover_truncated_narrative(candidate):
    recovered = {}
    for key in ("summary", "turning_point", "likely_next", "recommendation"):
        match = re.search(rf'"{re.escape(key)}"\s*:\s*("(?:\\.|[^"\\])*")', str(candidate or ""), re.IGNORECASE)
        if not match:
            continue
        try:
            recovered[key] = json.loads(match.group(1))
        except (TypeError, ValueError, json.JSONDecodeError):
            # A later field may be cut off while earlier fields remain valid.
            continue
    return recovered or None


def deterministic_round_narrative(round_number, roles, events):
    labels = {role["id"]: role["label"] for role in roles}
    changes = ", ".join(
        f"{labels.get(item['role_id'], item['role_id'])} {'moved toward cooperation' if item['delta'] >= 0 else 'moved toward conflict'}"
        for item in events
    )
    average_delta = sum(item["delta"] for item in events) / max(1, len(events))
    turning_point = "de-escalation" if average_delta > 0.15 else "escalation" if average_delta < -0.15 else "stable"
    return {
        "round": round_number,
        "summary": f"Round {round_number}: {changes}.",
        "turning_point": turning_point,
        "role_states": [],
        "likely_next": "The next round remains uncertain without a model annotation.",
        "recommendation": "",
    }


def markdown_text(value):
    return safe_text(value, 1000).replace("|", "\\|")


def render_report(scenario, result, timeline, node, transport):
    timeline_rows = "\n".join(
        f"| {item['round']} | {item['turning_point']} | {markdown_text(item['summary'])} |"
        for item in timeline
    )
    turning_points = "\n".join(
        f"- Round {item['round']} · {item['turning_point']}: {item['summary']}"
        for item in timeline
        if item["turning_point"] != "stable"
    ) or "- No strong turning point was identified in this bounded run."
    recommendations = []
    for item in timeline:
        recommendation = item.get("recommendation")
        if recommendation and recommendation not in recommendations:
            recommendations.append(recommendation)
    recommendation_text = "\n".join(f"- {item}" for item in recommendations) or "- Review the event assumptions before taking real-world action."
    role_rows = "\n".join(
        f"| {markdown_text(role['label'])} | {role['final_score']} | {role['event_count']} |"
        for role in result["roles"]
    )
    return (
        f"# {scenario['title']}\n\n"
        "Verdict: completed\n\n"
        f"{scenario['uncertainty_notice']}\n\n"
        "## Scenario\n\n"
        f"{scenario['objective']}\n\n"
        f"- Run: {result['run_id']}\n- Job: {result['job_id']}\n- Execution location: {node}\n"
        f"- Platform: {platform.system().lower()}\n- Transport: {transport}\n- Mode: {scenario['mode']}\n"
        f"- Model policy: {result['model_usage']['policy']}\n- Model calls: {result['model_usage']['calls']}\n"
        f"- Model provider: {result['model_usage'].get('provider') or 'none'}\n"
        f"- Provider route: {' -> '.join(result['model_usage'].get('providers_attempted') or []) or 'none'}\n"
        f"- Model status: {'degraded with deterministic fallback' if result['model_usage'].get('degraded') else 'complete'}\n"
        f"- Model fallback rounds: {', '.join(map(str, result['model_usage'].get('fallback_rounds') or [])) or 'none'}\n"
        f"- Input sources: {len(scenario['input_sources'])}\n- Rounds: {scenario['rounds']}\n- Cleanup: worker-managed\n\n"
        "## Timeline\n\n"
        "| Round | Direction | What happened |\n| ---: | --- | --- |\n"
        f"{timeline_rows}\n\n"
        "## Turning points\n\n"
        f"{turning_points}\n\n"
        "## Most likely bounded outcome\n\n"
        f"{result['conclusion']}\n\n"
        "## Recommended next steps\n\n"
        f"{recommendation_text}\n\n"
        "## Role state\n\n"
        "| Role | Final score | Events |\n| --- | ---: | ---: |\n"
        f"{role_rows}\n\n"
        "## Uncertainty\n\n"
        f"{result['uncertainty']}\n"
    )


def main():
    if sys.argv[1:] != ["run"]:
        raise ValueError("scenario runtime expects the run command")
    input_dir = Path(os.environ["ACROSS_INPUT_DIR"])
    output_dir = Path(os.environ["ACROSS_OUTPUT_DIR"])
    output_dir.mkdir(parents=True, exist_ok=True)
    scenario = normalize(json.loads((input_dir / "input.json").read_text()))
    manifest_path = input_dir / "job-manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "schema_version": "across-job-manifest/1.0",
        "job_id": os.environ["ACROSS_JOB_ID"],
        "run_id": os.environ["ACROSS_RUN_ID"],
        "workflow_id": "scenario-simulation",
        "executor": "bounded-process",
        "manifest_hash": os.environ.get("ACROSS_MANIFEST_HASH"),
    }
    run_id, job_id = os.environ["ACROSS_RUN_ID"], os.environ["ACROSS_JOB_ID"]
    started = time.time()
    rng = random_stream(scenario["seed"])
    states = {role["id"]: {"score": role["initial_score"], "events": 0} for role in scenario["roles"]}
    timeline = []
    usage = {"schema_version": "across-model-usage/1.0", "mode": scenario["mode"], "policy": scenario["model_policy"]["policy"], "calls": 0, "failed_calls": 0, "fallback_rounds": [], "degraded": False, "provider_attempts": 0, "providers_attempted": [], "input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "provider": None, "model": None, "prompts_stored": False, "responses_stored": False, "derived_round_summaries_stored": True}
    for round_number in range(1, scenario["rounds"] + 1):
        events = []
        for role in scenario["roles"]:
            relation = sum(role["relationships"].get(other["id"], 0) for other in scenario["roles"] if other["id"] != role["id"]) / max(1, len(scenario["roles"]) - 1)
            delta = round((next(rng) - 0.5) * role["volatility"] + relation * role["cooperation_weight"], 6)
            state = states[role["id"]]
            state["score"] = round(max(-100, min(100, state["score"] + delta)), 6)
            state["events"] += 1
            events.append({"role_id": role["id"], "delta": delta, "score": state["score"]})
        narrative = deterministic_round_narrative(round_number, scenario["roles"], events)
        annotation_hash = None
        if scenario["mode"] == "live-model" and round_number <= scenario["model_policy"]["max_calls"]:
            try:
                response = model_call(
                    scenario,
                    [{"role_id": item["role_id"], "score": item["score"]} for item in events],
                    round_number,
                    [item["summary"] for item in timeline],
                )
                text = str(response.get("text") or "")[:2000]
                if not text.strip():
                    raise ValueError("live-model gateway returned no final annotation text")
                annotation_hash = digest(text.encode()) if text else None
                narrative = parse_round_narrative(text, round_number, scenario["roles"])
                raw_usage = dict(response.get("usage") or {})
                usage["calls"] += 1
                usage["input_tokens"] += int(raw_usage.get("input_tokens") or raw_usage.get("prompt_tokens") or 0)
                usage["output_tokens"] += int(raw_usage.get("output_tokens") or raw_usage.get("completion_tokens") or 0)
                usage["provider_attempts"] += int(raw_usage.get("provider_attempts") or 1)
                for provider in raw_usage.get("providers_attempted") or [response.get("provider")]:
                    clean_provider = safe_text(provider, 80)
                    if clean_provider and clean_provider not in usage["providers_attempted"]:
                        usage["providers_attempted"].append(clean_provider)
                usage["cost_usd"] = round(usage["cost_usd"] + float(raw_usage.get("cost_usd") or 0), 8)
                usage["provider"] = usage["provider"] or safe_text(response.get("provider"), 80)
                usage["model"] = usage["model"] or safe_text(response.get("model"), 120)
            except Exception as error:
                usage["failed_calls"] += 1
                usage["fallback_rounds"].append(round_number)
                usage["degraded"] = True
                usage["last_failure_category"] = model_failure_category(error)
        timeline.append({**narrative, "events": events, "model_annotation_hash": annotation_hash})
    if scenario["mode"] == "live-model" and usage["calls"] == 0 and usage["failed_calls"]:
        raise ValueError("live-model gateway was unavailable for every planned annotation")
    if usage["calls"] > scenario["model_policy"]["max_calls"] or usage["input_tokens"] + usage["output_tokens"] > scenario["model_policy"]["max_tokens"]:
        raise ValueError("scenario Model Grant budget exceeded")
    roles = [{"role_id": role["id"], "label": role["label"], "final_score": states[role["id"]]["score"], "event_count": states[role["id"]]["events"]} for role in scenario["roles"]]
    scores = [item["final_score"] for item in roles]
    final_narrative = next((item for item in reversed(timeline) if item.get("model_annotation_hash")), timeline[-1])
    conclusion = final_narrative.get("likely_next") or final_narrative.get("summary") or f"Completed {scenario['rounds']} bounded rounds across {len(roles)} roles."
    result = {"schema_version": "across-scenario-simulation-result/1.0", "run_id": run_id, "job_id": job_id, "status": "completed", "runtime_version": "1.1.5", "mode": scenario["mode"], "seed": scenario["seed"], "rounds": scenario["rounds"], "input_source_count": len(scenario["input_sources"]), "roles": roles, "metrics": {"mean_score": round(sum(scores) / len(scores), 6), "min_score": min(scores), "max_score": max(scores), "spread": round(max(scores) - min(scores), 6)}, "conclusion": conclusion, "narrative_timeline": [{key: value for key, value in item.items() if key not in {"events", "model_annotation_hash"}} for item in timeline], "uncertainty": scenario["uncertainty_notice"], "started_at": started, "ended_at": time.time(), "timeline_hash": digest(timeline), "model_usage": usage}
    result["result_hash"] = digest(result)
    node = os.environ.get("ACROSS_NODE_ID", "worker")
    report = render_report(scenario, result, timeline, node, os.environ.get("ACROSS_TRANSPORT", "unknown"))
    evidence = {"schema_version": "across-scenario-evidence/1.0", "run_id": run_id, "job_id": job_id, "manifest_hash": os.environ.get("ACROSS_MANIFEST_HASH") or manifest.get("manifest_hash") or digest(manifest), "input_hash": digest(scenario), "result_hash": result["result_hash"], "timeline_hash": result["timeline_hash"], "node": {"node_id": node}, "executor": manifest.get("executor"), "transport": os.environ.get("ACROSS_TRANSPORT", "unknown"), "model_usage": usage, "quality_gates": {"required_artifacts_present": True, "scenario_disclaimer_present": True, "evidence_complete": True}, "cleanup_status": "worker-managed"}
    evidence["evidence_hash"] = digest(evidence)
    bodies = {"job-manifest.json": stable(manifest) + "\n", "result.json": stable(result) + "\n", "report.md": report, "evidence.json": stable(evidence) + "\n", "model-usage.json": stable(usage) + "\n"}
    entries = [{"logical_name": name, "size": len(body.encode()), "sha256": digest(body.encode()), "media_type": "application/json" if name.endswith(".json") else "text/markdown"} for name, body in bodies.items()]
    artifact_manifest = {"schema_version": "across-artifact-manifest/1.0", "run_id": run_id, "job_id": job_id, "artifacts": entries, "complete": True}
    bodies["artifact-manifest.json"] = stable(artifact_manifest) + "\n"
    for name, body in bodies.items():
        (output_dir / name).write_text(body)
    print(stable({"status": "completed", "run_id": run_id, "job_id": job_id}))


if __name__ == "__main__":
    main()
