/**
 * Responsibility: Pins the weekly summary of the change log: the period
 *   window, family mapping, per-actor counts and order, the notable events
 *   and their precedence, refused sign-ins counted only, the reviewer's own
 *   day bounds, and the CSV rows with or without the refusals row.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/auditSummary.ts, ./model (types).
 */
import { afterEach, describe, it, expect } from "vitest";
import type { AuditEntry } from "./model";
import {
  actionFamily,
  auditSummaryCsvRows,
  FAMILY_ORDER,
  familyShares,
  summarizeAudit,
  summaryPeriod,
  withLocalBounds,
} from "./auditSummary";

// Entries are stamped at local noon so the day never shifts with the zone.
const DAY = (date: string) => new Date(date + "T12:00:00").getTime();
const PERIOD = { from: "2026-11-03", to: "2026-11-09" };

function entry(
  action: string,
  fields: Partial<AuditEntry> & { day?: string } = {},
): AuditEntry {
  const { day = "2026-11-05", ...rest } = fields;
  return {
    uuid: crypto.randomUUID(),
    actorId: "alex",
    at: DAY(day),
    action,
    entityUuid: "e",
    ...rest,
  };
}

describe("weekly summary", () => {
  it("maps action types to families and the rest to other", () => {
    expect(actionFamily("flight.dispatch_override")).toBe("flights");
    expect(actionFamily("discrepancy.resolved")).toBe("flights");
    expect(actionFamily("inspection.completed")).toBe("maintenance");
    expect(actionFamily("component.removed")).toBe("maintenance");
    expect(actionFamily("ad.correct")).toBe("ads");
    expect(actionFamily("taskCard.sign")).toBe("workOrders");
    expect(actionFamily("workOrder.save")).toBe("workOrders");
    expect(actionFamily("stock.issue")).toBe("parts");
    expect(actionFamily("po.cancel")).toBe("parts");
    expect(actionFamily("group.saved")).toBe("access");
    expect(actionFamily("faa.check")).toBe("faa");
    expect(actionFamily("manual.rename")).toBe("other");
    expect(actionFamily("nodot")).toBe("other");
  });

  it("counts the last 7 or 30 days ending today, inclusive", () => {
    expect(summaryPeriod("7d", "2026-11-09")).toEqual(PERIOD);
    expect(summaryPeriod("30d", "2026-03-01")).toEqual({
      from: "2026-01-31",
      to: "2026-03-01",
    });
  });

  it("keeps entries by local date within the period and totals per actor, most active first", () => {
    const summary = summarizeAudit(
      [
        entry("flight.created", { actorId: "sam", day: "2026-11-03" }),
        entry("flight.created", { actorId: "sam", day: "2026-11-09" }),
        entry("inspection.completed", { actorId: "alex" }),
        entry("flight.created", { actorId: "alex", day: "2026-11-02" }),
        entry("flight.created", { actorId: "alex", day: "2026-11-10" }),
        entry("manual.rename", { actorId: "pat" }),
      ],
      PERIOD,
    );
    expect(summary.total).toBe(4);
    expect(summary.actors.map((a) => [a.actorId, a.total])).toEqual([
      ["sam", 2],
      ["alex", 1],
      ["pat", 1],
    ]);
    expect(summary.actors[0].counts).toMatchObject({ flights: 2, other: 0 });
    expect(summary.families).toMatchObject({
      flights: 2,
      maintenance: 1,
      other: 1,
      ads: 0,
    });
    expect(Object.keys(summary.families)).toEqual(FAMILY_ORDER);
  });

  it("lists notable events newest first with the first matching kind", () => {
    const summary = summarizeAudit(
      [
        entry("flight.dispatch_override", {
          day: "2026-11-04",
          reason: "Ferry to maintenance base",
        }),
        entry("group.saved", { day: "2026-11-05" }),
        entry("user.permissions_changed", {
          day: "2026-11-06",
          after: JSON.stringify({ active: true, groupIds: [] }),
        }),
        entry("user.permissions_changed", {
          day: "2026-11-07",
          after: JSON.stringify({ active: false, groupIds: [] }),
        }),
        entry("user.password_reset", { day: "2026-11-03" }),
        entry("aircraft.file_archived", { day: "2026-11-08", reason: "Dup" }),
        entry("ad.correct", { day: "2026-11-09", reason: "Wrong date" }),
        entry("inspection.completed", { day: "2026-11-09" }),
        entry("component.removed", { day: "2026-11-09" }),
      ],
      PERIOD,
    );
    expect(summary.notable.map((n) => [n.action, n.kind])).toEqual([
      ["ad.correct", "correction"],
      ["aircraft.file_archived", "archive"],
      ["user.permissions_changed", "account-change"],
      ["user.permissions_changed", "permission-change"],
      ["group.saved", "permission-change"],
      ["flight.dispatch_override", "dispatch-override"],
      ["user.password_reset", "account-change"],
    ]);
    expect(summary.notable[0].reason).toBe("Wrong date");
    expect(summary.notable[0]).not.toHaveProperty("after");
  });

  it("counts refused sign-ins without listing them or their emails", () => {
    const summary = summarizeAudit(
      [
        entry("user.sign_in_refused", {
          actorId: "system",
          after: JSON.stringify({ email: "stranger@example.test" }),
        }),
        entry("user.sign_in_refused", { actorId: "system" }),
        entry("flight.created"),
      ],
      PERIOD,
    );
    expect(summary.refusedSignIns).toBe(2);
    expect(summary.total).toBe(1);
    expect(summary.actors.map((a) => a.actorId)).toEqual(["alex"]);
    expect(summary.notable).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain("stranger@");
  });

  it("writes one CSV row per actor, a column per family and a refused sign-ins row", () => {
    const summary = summarizeAudit(
      [entry("flight.created"), entry("user.sign_in_refused")],
      PERIOD,
    );
    const rows = auditSummaryCsvRows(summary, (id) => id.toUpperCase());
    expect(rows).toEqual([
      {
        Actor: "ALEX",
        "Flights and discrepancies": 1,
        "Inspections and components": 0,
        ADs: 0,
        "Work orders and job cards": 0,
        "Parts and purchasing": 0,
        "Users and access": 0,
        FAA: 0,
        Other: 0,
        Total: 1,
      },
      { Actor: "Refused sign-ins", Total: 1 },
    ]);
    // A reader who sees no refused sign-ins gets no row claiming 0.
    expect(
      auditSummaryCsvRows(summary, (id) => id, false).map((r) => r.Actor),
    ).toEqual(["alex"]);
  });

  it("counts the reviewer's own days when the period carries their midnights", () => {
    const period = {
      ...PERIOD,
      fromMs: DAY("2026-11-04"),
      toMs: DAY("2026-11-06"),
    };
    const summary = summarizeAudit(
      [
        entry("flight.created", { day: "2026-11-03" }),
        entry("flight.created", { day: "2026-11-04" }),
        entry("flight.created", { day: "2026-11-05" }),
        entry("flight.created", { day: "2026-11-06" }),
      ],
      period,
    );
    // From fromMs inclusive to toMs exclusive, whatever the dates say.
    expect(summary.total).toBe(2);
  });
});

describe("local day bounds", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  it("are the device's midnights at the start and just after the end", () => {
    process.env.TZ = "America/New_York";
    expect(withLocalBounds({ from: "2026-11-04", to: "2026-11-10" })).toEqual({
      from: "2026-11-04",
      to: "2026-11-10",
      fromMs: Date.parse("2026-11-04T05:00:00Z"),
      toMs: Date.parse("2026-11-11T05:00:00Z"),
    });
    // Across the end of daylight saving time (1 November 2026).
    expect(
      withLocalBounds({ from: "2026-10-31", to: "2026-10-31" }),
    ).toMatchObject({
      fromMs: Date.parse("2026-10-31T04:00:00Z"),
      toMs: Date.parse("2026-11-01T04:00:00Z"),
    });
  });
});

describe("familyShares", () => {
  const counts = (
    some: Partial<Record<(typeof FAMILY_ORDER)[number], number>>,
  ) =>
    ({
      ...Object.fromEntries(FAMILY_ORDER.map((f) => [f, 0])),
      ...some,
    }) as Record<(typeof FAMILY_ORDER)[number], number>;

  it("lists families with entries, most first, ties in table order", () => {
    expect(familyShares(counts({ parts: 2, flights: 2, ads: 5 }))).toEqual([
      { label: "ADs", value: 5 },
      { label: "Flights and discrepancies", value: 2 },
      { label: "Parts and purchasing", value: 2 },
    ]);
    expect(familyShares(counts({}))).toEqual([]);
  });

  it("adds the smallest up into Everything else beyond the limit", () => {
    const shares = familyShares(
      counts({
        flights: 9,
        maintenance: 7,
        ads: 5,
        workOrders: 3,
        parts: 2,
        other: 1,
      }),
    );
    expect(shares).toHaveLength(5);
    expect(shares.at(-1)).toEqual({ label: "Everything else", value: 3 });
    expect(shares.reduce((sum, s) => sum + s.value, 0)).toBe(27);
  });
});
