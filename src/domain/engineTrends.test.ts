/**
 * Responsibility: Pins engine-log parsing (formats, channels, units, summary
 *   math), flags against limits, chart series, and trend commands.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/engineTrends.ts, ./rejection, tests/fixtures
 *   (JPI and Garmin exports).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ENGINE_FILE_MAX_BYTES,
  ENGINE_LIMIT_BOUNDS,
  applyEngineTrendCommand,
  channelForHeader,
  defaultEngineLimits,
  detectEngineFormat,
  engineFlags,
  engineLimitsSchema,
  engineSeries,
  hottest,
  parseEngineLog,
  parseExportDate,
  parseExportTime,
  type EngineTrend,
  type EngineTrendCommand,
  type EngineTrendData,
} from "./engineTrends";
import { Rejection } from "./rejection";
const fixture = (name: string) =>
  readFileSync(`tests/fixtures/${name}`, "utf8");
const trend = (
  summary: ReturnType<typeof parseEngineLog>,
  uuid = crypto.randomUUID(),
): EngineTrend => ({
  ...summary,
  uuid,
  aircraftUuid: "a1",
  importedAt: 1,
  importedBy: "u1",
});

describe("engine log format detection", () => {
  it("recognizes JPI EDM and Garmin headers", () => {
    expect(
      detectEngineFormat(["INDEX", "DATE", "TIME", "E1", "C1", "RPM"], false),
    ).toBe("jpi");
    expect(
      detectEngineFormat(["Lcl Date", "Lcl Time", "E1 CHT1", "E1 RPM"], false),
    ).toBe("garmin");
    expect(detectEngineFormat(["Date", "Time", "CHT1"], true)).toBe("garmin");
  });
  it("maps header variations and units annotations to channels", () => {
    expect(
      [
        "E1 CHT1",
        "CHT 1 (deg F)",
        "C1",
        "E3",
        "E1 EGT6",
        "OIL-T",
        "Oil Temp",
        "E1 OilP",
        "Oil Press (PSI)",
        "E1 FFlow",
        "Fuel Flow",
        "FF",
        "T1",
        "E1 TIT1",
        "Manifold Press",
        "E1 MAP",
        "RPM",
        "E2 CHT1",
        "OAT",
      ].map(channelForHeader),
    ).toEqual([
      "CHT1",
      "CHT1",
      "CHT1",
      "EGT3",
      "EGT6",
      "OILT",
      "OILT",
      "OILP",
      "OILP",
      "FF",
      "FF",
      "FF",
      "TIT",
      "TIT",
      "MAP",
      "MAP",
      "RPM",
      undefined,
      undefined,
    ]);
  });
  it("reads unit marks left to right, keeping an unclosed bracket as text", () => {
    expect(
      ["CHT1 (deg (F))", "CHT1 [F] °C", "CHT1 (", "CHT1 (F", "EGT1 [x"].map(
        channelForHeader,
      ),
    ).toEqual(["CHT1", "CHT1", "CHT1", undefined, undefined]);
  });
  it("reads no channel from a header cell over 240 characters", () => {
    const padded = (length: number) => "CHT1".padEnd(length, " ");
    expect([padded(240), padded(241)].map(channelForHeader)).toEqual([
      "CHT1",
      undefined,
    ]);
  });
  it("answers a header of unclosed brackets at once", () => {
    // One cell of 200,000 "(" took 16 s when each bracket rescanned the cell.
    const budgetMs = 1000;
    for (const open of ["(", "["]) {
      const started = performance.now();
      const text = `${open.repeat(200_000)},Date\n1,2\n`;
      expect(() => parseEngineLog(text, "x.csv")).toThrow(
        "Unrecognized engine data file",
      );
      expect(performance.now() - started).toBeLessThan(budgetMs);
    }
  });
  it("rejects files without engine channels", () => {
    expect(() =>
      parseEngineLog("Date,Time,Altitude\n2026-01-01,10:00:00,5000", "x.csv"),
    ).toThrow(/Unrecognized engine data file/);
  });
  it("rejects files without a date", () => {
    expect(() =>
      parseEngineLog("RPM,CHT1,CHT2\n2400,350,360", "x.csv"),
    ).toThrow(/date/);
  });
});

describe("engine summary math", () => {
  it("summarizes a JPI EDM export, excluding engine-off samples", () => {
    const s = parseEngineLog(fixture("engine-jpi-edm830.csv"), "jpi.csv");
    expect(s).toMatchObject({
      source: "jpi",
      fileName: "jpi.csv",
      date: "2026-09-14",
      start: "2026-09-14T14:00:00",
      durationSeconds: 3600,
      samples: 4,
      maxChtSpread: 95,
      maxEgtSpread: 60,
      minCruiseOilPressure: 55,
    });
    expect(s.channels.CHT1).toEqual({ max: 380, avg: 348.8 });
    expect(s.channels.CHT2).toEqual({ max: 440, avg: 387.5 });
    expect(s.channels.OILT).toEqual({ max: 195, avg: 187.5 });
    expect(s.channels.OILP).toEqual({ max: 70, avg: 53.8 });
    expect(s.channels.RPM).toEqual({ max: 2500, avg: 2125 });
    expect(s.channels.FF).toEqual({ max: 16, avg: 10.2 });
    expect(s.channels.MAP?.max).toBe(29.5);
    expect(hottest(s, "CHT")).toBe(440);
  });
  it("summarizes a Garmin G1000 log with comment lines and a units row", () => {
    const s = parseEngineLog(fixture("engine-g1000.csv"), "log_261002.csv");
    expect(s).toMatchObject({
      source: "garmin",
      date: "2026-10-02",
      durationSeconds: 3601,
      samples: 3,
      maxChtSpread: 17,
      maxEgtSpread: 30,
      minCruiseOilPressure: 22,
    });
    expect(s.channels.CHT6).toEqual({ max: 380, avg: 321.7 });
    expect(Object.keys(s.channels)).toHaveLength(17);
  });
  it("converts Celsius and kPa from a Garmin G3X log", () => {
    const s = parseEngineLog(fixture("engine-g3x-metric.csv"), "g3x.csv");
    expect(s.source).toBe("garmin");
    expect(hottest(s, "CHT")).toBe(446);
    expect(s.maxChtSpread).toBe(72);
    expect(s.channels.OILT?.max).toBe(203);
    expect(s.channels.OILP).toEqual({ max: 58, avg: 56.6 });
    expect(s.minCruiseOilPressure).toBe(55.1);
    expect(s.channels.MAP?.max).toBe(25);
  });
  it("leaves cruise oil pressure empty without an RPM channel", () => {
    const s = parseEngineLog(
      "DATE,TIME,C1,C2,OIL-P\n09/14/26,10:00:00,350,360,60\n09/14/26,10:01:00,355,380,58",
      "x.csv",
    );
    expect(s.date).toBe("2026-09-14");
    expect(s.minCruiseOilPressure).toBeUndefined();
    expect(s.maxChtSpread).toBe(25);
  });
});

describe("engine flags and commands", () => {
  it("flags CHT over the limit, wide CHT spread, and low cruise oil pressure", () => {
    const jpi = parseEngineLog(fixture("engine-jpi-edm830.csv"), "j.csv");
    expect(engineFlags(jpi, defaultEngineLimits)).toEqual([
      "Hottest CHT 440 °F exceeds the 435 °F limit.",
      "CHT spread 95 °F exceeds 50 °F.",
    ]);
    expect(engineFlags(jpi, { chtMaxF: 450, oilPressureMinPsi: 56 })).toEqual([
      "CHT spread 95 °F exceeds 50 °F.",
      "Cruise oil pressure 55 psi is below the 56 psi minimum.",
    ]);
    const g1000 = parseEngineLog(fixture("engine-g1000.csv"), "g.csv");
    expect(engineFlags(g1000, defaultEngineLimits)).toEqual([
      "Cruise oil pressure 22 psi is below the 25 psi minimum.",
    ]);
  });
  it("imports, rejects duplicates, removes, and saves limits immutably", () => {
    const summary = parseEngineLog(fixture("engine-jpi-edm830.csv"), "j.csv");
    const empty = { trends: [], limits: defaultEngineLimits };
    const uuid = crypto.randomUUID();
    const imported = applyEngineTrendCommand(
      empty,
      { action: "import", uuid, summary },
      { aircraftUuid: "a1", actorId: "u1", now: 5 },
    );
    expect(empty.trends).toHaveLength(0);
    expect(imported.created).toMatchObject({
      uuid,
      aircraftUuid: "a1",
      importedBy: "u1",
      importedAt: 5,
    });
    expect(() =>
      applyEngineTrendCommand(
        imported,
        { action: "import", uuid: crypto.randomUUID(), summary },
        { aircraftUuid: "a1", actorId: "u1", now: 6 },
      ),
    ).toThrow(/already imported/);
    expect(() =>
      applyEngineTrendCommand(
        imported,
        { action: "remove", uuid: crypto.randomUUID() },
        { aircraftUuid: "a1", actorId: "u1", now: 6 },
      ),
    ).toThrow(/not found/);
    const removed = applyEngineTrendCommand(
      imported,
      { action: "remove", uuid },
      { aircraftUuid: "a1", actorId: "u1", now: 6 },
    );
    expect(removed.trends).toHaveLength(0);
    expect(removed.removed?.uuid).toBe(uuid);
    const limits = applyEngineTrendCommand(
      imported,
      { action: "limits", limits: { chtMaxF: 420, oilPressureMinPsi: 30 } },
      { aircraftUuid: "a1", actorId: "u1", now: 6 },
    );
    expect(limits.limits).toEqual({ chtMaxF: 420, oilPressureMinPsi: 30 });
    expect(imported.limits).toEqual(defaultEngineLimits);
    expect(trend(summary).aircraftUuid).toBe("a1");
  });
});

describe("export dates, times and file rules", () => {
  it("reads ISO and US dates and 24-hour times, refusing impossible ones", () => {
    expect(
      ["2026-9-4", "9/4/26", "09/04/2026", "2026-02-30", "13/01/26", "x"].map(
        parseExportDate,
      ),
    ).toEqual([
      "2026-09-04",
      "2026-09-04",
      "2026-09-04",
      undefined,
      undefined,
      undefined,
    ]);
    expect(["9:05", "09:05:07", "24:00", "10:60"].map(parseExportTime)).toEqual(
      ["09:05:00", "09:05:07", undefined, undefined],
    );
  });

  it("refuses unusable files as a Rejection", () => {
    const log = (rows: string) => `DATE,TIME,C1,RPM\n${rows}`;
    for (const [text, message] of [
      [
        "x".repeat(7 * 1024 * 1024 + 1),
        "Engine data files must be at most 7 MiB.",
      ],
      ["Date,Altitude\n2026-01-01,5000", "Unrecognized engine data file."],
      [
        "C1,RPM\n350,2400",
        "The engine data file has no recognizable date column.",
      ],
      [
        log("x,10:00,350,2400"),
        "The engine data file has no recognizable date column.",
      ],
      [
        log("2099-01-01,10:00,350,2400"),
        "Engine data dated 2099-01-01 is in the future.",
      ],
      [
        log("2026-01-01,10:00,350,0"),
        "No engine samples were found with the engine running.",
      ],
    ]) {
      const parse = () => parseEngineLog(text, "x.csv");
      expect(parse).toThrow(Rejection);
      expect(parse).toThrow(message);
    }
    expect(() =>
      parseEngineLog(
        "DATE,TIME,C1\n2026-01-01,10:00,350\n2026-01-09,10:00,350",
        "x.csv",
      ),
    ).toThrow(z.ZodError);
  });

  it("dates a flight by its first dated row and keeps 200 characters of its name", () => {
    // Characterizes current behaviour: the date comes from the first dated
    // row even when that sample is skipped with the engine stopped.
    const s = parseEngineLog(
      "DATE,TIME,C1,RPM\n2026-01-01,23:59,300,0\n2026-01-02,00:01,350,2400",
      "f".repeat(250),
    );
    expect(s).toMatchObject({
      date: "2026-01-01",
      start: "2026-01-01T23:59:00",
      durationSeconds: 120,
      samples: 1,
    });
    expect(s.fileName).toHaveLength(200);
  });

  it("converts bar and kPa, and counts cruise from 80% of the highest RPM", () => {
    const s = parseEngineLog(
      [
        "DATE,TIME,C1 (°C),Oil Press (bar),MAP (kPa),RPM",
        "2026-01-01,10:00,100,4,100,2500",
        "2026-01-01,10:01,100,1,100,1999",
        "2026-01-01,10:02,100,3,100,2000",
      ].join("\n"),
      "x.csv",
    );
    expect(s.channels).toMatchObject({
      CHT1: { max: 212 },
      OILP: { max: 58 },
      MAP: { max: 29.5 },
    });
    expect(s.minCruiseOilPressure).toBe(43.5);
  });

  it("charts series in display order", () => {
    expect(engineSeries.map((series) => series.key)).toEqual([
      "cht",
      "chtSpread",
      "egt",
      "egtSpread",
      "tit",
      "oilt",
      "oilp",
      "rpm",
      "map",
      "ff",
    ]);
  });

  it("refuses commands as a Rejection", () => {
    const summary = parseEngineLog(fixture("engine-jpi-edm830.csv"), "j.csv");
    const context = { aircraftUuid: "a1", actorId: "u1", now: 1 };
    const full = {
      trends: Array.from({ length: 1000 }, (_, i) =>
        trend({ ...summary, samples: i + 100 }),
      ),
      limits: defaultEngineLimits,
    };
    const cases: [EngineTrendData, EngineTrendCommand, string][] = [
      [
        full,
        { action: "remove", uuid: crypto.randomUUID() },
        "Engine trend import not found.",
      ],
      [
        full,
        { action: "import", uuid: crypto.randomUUID(), summary },
        "An aircraft can keep up to 1000 engine trend imports. Remove old imports first.",
      ],
      [
        { ...full, trends: [trend(summary)] },
        { action: "import", uuid: crypto.randomUUID(), summary },
        "This engine data file was already imported.",
      ],
    ];
    for (const [data, command, message] of cases) {
      const apply = () => applyEngineTrendCommand(data, command, context);
      expect(apply).toThrow(Rejection);
      expect(apply).toThrow(message);
    }
  });
});

describe("limits shared with the engine trends form", () => {
  it("bounds each engine limit at 200–700 °F and 0–200 psi", () => {
    expect(ENGINE_LIMIT_BOUNDS).toEqual({
      chtMaxF: { min: 200, max: 700 },
      oilPressureMinPsi: { min: 0, max: 200 },
    });
    for (const [key, { min, max }] of Object.entries(ENGINE_LIMIT_BOUNDS)) {
      const valid = (value: number) =>
        engineLimitsSchema.safeParse({ ...defaultEngineLimits, [key]: value })
          .success;
      expect([min - 1, min, max, max + 1].map(valid)).toEqual([
        false,
        true,
        true,
        false,
      ]);
    }
  });

  it("refuses a file only beyond its byte limit", () => {
    const sizeRefusal = (length: number) => {
      try {
        parseEngineLog("x".repeat(length), "big.csv");
      } catch (e) {
        return (e as Error).message.startsWith("Engine data files must be");
      }
      return false;
    };
    expect(sizeRefusal(ENGINE_FILE_MAX_BYTES)).toBe(false);
    expect(sizeRefusal(ENGINE_FILE_MAX_BYTES + 1)).toBe(true);
  });
});
