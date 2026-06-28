#!/bin/sh
set -eu
CHECK_HOME="$(mktemp -d "${TMPDIR:-/tmp}/across-autopilot-check.XXXXXX")"
trap 'rm -rf "$CHECK_HOME"' EXIT
export ACROSS_HOME="$CHECK_HOME/across-home"

echo "== whitespace =="
git diff --check

echo "== tests =="
npm test

echo "== cli smoke =="
node src/cli.js --help >/dev/null
node src/mcp-server.js --help >/dev/null

echo "Across Autopilot checks passed."
