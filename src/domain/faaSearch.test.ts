/**
 * Responsibility: Pins FAA search assets, DRS filters and their limits, and
 *   how searchFAA groups requests and merges and orders results.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/faaSearch.ts, ./faa, ./components, ./rejection,
 *   src/data/demo.ts (seed).
 */
import { it, expect, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  searchAssets,
  blankSearch,
  searchFilters,
  searchFAA,
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
it("queries identical engines once per document type, merges asset assignments and prefers current final rules", async () => {
  const s = demoSnapshot();
  s.management = [component("left"), component("right")];
  const f = blankSearch(
    "demo-206",
    searchAssets(s, "demo-206").filter((a) => a.id),
  );
  const response = (emergency: boolean) =>
    new Response(
      JSON.stringify({
        summary: { hasMoreItems: false },
        documents: [
          {
            documentGuid: emergency ? "emergency" : "final",
            "drs:documentNumber": "2026-01-01",
            "drs:status": "Current",
            docLastModifiedDate: "2026-01-01",
            documentURL: `https://drs.faa.gov/${emergency ? "emergency" : "final"}`,
          },
        ],
      }),
    );
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      response(String(url).includes("ADFREAD")),
    );
  const r = await searchFAA("synthetic", f, request);
  expect(request).toHaveBeenCalledTimes(2);
  expect(r).toHaveLength(1);
  expect(r[0].assetIds).toEqual(["left", "right"]);
  expect(r[0].candidate.emergency).toBe(false);
  expect(r[0].documents).toHaveLength(2);
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

function drs(documents: Record<string, string>[]) {
  return new Response(
    JSON.stringify({ summary: { hasMoreItems: false }, documents }),
  );
}
const ad = (number: string, fields: Record<string, string> = {}) => ({
  documentGuid: number,
  "drs:documentNumber": number,
  "drs:status": "Current",
  docLastModifiedDate: "2026-01-01",
  documentURL: `https://drs.faa.gov/${number}`,
  ...fields,
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

it("orders ADs by effective date, else issue date, then number, and prefers current documents", async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).includes("ADFREAD")
      ? drs([
          ad("2024-01-01", { documentURL: "https://drs.faa.gov/emergency" }),
        ])
      : drs([
          ad("2024-01-01", {
            "drs:effectiveDate": "2024-02-01",
            "drs:status": "Historical",
          }),
          ad("2025-02-02", { "drs:adfrawdIssueDate": "2025-03-01" }),
          ad("2025-03-03", { "drs:effectiveDate": "2025-03-01" }),
          ad("2020-01-01"),
        ]),
  );
  const r = await searchFAA("synthetic", airframeSearch(), request);
  expect(r.map((x) => x.candidate.source.number)).toEqual([
    "2025-03-03",
    "2025-02-02",
    "2024-01-01",
    "2020-01-01",
  ]);
  expect(r[2].candidate).toMatchObject({ status: "Current", emergency: true });
  expect(r[2].documents).toHaveLength(2);
});

it("refuses more than 400 ADs without returning any", async () => {
  const many = (prefix: string) =>
    drs(Array.from({ length: 201 }, (_, i) => ad(`${prefix}-${i}`)));
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      many(String(url).includes("ADFREAD") ? "2026-02" : "2026-01"),
    );
  const search = searchFAA("synthetic", airframeSearch(), request);
  await expect(search).rejects.toThrow(Rejection);
  await expect(
    searchFAA("synthetic", airframeSearch(), request),
  ).rejects.toThrow(
    "More than 400 ADs matched. Narrow your search; no partial results were imported.",
  );
});
