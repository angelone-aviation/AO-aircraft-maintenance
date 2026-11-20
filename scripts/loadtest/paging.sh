#!/usr/bin/env bash
# Responsibility: The history-paging size sweep (ADR-0013, stage S8) on a
#   fresh local database: seed, generate, then per step load, run the release
#   steps and measure, with the backend logging its limit counts.
# Layer: Script. Load test only; deletes and refills THIS checkout's local
#   Convex database, and refuses any backend but a local one.
# Dependencies: bash, npm (dev:local, setup:auth, test:local), node,
#   scripts/loadtest/{guard,seed,load,release,paging,measure}.mjs, gen/run.sh.
#
# Usage, with the local backend stopped:
#   LOADTEST_DIR=<folder> bash scripts/loadtest/paging.sh --wipe-local-database 1 3 10 20
# It stops the backend it started when done. A failed load stops the sweep;
# a failed measurement is recorded and the sweep goes on.
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${LOADTEST_DIR:?Set LOADTEST_DIR to the folder for the load test data and results.}"
export LOADTEST_DIR
readonly LOCAL_STATE=.convex/local/default
readonly BACKEND_LOG="$LOADTEST_DIR/backend.log"
# The precompiled backend can take minutes to download on first use.
readonly BACKEND_START_LIMIT_S=600
# Below every real count, so the backend logs each call's documents, bytes
# and index ranges read as a limit warning (logUsage.mjs reads them).
readonly WARN_ON_EVERY_CALL=0.0000001

start_backend() {
  : > "$BACKEND_LOG"
  npm run dev:local > "$BACKEND_LOG" 2>&1 &
  local waited=0
  until grep -q "Convex functions ready" "$BACKEND_LOG"; do
    [ "$waited" -lt "$BACKEND_START_LIMIT_S" ] || { echo "The local backend did not start; see $BACKEND_LOG." >&2; exit 1; }
    sleep 2
    waited=$((waited + 2))
  done
  node scripts/loadtest/guard.mjs || exit 1
}

stop_backend() {
  pkill -f "convex dev --local-backend-version" || true
  pkill -f "convex-local-backend .*$PWD/$LOCAL_STATE" || true
  sleep 3
}

if [ "${1:-}" != "--wipe-local-database" ]; then
  echo "paging.sh deletes this checkout's local Convex database; run it with --wipe-local-database." >&2
  exit 2
fi
shift
node scripts/loadtest/guard.mjs || exit 1
mkdir -p "$LOADTEST_DIR/results"
rm -f "$LOCAL_STATE/convex_local_backend.sqlite3" .env.local-admin.json
rm -rf "$LOCAL_STATE/convex_local_storage"
# Setup reads CLI output, which the limit warnings would mix into.
start_backend
npm run setup:auth >/dev/null && npm run test:local >/dev/null || exit 1
node scripts/loadtest/seed.mjs && bash scripts/loadtest/gen/run.sh >/dev/null || exit 1
node scripts/loadtest/load.mjs init || exit 1
stop_backend
export FUNCTION_LIMIT_WARNING_RATIO=$WARN_ON_EVERY_CALL
start_backend
for years in "$@"; do
  step=$(printf "y%02d" "$years")
  node scripts/loadtest/load.mjs step "$years" || exit 1
  node scripts/loadtest/release.mjs --step "$step"
  node scripts/loadtest/paging.mjs --step "$step"
  node scripts/loadtest/measure.mjs --step "$step" --no-export
done
stop_backend
echo PAGING SWEEP DONE
