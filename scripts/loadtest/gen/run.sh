#!/usr/bin/env bash
# Responsibility: Bundles and runs the history generator, which writes the
#   import files to $LOADTEST_DIR/data from the seeded accounts.json.
# Layer: Script. Load test only; refuses to start unless the backend the
#   seed used is local.
# Dependencies: bash, npx esbuild (installed with vite and convex), node,
#   scripts/loadtest/gen/gen.ts, scripts/loadtest/profile.json.
#
# Usage: LOADTEST_DIR=<folder> bash scripts/loadtest/gen/run.sh
# $LOADTEST_DIR/profile.json, when present, replaces the default volume model.
set -euo pipefail
cd "$(dirname "$0")/../../.."
: "${LOADTEST_DIR:?Set LOADTEST_DIR to the folder for the load test data and results.}"
export LOADTEST_DIR
node scripts/loadtest/guard.mjs
[ -f "$LOADTEST_DIR/profile.json" ] || cp scripts/loadtest/profile.json "$LOADTEST_DIR/profile.json"
rm -rf "$LOADTEST_DIR/data"
mkdir -p "$LOADTEST_DIR/data"
npx esbuild scripts/loadtest/gen/gen.ts --bundle --platform=node --format=esm \
  --outfile="$LOADTEST_DIR/gen.bundle.mjs" --log-level=warning
node "$LOADTEST_DIR/gen.bundle.mjs"
