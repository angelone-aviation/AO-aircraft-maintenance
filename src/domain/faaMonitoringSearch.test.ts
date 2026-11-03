import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { componentSchema } from "./components";
import { blankAD } from "./airworthiness";
import { monitoringQueries, monitoringScope } from "./faaMonitoringSearch";
it("uses typed models, checks tracked AD numbers, and searches keywords only when explicitly needed", () => {
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
