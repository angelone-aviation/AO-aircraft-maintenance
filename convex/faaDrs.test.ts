/**
 * Responsibility: Pins the FAA DRS requests: paging by offset, failures and
 *   the per-query limit, and how a search and a monitor check run their
 *   queries and merge the results.
 * Layer: Test. Vitest suite with a stubbed fetch; never shipped in the build.
 * Dependencies: convex/faaDrs, src/domain (faaSearch, components, rejection),
 *   src/data/demo (seed).
 */
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../src/data/demo";
import { blankSearch, searchAssets } from "../src/domain/faaSearch";
import type { Component } from "../src/domain/components";
import { Rejection } from "../src/domain/rejection";
import {
  fetchDrsFiltered,
  fetchMonitoringCandidates,
  searchFAA,
} from "./faaDrs";

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

describe("fetchDrsFiltered", () => {
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
      [pages(new Response("", { status: 403 })), "FAA rejected the API key."],
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
});

describe("searchFAA", () => {
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
    expect(r[2].candidate).toMatchObject({
      status: "Current",
      emergency: true,
    });
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
});

describe("fetchMonitoringCandidates", () => {
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
});
