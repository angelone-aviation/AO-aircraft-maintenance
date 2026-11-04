/**
 * Responsibility: Pins FAA DRS candidate parsing, paging and limits, keyword
 *   batching, candidate merging and the aircraft's search terms.
 * Layer: Test. Vitest suite with a stubbed fetch; never shipped in the build.
 * Dependencies: src/domain/faa.ts, ./airworthiness, ./components,
 *   ./rejection, src/data/demo.ts (seed).
 */
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD } from "./airworthiness";
import { componentSchema } from "./components";
import {
  drsCandidate,
  emptyMonitor,
  faaMonitorSchema,
  faaSearchTerms,
  fetchDrsCandidates,
  fetchDrsFiltered,
  mergeCandidates,
  type FaaCandidate,
} from "./faa";
import { Rejection } from "./rejection";

const doc = (guid: string, fields: Record<string, unknown> = {}) => ({
  documentGuid: guid,
  "drs:documentNumber": `2026-${guid}`,
  ...fields,
});
const page = (documents: object[], hasMoreItems = false) =>
  new Response(JSON.stringify({ summary: { hasMoreItems }, documents }));
const pages = (...responses: Response[]) => {
  const request = vi.fn<typeof fetch>();
  for (const response of responses) request.mockResolvedValueOnce(response);
  return request;
};
const failure = (attempt: () => unknown) =>
  Promise.resolve()
    .then(attempt)
    .then(
      () => undefined,
      (error: unknown) => error,
    );

describe("DRS candidates", () => {
  it("reads DRS fields, treating null and _EMPTY_ as blank", () => {
    const c = drsCandidate(
      doc("g1", {
        docLastModifiedDate: "2026-03-01",
        "drs:status": "Current",
        "drs:adfreadProductType": ["Reciprocating Engine", "_EMPTY_"],
        "drs:adfreadMake": ["Lycoming", "_EMPTY_", "Continental"],
        "drs:adfreadAmendment": null,
        "drs:adfreadSupersededAD": "_EMPTY_",
        "drs:title": "Fuel pump",
        documentURL: "https://drs.faa.gov/browse/ADFREAD/doc/1",
      }),
      "ADFREAD",
    );
    expect(c).toMatchObject({
      id: "ADFREAD:g1",
      modified: "2026-03-01",
      emergency: true,
      reviewReason: "",
      source: {
        number: "2026-g1",
        section: "Engine",
        make: "Lycoming, Continental",
        amendment: "",
        subject: "Fuel pump",
        url: "https://drs.faa.gov/browse/ADFREAD/doc/1",
        source: "FAA DRS ADFREAD",
        sourceNotes: "Status: Current\nSupersedes: \nAffected ADs:",
      },
    });
  });

  it("sorts by product type, keeps only DRS links and caps long text", () => {
    const section = (product?: string) =>
      drsCandidate(doc("g", { "drs:adfrawdProductType": product }), "ADFRAWD")
        .source.section;
    expect(
      [undefined, "Propeller", "appliance", "Glider"].map(section),
    ).toEqual(["Airframe", "Propeller", "Appliance", "Airframe"]);
    const c = drsCandidate(
      doc("g", {
        documentURL: "https://drs.faa.gov.example.com/ad",
        "drs:adfrawdSubject": "s".repeat(2500),
      }),
      "ADFRAWD",
    );
    expect(c.source.url).toBe(
      "https://drs.faa.gov/browse/ADFRAWD/doctypeDetails",
    );
    expect(c.source.subject).toHaveLength(2000);
    expect(c.emergency).toBe(false);
  });

  it("refuses a document without a guid or AD number as a fault", () => {
    for (const fields of [
      { documentGuid: "_EMPTY_" },
      { "drs:documentNumber": null },
    ]) {
      const attempt = () => drsCandidate(doc("g", fields), "ADFRAWD");
      expect(attempt).toThrow(
        Error(
          "FAA returned an AD without an identifier. Check was not completed.",
        ),
      );
      expect(attempt).not.toThrow(Rejection);
    }
  });
});

describe("DRS paging", () => {
  it("follows pages by offset and keeps each document once", async () => {
    const request = pages(
      page([doc("a"), doc("b")], true),
      page([doc("b"), doc("c")]),
    );
    const found = await fetchDrsFiltered("key", "ADFRAWD", {}, request);
    expect(found.map((c) => c.id)).toEqual([
      "ADFRAWD:a",
      "ADFRAWD:b",
      "ADFRAWD:c",
    ]);
    const offsets = request.mock.calls.map(
      ([, init]) => JSON.parse(init!.body as string).offset,
    );
    expect(offsets).toEqual([0, 2]);
    expect(request.mock.calls[0][0]).toBe(
      "https://drs.faa.gov/api/drs/data-pull/ADFRAWD/filtered",
    );
  });

  it("fails closed on DRS errors, stalls and too many pages", async () => {
    const endless = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => page([doc(crypto.randomUUID())], true));
    for (const [request, message] of [
      [pages(new Response("", { status: 401 })), "FAA rejected the API key."],
      [pages(new Response("", { status: 503 })), "FAA request failed (503)."],
      [pages(new Response("{}")), "Unexpected FAA response."],
      [pages(page([], true)), "FAA pagination stalled."],
      [endless, "FAA results exceeded the page limit."],
    ] as const) {
      const error = await failure(() =>
        fetchDrsFiltered("key", "ADFREAD", {}, request),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(Rejection);
      expect((error as Error).message).toContain(message);
    }
    expect(endless).toHaveBeenCalledTimes(20);
  });

  it("refuses more than 400 documents as a Rejection", async () => {
    const documents = Array.from({ length: 401 }, (_, i) => doc(`g${i}`));
    const error = await failure(() =>
      fetchDrsFiltered("key", "ADFRAWD", {}, pages(page(documents))),
    );
    expect(error).toEqual(
      new Rejection(
        "More than 400 matching documents. Narrow the aircraft/component search terms.",
      ),
    );
    expect(error).toBeInstanceOf(Rejection);
  });

  it("searches final-rule then emergency ADs, ten keywords per request", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => page([doc("same")]));
    const terms = Array.from({ length: 11 }, (_, i) => `term${i}`);
    const found = await fetchDrsCandidates("key", terms, request);
    expect(found.map((c) => c.id)).toEqual(["ADFRAWD:same", "ADFREAD:same"]);
    expect(
      request.mock.calls.map(([url, init]) => [
        String(url).split("/").at(-2),
        JSON.parse(init!.body as string).documentFilters.Keyword.length,
      ]),
    ).toEqual([
      ["ADFRAWD", 10],
      ["ADFRAWD", 1],
      ["ADFREAD", 10],
      ["ADFREAD", 1],
    ]);
    const error = await failure(() => fetchDrsCandidates("key", [], request));
    expect(error).toEqual(
      new Rejection(
        "Add an aircraft model, component model, or search term first.",
      ),
    );
    expect(error).toBeInstanceOf(Rejection);
  });
});

describe("monitor history", () => {
  const candidate = (id: string, modified = "2026-01-01"): FaaCandidate =>
    drsCandidate(doc(id, { docLastModifiedDate: modified }), "ADFRAWD");

  it("keeps reviews of unchanged documents, prior entries first", () => {
    const reviewed = [
      { ...candidate("a"), reviewReason: "Not applicable" },
      { ...candidate("b"), reviewReason: "Not applicable" },
    ];
    const merged = mergeCandidates(reviewed, [
      candidate("c"),
      candidate("b", "2026-05-01"),
      candidate("a"),
    ]);
    expect(merged.map((c) => [c.id, c.reviewReason])).toEqual([
      ["ADFRAWD:a", "Not applicable"],
      ["ADFRAWD:b", ""],
      ["ADFRAWD:c", ""],
    ]);
    for (const changed of [
      { modified: "2026-06-01" },
      { status: "Superseded" },
      { source: { ...reviewed[0].source, subject: "Revised" } },
    ])
      expect(
        mergeCandidates(reviewed, [{ ...candidate("a"), ...changed }])[0]
          .reviewReason,
      ).toBe("");
  });

  it("refuses a history over 400 documents as a Rejection", () => {
    const many = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => candidate(`${tag}${i}`));
    expect(mergeCandidates(many(200, "a"), many(200, "b"))).toHaveLength(400);
    const attempt = () => mergeCandidates(many(200, "a"), many(201, "b"));
    expect(attempt).toThrow(
      new Rejection(
        "Monitoring history reached 400 documents; narrow the monitoring scope before continuing.",
      ),
    );
    expect(attempt).toThrow(Rejection);
  });

  it("starts disabled and bounds the extra search terms", () => {
    const monitor = emptyMonitor("demo-206");
    expect(faaMonitorSchema.parse(monitor)).toEqual(monitor);
    expect(monitor.enabled).toBe(false);
    const withTerms = (terms: string[]) =>
      faaMonitorSchema.safeParse({ ...monitor, terms }).success;
    expect(withTerms([" ab "])).toBe(true);
    expect(withTerms(["a"])).toBe(false);
    expect(withTerms(Array(31).fill("ab"))).toBe(false);
  });
});

describe("search terms", () => {
  it("lists the aircraft, installed components, ADs, then extras, each once", () => {
    const s = demoSnapshot();
    const a = { ...s.aircraft[0], faaSearchModel: " 206H " };
    const pump = (uuid: string, installed: boolean) =>
      componentSchema.parse({
        uuid,
        kind: "component",
        version: 1,
        aircraftUuid: a.uuid,
        componentType: "Pump",
        partNumber: "PN-7",
        serial: "",
        manufacturer: "",
        model: "P100",
        faaSearchModel: installed ? "" : "REMOVED",
        notes: "",
        trackTime: false,
        trackCycles: false,
        trackCalendar: false,
        installed,
        installedSeconds: 0,
        installedCycles: 0,
        timeSinceNew: 0,
        timeSinceOverhaul: null,
        timeSinceRepair: null,
        cyclesSinceNew: 0,
        serviceDaysBase: 0,
      });
    const ad = blankAD(a.uuid);
    ad.source.number = "2026-01-01";
    const terms = faaSearchTerms(
      {
        aircraft: [a],
        management: [pump("on", true), pump("off", false)],
        airworthiness: [ad],
      },
      a.uuid,
      [" P100 ", "x", "Fuel pump"],
    );
    expect(terms).toEqual(["206H", "P100", "PN-7", "2026-01-01", "Fuel pump"]);
  });
});
