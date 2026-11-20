#!/usr/bin/env bash
# Responsibility: Runs the size sweep from the current state: loads each
#   step's yearly slices, then measures it (and the browser pass at 2 and 3).
# Layer: Script. Load test only; refuses any backend but a local one.
# Dependencies: bash, node, scripts/loadtest/{guard,load,measure,browser}.mjs.
#
# Usage: LOADTEST_DIR=<folder> bash scripts/loadtest/sweep.sh 2 3 5 8 10 15 20
# A failed load stops the sweep; a failed measurement is recorded and the
# sweep goes on to the next step.
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${LOADTEST_DIR:?Set LOADTEST_DIR to the folder for the load test data and results.}"
export LOADTEST_DIR
node scripts/loadtest/guard.mjs || exit 1
for years in "$@"; do
  step=$(printf "y%02d" "$years")
  node scripts/loadtest/load.mjs step "$years" || exit 1
  node scripts/loadtest/measure.mjs --step "$step"
  case "$years" in 2|3) node scripts/loadtest/browser.mjs --step "$step" ;; esac
done
echo SWEEP DONE
