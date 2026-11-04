/**
 * Responsibility: Pins the FAA DRS searches that monitor an aircraft, and how
 *   their results merge into one candidate list.
 * Layer: Test. Vitest suite with a stubbed fetch; never shipped in the build.
 * Dependencies: src/domain/faaMonitoringSearch.ts, ./components,
 *   ./airworthiness, ./rejection, src/data/demo.ts (seed).
 */
import { it, expect, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { componentSchema } from "./components";
import { blankAD } from "./airworthiness";
import {
  fetchMonitoringCandidates,
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

const query = (label: string, assetIds: string[]) => ({
  type: "ADFRAWD" as const,
  filters: { Keyword: [label] },
  label,
  assetIds,
});
const docs = (...guids: string[]) =>
  new Response(
    JSON.stringify({
      summary: { hasMoreItems: false },
      documents: guids.map((guid) => ({
        documentGuid: guid,
        "drs:documentNumber": `2026-${guid}`,
      })),
    }),
  );
const pages = (...responses: Response[]) => {
  const request = vi.fn<typeof fetch>();
  for (const response of responses) request.mockResolvedValueOnce(response);
  return request;
};

it("lists each candidate once, in order, with the assets whose searches found it", async () => {
  const request = pages(docs("1", "2"), docs("2", "3"), docs("1"));
  const queries = [
    query("A", ["engine"]),
    query("B", []),
    query("C", ["prop"]),
  ];
  const found = await fetchMonitoringCandidates("key", queries, request);
  expect(found.map((c) => [c.id, c.matchedAssetIds])).toEqual([
    ["ADFRAWD:1", ["engine", "prop"]],
    ["ADFRAWD:2", ["engine"]],
    ["ADFRAWD:3", undefined],
  ]);
});

it("refuses no searches and too many documents, and names a failed search", async () => {
  const none = fetchMonitoringCandidates("key", [], pages());
  await expect(none).rejects.toBeInstanceOf(Rejection);
  await expect(none).rejects.toThrow(
    "No aircraft or component search data is available.",
  );
  const many = (from: number) =>
    docs(...Array.from({ length: 201 }, (_, i) => String(from + i)));
  const tooMany = fetchMonitoringCandidates(
    "key",
    [query("A", []), query("B", [])],
    pages(many(0), many(1000)),
  );
  await expect(tooMany).rejects.toBeInstanceOf(Rejection);
  await expect(tooMany).rejects.toThrow(
    "B: More than 400 documents across monitoring searches. Narrow additional keywords before checking again.",
  );
  const failed = fetchMonitoringCandidates(
    "key",
    [query("A", [])],
    pages(new Response("", { status: 503 })),
  );
  await expect(failed).rejects.toThrow(
    "A: FAA request failed (503). Try again later.",
  );
  await expect(failed).rejects.not.toBeInstanceOf(Rejection);
});
