/**
 * Responsibility: Pins the FAA DRS searches that monitor an aircraft, and how
 *   their results merge into one candidate list.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/faaMonitoringSearch.ts, ./components,
 *   ./airworthiness, ./faa, ./rejection, src/data/demo.ts (seed).
 */
import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { componentSchema } from "./components";
import { blankAD } from "./airworthiness";
import { drsCandidate, type FaaCandidate } from "./faa";
import {
  mergeMonitoringCandidates,
  monitoringQueries,
  monitoringScope,
} from "./faaMonitoringSearch";
import { Rejection } from "./rejection";

function engineScope() {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  a.model = "441";
  const engine = componentSchema.parse({
    kind: "component",
    uuid: "engine",
    version: 0,
    aircraftUuid: a.uuid,
    componentType: "Engine",
    model: "TPE331-10N",
    manufacturer: "Honeywell",
    partNumber: "TPE 331-10N-5115",
    serial: "1",
    notes: "",
    installed: true,
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 0,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 0,
    serviceDaysBase: 0,
  });
  s.management = [engine];
  s.airworthiness = [];
  return { s, a, engine };
}

it("uses typed models, checks tracked AD numbers, and searches keywords only when explicitly needed", () => {
  const { s, a, engine } = engineScope();
  s.management = [engine, { ...engine, uuid: "engine2", serial: "2" }];
  s.airworthiness = [
    {
      ...blankAD(a.uuid),
      source: { ...blankAD(a.uuid).source, number: "2026-01-01" },
    },
  ];
  const queries = monitoringQueries(s, a.uuid);
  expect(queries).toHaveLength(6);
  expect(queries.every((q) => !q.filters.Keyword)).toBe(true);
  expect(
    queries.some(
      (q) =>
        q.filters["drs:adfrawdProductType"]?.[0] === "Engine" &&
        q.filters["drs:adfrawdModel"]?.[0] === "TPE331-10N",
    ),
  ).toBe(true);
  expect(
    queries.some((q) => q.filters["drs:documentNumber"]?.[0] === "2026-01-01"),
  ).toBe(true);
  const before = monitoringScope(s, a.uuid);
  engine.componentType = "Appliance";
  expect(monitoringScope(s, a.uuid)).not.toEqual(before);
  expect(
    monitoringQueries(s, a.uuid, ["custom keyword"]).filter(
      (q) => q.filters.Keyword,
    ),
  ).toHaveLength(2);
  engine.model = "";
  expect(
    monitoringQueries(s, a.uuid).some(
      (q) => q.filters.Keyword?.[0] === engine.partNumber,
    ),
  ).toBe(true);
});

it("refuses an asset with nothing to search by, and shows the refusal as the scope", () => {
  const { s, a, engine } = engineScope();
  engine.model = "";
  engine.partNumber = "";
  const message =
    "Engine: enter a model, FAA search model, or component part number before checking.";
  expect(() => monitoringQueries(s, a.uuid)).toThrow(Rejection);
  expect(() => monitoringQueries(s, a.uuid)).toThrow(message);
  expect(monitoringScope(s, a.uuid)).toEqual([message]);
});

it("lists the scope sorted, not in search order", () => {
  const { s, a } = engineScope();
  expect(monitoringScope(s, a.uuid, ["governor"])[0]).toBe(
    'ADFRAWD: {"Keyword":["governor"],"drs:status":["Current"]}',
  );
});

it("merges repeated searches into the first, with the later label", () => {
  const { s, a, engine } = engineScope();
  s.management = [
    engine,
    { ...engine, uuid: "engine2", serial: "2", installPosition: "RIGHT" },
  ];
  const engines = monitoringQueries(s, a.uuid).filter((q) =>
    q.assetIds.includes("engine"),
  );
  expect(engines.map((q) => [q.type, q.label, q.assetIds])).toEqual([
    ["ADFRAWD", "Engine · RIGHT: Engine TPE331-10N", ["engine", "engine2"]],
    ["ADFREAD", "Engine · RIGHT: Engine TPE331-10N", ["engine", "engine2"]],
  ]);
});

it("searches tracked AD numbers ten at a time, and each extra keyword once", () => {
  const { s, a } = engineScope();
  const numbers = Array.from({ length: 11 }, (_, i) => `2026-${i + 10}-01`);
  s.airworthiness = [...numbers, numbers[0]].map((number) => ({
    ...blankAD(a.uuid),
    source: { ...blankAD(a.uuid).source, number },
  }));
  const extra = [" governor ", "governor", " "];
  const queries = monitoringQueries(s, a.uuid, extra).filter(
    (q) => !q.assetIds.length && q.type === "ADFRAWD",
  );
  expect(queries).toEqual([
    {
      type: "ADFRAWD",
      filters: {
        "drs:documentNumber": numbers.slice(0, 10),
        "drs:status": ["Current", "Historical"],
      },
      assetIds: [],
      label: `Tracked ADs: ${numbers.slice(0, 10).join(", ")}`,
    },
    {
      type: "ADFRAWD",
      filters: {
        "drs:documentNumber": [numbers[10]],
        "drs:status": ["Current", "Historical"],
      },
      assetIds: [],
      label: `Tracked ADs: ${numbers[10]}`,
    },
    {
      type: "ADFRAWD",
      filters: { Keyword: ["governor"], "drs:status": ["Current"] },
      assetIds: [],
      label: "Additional keyword: governor",
    },
  ]);
});

it("merges a search's candidates by id with every finding search's assets, up to 400", () => {
  const candidate = (guid: string) =>
    drsCandidate(
      { documentGuid: guid, "drs:documentNumber": `2026-${guid}` },
      "ADFRAWD",
    );
  const query = (label: string, assetIds: string[]) => ({
    type: "ADFRAWD" as const,
    filters: { Keyword: [label] },
    label,
    assetIds,
  });
  const found = new Map<string, FaaCandidate>();
  mergeMonitoringCandidates(found, query("A", ["engine"]), [candidate("1")]);
  mergeMonitoringCandidates(found, query("B", []), [
    candidate("2"),
    candidate("1"),
  ]);
  mergeMonitoringCandidates(found, query("C", ["prop", "engine"]), [
    candidate("1"),
  ]);
  expect([...found.values()].map((c) => [c.id, c.matchedAssetIds])).toEqual([
    ["ADFRAWD:1", ["engine", "prop"]],
    ["ADFRAWD:2", undefined],
  ]);
  const many = Array.from({ length: 398 }, (_, i) => candidate(`m${i}`));
  mergeMonitoringCandidates(found, query("D", []), many);
  const attempt = () =>
    mergeMonitoringCandidates(found, query("E", []), [candidate("extra")]);
  expect(attempt).toThrow(Rejection);
  expect(attempt).toThrow(
    "E: More than 400 documents across monitoring searches. Narrow additional keywords before checking again.",
  );
});
