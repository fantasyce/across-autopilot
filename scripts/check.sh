#!/bin/sh
set -eu

echo "== whitespace =="
git diff --check

echo "== tests =="
npm test

echo "== cli smoke =="
node src/cli.js --help >/dev/null
node src/mcp-server.js --help >/dev/null

echo "Across Autopilot checks passed."

