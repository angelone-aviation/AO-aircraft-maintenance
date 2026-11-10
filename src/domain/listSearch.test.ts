/**
 * Responsibility: Pins what each record list's search box matches: the shared
 *   text rule and the fields of work orders, job cards, ADs, discrepancy
 *   reports and alerts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/listSearch.ts, src/domain/airworthiness.ts
 *   (blankAD, blankADTask), src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD, blankADTask } from "./airworthiness";
import type { Alert } from "./alerts";
import {
  adMatches,
  alertMatches,
  discrepancyMatches,
  matchesSearch,
  taskCardMatches,
  workOrderMatches,
} from "./listSearch";
import type { Discrepancy } from "./model";

const DEMO = demoSnapshot();
const [N206, N208] = DEMO.aircraft;

describe("matchesSearch", () => {
  it("keeps everything for a blank or spaces-only search", () => {
    expect(matchesSearch("", [])).toBe(true);
    expect(matchesSearch("   ", ["anything"])).toBe(true);
  });

  it("matches part of one field, ignoring case and surrounding spaces", () => {
    expect(matchesSearch(" kbf ", ["KSEA", "KBFI"])).toBe(true);
    expect(matchesSearch("KPAE", ["KSEA", undefined])).toBe(false);
  });

  it("does not match across two fields", () => {
    expect(matchesSearch("KSEA KBFI", ["KSEA", "KBFI"])).toBe(false);
  });
});

describe("workOrderMatches", () => {
  const order = {
    number: "WO-0042",
    supervisor: "Dana Ruiz",
    scope: "Annual inspection",
    aircraft: { registration: "N206MA" },
    tasks: [{ description: "Replace left brake lining" }],
  };

  it.each(["wo-0042", "N206", "dana", "annual", "brake lining"])(
    "matches %s",
    (search) => expect(workOrderMatches(order, search)).toBe(true),
  );

  it("does not match other text", () => {
    expect(workOrderMatches(order, "N208")).toBe(false);
  });
});

describe("taskCardMatches", () => {
  const s = {
    aircraft: DEMO.aircraft,
    workOrders: [{ uuid: "wo-1", number: "WO-0007" }],
  };
  const card = {
    cardNumber: "JC-12",
    title: "Lubricate flap tracks",
    description: "Use MIL-PRF-81322 grease",
    aircraftUuid: N208.uuid,
    workOrderUuid: "wo-1",
  };

  it.each(["jc-12", "flap", "81322", "N208MA", "WO-0007"])(
    "matches %s",
    (search) => expect(taskCardMatches(s, card, search)).toBe(true),
  );

  it("does not match another aircraft's registration", () => {
    expect(taskCardMatches(s, card, N206.registration)).toBe(false);
  });
});

describe("adMatches", () => {
  const ad = blankAD(N206.uuid, "Engine");
  ad.source = {
    ...ad.source,
    number: "2024-05-12",
    subject: "Crankshaft gear retention",
    make: "Continental",
    model: "IO-550",
    amendment: "39-22712",
    supersededBy: "2026-01-04",
  };
  ad.tasks = [{ ...blankADTask(), description: "Inspect the gear bolt" }];

  it.each([
    "2024-05",
    "crankshaft",
    "engine",
    "continental",
    "io-550",
    "39-22712",
    "2026-01-04",
    "gear bolt",
  ])("matches %s", (search) => expect(adMatches(ad, search)).toBe(true));

  it("does not match source notes", () => {
    const noted = { ...ad, source: { ...ad.source, sourceNotes: "Hidden" } };
    expect(adMatches(noted, "hidden")).toBe(false);
  });
});

describe("discrepancyMatches", () => {
  const report: Discrepancy = {
    uuid: "r1",
    aircraftUuid: N208.uuid,
    description: "Left landing light intermittent",
    status: "resolved",
    resolution: "Reseated the connector",
    authorId: "demo-pilot",
    createdAt: 0,
  };

  it.each(["N208", "landing light", "reseated", "jordan"])(
    "matches %s",
    (search) => expect(discrepancyMatches(DEMO, report, search)).toBe(true),
  );

  it("does not match another aircraft's registration", () => {
    expect(discrepancyMatches(DEMO, report, "N206")).toBe(false);
  });
});

describe("alertMatches", () => {
  const alert: Alert = {
    key: "k",
    kind: "inspection-due-soon",
    severity: "warning",
    title: "Inspection due soon: 100-hour",
    detail: "Due in 4.2 hours",
    aircraftUuid: N206.uuid,
    entityUuid: "e",
    link: "/inspections",
  };

  it.each(["100-hour", "4.2 hours", "n206ma"])("matches %s", (search) =>
    expect(alertMatches(DEMO, alert, search)).toBe(true),
  );

  it("matches only title and detail when no aircraft is named", () => {
    const programAlert = { ...alert, aircraftUuid: undefined };
    expect(alertMatches(DEMO, programAlert, "N206")).toBe(false);
  });
});
