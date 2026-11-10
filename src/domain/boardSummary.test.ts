/**
 * Responsibility: Pins the board's fleet summary: status counts, each
 *   aircraft's line, the 30-day due list's contents and order, the cost
 *   source and the backup line.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: ./boardSummary, ./boardView, ./offsiteBackups, ./model,
 *   tests/fixtures/dueFleet.ts.
 */
import { describe, expect, it } from "vitest";
import { dueFleet } from "../../tests/fixtures/dueFleet";
import { boardSummary, BOARD_DUE_HORIZON_DAYS } from "./boardSummary";
import type { BoardAircraftCosts } from "./boardView";
import { requirementSchema } from "./components";
import type { Discrepancy } from "./model";
import { offsiteFreshness } from "./offsiteBackups";

// Local noon on dueFleet's day, so localDate() gives 2026-10-30 in any zone.
const NOW = new Date(2026, 9, 30, 12).getTime();
const HOUR_MS = 3_600_000;

describe("the fleet lines", () => {
  it("counts each aircraft's status, due items and open reports, in snapshot order", () => {
    const { s, a, b } = fleet();
    s.discrepancies = [
      report(a.uuid, "grounds", { grounding: true }),
      report(a.uuid, "deferred", { grounding: true, deferral: deferral() }),
      report(a.uuid, "resolved", { grounding: true, status: "resolved" }),
      report(b.uuid, "minor", {}),
    ];
    const summary = boardSummary(s, NOW);
    expect(summary.today).toBe("2026-10-30");
    expect(summary.programName).toBe("Mission operations");
    expect(summary.fleet).toEqual({
      airworthy: 0,
      "due-soon": 0,
      "setup-incomplete": 1,
      grounded: 2,
    });
    expect(summary.overdue).toBe(7);
    expect(
      summary.aircraft.map((l) => ({
        registration: l.aircraft.registration,
        status: l.status,
        overdue: l.overdue,
        dueSoon: l.dueSoon,
        open: l.openDiscrepancies,
        grounding: l.grounding,
      })),
    ).toEqual([
      line("N206MA", "grounded", 4, 4, 2, 1),
      line("N208MA", "grounded", 3, 0, 1, 0),
      // N182MA has no components and no reviewed AD in dueFleet.
      line("N182MA", "setup-incomplete", 0, 0, 0, 0),
    ]);
  });

  it("uses the board's cost totals when the snapshot carries them", () => {
    const { s, a } = fleet();
    const totals: BoardAircraftCosts = {
      aircraftUuid: a.uuid,
      year: 2026,
      quarterLabel: "Q4 2026",
      quarterCents: 12_345,
      yearCents: 67_890,
      overBudget: true,
    };
    s.boardCosts = [totals];
    const [first, second] = boardSummary(s, NOW).aircraft;
    expect(first.costs).toBe(totals);
    expect(second.costs).toBeUndefined();
  });
});

describe("the due list", () => {
  it("lists what is overdue or due soon, worst first, then soonest by date", () => {
    const upcoming = boardSummary(fleet().s, NOW).upcoming;
    expect(upcoming.map((i) => [i.uuid, i.status, i.days])).toEqual([
      ["ad-overdue", "overdue", -2494],
      ["ad-b", "overdue", -2494],
      ["i-other", "overdue", -302],
      ["i-late", "overdue", -29],
      ["i-zero", "overdue", undefined],
      ["r-now", "overdue", undefined],
      ["r-b", "overdue", undefined],
      ["i-today", "due-soon", 0],
      ["r-today", "due-soon", 0],
      ["i-cycles", "due-soon", undefined],
      ["ad-soon", "due-soon", undefined],
    ]);
    expect(upcoming.find((i) => i.uuid === "i-late")?.registration).toBe(
      "N206MA",
    );
  });

  it(`adds a limit that is not yet due when its date is within ${BOARD_DUE_HORIZON_DAYS} days`, () => {
    const { s } = fleet();
    s.management = [
      ...(s.management ?? []),
      calendarLimit("r-in-30", "2026-11-29"),
      calendarLimit("r-in-31", "2026-11-30"),
    ];
    const upcoming = boardSummary(s, NOW).upcoming;
    expect(upcoming.find((i) => i.uuid === "r-in-30")).toMatchObject({
      status: "ok",
      days: 30,
    });
    expect(upcoming.some((i) => i.uuid === "r-in-31")).toBe(false);
  });

  it("counts an AD's days from its earliest action due date", () => {
    const { s } = fleet();
    const ad = s.airworthiness!.find((r) => r.uuid === "ad-overdue")!;
    ad.tasks = [
      { ...ad.tasks[0], uuid: "later", dueDate: "2026-12-01" },
      { ...ad.tasks[0], uuid: "earlier", dueDate: "2026-11-10" },
    ];
    const row = boardSummary(s, NOW).upcoming.find(
      (i) => i.uuid === "ad-overdue",
    );
    expect(row?.days).toBe(11);
  });
});

it("reports the off-site backup's freshness only when the snapshot carries its time", () => {
  const { s } = fleet();
  expect(boardSummary(s, NOW).backup).toBeNull();
  s.offsiteBackupAt = NOW - 2 * HOUR_MS;
  expect(boardSummary(s, NOW).backup).toEqual(
    offsiteFreshness({ completedAt: s.offsiteBackupAt }, NOW),
  );
});

// dueFleet without N182's collective inspection, whose status throws, and
// without its complied AD, whose action date was never cleared.
function fleet() {
  const f = dueFleet();
  f.s.inspections = f.s.inspections.filter((i) => i.aircraftUuid !== f.c.uuid);
  f.s.airworthiness = f.s.airworthiness?.filter(
    (r) => r.uuid !== "ad-complied",
  );
  return f;
}

function line(
  registration: string,
  status: string,
  overdue: number,
  dueSoon: number,
  open: number,
  grounding: number,
) {
  return { registration, status, overdue, dueSoon, open, grounding };
}

function report(
  aircraftUuid: string,
  uuid: string,
  fields: Partial<Discrepancy>,
): Discrepancy {
  return {
    uuid,
    aircraftUuid,
    description: uuid,
    status: "open",
    authorId: "demo-admin",
    createdAt: 0,
    ...fields,
  };
}

function deferral(): NonNullable<Discrepancy["deferral"]> {
  return {
    type: "mel",
    melItem: "24-1",
    category: "C",
    placard: "INOP",
    deferredOn: "2026-10-29",
    deferredAt: 0,
    deferredBy: "demo-admin",
    deferredByName: "Admin",
    expiresOn: "2026-11-08",
  };
}

// A calendar-only limit on N206MA's pump with no warning period, so it
// stays "ok" until its date.
function calendarLimit(uuid: string, dueDate: string) {
  return requirementSchema.parse({
    uuid,
    kind: "componentRequirement",
    version: 1,
    componentUuid: "pump",
    aircraftUuid: "",
    requirementType: "Life Limits",
    description: `${uuid} limit`,
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    warningCalendarMonths: 0,
    warningSeconds: 0,
    warningCycles: 0,
    dueDate,
  });
}
