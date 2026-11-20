#!/usr/bin/env bash
# Responsibility: A second, clean pass of the size test on a fresh local
#   database: years 1 to 3, with the browser checks that need a working
#   snapshot first (download size, a device that already holds its copy).
# Layer: Script. Load test only; deletes and refills THIS checkout's local
#   Convex database, and refuses any backend but a local one.
# Dependencies: bash, npm (dev:local, setup:auth, test:local), node,
#   scripts/loadtest/*, scripts/serve-dist.mjs serving the build on 4391.
#
# Usage, with the local backend stopped:
#   LOADTEST_DIR=<folder> bash scripts/loadtest/rerun.sh --wipe-local-database
# It leaves the local backend running, with its output in
# $LOADTEST_DIR/backend.log.
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${LOADTEST_DIR:?Set LOADTEST_DIR to the folder for the load test data and results.}"
export LOADTEST_DIR
readonly LOCAL_STATE=.convex/local/default
readonly BACKEND_LOG="$LOADTEST_DIR/backend.log"
# The precompiled backend can take minutes to download on first use.
readonly BACKEND_START_LIMIT_S=600

if [ "${1:-}" != "--wipe-local-database" ]; then
  echo "rerun.sh deletes this checkout's local Convex database; run it with --wipe-local-database." >&2
  exit 2
fi
node scripts/loadtest/guard.mjs || exit 1
mkdir -p "$LOADTEST_DIR/results" "$LOADTEST_DIR/shots"
rm -f "$LOCAL_STATE/convex_local_backend.sqlite3" .env.local-admin.json
rm -rf "$LOCAL_STATE/convex_local_storage" "$LOADTEST_DIR/browser-profile"
npm run dev:local > "$BACKEND_LOG" 2>&1 &
waited=0
until grep -q "Convex functions ready" "$BACKEND_LOG"; do
  [ "$waited" -lt "$BACKEND_START_LIMIT_S" ] || { echo "The local backend did not start; see $BACKEND_LOG." >&2; exit 1; }
  sleep 2
  waited=$((waited + 2))
done
node scripts/loadtest/guard.mjs || exit 1
npm run setup:auth >/dev/null && npm run test:local >/dev/null
node scripts/loadtest/seed.mjs && bash scripts/loadtest/gen/run.sh >/dev/null && node scripts/loadtest/load.mjs init
node scripts/loadtest/load.mjs step 1
node scripts/loadtest/measure.mjs --step y01 --no-export
node scripts/loadtest/browser.mjs --step y01
node scripts/loadtest/wsbytes.mjs --step y01
node scripts/loadtest/load.mjs step 2
node scripts/loadtest/measure.mjs --step y02 --no-export
node scripts/loadtest/wsbytes.mjs --step y02
node scripts/loadtest/returning.mjs prime
node scripts/loadtest/load.mjs step 3
node scripts/loadtest/measure.mjs --step y03 --no-export
node scripts/loadtest/returning.mjs check y03
node scripts/loadtest/blank.mjs
echo RERUN DONE
