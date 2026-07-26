#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_CACHE="${TOKIMETER_NPM_CACHE:-${TMPDIR:-/tmp}/tokimeter-npm-cache}"

cd "$ROOT"
mkdir -p "$NPM_CACHE"
export npm_config_cache="$NPM_CACHE"

echo "== Python CLI =="
python3 -m tokimeter.cli --version
python3 -m tokimeter.cli doctor

echo "== Python tests =="
python3 tests/test_basic.py

echo "== Node wrapper =="
cd "$ROOT/ts"
npm run build
npm test
node packages/proxy/src/cli.js help
node packages/proxy/src/cli.js --version
node packages/proxy/src/cli.js ready
node packages/proxy/src/cli.js pricing source claude-sonnet-4
node packages/proxy/src/cli.js advisor-test claude sonnet hi

echo "== Package dry runs =="
cd "$ROOT/ts"
npm run pack:core:dry
npm run pack:proxy:dry

echo "== VS Code package =="
npm run package --workspace tokimeter

echo "Smoke install checks passed."
