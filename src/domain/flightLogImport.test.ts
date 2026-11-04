/**
 * Responsibility: Pins logbook CSV parsing, import planning (matching,
 *   validation, duplicates) and submission order.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightLogImport.ts, ./model, ./rejection,
 *   src/data/demo.ts (seed), tests/fixtures logbook CSVs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { localDate, type Flight, type Snapshot } from "./model";
import {
  parseLogbook,
  planLogbookImport,
  sequenceImport,
} from "./flightLogImport";
import { Rejection } from "./rejection";
const fixture = (name: string) =>
  readFileSync(`tests/fixtures/${name}`, "utf8");
const h = (hours: number) => Math.round(hours * 3600);
const options = {
  pilotId: "demo-admin",
  operation: "Private" as const,
  flightRules: "VFR" as const,
};
function snapshotWithFlight(): Snapshot {
  const s = demoSnapshot();
  const logged: Flight = {
    uuid: crypto.randomUUID(),
    aircraftUuid: "demo-206",
    pilotId: "demo-admin",
    authorId: "demo-admin",
    submittedAt: 1,
    status: "accepted",
    startTime: new Date(2026, 8, 14, 9, 0).toISOString(),
    hobbsOff: h(2341.2),
    hobbsOn: h(2342.4),
    landings: 2,
    cycles: 0,
    origin: "kpao",
    destination: "KSQL ",
    operation: "Private",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
  return { ...s, flights: [logged] };
}

describe("logbook parsing", () => {
  it("reads the ForeFlight Flights Table after the Aircraft Table", () => {
    const { format, rows } = parseLogbook(fixture("foreflight-logbook.csv"));
    expect(format).toBe("foreflight");
    expect(rows.map((r) => r.row)).toEqual([12, 13, 14, 15, 16, 17, 18]);
    expect(rows[0]).toMatchObject({
      registration: "N206MA",
      date: "2026-09-14",
      timeOut: "14:30",
      from: "KPAO",
      to: "KSQL",
      totalSeconds: h(1.2),
      landings: 2,
      dayLandings: 1,
      nightLandings: 0,
      fullStopLandings: 1,
      hobbsEnd: h(2342.4),
      tachEnd: h(2262.2),
      comments: "Pattern work, one touch and go",
    });
    expect(rows[0].error).toBeUndefined();
    expect(rows[3].error).toMatch(/Total time is required/);
    expect(rows[4].error).toMatch(/tenths/);
    expect(rows[6]).toMatchObject({ landings: 1, nightLandings: 1 });
  });
  it("maps Garmin Pilot column names and h:mm totals", () => {
    const { format, rows } = parseLogbook(fixture("garmin-pilot-logbook.csv"));
    expect(format).toBe("garmin-pilot");
    expect(rows[0]).toMatchObject({
      row: 2,
      registration: "N206MA",
      date: "2026-09-20",
      from: "KPAO",
      to: "KMRY",
      totalSeconds: h(1.5),
      landings: 1,
      hobbsEnd: h(2344.7),
      comments: "Coastal hop",
    });
    expect(rows[1]).toMatchObject({ landings: 1, nightLandings: 1 });
    expect(rows[2]).toMatchObject({ row: 4 });
    expect(rows[2].error).toMatch(/date/i);
  });
  it("rejects files that are not logbook exports", () => {
    expect(() => parseLogbook("Name,Value\nA,1")).toThrow(
      /ForeFlight or Garmin Pilot/,
    );
    expect(() => parseLogbook("Name,Value\nA,1")).toThrow(Rejection);
  });
  it("accepts at most 20,000 flights", () => {
    const file = (records: number) =>
      "Date,Aircraft ID\n" + "2026-09-14,N206MA\n".repeat(records);
    expect(parseLogbook(file(20_000)).rows).toHaveLength(20_000);
    expect(() => parseLogbook(file(20_001))).toThrow(
      "Use at most 20,000 records per CSV file.",
    );
  });
});

describe("logbook import planning", () => {
  it("matches aircraft by registration, applies flight validation and flags duplicates", () => {
    const s = snapshotWithFlight();
    const { rows } = parseLogbook(fixture("foreflight-logbook.csv"));
    const plan = planLogbookImport(s, rows, options);
    expect(plan.otherAircraft).toBe(1);
    const byRow = new Map(plan.rows.map((r) => [r.row, r]));
    expect([...byRow.keys()]).toEqual([12, 13, 15, 16, 17, 18]);
    expect(byRow.get(12)).toMatchObject({ duplicate: true });
    const ready = byRow.get(13)!;
    expect(ready).toMatchObject({ duplicate: false, aircraftUuid: "demo-206" });
    expect(ready.error).toBeUndefined();
    expect(ready.input).toMatchObject({
      aircraftUuid: "demo-206",
      pilotId: "demo-admin",
      hobbsOn: h(2343.2),
      tachOn: undefined,
      landings: 1,
      cycles: 0,
      origin: "KSQL",
      destination: "KHAF",
      operation: "Private",
      flightRules: "VFR",
    });
    expect(localDate(Date.parse(ready.input!.startTime))).toBe("2026-09-15");
    expect(new Date(ready.input!.startTime).getHours()).toBe(9);
    expect(ready.input!.remarks).toMatch(/ForeFlight logbook row 13/);
    expect(byRow.get(15)!.error).toMatch(/Total time/);
    expect(byRow.get(16)!.error).toMatch(/tenths/);
    expect(byRow.get(17)!.error).toMatch(/future/);
    expect(byRow.get(18)!.error).toMatch(/hobbs reading is required/);
  });
  it("detects duplicates within the file and against pending entries", () => {
    const s = demoSnapshot();
    const { rows } = parseLogbook(fixture("garmin-pilot-logbook.csv"));
    const twice = planLogbookImport(
      s,
      [rows[0], { ...rows[0], row: 9 }],
      options,
    );
    expect(twice.rows.map((r) => r.duplicate)).toEqual([false, true]);
    const pending = planLogbookImport(s, [rows[0]], options, [
      twice.rows[0].input!,
    ]);
    expect(pending.rows[0].duplicate).toBe(true);
  });
  it("matches registrations loosely and duplicates within a tenth of an hour", () => {
    const s = demoSnapshot();
    const [row] = parseLogbook(fixture("garmin-pilot-logbook.csv")).rows;
    const later = (seconds: number) => ({
      ...row,
      row: 9,
      registration: "n-206ma",
      totalSeconds: row.totalSeconds! + seconds,
    });
    const plan = (seconds: number) =>
      planLogbookImport(s, [row, later(seconds)], options).rows.map(
        (r) => r.duplicate,
      );
    expect(plan(360)).toEqual([false, true]);
    expect(plan(361)).toEqual([false, false]);
  });
  it("requires engine cycles for turbine aircraft", () => {
    const s = demoSnapshot();
    const turbine = {
      ...s,
      aircraft: s.aircraft.map((a) =>
        a.uuid === "demo-206" ? { ...a, turbine: true } : a,
      ),
    };
    const { rows } = parseLogbook(fixture("garmin-pilot-logbook.csv"));
    expect(
      planLogbookImport(turbine, [rows[0]], options).rows[0].error,
    ).toMatch(/cycles/);
  });
  it("sequences selected rows chronologically like the server", () => {
    const s = demoSnapshot();
    const foreflight = parseLogbook(fixture("foreflight-logbook.csv")).rows;
    const garmin = parseLogbook(fixture("garmin-pilot-logbook.csv")).rows;
    const plan = planLogbookImport(
      s,
      [garmin[0], foreflight[1], foreflight[0]],
      options,
    );
    const sequence = sequenceImport(s, plan.rows);
    expect(sequence.map((e) => e.row.row)).toEqual([12, 13, 2]);
    expect(sequence.map((e) => e.baseVersion)).toEqual([0, 1, 2]);
    expect(sequence.every((e) => !e.reviewReason)).toBe(true);
    const stale = sequenceImport(
      {
        ...s,
        aircraft: s.aircraft.map((a) =>
          a.uuid === "demo-206" ? { ...a, currentHobbs: h(2342.8) } : a,
        ),
      },
      plan.rows,
    );
    expect(stale.map((e) => e.baseVersion)).toEqual([0, 0, 1]);
    expect(stale[0].reviewReason).toMatch(/Hobbs reading is lower/);
    expect(stale[2].reviewReason).toBeUndefined();
    const refused = { ...plan.rows[0], error: "Refused." };
    expect(sequenceImport(s, [refused, plan.rows[1]])).toHaveLength(1);
  });
});
