# Responsibility: Summarises the backend's own execution log for the size
#   test: per step and function, the uncached executions with documents and
#   bytes read, user-code time (min / median / max), errors and warnings.
# Layer: Script. Load test reporting; reads result files only, no backend.
# Dependencies: Python 3 standard library; results/server.jsonl,
#   results/browser.jsonl and results/logs-yNN.jsonl from measure.mjs.
#
# Usage: python3 -I scripts/loadtest/usage.py "$LOADTEST_DIR/results"
# A step's window runs from the previous step's last result line to its own.
import collections
import datetime
import glob
import json
import os
import statistics
import sys

# Log lines up to this long after a step's last result still belong to it.
STEP_SLACK_S = 2
TEXT_LIMIT = 175
ERROR_LIMIT = 170
# Sign-in and the measurement's own cache-busting call are not measured.
SKIPPED_FUNCTIONS = ("programs:select",)


def timestamp(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def result_rows(folder):
    paths = [os.path.join(folder, name) for name in ("server.jsonl", "browser.jsonl")]
    return [json.loads(line) for path in paths if os.path.exists(path) for line in open(path)]


def step_ends(folder):
    last = {}
    for row in result_rows(folder):
        last[row["step"]] = max(last.get(row["step"], 0), timestamp(row["at"]))
    return sorted(last.items(), key=lambda item: item[1])


def step_of(ends, moment):
    return next((name for name, end in ends if moment <= end + STEP_SLACK_S), None)


def parse_log_line(line):
    try:
        return [json.loads(line)]
    except ValueError:
        # The last line is cut off when the stream is stopped mid-write.
        return []


def log_entries(folder):
    paths = sorted(glob.glob(os.path.join(folder, "logs-y*.jsonl")))
    return [entry for path in paths for line in open(path) for entry in parse_log_line(line)]


def measured(entry):
    if entry.get("kind") != "Completion" or entry.get("cachedResult"):
        return False
    identifier = entry["identifier"]
    return not identifier.startswith("auth") and identifier not in SKIPPED_FUNCTIONS


def group_executions(folder):
    ends, seen = step_ends(folder), set()
    groups = collections.defaultdict(list)
    for entry in filter(measured, log_entries(folder)):
        if entry["executionId"] in seen:
            continue
        seen.add(entry["executionId"])
        step = step_of(ends, entry["executionTimestamp"])
        if step:
            groups[(step, entry["identifier"])].append(entry)
    return groups


def warnings(entries):
    messages = {
        message
        for entry in entries
        for line in entry.get("logLines", [])
        if isinstance(line, dict) and line.get("level") == "WARN"
        for message in line.get("messages", [])
    }
    return [m[:TEXT_LIMIT] for m in sorted(messages) if "took a long time" not in m]


def summarise(step, identifier, entries):
    failed = [e for e in entries if e.get("error")]
    ms = sorted(round(e["userExecutionTime"] * 1000) for e in entries)
    usage = max(entries, key=lambda e: e["usageStats"]["databaseReadBytes"])["usageStats"]
    return {
        "step": step, "fn": identifier, "runs": len(entries), "failed": len(failed),
        "readDocs": usage["databaseReadDocuments"], "readBytes": usage["databaseReadBytes"],
        "writeDocs": max(e["usageStats"]["databaseWriteDocuments"] for e in entries),
        "userMs": [ms[0], round(statistics.median(ms)), ms[-1]],
        "returnBytes": sorted({e.get("returnBytes") for e in entries if e.get("returnBytes")}),
        "errors": sorted({str(e["error"]).strip()[:ERROR_LIMIT] for e in failed}),
        "warnings": warnings(entries),
    }


def main(folder):
    for (step, identifier), entries in sorted(group_executions(folder).items()):
        print(json.dumps(summarise(step, identifier, entries)))


main(sys.argv[1])
