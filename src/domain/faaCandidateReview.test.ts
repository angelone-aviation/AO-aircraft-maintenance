import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { blankAD } from "./airworthiness";
import { componentSchema } from "./components";
import { monitoringReviewCandidates } from "./faaCandidateReview";
import type { FaaCandidate } from "./faa";
function setup() {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const r = blankAD(a.uuid);
  r.source.number = "2026-01-01";
  r.source.subject = "Inspect";
  r.source.source = "FAA DRS ADFRAWD";
  r.source.model = a.model;
  r.updatedAt = Date.parse("2026-10-01");
  s.airworthiness = [r];
  const c: FaaCandidate = {
    id: "ADFRAWD:1",
    modified: "2026-01-01",
    source: { ...r.source },
    emergency: false,
    status: "Current",
    reviewReason: "",
    matchedAssetIds: [""],
  };
  return { s, a, r, c };
}
it("hides already imported ADs despite local applicability, recurrence, and compliance decisions", () => {
  const { s, a, r, c } = setup();
  r.applicability = "Not applicable";
  r.reason = "Serial excluded";
  r.source.recurring = "No";
  expect(monitoringReviewCandidates(s, a.uuid, [c])).toEqual([]);
  expect(s.airworthiness![0]).toBe(r);
});
it("retains new revisions, changed FAA content, and newer document modification dates", () => {
  const { s, a, r, c } = setup();
  for (const source of [
    { ...c.source, number: "2026-01-01 R1" },
    { ...c.source, subject: "Changed" },
    { ...c.source, supersededBy: "2026-02-01" },
  ])
    expect(
      monitoringReviewCandidates(s, a.uuid, [{ ...c, source }]),
    ).toHaveLength(1);
  expect(
    monitoringReviewCandidates(s, a.uuid, [{ ...c, modified: "2026-10-02" }]),
  ).toHaveLength(1);
  r.source.faaModified = "2026-01-01";
  expect(monitoringReviewCandidates(s, a.uuid, [c])).toHaveLength(0);
  expect(
    monitoringReviewCandidates(s, a.uuid, [{ ...c, modified: "2026-02-01" }]),
  ).toHaveLength(1);
});
it("does not suppress a component AD when only another matching component has imported it", () => {
  const { s, a, r, c } = setup();
  const engine = componentSchema.parse({
    kind: "component",
    uuid: "engine-1",
    version: 0,
    aircraftUuid: a.uuid,
    componentType: "Engine",
    manufacturer: "",
    model: "TPE331",
    partNumber: "PN",
    serial: "SN",
    notes: "",
    installed: true,
    trackTime: true,
    trackCycles: false,
    trackCalendar: false,
    installedSeconds: 0,
    installedCycles: 0,
    timeSinceNew: 0,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 0,
    serviceDaysBase: 0,
  });
  s.management = [engine, { ...engine, uuid: "engine-2", serial: "SN2" }];
  r.componentUuid = "engine-1";
  r.source.section = "Engine";
  r.source.model = "TPE331";
  c.source = { ...r.source };
  c.matchedAssetIds = ["engine-1", "engine-2"];
  expect(monitoringReviewCandidates(s, a.uuid, [c])).toHaveLength(1);
  s.airworthiness!.push({
    ...r,
    uuid: crypto.randomUUID(),
    componentUuid: "engine-2",
  });
  expect(monitoringReviewCandidates(s, a.uuid, [c])).toHaveLength(0);
  c.matchedAssetIds = undefined;
  expect(monitoringReviewCandidates(s, a.uuid, [c])).toHaveLength(0);
  expect(monitoringReviewCandidates(s, s.aircraft[1].uuid, [c])).toHaveLength(
    1,
  );
});

it("recognizes an appliance AD imported against its listed aircraft model", () => {
  const { s, a, c } = setup();
  c.source.section = "Appliance";
  c.matchedAssetIds = undefined;
  expect(monitoringReviewCandidates(s, a.uuid, [c])).toHaveLength(0);
});
