/**
 * Responsibility: Pins the AD guards no other suite reaches: a correction
 *   that reuses an entry id or names an action no longer on the AD, an AD
 *   saved against another aircraft's component, and a saved AD that stays
 *   with its removed component.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/airworthiness.ts, ./model, src/data/demo.ts,
 *   tests/fixtures/workOrders.ts.
 *
 * Compliance history is append-only (ADR-0005): a refused correction must
 * leave every recorded entry as it was.
 */
import { expect, it } from "vitest";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { demoSnapshot } from "../data/demo";
import {
  applyADCommand,
  blankAD,
  blankADTask,
  clearInitialLimits,
  initialLimitLabel,
  type AD,
  type ADCompliance,
} from "./airworthiness";
import { localDate, type Snapshot } from "./model";

const DAY_MS = 86_400_000;
const TEN_DAYS_AGO = new Date(Date.parse(localDate()) - 10 * DAY_MS)
  .toISOString()
  .slice(0, 10);
const REASON = "Hours transcribed from the wrong logbook page";

it("refuses a correction that reuses a recorded entry's id, leaving the history as it was", () => {
  const { s, original } = complied();
  const before = structuredClone(current(s).history);
  expect(() =>
    correct(s, original.uuid, { uuid: original.uuid, hours: 2330 }),
  ).toThrow("Compliance entry already recorded.");
  expect(current(s).history).toEqual(before);
});

it("refuses to correct an entry whose required action is no longer on the AD", () => {
  const { s, original } = complied();
  const r = current(s);
  r.tasks = [{ ...blankADTask(), description: "Replacement action" }];
  expect(() => correct(s, original.uuid, { hours: 2330 })).toThrow(
    "Required action not found.",
  );
});

it("refuses an AD on a component recorded on another aircraft", () => {
  const s = demoSnapshot();
  s.management = [{ ...workOrderComponent(), aircraftUuid: "demo-208" }];
  expect(() =>
    applyADCommand(s, { kind: "save", record: componentAD(s) }),
  ).toThrow("Select a component belonging to this aircraft.");
});

it("keeps a saved AD with its component once the component is removed to storage", () => {
  const s = demoSnapshot();
  s.management = [workOrderComponent()];
  applyADCommand(s, { kind: "save", record: componentAD(s) });
  s.management = [
    { ...workOrderComponent(), installed: false, aircraftUuid: "" },
  ];
  const saved = current(s);
  applyADCommand(s, {
    kind: "save",
    record: { ...saved, reason: "Subject wording" },
  });
  expect(current(s).version).toBe(saved.version + 1);
});

it("returns an equal copy, not the AD itself, when the action has no stale limit", () => {
  const { s } = complied();
  const r = current(s);
  const copy = clearInitialLimits(r, "no-such-action");
  expect(copy).toEqual(r);
  expect(copy).not.toBe(r);
});

it("names an initial limit for the user by date or by its unit", () => {
  const t = { ...blankADTask(), dueDate: "2026-01-01", dueHours: 2400 };
  expect(initialLimitLabel(t, "dueDate")).toBe("due date 2026-01-01");
  expect(initialLimitLabel(t, "dueHours")).toBe("2400 hours");
});

// A reviewed airframe AD repeating every 100 h, with one compliance entry.
function complied() {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source = { ...r.source, number: "2026-01-01", recurring: "Yes" };
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect",
      intervalHours: 100,
      dueHours: 2400,
      recurrence: "Recurring",
    },
  ];
  applyADCommand(s, { kind: "save", record: r });
  const original = entry(current(s).tasks[0].uuid);
  applyADCommand(s, {
    kind: "comply",
    uuid: current(s).uuid,
    version: current(s).version,
    entry: original,
  });
  return { s, original };
}

function correct(s: Snapshot, corrects: string, patch: Partial<ADCompliance>) {
  const r = current(s);
  const shown = r.history.find((h) => h.uuid === corrects)!;
  applyADCommand(s, {
    kind: "correct",
    uuid: r.uuid,
    version: r.version,
    corrects,
    reason: REASON,
    entry: { ...shown, uuid: crypto.randomUUID(), ...patch },
  });
}

function componentAD(s: Snapshot): AD {
  const r = blankAD(s.aircraft[0].uuid);
  r.source = { ...r.source, number: "2026-02-02", section: "Engine" };
  return { ...r, componentUuid: workOrderComponent().uuid };
}

function entry(taskUuid: string): ADCompliance {
  return {
    uuid: crypto.randomUUID(),
    taskUuid,
    date: TEN_DAYS_AGO,
    hours: 2340,
    cycles: 1890,
    method: "Inspected per paragraph (g)",
    serviceBulletin: "",
    terminatedBy: "",
    workOrderUuid: "",
    mechanic: "Test mechanic",
    certificate: "12345",
    evidence: "Logbook page 42",
    recordedAt: 0,
    recordedBy: "",
  };
}

function current(s: Snapshot): AD {
  return s.airworthiness![0];
}
