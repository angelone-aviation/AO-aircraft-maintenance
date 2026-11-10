/**
 * Responsibility: Pins the due calendar's month layout: Monday-first whole
 *   weeks, month edges, leap day, daylight-saving months, agenda and undated
 *   items, and month arithmetic.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/dueCalendar.ts, ./forecast (types).
 */
import { afterEach, describe, expect, it } from "vitest";
import { dueMonth, monthOf, shiftMonth } from "./dueCalendar";
import type { Projection } from "./forecast";

type Item = { key: string; projection?: Projection };
const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("dueMonth", () => {
  it("covers the month in whole Monday-to-Sunday weeks", () => {
    // November 2026 starts on a Sunday and ends on a Monday.
    const { weeks } = dueMonth([], "2026-11");
    expect(weeks).toHaveLength(6);
    expect(weeks[0][0].date).toBe("2026-10-26");
    expect(weeks[0][6]).toMatchObject({ date: "2026-11-01", inMonth: true });
    expect(weeks[5][0]).toMatchObject({ date: "2026-11-30", inMonth: true });
    expect(weeks[5][6]).toMatchObject({ date: "2026-12-06", inMonth: false });
  });

  it("places items on the first and last day of the month and its neighbours", () => {
    const items = [
      item("before", "2026-10-31"),
      item("first", "2026-11-01"),
      item("last", "2026-11-30"),
      item("after", "2026-12-01"),
      item("outside", "2027-01-15"),
    ];
    const month = dueMonth(items, "2026-11");
    expect(keysOn(month, "2026-10-31")).toEqual(["before"]);
    expect(keysOn(month, "2026-11-01")).toEqual(["first"]);
    expect(keysOn(month, "2026-11-30")).toEqual(["last"]);
    expect(keysOn(month, "2026-12-01")).toEqual(["after"]);
    expect(month.agenda.map((d) => d.date)).toEqual([
      "2026-11-01",
      "2026-11-30",
    ]);
  });

  it("includes the leap day in a leap February only", () => {
    const leap = dueMonth([item("leap", "2028-02-29")], "2028-02");
    expect(leap.agenda).toEqual([
      {
        date: "2028-02-29",
        inMonth: true,
        items: [item("leap", "2028-02-29")],
      },
    ]);
    // February 2027 runs Monday the 1st to Sunday the 28th: four weeks.
    const plain = dueMonth([], "2027-02").weeks.flat();
    expect(plain).toHaveLength(28);
    expect(plain.every((d) => d.inMonth)).toBe(true);
    expect(plain.at(-1)!.date).toBe("2027-02-28");
  });

  it.each(["America/New_York", "Europe/London", "Australia/Sydney"])(
    "steps one calendar day at a time through daylight-saving months in %s",
    (zone) => {
      process.env.TZ = zone;
      for (const month of ["2026-03", "2026-04", "2026-10", "2026-11"]) {
        const days = dueMonth([], month).weeks.flat();
        days.slice(1).forEach((d, n) => {
          const gap = Date.parse(d.date) - Date.parse(days[n].date);
          expect(gap).toBe(86_400_000);
        });
      }
    },
  );

  it("keeps undated items aside, in order, and the order of items on a day", () => {
    const items = [
      item("hours"),
      item("b", "2026-11-12"),
      item("cycles"),
      item("a", "2026-11-12"),
    ];
    const month = dueMonth(items, "2026-11");
    expect(month.undated.map((i) => i.key)).toEqual(["hours", "cycles"]);
    expect(keysOn(month, "2026-11-12")).toEqual(["b", "a"]);
  });

  it("refuses a month that is not YYYY-MM", () => {
    expect(() => dueMonth([], "2026-13")).toThrow("Invalid month: 2026-13");
    expect(() => dueMonth([], "2026-1")).toThrow(RangeError);
  });
});

describe("month arithmetic", () => {
  it("moves across year ends both ways", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-11", -23)).toBe("2024-12");
  });

  it("reads the month of a date", () => {
    expect(monthOf("2028-02-29")).toBe("2028-02");
  });
});

function item(key: string, date?: string): Item {
  return date
    ? { key, projection: { date, basis: "calendar", overdue: false } }
    : { key };
}

function keysOn(month: ReturnType<typeof dueMonth<Item>>, date: string) {
  const day = month.weeks.flat().find((d) => d.date === date);
  return day?.items.map((i) => i.key);
}
