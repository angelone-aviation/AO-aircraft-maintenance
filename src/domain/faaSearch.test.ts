/**
 * Responsibility: Pins FAA search assets, DRS filters and their limits, and
 *   how a search's assets share DRS queries.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/faaSearch.ts, ./faa, ./components, ./rejection,
 *   src/data/demo.ts (seed).
 */
import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  searchAssets,
  blankSearch,
  searchFilters,
  faaSearchQueries,
  faaSearchSchema,
} from "./faaSearch";
import type { Component } from "./components";
import { Rejection } from "./rejection";
const component = (id: string): Component => ({
  uuid: id,
  version: 1,
  kind: "component",
  aircraftUuid: "demo-206",
  componentType: "Engine",
  model: "TPE331-10N",
  partNumber: "PN-100",
  serial: id,
  manufacturer: "Honeywell",
  notes: "",
  trackTime: true,
  trackCycles: true,
  trackCalendar: false,
  installed: true,
  installedSeconds: 0,
  installedCycles: 0,
  timeSinceNew: 0,
  timeSinceOverhaul: null,
  timeSinceRepair: null,
  cyclesSinceNew: 0,
  serviceDaysBase: 0,
});
it("prefills only installed aircraft assets, leaves manufacturer filtering off, and uses part number when model is missing", () => {
  const s = demoSnapshot();
  s.management = [
    component("left"),
    { ...component("right"), model: "" },
    { ...component("stock"), installed: false },
  ];
  const assets = searchAssets(s, "demo-206");
  expect(assets.map((a) => a.id)).toEqual(["", "left", "right"]);
  expect(assets[1].useMake).toBe(false);
  expect(assets[2].keywords).toBe("PN-100");
  const f = blankSearch("demo-206", assets);
  expect(searchFilters(f, f.assets[1], "ADFRAWD")).toEqual({
    "drs:status": ["Current"],
    "drs:adfrawdModel": ["TPE331-10N"],
    "drs:adfrawdProductType": ["Engine"],
  });
});
it("validates empty searches, date ranges and FAA filter limits before requests", () => {
  const s = demoSnapshot();
  const f = blankSearch("demo-206", searchAssets(s, "demo-206"));
  expect(() => faaSearchSchema.parse({ ...f, assets: [] })).toThrow();
  expect(() =>
    faaSearchSchema.parse({ ...f, dateFrom: "2026-01-01" }),
  ).toThrow();
  expect(() =>
    searchFilters(
      {
        ...f,
        number: "2026-01-01",
        subject: "test",
        docket: "FAA",
        amendment: "39",
      },
      f.assets[0],
      "ADFRAWD",
    ),
  ).toThrow("five filters");
  expect(() =>
    searchFilters(f, { ...f.assets[0], model: "" }, "ADFRAWD"),
  ).toThrow("model or keyword");
});
it("uses emergency-specific product and date metadata and supports historical searches", () => {
  const s = demoSnapshot();
  const f = blankSearch("demo-206", searchAssets(s, "demo-206"));
  const filters = searchFilters(
    {
      ...f,
      historical: true,
      dateField: "issued",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    },
    f.assets[0],
    "ADFREAD",
  );
  expect(filters["drs:adfreadProductTypes"]).toEqual(["Aircraft"]);
  expect(filters["drs:adfreadIssueDate"]).toEqual(["2026-01-01", "2026-12-31"]);
  expect(filters["drs:status"]).toContain("Historical");
});

it("searches aircraft as Aircraft and attached components with their FAA product types", () => {
  const s = demoSnapshot();
  s.management = [
    component("engine"),
    { ...component("propeller"), componentType: "Propeller" },
    { ...component("appliance"), componentType: "Appliance" },
  ];
  const assets = searchAssets(s, "demo-206");
  const form = blankSearch("demo-206", assets);
  for (const type of ["ADFRAWD", "ADFREAD"] as const) {
    const key =
      type === "ADFRAWD" ? "drs:adfrawdProductType" : "drs:adfreadProductTypes";
    expect(
      assets.map((asset) => searchFilters(form, asset, type)[key]),
    ).toEqual([["Aircraft"], ["Engine"], ["Propeller"], ["Appliance"]]);
  }
});

it("uses explicit FAA model overrides without rewriting profile identities", async () => {
  const s = demoSnapshot();
  s.aircraft[0].model = "C441";
  s.aircraft[0].faaSearchModel = "441";
  s.management = [
    {
      ...component("engine"),
      model: "Custom engine name",
      faaSearchModel: "TPE331-10N",
    },
  ];
  const assets = searchAssets(s, s.aircraft[0].uuid);
  expect(assets[0].model).toBe("441");
  expect(assets[1].model).toBe("TPE331-10N");
  const { faaSearchTerms } = await import("./faa");
  expect(faaSearchTerms(s, s.aircraft[0].uuid)).toContain("441");
  expect(faaSearchTerms(s, s.aircraft[0].uuid)).toContain("TPE331-10N");
  expect(s.aircraft[0].model).toBe("C441");
  s.aircraft[0].faaSearchModel = "";
  expect(searchAssets(s, s.aircraft[0].uuid)[0].model).toBe("C441");
});

function airframeSearch() {
  const s = demoSnapshot();
  return blankSearch("demo-206", searchAssets(s, "demo-206").slice(0, 1));
}

it("refuses filters the FAA cannot run with a Rejection", () => {
  const f = airframeSearch();
  const tooMany = () =>
    searchFilters(
      { ...f, subject: "a", docket: "b", amendment: "c", affectedAD: "d" },
      f.assets[0],
      "ADFRAWD",
    );
  expect(tooMany).toThrow(Rejection);
  expect(tooMany).toThrow(
    "FAA allows five filters per search, including status. Remove some advanced fields or disable the manufacturer filter.",
  );
  const blank = () =>
    searchFilters(f, { ...f.assets[0], model: "" }, "ADFRAWD");
  expect(blank).toThrow(Rejection);
  expect(blank).toThrow(
    "Each selected asset needs a model or keyword, or enter an AD number.",
  );
});

it("names the date filter by field and a component under Airframe as an appliance", () => {
  const f = {
    ...airframeSearch(),
    dateFrom: "2026-01-01",
    dateTo: "2026-02-01",
  };
  const component = { ...f.assets[0], id: "c", section: "Airframe" as const };
  expect(searchFilters(f, component, "ADFRAWD")).toMatchObject({
    "drs:effectiveDate": ["2026-01-01", "2026-02-01"],
    "drs:adfrawdProductType": ["Appliance"],
  });
  expect(
    searchFilters({ ...f, dateField: "published" }, f.assets[0], "ADFREAD"),
  ).toHaveProperty("drs:adfreadCitationPublishDate");
});

it("plans one DRS query per document type and distinct filters, final rules first", () => {
  const s = demoSnapshot();
  s.management = [
    component("left"),
    component("right"),
    { ...component("prop"), componentType: "Propeller" },
  ];
  const form = blankSearch("demo-206", searchAssets(s, "demo-206"));
  const queries = faaSearchQueries(form);
  expect(queries.map((q) => [q.type, q.assets])).toEqual([
    ["ADFRAWD", [""]],
    ["ADFRAWD", ["left", "right"]],
    ["ADFRAWD", ["prop"]],
    ["ADFREAD", [""]],
    ["ADFREAD", ["left", "right"]],
    ["ADFREAD", ["prop"]],
  ]);
  expect(queries[1].filters).toEqual(
    searchFilters(form, form.assets[1], "ADFRAWD"),
  );
  expect(
    faaSearchQueries({ ...form, finalRules: false }).map((q) => q.type),
  ).toEqual(["ADFREAD", "ADFREAD", "ADFREAD"]);
  expect(() => faaSearchQueries({ ...form, assets: [] })).toThrow();
  const blank = { ...form.assets[0], model: "" };
  expect(() => faaSearchQueries({ ...form, assets: [blank] })).toThrow(
    Rejection,
  );
});
