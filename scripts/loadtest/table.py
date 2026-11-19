# Responsibility: Prints the size test's two per-step Markdown tables: the
#   workspace snapshot per role, then the other operations, from the results
#   of measure.mjs and the generator's counts.
# Layer: Script. Load test reporting; reads result files only, no backend.
# Dependencies: Python 3 standard library, scripts/loadtest/usage.py;
#   data/counts.json and results/server.jsonl under the load test's folder.
#
# Usage: python3 -I scripts/loadtest/table.py "$LOADTEST_DIR"
import json
import os
import subprocess
import sys

STEPS = [1, 2, 3, 5, 8, 10, 15, 20]
SNAPSHOT_ROLES = ("admin", "pilot", "owner", "board")
# Estimates carried over from the 2026-11 size test: documents outside the
# generated files (the seed's program, aircraft, users and groups), lookups
# that do not grow with history, and one lookup per stock record (300) and
# component (6 aircraft x 100) for a program administrator.
SEEDED_DOCUMENTS = 240
BASE_LOOKUPS = 149
INVENTORY_LOOKUPS = 900
FAILURES = (
    ("Too many bytes read", "FAIL: too many bytes read"),
    ("timed out (maximum duration: 1s)", "FAIL: 1 s time limit"),
    ("too many system operations", "FAIL: too many system operations"),
    ("Too many reads", "FAIL: too many reads"),
    ("Too many documents", "FAIL: too many documents"),
)
FAILURE_TEXT_LIMIT = 40
EXPORT_ERROR_LIMIT = 80


def slice_name(years):
    return "y%02d" % years


def read_usage(folder):
    script = os.path.join(os.path.dirname(__file__), "usage.py")
    run = subprocess.run([sys.executable, "-I", script, folder + "/results"], capture_output=True, text=True)
    return [json.loads(line) for line in run.stdout.splitlines()]


def loaded(counts, years, table):
    history = sum(counts[slice_name(i)].get(table, 0) for i in range(1, years + 1))
    return history + counts["fixed"].get(table, 0)


def total_documents(counts, years):
    history = sum(
        value
        for i in range(1, years + 1)
        for table, value in counts[slice_name(i)].items()
        if table != "airworthiness.full"
    )
    return history + sum(counts["fixed"].values()) + SEEDED_DOCUMENTS


def short(error):
    if not error:
        return ""
    return next((label for key, label in FAILURES if key in error), "FAIL: " + error[:FAILURE_TEXT_LIMIT])


def mb(size):
    return "" if size is None else "%.2f" % (size / 1e6)


def number(value):
    return f"{value:,}" if isinstance(value, int) else str(value)


class Results:
    def __init__(self, folder):
        self.counts = json.load(open(folder + "/data/counts.json"))["counts"]
        self.rows = [json.loads(line) for line in open(folder + "/results/server.jsonl")]
        self.usage = read_usage(folder)

    def usage_of(self, step, fn):
        return next((x for x in self.usage if x["step"] == step and x["fn"] == fn), None)

    def result(self, step, name, role):
        found = [r for r in self.rows if r["step"] == step and r["name"] == name and r["role"] == role]
        return found[-1] if found else None

    def outcome(self, step, role):
        found = self.result(step, "snapshot", role)
        if not found:
            return "?"
        return "ok" if found["ok"] else short(found["error"])

    def cell(self, step, name, role):
        found = self.result(step, name, role)
        if not found:
            return "?"
        usage = next((x for x in self.rows if x["step"] == step and x["name"] == "usage" and x["extra"]["of"] == name and x["role"] == role), None)
        outcome = f"ok {found['medianMs']} ms" if found["ok"] else short(found["error"])
        if not usage:
            return outcome
        e = usage["extra"]
        return outcome + f" ({number(e.get('readDocuments', '?'))} docs, {mb(e.get('readBytes'))} MB, {e.get('userExecutionMs')} ms user)"

    def export_cell(self, step):
        found = self.result(step, "convex export", "cli")
        if not found:
            return "not finished"
        if found["ok"]:
            return "%.0f s, %.1f MB" % (found["medianMs"] / 1000, found["bytes"] / 1e6)
        return found["error"][-EXPORT_ERROR_LIMIT:]


def snapshot_row(results, years):
    step = slice_name(years)
    snap = results.usage_of(step, "operations:snapshot") or {}
    cards = loaded(results.counts, years, "taskCards")
    orders = loaded(results.counts, years, "workOrders")
    returned = max(snap.get("returnBytes") or [0]) or None
    cells = [
        years, number(loaded(results.counts, years, "flights")), number(cards), number(orders),
        number(total_documents(results.counts, years)),
        " / ".join(results.outcome(step, role) for role in SNAPSHOT_ROLES),
        number(snap.get("readDocs", "")), mb(snap.get("readBytes")), mb(returned),
        number(BASE_LOOKUPS + cards + orders + INVENTORY_LOOKUPS), "/".join(map(str, snap.get("userMs", []))),
    ]
    return "| " + " | ".join(map(str, cells)) + " |"


def operations_row(results, years):
    step = slice_name(years)
    cells = [
        years,
        results.cell(step, "auditHistory.page", "admin"),
        results.cell(step, "auditHistory.summary(7d)", "admin"),
        results.cell(step, "auditHistory.summary(31d)", "admin"),
        results.cell(step, "flight.submit", "pilot"),
        results.cell(step, "flight.review(accept, oldest year)", "admin"),
        results.cell(step, "workOrder.save(new)", "mechanic"),
        results.cell(step, "taskCard.save(new)", "mechanic"),
        results.export_cell(step),
    ]
    return "| " + " | ".join(map(str, cells)) + " |"


def main(folder):
    results = Results(folder)
    print("| Years | Flights | Job cards | Work orders | All documents | Snapshot admin / pilot / owner / board | Snapshot docs read | Snapshot MB read (usage) | MB returned (admin) | Lookups (admin, est.) | Snapshot user ms min/med/max |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for years in STEPS:
        print(snapshot_row(results, years))
    print()
    print("| Years | History page | Summary 7d | Summary 31d | New flight | Held flight review | Work order save | Job card save | Export |")
    print("|---|---|---|---|---|---|---|---|---|")
    for years in STEPS:
        print(operations_row(results, years))


main(sys.argv[1])
