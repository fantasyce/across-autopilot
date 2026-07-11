#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_REPO="${ACROSS_GITHUB_E2E_REPOSITORY:-}"

if [[ -z "$TARGET_REPO" ]]; then
  echo "ACROSS_GITHUB_E2E_REPOSITORY=owner/private-repo is required." >&2
  exit 2
fi

for command in gh git node python3 openssl; do
  command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 2; }
done

retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    sleep $((attempt * 2))
  done
  return 1
}

if [[ "$(retry gh api "repos/$TARGET_REPO" --jq .private)" != "true" ]]; then
  echo "The real remote E2E is restricted to a private repository." >&2
  exit 2
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BASE_BRANCH="across-e2e-base-$RUN_ID"
FEATURE_BRANCH="across-e2e-feature-$RUN_ID"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/across-github-remote-e2e.XXXXXX")"
CHECKOUT="$TMP_ROOT/repository"
FIRST_RESULT="$TMP_ROOT/first.json"
SECOND_RESULT="$TMP_ROOT/second.json"
PR_NUMBER=""

cleanup() {
  set +e
  if [[ -n "$PR_NUMBER" ]]; then
    gh api --method PATCH "repos/$TARGET_REPO/pulls/$PR_NUMBER" -f state=closed >/dev/null 2>&1 || true
  else
    local owner
    owner="${TARGET_REPO%%/*}"
    while read -r discovered_pr; do
      [[ -z "$discovered_pr" ]] || gh api --method PATCH "repos/$TARGET_REPO/pulls/$discovered_pr" -f state=closed >/dev/null 2>&1 || true
    done < <(gh api "repos/$TARGET_REPO/pulls?state=open&head=$owner:$FEATURE_BRANCH" --jq '.[].number' 2>/dev/null || true)
  fi
  if [[ -d "$CHECKOUT/.git" ]]; then
    git -C "$CHECKOUT" push origin --delete "$FEATURE_BRANCH" >/dev/null 2>&1 || true
    git -C "$CHECKOUT" push origin --delete "$BASE_BRANCH" >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_GITHUB_REMOTE_E2E_HOME:-0}" == "1" ]]; then
    echo "Preserved GitHub remote E2E home: $TMP_ROOT" >&2
  else
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

echo "== Preparing private GitHub fixture =="
retry git clone --depth 1 --filter=blob:none --sparse "git@github.com:$TARGET_REPO.git" "$CHECKOUT" >/dev/null
git -C "$CHECKOUT" sparse-checkout set --skip-checks .across .github across-e2e
DEFAULT_BRANCH="$(git -C "$CHECKOUT" branch --show-current)"
git -C "$CHECKOUT" config user.name "Across Remote E2E"
git -C "$CHECKOUT" config user.email "remote-e2e@across.invalid"
git -C "$CHECKOUT" switch -c "$BASE_BRANCH" "origin/$DEFAULT_BRANCH" >/dev/null

APPROVAL_TOKEN="$(openssl rand -hex 24)"
APPROVAL_DIGEST="$(printf '%s' "$APPROVAL_TOKEN" | shasum -a 256 | awk '{print $1}')"

python3 - "$CHECKOUT" "$TARGET_REPO" "$FEATURE_BRANCH" "$BASE_BRANCH" "$APPROVAL_DIGEST" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
repository, feature, base, digest = sys.argv[2:]
(root / ".across").mkdir(exist_ok=True)
(root / ".github" / "workflows").mkdir(parents=True, exist_ok=True)
(root / "across-e2e").mkdir(exist_ok=True)

config = {
    "schema_version": "across-autopilot-gate-config/1.0",
    "id": "real-github-remote-e2e",
    "network_policy": "allow",
    "github_remote": {
        "enabled": True,
        "repository": repository,
        "allowed_hosts": ["github.com"],
        "allowed_operations": ["push_branch", "draft_pr", "ci_watch", "check_run", "pr_comment"],
        "allowed_push_refs": [f"refs/heads/{feature}"],
        "verification_mode": "commit_status",
        "require_draft": True,
        "approval_token_env": "ACROSS_REPO_GATE_APPROVAL_TOKEN",
        "approval_token_sha256": digest,
        "auth_token_env": "GH_TOKEN",
    },
    "checks": [{
        "id": "trusted-diff-check",
        "category": "lint",
        "argv": ["git", "diff", "--check"],
        "required": True,
        "timeout_ms": 30000,
    }],
    "tools": [],
    "budget": {
        "max_commands": 4,
        "max_total_timeout_ms": 120000,
        "max_diff_bytes": 1000000,
        "max_changed_files": 40,
        "max_findings": 100,
        "max_output_bytes": 64000,
        "max_repair_actions": 2,
        "max_repair_rounds": 1,
    },
    "ci": {"required": True, "expected_checks": []},
    "policies": {
        "dirty_tree": "block",
        "base_must_be_ancestor": True,
        "codeowners": {"required": False, "require_changed_file_coverage": False},
        "generated_files": {"mode": "report", "patterns": []},
        "vulnerability": {"required_tool": False},
    },
}
(root / ".across" / "repo-push-gate.json").write_text(
    json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
(root / "across-e2e" / "README.md").write_text(
    "# Across GitHub Remote E2E\n\nTemporary trusted base for a supervised remote-gate test.\n",
    encoding="utf-8",
)
(root / ".github" / "workflows" / "across-remote-e2e.yml").write_text(
    f'''name: Across Remote Gate E2E
on:
  push:
    branches: [{feature}]
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate supervised feature
        run: |
          test -f across-e2e/feature.json
          python3 -m json.tool across-e2e/feature.json >/dev/null
''',
    encoding="utf-8",
)
PY

git -C "$CHECKOUT" add .across .github across-e2e
git -C "$CHECKOUT" commit -m "Add temporary Across remote gate base" >/dev/null
git -C "$CHECKOUT" push origin "$BASE_BRANCH" >/dev/null
git -C "$CHECKOUT" switch -c "$FEATURE_BRANCH" >/dev/null

python3 - "$CHECKOUT/across-e2e/feature.json" "$RUN_ID" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({
    "schema_version": "across-real-remote-e2e/1.0",
    "run_id": sys.argv[2],
    "checks": ["trusted-local-gate", "branch-push", "draft-pr", "github-actions", "check-run", "pr-comment"],
}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
git -C "$CHECKOUT" add across-e2e/feature.json
git -C "$CHECKOUT" commit -m "Exercise supervised GitHub remote gate" >/dev/null

export ACROSS_REPO_GATE_APPROVAL_TOKEN="$APPROVAL_TOKEN"
export GH_TOKEN="$(gh auth token)"

run_gate() {
  local output="$1"
  node "$ROOT_DIR/src/cli.js" gate \
    --repo "$CHECKOUT" \
    --base-ref "$BASE_BRANCH" \
    --head-ref HEAD \
    --push-branch \
    --draft-pr \
    --approve-remote \
    --watch-ci true \
    --ci-idle-timeout-ms 60000 \
    --ci-max-wall-timeout-ms 300000 \
    --json >"$output"
}

echo "== Running first approved remote gate =="
if ! run_gate "$FIRST_RESULT"; then
  echo "First remote gate failed; result follows:" >&2
  python3 -m json.tool "$FIRST_RESULT" >&2 || true
  exit 1
fi
PR_NUMBER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["github_remote"]["pull_request"]["number"])' "$FIRST_RESULT")"

echo "== Re-running for idempotency and recovery =="
if ! run_gate "$SECOND_RESULT"; then
  echo "Second remote gate failed; result follows:" >&2
  python3 -m json.tool "$SECOND_RESULT" >&2 || true
  exit 1
fi

REPORT_DIR="$HOME/.across/data/across-agents-assistant/release-reports"
mkdir -p "$REPORT_DIR"
REPORT_PATH="$REPORT_DIR/github-remote-e2e-$RUN_ID.json"
python3 - "$FIRST_RESULT" "$SECOND_RESULT" "$REPORT_PATH" "$TARGET_REPO" "$BASE_BRANCH" "$FEATURE_BRANCH" <<'PY'
import json
import subprocess
import sys
import time
from pathlib import Path

first = json.load(open(sys.argv[1], encoding="utf-8"))
second = json.load(open(sys.argv[2], encoding="utf-8"))
report_path = Path(sys.argv[3])
repository, base, feature = sys.argv[4:]

def gh_json(*args):
    last_error = None
    for attempt, delay in enumerate((0, 1, 2, 4, 8, 16), start=1):
        if delay:
            time.sleep(delay)
        try:
            return json.loads(subprocess.check_output(["gh", *args], text=True))
        except subprocess.CalledProcessError as error:
            last_error = error
    raise last_error

for result in (first, second):
    assert result["gate_verdict"] == "pass", result
    assert result["github_remote"]["status"] == "completed", result["github_remote"]
    assert result["github_remote"]["pull_request"]["draft"] is True
    assert result["github_remote"]["ci_watch"]["status"] == "completed"
    assert result["github_remote"]["ci_watch"]["snapshot"]["status"] == "passed"

first_ops = {item["id"]: item for item in first["github_remote"]["operations"]}
second_ops = {item["id"]: item for item in second["github_remote"]["operations"]}
assert first_ops["push_branch"]["mutation_performed"] is True
assert first_ops["push_branch"]["reconciled"] is True
assert second_ops["push_branch"]["mutation_performed"] is False
assert second_ops["push_branch"]["resumed"] is True
assert first["head_sha"] == first_ops["push_branch"]["remote_sha"]

pr_number = first["github_remote"]["pull_request"]["number"]
raw_pr = gh_json("api", f"repos/{repository}/pulls/{pr_number}")
pr = {
    "number": raw_pr["number"],
    "isDraft": raw_pr["draft"],
    "state": raw_pr["state"].upper(),
    "headRefName": raw_pr["head"]["ref"],
    "baseRefName": raw_pr["base"]["ref"],
    "url": raw_pr["html_url"],
}
assert pr["isDraft"] is True and pr["state"] == "OPEN"
assert pr["headRefName"] == feature and pr["baseRefName"] == base

comments = gh_json("api", f"repos/{repository}/issues/{pr_number}/comments")
marked = [item for item in comments if "<!-- across-autopilot:repo-push-gate -->" in item.get("body", "")]
assert len(marked) == 1, marked

checks = gh_json("api", f"repos/{repository}/commits/{first['head_sha']}/check-runs", "--header", "Accept: application/vnd.github+json")
named = [item for item in checks.get("check_runs", []) if item.get("name") == "Across Repository Push Gate"]
statuses = gh_json("api", f"repos/{repository}/commits/{first['head_sha']}/status", "--header", "Accept: application/vnd.github+json")
named_statuses = [item for item in statuses.get("statuses", []) if item.get("context") == "Across Repository Push Gate"]
assert (
    (len(named) == 1 and named[0].get("conclusion") == "success")
    or (len(named_statuses) == 1 and named_statuses[0].get("state") == "success")
), {"check_runs": named, "commit_statuses": named_statuses}
verification_mode = "check_run" if named else "commit_status_fallback"

report = {
    "schema_version": "across-github-remote-e2e/1.0",
    "status": "passed",
    "repository": repository,
    "temporary_base": base,
    "temporary_feature": feature,
    "head_sha": first["head_sha"],
    "pull_request": pr,
    "ci_status": first["github_remote"]["ci_watch"]["snapshot"]["status"],
    "ci_polls": first["github_remote"]["ci_watch"]["polls"],
    "verification_mode": verification_mode,
    "check_run_count": len(named),
    "commit_status_count": len(named_statuses),
    "marked_comment_count": len(marked),
    "idempotent_push_resumed": second_ops["push_branch"]["resumed"],
}
report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(report_path)
PY

echo "Real GitHub remote E2E passed: $REPORT_PATH"
