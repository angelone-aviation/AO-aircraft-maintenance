/**
 * Responsibility: Pins inspection due dates, statuses, the due-soon window,
 *   the limit that drives an inspection's status and the urgency order.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/maintenance.ts, rejection.ts, model.ts (types),
 *   src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  compareInspectionUrgency,
  endOfDueMonth,
  INSPECTION_DUE_SOON_WITHIN,
  inspectionDueDate,
  inspectionDueLimit,
  inspectionStatus,
} from "./maintenance";
import { Rejection } from "./rejection";
import type { Inspection } from "./model";

const aircraft = () => demoSnapshot().aircraft[0];
const inspection = (fields: Partial<Inspection> = {}): Inspection => ({
  uuid: "i",
  aircraftUuid: aircraft().uuid,
  reference: "Annual",
  description: "",
  ...fields,
});

describe("calendar due dates", () => {
  it("runs to the end of the due month", () => {
    expect(endOfDueMonth("2026-01-15", 12)).toBe("2027-01-31");
  });
  it("refuses a malformed date or interval and a date that does not exist", () => {
    for (const [date, months] of [
      ["2026-1-15", 12],
      ["2026-01-15", 0],
      ["2026-01-15", 1.5],
    ] as const) {
      expect(() => endOfDueMonth(date, months)).toThrow(Rejection);
      expect(() => endOfDueMonth(date, months)).toThrow(
        Error("A valid date and positive month interval are required."),
      );
    }
    expect(() => endOfDueMonth("2026-02-30", 1)).toThrow(Rejection);
    expect(() => endOfDueMonth("2026-02-30", 1)).toThrow(
      Error("Invalid calendar date."),
    );
  });
  it("derives a recurring date over the saved one, and none when exempt", () => {
    const recurring = inspection({
      lastDate: "2026-01-15",
      intervalMonths: 12,
      dueDate: "2026-06-01",
    });
    expect(inspectionDueDate(recurring)).toBe("2027-01-31");
    expect(inspectionDueDate({ ...recurring, lastDate: undefined })).toBe(
      "2026-06-01",
    );
    expect(
      inspectionDueDate({ ...recurring, calendarExempt: true }),
    ).toBeUndefined();
  });
});

describe("inspection status", () => {
  it("is overdue before due soon, due soon before scheduled", () => {
    const a = aircraft();
    const status = (fields: Partial<Inspection>) =>
      inspectionStatus(inspection(fields), a, "2026-06-01").status;
    expect(status({ dueDate: "2026-05-31", dueCycles: a.cycles + 100 })).toBe(
      "overdue",
    );
    expect(status({ dueDate: "2026-06-20", dueCycles: a.cycles + 100 })).toBe(
      "due-soon",
    );
    expect(status({ dueDate: "2026-08-01", dueCycles: a.cycles + 100 })).toBe(
      "scheduled",
    );
  });
  it("reads no limit as unknown, unless calendar exempt", () => {
    const a = aircraft();
    expect(inspectionStatus(inspection(), a).status).toBe("unknown");
    expect(
      inspectionStatus(
        inspection({ calendarExempt: true, dueDate: "2020-01-01" }),
        a,
      ),
    ).toMatchObject({ status: "scheduled", daysRemaining: undefined });
  });
});

describe("the limit that drives the status", () => {
  it("prefers any overdue limit, then the lowest share of its allowance", () => {
    expect(
      inspectionDueLimit({ hoursRemaining: 1, daysRemaining: -1 }),
    ).toMatchObject({ dimension: "days", overdue: true });
    expect(
      inspectionDueLimit({ hoursRemaining: 5, daysRemaining: 6 }),
    ).toMatchObject({ dimension: "days", urgency: 0.2 });
    expect(inspectionDueLimit({})).toBeUndefined();
  });
  it("takes the first of hours, days, cycles, landings on a tie", () => {
    expect(
      inspectionDueLimit({ landingsRemaining: 5, cyclesRemaining: 5 })
        ?.dimension,
    ).toBe("cycles");
    expect(
      inspectionDueLimit({ daysRemaining: 15, hoursRemaining: 5 })?.dimension,
    ).toBe("hours");
  });
  it("is due soon within 10 hours, cycles or landings, or 30 days", () => {
    expect(INSPECTION_DUE_SOON_WITHIN).toEqual({
      hours: 10,
      days: 30,
      cycles: 10,
      landings: 10,
    });
  });
});

describe("urgency order", () => {
  it("ranks by status, then by the driving limit, with none last", () => {
    const at = (
      status: "overdue" | "due-soon" | "scheduled" | "unknown",
      hoursRemaining?: number,
    ) => ({
      name: `${status} ${hoursRemaining}`,
      status,
      limit: inspectionDueLimit({ hoursRemaining }),
    });
    const order = [
      at("unknown"),
      at("scheduled", 50),
      at("due-soon"),
      at("due-soon", 8),
      at("due-soon", 2),
      at("overdue", -1),
    ].sort(compareInspectionUrgency);
    expect(order.map((x) => x.name)).toEqual([
      "overdue -1",
      "due-soon 2",
      "due-soon 8",
      "due-soon undefined",
      "scheduled 50",
      "unknown undefined",
    ]);
  });
});
