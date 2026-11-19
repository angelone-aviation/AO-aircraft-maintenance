/**
 * Responsibility: Pins FAA DRS candidate and page parsing, the per-query
 *   limit, candidate merging, monitor commands and the aircraft's search
 *   terms.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/faa.ts, ./airworthiness, ./components,
 *   ./rejection, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD } from "./airworthiness";
import { componentSchema } from "./components";
import {
  addDrsCandidate,
  applyFaaCommand,
  drsCandidate,
  emptyMonitor,
  faaMonitorSchema,
  faaSearchTerms,
  mergeCandidates,
  parseDrsPage,
  monitorAttemptedWithin,
  faaCheckWaitMs,
  startFaaRun,
  type FaaCandidate,
  type FaaMonitor,
} from "./faa";
import { Rejection } from "./rejection";

const doc = (guid: string, fields: Record<string, unknown> = {}) => ({
  documentGuid: guid,
  "drs:documentNumber": `2026-${guid}`,
  ...fields,
});

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

describe("DRS pages", () => {
  it("reads a page's paging flag and documents, and refuses any other shape", () => {
    const body = { summary: { hasMoreItems: true }, documents: [doc("a")] };
    expect(parseDrsPage(body)).toEqual(body);
    for (const bad of [{}, { summary: {}, documents: [] }, null, "page"]) {
      const attempt = () => parseDrsPage(bad);
      expect(attempt).toThrow(
        Error("Unexpected FAA response. Check was not completed."),
      );
      expect(attempt).not.toThrow(Rejection);
    }
  });

  it("keeps a resent document in its first place with the later copy, up to 400", () => {
    const found = new Map<string, FaaCandidate>();
    const later = drsCandidate(
      doc("a", { "drs:status": "Current" }),
      "ADFRAWD",
    );
    addDrsCandidate(found, drsCandidate(doc("a"), "ADFRAWD"));
    addDrsCandidate(found, drsCandidate(doc("b"), "ADFRAWD"));
    addDrsCandidate(found, later);
    expect([...found.values()]).toEqual([
      later,
      drsCandidate(doc("b"), "ADFRAWD"),
    ]);
    for (let i = found.size; i < 400; i++)
      addDrsCandidate(found, drsCandidate(doc(`g${i}`), "ADFRAWD"));
    const attempt = () =>
      addDrsCandidate(found, drsCandidate(doc("extra"), "ADFRAWD"));
    expect(attempt).toThrow(
      new Rejection(
        "More than 400 matching documents. Narrow the aircraft/component search terms.",
      ),
    );
    expect(attempt).toThrow(Rejection);
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

describe("monitor commands", () => {
  const NOW = 1_000_000;
  const MINUTE = 60_000;
  const candidate = (id: string): FaaCandidate =>
    drsCandidate(doc(id), "ADFRAWD");
  const monitor = (fields: Partial<FaaMonitor> = {}): FaaMonitor => ({
    ...emptyMonitor("demo-206"),
    runId: "earlier",
    error: "Earlier error.",
    candidates: [candidate("a"), candidate("b")],
    ...fields,
  });
  const aircraftUuid = "demo-206";

  it("saves settings and drops the running check, so the next check verifies them", () => {
    const before = monitor();
    const cmd = {
      kind: "configure" as const,
      aircraftUuid,
      enabled: true,
      terms: ["441"],
    };
    expect(applyFaaCommand(before, cmd, NOW)).toEqual({
      ...before,
      enabled: true,
      terms: ["441"],
      runId: "",
      error: "Settings changed. Run a check to verify coverage.",
    });
    expect(before).toEqual(monitor());
  });

  it("records a review on the named candidate only, and refuses an unknown one", () => {
    const before = monitor();
    const review = (id: string) =>
      applyFaaCommand(
        before,
        { kind: "review", aircraftUuid, id, reason: "Not applicable." },
        NOW,
      );
    expect(review(candidate("b").id).candidates).toEqual([
      candidate("a"),
      { ...candidate("b"), reviewReason: "Not applicable.", reviewedAt: NOW },
    ]);
    expect(before).toEqual(monitor());
    expect(() => review("missing")).toThrow(Rejection);
    expect(() => review("missing")).toThrow(Error("Candidate not found."));
  });

  it("starts a check with a new run, unless one started within the last minute", () => {
    const check = { kind: "check", aircraftUuid } as const;
    const started = applyFaaCommand(
      monitor({ lastAttempt: NOW - MINUTE }),
      check,
      NOW,
    );
    expect(started).toMatchObject({ lastAttempt: NOW, error: "" });
    expect(started.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(startFaaRun(monitor(), NOW).runId).not.toBe(started.runId);
    const recent = () =>
      applyFaaCommand(monitor({ lastAttempt: NOW - MINUTE + 1 }), check, NOW);
    expect(recent).toThrow(Rejection);
    expect(recent).toThrow(Error("Wait one minute before checking again."));
  });

  it("waits a minute after the last attempt for a manual check, finished or not", () => {
    expect(faaCheckWaitMs(monitor(), NOW)).toBe(0);
    expect(
      faaCheckWaitMs(monitor({ lastAttempt: NOW - MINUTE + 1 }), NOW),
    ).toBe(1);
    expect(
      faaCheckWaitMs(monitor({ lastAttempt: NOW - MINUTE, runId: "run" }), NOW),
    ).toBe(0);
  });

  it("tells whether the last check started within an interval", () => {
    expect(monitorAttemptedWithin(monitor(), MINUTE, NOW)).toBe(false);
    for (const [ago, within] of [
      [MINUTE - 1, true],
      [MINUTE, false],
    ] as const)
      expect(
        monitorAttemptedWithin(
          monitor({ lastAttempt: NOW - ago }),
          MINUTE,
          NOW,
        ),
      ).toBe(within);
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
