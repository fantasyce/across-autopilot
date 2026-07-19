#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$repo_root/dist/across-scenario-simulation-worker-pack.tar.gz}"
version="${SCENARIO_WORKER_PACK_VERSION:-1.0.11}"
source_date_epoch="${SOURCE_DATE_EPOCH:-0}"
python3 "$repo_root/scripts/build_scenario_worker_pack.py" \
  --root "$repo_root" \
  --output "$output" \
  --version "$version" \
  --source-date-epoch "$source_date_epoch"
shasum -a 256 "$output"
