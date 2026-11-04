/**
 * Responsibility: Pins AD corrections: when a save needs a reason, appended
 *   compliance corrections, and stale one-time limits left by #42.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/airworthiness.ts, ./model, src/data/demo.ts (seed).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  adSaveIsCorrection,
  adStatus,
  adTaskStatus,
  applyADCommand,
  blankAD,
  blankADTask,
  clearInitialLimits,
  effectiveCompliance,
  initialLimitClearReason,
  staleInitialLimitNotice,
  staleInitialLimits,
  type AD,
  type ADCompliance,
} from "./airworthiness";
import { localDate, type Snapshot } from "./model";

const DAY_MS = 86_400_000;
const today = localDate();
const daysAgo = (n: number) =>
  new Date(Date.parse(today + "T00:00:00Z") - n * DAY_MS)
    .toISOString()
    .slice(0, 10);
// A reviewed, applicable AD: repeat every 100 h, next due 2400 h. The demo
// aircraft reads 2341.2 h and 1894 cycles.
function setup() {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-01-01";
  r.source.subject = "Inspection";
  r.source.recurring = "Yes";
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
  return { s, r: s.airworthiness![0] };
}
const entry = (
  taskUuid: string,
  patch: Partial<ADCompliance> = {},
): ADCompliance => ({
  uuid: crypto.randomUUID(),
  taskUuid,
  date: daysAgo(10),
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
  ...patch,
});
const current = (s: Snapshot) => s.airworthiness![0];
function comply(s: Snapshot, patch: Partial<ADCompliance> = {}) {
  const r = current(s);
  const e = entry(r.tasks[0].uuid, patch);
  applyADCommand(s, {
    kind: "comply",
    uuid: r.uuid,
    version: r.version,
    entry: e,
  });
  return e;
}
function correct(
  s: Snapshot,
  corrects: string,
  patch: Partial<ADCompliance>,
  reason = "Hours transcribed from the wrong logbook page",
) {
  const r = current(s);
  // Start from the entry's current values (any entry for an unknown id).
  const shown = effectiveCompliance(r);
  const original =
    shown.find(
      (h) => (h.corrects ?? h.uuid) === corrects || h.uuid === corrects,
    ) ?? shown[0];
  const { corrects: _c, correctionReason: _r, ...values } = original;
  return applyADCommand(s, {
    kind: "correct",
    uuid: r.uuid,
    version: r.version,
    corrects,
    reason,
    entry: { ...values, uuid: crypto.randomUUID(), ...patch },
  });
}
function asMaintenance(s: Snapshot) {
  s.groups = [
    ...s.groups,
    {
      id: "mx",
      name: "Maintenance",
      programUuid: "demo-program",
      aircraftIds: [],
      permissions: ["read", "maintenance"],
    },
  ];
  s.user = { ...s.user, isAdmin: false, groupIds: ["mx"] };
}
function asProgramAdmin(s: Snapshot) {
  s.groups = [
    ...s.groups,
    {
      id: "pa",
      name: "Administrators",
      programUuid: "demo-program",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    },
  ];
  s.user = { ...s.user, isAdmin: false, groupIds: ["pa"] };
}
/** One imported AD, awaiting its first review. */
function importForReview() {
  const s = demoSnapshot();
  applyADCommand(s, {
    kind: "import",
    aircraftUuid: s.aircraft[0].uuid,
    entries: [
      {
        componentUuid: "",
        source: { ...blankAD("").source, number: "2026-05-05", subject: "X" },
      },
    ],
  });
  return { s, imported: current(s) };
}

describe("AD correction reasons", () => {
  it("needs a reason to change an AD once its applicability is decided, but not for its first review", () => {
    const { s, imported } = importForReview();
    expect(adSaveIsCorrection(undefined)).toBe(false);
    expect(adSaveIsCorrection(imported)).toBe(false);
    // The first review decides applicability; it is not a correction.
    applyADCommand(s, {
      kind: "save",
      record: {
        ...imported,
        applicability: "Not applicable",
        reason: "Serial outside paragraph (c).",
        reviewRequired: false,
      },
    });
    const decided = current(s);
    expect(adSaveIsCorrection(decided)).toBe(true);
    const change = { ...decided, reason: "Serial outside paragraph (d)." };
    expect(() => applyADCommand(s, { kind: "save", record: change })).toThrow(
      "reason for changing",
    );
    expect(() =>
      applyADCommand(s, { kind: "save", record: change, reason: "   " }),
    ).toThrow("reason for changing");
    expect(current(s).version).toBe(decided.version);
    applyADCommand(s, {
      kind: "save",
      record: change,
      reason: "Applicability paragraph reference corrected.",
    });
    expect(current(s).reason).toBe("Serial outside paragraph (d).");
  });
  it("treats an AD with compliance history as decided even when it is back under review", () => {
    const { s, r } = setup();
    comply(s);
    const reopened = { ...current(s), applicability: "Needs review" as const };
    expect(adSaveIsCorrection(reopened)).toBe(true);
    expect(adSaveIsCorrection({ ...r, applicability: "Needs review" })).toBe(
      false,
    );
  });
});

describe("AD compliance corrections", () => {
  it("lets only a Flight Program administrator correct a compliance record and keeps the original", () => {
    const { s } = setup();
    const original = comply(s, { hours: 2340 });
    expect(current(s).tasks[0].dueHours).toBe(2440);
    asMaintenance(s);
    expect(() => correct(s, original.uuid, { hours: 2330 })).toThrow(
      "Flight Program administrator",
    );
    expect(current(s).history).toHaveLength(1);
    asProgramAdmin(s);
    expect(() => correct(s, original.uuid, { hours: 2330 }, "  ")).toThrow();
    correct(s, original.uuid, { hours: 2330 });
    const r = current(s);
    // Append-only: the original stays exactly as recorded.
    expect(r.history).toHaveLength(2);
    expect(r.history[0]).toEqual({
      ...original,
      recordedAt: r.history[0].recordedAt,
      recordedBy: r.history[0].recordedBy,
    });
    expect(r.history[1]).toMatchObject({
      corrects: original.uuid,
      correctionReason: "Hours transcribed from the wrong logbook page",
      hours: 2330,
      recordedBy: s.user.id,
    });
    expect(effectiveCompliance(r)).toEqual([r.history[1]]);
    // The latest entry drives the next due, so its correction does too.
    expect(r.tasks[0].dueHours).toBe(2430);
  });
  it("keeps maintenance permission for recording new compliance", () => {
    const { s } = setup();
    asMaintenance(s);
    comply(s);
    expect(current(s).history).toHaveLength(1);
  });
  it("requires a change that fits between the neighbouring entries and resolves corrections of corrections", () => {
    const { s } = setup();
    const first = comply(s, { date: daysAgo(20), hours: 2300 });
    comply(s, { date: daysAgo(10), hours: 2340 });
    expect(() => correct(s, first.uuid, {})).toThrow("Change at least one");
    expect(() => correct(s, first.uuid, { date: daysAgo(5) })).toThrow(
      "after the next compliance entry",
    );
    expect(() => correct(s, first.uuid, { hours: 2350 })).toThrow(
      "after the next compliance entry",
    );
    expect(() =>
      correct(s, first.uuid, { taskUuid: crypto.randomUUID() }),
    ).toThrow("same required action");
    correct(s, first.uuid, { hours: 2290 });
    // An earlier entry's correction leaves the next due from the latest one.
    expect(current(s).tasks[0].dueHours).toBe(2440);
    const firstCorrection = current(s).history[2];
    correct(s, firstCorrection.uuid, { hours: 2295 }, "Second look at page");
    const r = current(s);
    expect(r.history).toHaveLength(4);
    expect(r.history[3].corrects).toBe(first.uuid);
    expect(effectiveCompliance(r).map((h) => h.hours)).toEqual([2295, 2340]);
    expect(() => correct(s, crypto.randomUUID(), { hours: 2296 })).toThrow(
      "not found",
    );
  });
  it("ignores a correction link sent with new compliance", () => {
    const { s, r } = setup();
    applyADCommand(s, {
      kind: "comply",
      uuid: r.uuid,
      version: r.version,
      entry: {
        ...entry(r.tasks[0].uuid),
        corrects: crypto.randomUUID(),
        correctionReason: "Forged",
      } as ADCompliance,
    });
    expect(current(s).history[0]).not.toHaveProperty("corrects");
    expect(current(s).history[0]).not.toHaveProperty("correctionReason");
  });
});

// What a compliance recorded before the #42 fix left behind: the repeating
// hours limit advanced, the one-time initial date stayed.
function staleRecord(patch: Partial<AD["tasks"][number]> = {}) {
  const { s } = setup();
  const stored = structuredClone(current(s));
  const done = entry(stored.tasks[0].uuid, { date: daysAgo(5) });
  stored.history = [{ ...done, recordedAt: Date.now(), recordedBy: s.user.id }];
  Object.assign(stored.tasks[0], {
    dueHours: 2440,
    dueDate: daysAgo(1),
    ...patch,
  });
  s.airworthiness = [stored];
  return { s, r: stored, done };
}
describe("stale initial AD limits", () => {
  it("flags a one-time limit left on a recurring action after compliance", () => {
    const { s, r, done } = staleRecord();
    expect(adStatus(s, r)).toBe("Overdue");
    expect(staleInitialLimits(r)).toEqual([
      {
        taskUuid: r.tasks[0].uuid,
        limits: ["dueDate"],
        complianceDate: done.date,
      },
    ]);
    const counters = staleRecord({
      dueDate: "",
      dueCycles: 1900,
      dueLandings: 2300,
    });
    expect(staleInitialLimits(counters.r)[0].limits).toEqual([
      "dueCycles",
      "dueLandings",
    ]);
    const hours = staleRecord({
      dueDate: "",
      intervalHours: null,
      intervalCycles: 100,
      dueCycles: 1990,
    });
    expect(staleInitialLimits(hours.r)[0].limits).toEqual(["dueHours"]);
  });
  it("does not flag limits that repeat, actions without compliance or ADs that no longer recur", () => {
    expect(staleInitialLimits(staleRecord({ intervalDays: 30 }).r)).toEqual([]);
    const none = staleRecord();
    none.r.history = [];
    expect(staleInitialLimits(none.r)).toEqual([]);
    const terminated = staleRecord();
    terminated.r.history[0].terminatedBy = "Replaced fitting per (h)";
    expect(staleInitialLimits(terminated.r)).toEqual([]);
    // A one-time action has no repeat interval; its limits are not stale.
    expect(
      staleInitialLimits(
        staleRecord({ intervalHours: null, recurrence: "One-time" }).r,
      ),
    ).toEqual([]);
    const notApplicable = staleRecord();
    notApplicable.r.applicability = "Not applicable";
    expect(staleInitialLimits(notApplicable.r)).toEqual([]);
  });
  it("clears a stale limit through the normal AD save with a prefilled reason", () => {
    const { s, r, done } = staleRecord();
    const [stale] = staleInitialLimits(r);
    const cleared = clearInitialLimits(r, stale.taskUuid);
    expect(cleared.tasks[0]).toMatchObject({ dueDate: "", dueHours: 2440 });
    // The stored record is untouched until the save.
    expect(r.tasks[0].dueDate).toBe(daysAgo(1));
    expect(() => applyADCommand(s, { kind: "save", record: cleared })).toThrow(
      "reason for changing",
    );
    expect(staleInitialLimitNotice(r, stale)).toBe(
      `This one-time limit (due date ${daysAgo(1)}) was not cleared when compliance was recorded on ${done.date}. If compliance satisfied it, clear it.`,
    );
    const reason = initialLimitClearReason(r, stale);
    expect(reason).toContain(done.date);
    expect(reason).toContain(`due date ${daysAgo(1)}`);
    applyADCommand(s, { kind: "save", record: cleared, reason });
    const saved = current(s);
    expect(saved.tasks[0].dueDate).toBe("");
    expect(saved.history).toHaveLength(1);
    expect(adTaskStatus(s, saved, saved.tasks[0])).toBe("Scheduled");
    expect(adStatus(s, saved)).toBe("Scheduled");
    expect(staleInitialLimits(saved)).toEqual([]);
  });
});
