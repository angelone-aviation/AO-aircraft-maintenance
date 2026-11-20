/**
 * Responsibility: Pins the demo adapter's discrepancy resolution, deferral
 *   and parts, checklist, job-card and flight-plan saves, template deletion,
 *   component templates, flight review, AD changes, attachments, manual
 *   edits, saved addresses, FAA monitor commands, program selection,
 *   membership and group saves, recurring parts lists, and certificate
 *   filing and approval against the server's rules: the same refusals,
 *   stored records and change-log rows.
 * Layer: Test. Vitest suite with fake IndexedDB; never shipped in the build.
 * Dependencies: src/data/store.ts (the demo workspace), ./local, ./demo
 *   (seed), src/domain (model, flights, airworthiness, rejection, attachments,
 *   checklists, taskCards, flightPlans, deleteInspectionTemplates,
 *   workOrders, purchaseOrders, manuals, addresses, faa, reportBacklog),
 *   convex/values (ConvexError), tests/fixtures.
 *
 * Before Batch 269 the demo resolved without the resolve permission or a
 * length limit, stored the text untrimmed, said "Describe the repair." and
 * "Already resolved.", and crashed on a missing report. Before Batch 300 its
 * flight review skipped the administrator, aircraft, crew, problem-report,
 * reason-length and (on a rejection) reading checks, said "Provide a
 * meaningful explanation.", moved a flight to the aircraft a correction named,
 * and crashed on a missing flight. Before Batch 296 its AD, deferral,
 * resolution, parts, checklist, job-card, flight-plan and template-deletion
 * rows named no Flight Program, a resolution row held the whole report after,
 * where the server keeps the resolved fields, and it logged no component
 * template save or setup. Before T12's final round its flight submission,
 * flight review and work-order rows named none either.
 * Before Batch 273 it took any number of attachments. Before Batch 285 it
 * audited a manual edit's whole record, saved addresses without
 * the administrator check or the 200 cap and with its own messages, kept an
 * FAA monitor's run and error on configure, and ignored an unknown candidate.
 * Before Batch 292 it said "Select at least one group with read access." and
 * "Select groups within this Flight Program.", and saved a group with a name
 * over 100 characters, write permissions without read, or no Flight Program,
 * untrimmed and with repeats. Before Finding 59's fix it logged no FAA
 * command or program selection, said "Permission denied." and had no monitor
 * cap, let anyone create an account unnormalized, kept unknown group ids,
 * said "PO access denied." and logged evidence without the card.
 */
import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { readSnapshot, saveSnapshot } from "./local";
import { demoSnapshot } from "./demo";
import type { Aircraft, Flight, FlightInput, Snapshot } from "../domain/model";
import { localDate } from "../domain/model";
import { applyFlight } from "../domain/flights";
import {
  adAuditRecord,
  blankAD,
  blankADTask,
  type AD,
} from "../domain/airworthiness";
import { ConvexError } from "convex/values";
import { Rejection } from "../domain/rejection";
import { MAX_ATTACHMENTS } from "../domain/attachments";
import {
  MAX_OPEN_REPORTS_PER_MEMBER,
  REPORT_LIMIT_REFUSAL,
} from "../domain/reportBacklog";
import { saveTaskCard } from "../domain/taskCards";
import { emptyChecklist } from "../domain/checklists";
import type { FlightPlan } from "../domain/flightPlans";
import { templateDeletionPreview } from "../domain/deleteInspectionTemplates";
import { newWorkTask, saveWorkOrder } from "../domain/workOrders";
import { requestDraftSchema } from "../domain/partsRequests";
import { poSchema } from "../domain/purchaseOrders";
import type { Manual } from "../domain/manuals";
import type { Group } from "../domain/model";
import { addressSchema } from "../domain/addresses";
import { MAX_ENABLED_FAA_MONITORS, type FaaMonitor } from "../domain/faa";
import type { Backend } from "./backend";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { templateDeletionFixture } from "../../tests/fixtures/templateDeletion";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";

const REPORT = "demo-report";
const LENGTH = "Describe the repair in 1–5000 characters.";

// A demo workspace over its own copy of the seed, online.
async function demo(namespace: string, edit: (s: Snapshot) => void = () => {}) {
  vi.stubGlobal("navigator", { onLine: true });
  const seed = demoSnapshot();
  edit(seed);
  await saveSnapshot(namespace + ":all", seed);
  const { useWorkspace } = await import("./store");
  await useWorkspace.getState().initialize(namespace, true);
  useWorkspace.setState({ online: true });
  return {
    backend: useWorkspace.getState().backend!,
    stored: async () => (await readSnapshot(namespace + ":all"))!,
  };
}

it("resolves with the trimmed repair and audits it as the server does: the program, the resolved fields", async () => {
  const { backend, stored } = await demo("demo-resolve");
  const before = (await stored()).discrepancies.find((d) => d.uuid === REPORT);
  await backend.resolve(REPORT, "  Reseated the connector ");
  const s = await stored();
  const after = s.discrepancies.find((d) => d.uuid === REPORT)!;
  expect(after).toEqual({
    ...before,
    status: "resolved",
    resolution: "Reseated the connector",
    resolvedBy: s.user.id,
    resolvedAt: expect.any(Number),
  });
  expect(s.audit[0]).toEqual({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: after.resolvedAt,
    action: "discrepancy.resolved",
    entityUuid: REPORT,
    aircraftUuid: after.aircraftUuid,
    reason: "  Reseated the connector ",
    before: JSON.stringify(before),
    after: JSON.stringify({
      status: "resolved",
      resolution: "Reseated the connector",
      resolvedBy: s.user.id,
      resolvedAt: after.resolvedAt,
    }),
  });
});

it("defers and audits it as the server does: the program, the placard, the deferral", async () => {
  const { backend, stored } = await demo("demo-defer");
  const before = (await stored()).discrepancies.find((d) => d.uuid === REPORT);
  await backend.deferDiscrepancy({
    uuid: REPORT,
    foundOn: localDate(before!.createdAt),
    deferredOn: localDate(),
    deferral: { type: "91.213d", placard: " LDG LT INOP ", notHazard: true },
  });
  const s = await stored();
  const after = s.discrepancies.find((d) => d.uuid === REPORT)!;
  expect(after).toEqual({
    ...before,
    deferral: {
      type: "91.213d",
      placard: "LDG LT INOP",
      notHazard: true,
      foundOn: localDate(before!.createdAt),
      deferredOn: localDate(),
      deferredAt: expect.any(Number),
      deferredBy: s.user.id,
      deferredByName: s.user.name,
      expiresOn: undefined,
    },
  });
  expect(s.audit[0]).toEqual({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: after.deferral!.deferredAt,
    action: "discrepancy.deferred",
    entityUuid: REPORT,
    aircraftUuid: after.aircraftUuid,
    reason: "LDG LT INOP",
    before: JSON.stringify(before),
    after: JSON.stringify(after.deferral),
  });
});

it("saves a report's parts and audits it as the server does, with the program", async () => {
  const { backend, stored } = await demo("demo-parts");
  const before = (await stored()).discrepancies.find((d) => d.uuid === REPORT);
  await backend.saveDiscrepancyParts(REPORT, 0, []);
  const s = await stored();
  const after = s.discrepancies.find((d) => d.uuid === REPORT)!;
  expect(after).toEqual({ ...before, requiredParts: [], partsVersion: 1 });
  expect(s.audit[0]).toEqual({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: expect.any(Number),
    action: "discrepancy.parts",
    entityUuid: REPORT,
    aircraftUuid: after.aircraftUuid,
    reason: "Required parts updated",
    before: JSON.stringify(before),
    after: JSON.stringify(after),
  });
});

it("saves a checklist and audits it as the server does: the program, the counts", async () => {
  const { backend, stored } = await demo("demo-checklist");
  const aircraftUuid = (await stored()).aircraft[0].uuid;
  const record = {
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: "demo-program",
    aircraftUuid,
    sourceName: "demo.fmd",
    updatedAt: 0,
    updatedBy: "",
    document: emptyChecklist(),
  };
  await backend.saveChecklist({ record, baseVersion: 0 });
  const s = await stored();
  const saved = s.checklists!.find((c) => c.uuid === record.uuid)!;
  expect(s.audit[0]).toEqual({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: saved.updatedAt,
    action: "checklist.saved",
    entityUuid: record.uuid,
    aircraftUuid,
    after: JSON.stringify({
      version: 1,
      name: "New checklist",
      lists: 0,
      entries: 0,
      checks: 0,
    }),
  });
});

it("saves a job card and audits it as the server does, with the program", async () => {
  const { backend, stored } = await demo("demo-task-card");
  const command = taskCardCommand();
  await backend.taskCard(command);
  const s = await stored();
  const saved = s.taskCards!.find((t) => t.uuid === command.uuid)!;
  expect(s.audit[0]).toEqual({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: saved.updatedAt,
    action: "taskCard.save",
    entityUuid: command.uuid,
    aircraftUuid: command.fields.aircraftUuid,
    before: undefined,
    after: JSON.stringify(saved),
  });
  expect(s.audit[0]).not.toHaveProperty("reason");
});

it("saves and cancels a flight plan, auditing each as the server does, with the program", async () => {
  const { backend, stored } = await demo("demo-flight-plan");
  const plan = flightPlan(demoSnapshot().aircraft[0]);
  await backend.savePlan({ plan, baseVersion: 0 });
  const saved = (await stored()).flightPlans!.find(
    (p) => p.uuid === plan.uuid,
  )!;
  await backend.savePlan({
    plan: { ...saved, status: "cancelled" },
    baseVersion: 1,
  });
  const s = await stored();
  const cancelled = s.flightPlans!.find((p) => p.uuid === plan.uuid)!;
  const entry = (action: string, before: unknown, after: unknown) => ({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: expect.any(Number),
    action,
    entityUuid: plan.uuid,
    aircraftUuid: plan.aircraftUuid,
    before: before && JSON.stringify(before),
    after: JSON.stringify(after),
  });
  expect(s.audit.slice(0, 2)).toEqual([
    entry("plan.cancelled", saved, cancelled),
    entry("plan.saved", undefined, saved),
  ]);
});

it("deletes templates, auditing each card, then each template, as the server does, with the program", async () => {
  const f = templateDeletionFixture();
  const { backend, stored } = await demo("demo-template-deletion", (seed) =>
    Object.assign(seed, f.s),
  );
  await backend.deleteInspectionTemplates(
    templateDeletionPreview(f.s, [f.template.uuid]),
  );
  const s = await stored();
  const entry = (record: { uuid: string }, fields: object) => ({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: expect.any(Number),
    entityUuid: record.uuid,
    ...fields,
    before: JSON.stringify(record),
  });
  expect(s.audit.slice(0, 2)).toEqual([
    entry(f.template, {
      action: "inspectionTemplate.deleted",
      reason: "Deleted template and associated reusable job cards.",
    }),
    entry(f.task, {
      action: "taskCard.deletedWithTemplate",
      aircraftUuid: f.task.aircraftUuid,
      reason: "Deleted with its inspection template.",
    }),
  ]);
});

it("audits a component template save and each setup it adds, as the server does", async () => {
  const { backend, stored } = await demo("demo-component-template");
  const a = demoSnapshot().aircraft[0];
  const row = {
    id: "1",
    parentId: "",
    componentType: "Engine" as const,
    partNumber: "P1",
    model: "Engine",
    manufacturer: "",
  };
  const template = { uuid: crypto.randomUUID(), version: 0, name: "Kit" };
  await backend.saveComponentTemplate({
    ...template,
    make: a.make,
    model: a.model,
    rows: [row],
  });
  await backend.applyComponentTemplate({
    templateUuid: template.uuid,
    version: 1,
    aircraftUuid: a.uuid,
    rowIds: ["1"],
  });
  const s = await stored();
  const [setup] = s.componentSetups!;
  const entry = (fields: object) => ({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: expect.any(Number),
    ...fields,
  });
  expect(s.audit.slice(0, 2)).toEqual([
    entry({
      action: "component.setupImported",
      entityUuid: setup.uuid,
      aircraftUuid: a.uuid,
      after: JSON.stringify(setup),
    }),
    entry({
      action: "componentTemplate.save",
      entityUuid: template.uuid,
      after: JSON.stringify(s.componentTemplates![0]),
    }),
  ]);
});

// A proposed plan as a PDF import produces it.
function flightPlan(aircraft: Aircraft): FlightPlan {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    aircraftUuid: aircraft.uuid,
    registration: aircraft.registration,
    departureAt: "2026-09-30T22:05:00Z",
    origin: "MZBZ",
    destination: "KCHA",
    alternate: "",
    durationMinutes: 293,
    cycles: 1,
    landings: 1,
    flightRules: "I",
    aircraftType: "C441",
    flightType: "G",
    speed: "N0255",
    level: "F270",
    route: "DCT",
    pilotText: "",
    equipment: "",
    otherInformation: "",
    sourceName: "plan.pdf",
    sourceHash: "a".repeat(64),
    status: "proposed",
    createdAt: 0,
  };
}

it.each([
  [
    "a member without the resolve permission",
    REPORT,
    "Fixed",
    "You do not have permission for this aircraft.",
    (s: Snapshot) => (s.user = { ...s.members[1] }),
  ],
  ["a blank repair", REPORT, "  ", LENGTH, undefined],
  [
    "a repair over 5000 characters",
    REPORT,
    "x".repeat(5001),
    LENGTH,
    undefined,
  ],
  [
    "a resolved report",
    REPORT,
    "Again",
    "This report is already resolved.",
    (s: Snapshot) => (s.discrepancies[0].status = "resolved"),
  ],
  ["a missing report", "missing", "Fixed", "Report not found.", undefined],
])(
  "refuses %s with the server's message and changes nothing",
  async (_, uuid, resolution, message, edit) => {
    const { backend, stored } = await demo(
      `demo-refuse-${uuid}-${message}`,
      edit,
    );
    const before = await stored();
    const error = await backend.resolve(uuid, resolution).catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);

const REASON = "Checked against the paper log";

// N206MA flew at 11:00; a flight at 09:00 synced later and is held for review.
function heldFlight(s: Snapshot) {
  const opening = s.aircraft[0];
  const input: FlightInput = {
    aircraftUuid: opening.uuid,
    pilotId: "demo-pilot",
    startTime: "2026-10-03T09:00:00Z",
    hobbsOn: opening.currentHobbs + 3600,
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
  const flight = (changes: Partial<Flight>): Flight => ({
    ...input,
    uuid: crypto.randomUUID(),
    authorId: "demo-pilot",
    submittedAt: 0,
    status: "accepted",
    hobbsOff: opening.currentHobbs,
    tachOff: opening.currentTach,
    ...changes,
  });
  const later = flight({
    uuid: "demo-later",
    startTime: "2026-10-03T11:00:00Z",
    hobbsOn: opening.currentHobbs + 7200,
  });
  const held = flight({
    uuid: "demo-held",
    status: "review",
    reviewReason: "Aircraft totals changed after this entry was started.",
    hobbsOff: later.hobbsOn,
  });
  s.aircraft[0] = applyFlight(opening, later);
  s.flights = [later, held];
  return input;
}

it("reviews a held flight: replays the aircraft and audits the review and each move", async () => {
  let input!: FlightInput;
  const { backend, stored } = await demo("demo-review", (seed) => {
    input = heldFlight(seed);
  });
  const before = await stored();
  const [later, held] = before.flights;
  const corrected = { ...input, remarks: "Paper log" };
  await backend.review(held.uuid, "accept", REASON, corrected);
  const s = await stored();
  const reviewed = {
    ...held,
    ...corrected,
    status: "accepted",
    reviewReason: REASON,
    hobbsOff: before.aircraft[0].baselineHobbs,
  };
  expect(s.flights).toEqual([{ ...later, hobbsOff: input.hobbsOn }, reviewed]);
  expect(s.aircraft[0]).toMatchObject({
    currentHobbs: later.hobbsOn,
    landings: before.aircraft[0].baselineLandings + 2,
    version: 2,
  });
  const [moved, review] = s.audit;
  expect(review).toMatchObject({
    action: "flight.reviewed",
    entityUuid: held.uuid,
    programUuid: "demo-program",
    aircraftUuid: held.aircraftUuid,
    actorId: s.user.id,
    reason: REASON,
    before: JSON.stringify(held),
  });
  expect(JSON.parse(review.after!)).toEqual(reviewed);
  expect(moved).toMatchObject({
    action: "flight.resequenced",
    entityUuid: later.uuid,
    programUuid: "demo-program",
    reason:
      "Starting readings recalculated after the flight of 2026-10-03 09:00 UTC was accepted.",
    before: JSON.stringify({ hobbsOff: later.hobbsOff }),
    after: JSON.stringify({ hobbsOff: input.hobbsOn }),
  });
});

it("logs a submitted flight and problem report under the aircraft's program, as the server does", async () => {
  const { backend, stored } = await demo("demo-submit");
  const { user, aircraft } = await stored();
  const a = aircraft[0];
  const entry = () => ({
    programUuid: "demo-program",
    uuid: crypto.randomUUID(),
    authorId: user.id,
  });
  await backend.submit({
    ...entry(),
    kind: "flight",
    baseVersion: a.version,
    input: {
      aircraftUuid: a.uuid,
      pilotId: user.id,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      hobbsOn: a.currentHobbs + 3600,
      landings: 1,
      cycles: 0,
      origin: "AAA",
      destination: "BBB",
      operation: "Mission",
      flightRules: "VFR",
      remarks: "",
      discrepancy: "",
    },
  });
  await backend.submit({
    ...entry(),
    kind: "discrepancy",
    aircraftUuid: a.uuid,
    description: "Landing light out",
  });
  const [report, flight] = (await stored()).audit;
  const logged = { programUuid: "demo-program", aircraftUuid: a.uuid };
  expect(flight).toMatchObject({ ...logged, action: "flight.created" });
  expect(report).toMatchObject({ ...logged, action: "discrepancy.created" });
});

it("refuses a report past the member's open-report limit as a ConvexError, as the server does (D2)", async () => {
  const { backend, stored } = await demo("demo-report-limit", (seed) => {
    seed.discrepancies = Array.from(
      { length: MAX_OPEN_REPORTS_PER_MEMBER },
      (_, i) => ({
        uuid: `open-${i}`,
        aircraftUuid: seed.aircraft[0].uuid,
        description: "Short",
        status: "open" as const,
        authorId: seed.user.id,
        createdAt: 0,
      }),
    );
  });
  const { user, aircraft } = await stored();
  const refused = await backend
    .submit({
      programUuid: "demo-program",
      uuid: crypto.randomUUID(),
      authorId: user.id,
      kind: "discrepancy",
      aircraftUuid: aircraft[0].uuid,
      description: "One more",
    })
    .catch((e) => e);
  expect(refused).toBeInstanceOf(ConvexError);
  expect(refused).toMatchObject({ data: REPORT_LIMIT_REFUSAL });
  expect((await stored()).discrepancies).toHaveLength(
    MAX_OPEN_REPORTS_PER_MEMBER,
  );
});

// The server receives FlightForm's cleared fields absent; the demo, undefined.
it.each([
  ["left out", {}],
  ["set undefined", { copilotId: undefined, tachOn: undefined }],
])(
  "clears the copilot and a reading the review has %s, as the server does",
  async (_, cleared) => {
    let input!: FlightInput;
    const { backend, stored } = await demo(`demo-clear-${_}`, (seed) => {
      input = heldFlight(seed);
      seed.flights[1].copilotId = seed.user.id;
      seed.flights[1].tachOn = seed.aircraft[0].currentTach + 3600;
    });
    const opening = (await stored()).aircraft[0];
    await backend.review("demo-held", "accept", REASON, {
      ...input,
      ...cleared,
    });
    const s = await stored();
    const flight = s.flights.find((f) => f.uuid === "demo-held")!;
    expect(flight.copilotId).toBeUndefined();
    expect(flight.tachOn).toBeUndefined();
    expect(s.aircraft[0].currentTach).toBe(opening.currentTach);
    const log = s.audit.find((e) => e.action === "flight.reviewed")!;
    expect(JSON.parse(log.after!)).toEqual(flight);
  },
);

it.each([
  [
    "a member who is not an administrator",
    {},
    (s: Snapshot) => (s.user = { ...s.members[1] }),
    "Flight Program administrator required.",
  ],
  [
    "a short reason",
    { reason: "ok" },
    undefined,
    "Provide a meaningful review explanation.",
  ],
  [
    "a reason over 5000 characters",
    { reason: "x".repeat(5001) },
    undefined,
    "Provide a meaningful review explanation.",
  ],
  ["a missing flight", { uuid: "missing" }, undefined, "Flight not found."],
  [
    "a change of aircraft",
    { input: { aircraftUuid: "demo-208" } },
    undefined,
    "A correction cannot change aircraft.",
  ],
  [
    "a change to the problem report",
    { input: { discrepancy: "Loose cowling" } },
    undefined,
    "Use the discrepancy workflow to update problem reports.",
  ],
  [
    "an unknown pilot",
    { input: { pilotId: "ghost" } },
    undefined,
    "Pilot not found.",
  ],
  [
    "a new copilot outside the Flight Program",
    { input: { copilotId: "outsider" } },
    (s: Snapshot) =>
      s.members.push({ ...s.members[1], id: "outsider", groupIds: [] }),
    "Pilot must belong to this Flight Program.",
  ],
  [
    "a rejection without the aircraft's reading",
    { decision: "reject" as const, input: { hobbsOn: undefined } },
    undefined,
    "The hobbs reading is required for this aircraft.",
  ],
])(
  "refuses a review with %s, with the server's message, and changes nothing",
  async (_, change, edit, message) => {
    let input!: FlightInput;
    const { backend, stored } = await demo(`demo-review-${message}`, (seed) => {
      input = heldFlight(seed);
      edit?.(seed);
    });
    const before = await stored();
    const error = await backend
      .review(
        "uuid" in change ? change.uuid : "demo-held",
        "decision" in change ? change.decision : "accept",
        "reason" in change ? change.reason : REASON,
        { ...input, ...("input" in change ? change.input : {}) },
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);

it("audits AD changes as the server does: with the program, newest first", async () => {
  const { backend, stored } = await demo("demo-ad");
  const before = await stored();
  const aircraftUuid = before.aircraft[0].uuid;
  const source = (number: string) => ({
    ...blankAD(aircraftUuid).source,
    number,
    subject: "Inspect",
  });
  await backend.saveAD({
    kind: "import",
    aircraftUuid,
    entries: [source("2099-02-02"), source("2099-01-01")].map((s) => ({
      source: s,
      componentUuid: "",
    })),
  });
  const s = await stored();
  const saved = (number: string) =>
    s.airworthiness!.find((r) => r.source.number === number)!;
  const row = (r: AD) => ({
    uuid: expect.any(String),
    programUuid: r.programUuid,
    actorId: s.user.id,
    at: expect.any(Number),
    action: "ad.import",
    entityUuid: r.uuid,
    aircraftUuid,
    reason: undefined,
    before: undefined,
    after: JSON.stringify(adAuditRecord(r)),
  });
  expect(saved("2099-01-01").programUuid).toBe("demo-program");
  expect(s.audit).toEqual([
    row(saved("2099-01-01")),
    row(saved("2099-02-02")),
    ...before.audit,
  ]);
});

const FULL = "This record already has the maximum of 25 attachments.";
const SIGNED = { userId: "demo-admin", name: "Alex Morgan", at: 1 };
const STORED = { name: "old.pdf", size: 1, uploadedAt: 0, url: "" };
const pdf = () =>
  new File(["%PDF-1.4"], "scan.pdf", { type: "application/pdf" });
const full = <T>(file: (i: number) => T) =>
  Array.from({ length: MAX_ATTACHMENTS }, (_, i) => file(i));

// The seed plus an open job card signed on its step, by its technician and by
// its inspector; an open work order; a component; and a draft purchase order.
function withRecords(s: Snapshot) {
  s.taskCards = [];
  s.workOrders = [];
  s.management = [workOrderComponent()];
  const card = saveTaskCard(s, taskCardCommand());
  s.taskCards = [
    {
      ...card,
      technicianSignoff: SIGNED,
      inspectionSignoff: SIGNED,
      stepSignoffs: { [card.steps[0].uuid]: SIGNED },
    },
  ];
  saveWorkOrder(s, workOrderCommand());
  s.purchaseOrders = [
    poSchema.parse({
      uuid: "po",
      version: 0,
      vendor: "Vendor",
      vendorContact: "",
      shipTo: "Hangar",
      expectedDate: "",
      currency: "USD",
      shippingCents: 0,
      notes: "",
      lines: [
        {
          uuid: "line",
          stockUuid: "",
          locationUuid: "store",
          partNumber: "TIRE",
          description: "Tire",
          quantity: 1,
          unitCents: 0,
          kind: "part",
        },
      ],
      programUuid: "demo-program",
      number: "PO-1",
      phase: "draft",
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
      shipments: [],
      receipts: [],
      history: [],
    }),
  ];
}

it("logs a receipt's file on the order and on each item it received, as the server does (T3)", async () => {
  const { backend, stored } = await demo("demo-po-file", (seed) => {
    withRecords(seed);
    seed.purchaseOrders![0].receipts = [
      {
        uuid: "receipt",
        date: "2026-01-01",
        invoice: "",
        notes: "",
        actorId: seed.user.id,
        lines: [
          {
            lineUuid: "line",
            quantity: 1,
            condition: "new",
            itemUuids: ["tire-lot"],
            serials: [],
          },
        ],
      },
    ];
  });
  await backend.attachPOFile("po", "receipt", pdf());
  const file = { name: "scan.pdf", size: pdf().size };
  expect((await stored()).audit.slice(0, 2).reverse()).toMatchObject([
    {
      action: "purchaseOrder.attachment",
      entityUuid: "po",
      programUuid: "demo-program",
      reason: "Receipt attachment uploaded",
      after: JSON.stringify({ ...file, receiptUuid: "receipt" }),
    },
    {
      action: "inventory.attachment",
      entityUuid: "tire-lot",
      programUuid: "demo-program",
      reason: "Receipt attachment from PO-1",
      after: JSON.stringify(file),
    },
  ]);
});

it("files evidence on a signed job card: every signoff cleared, at a new version", async () => {
  const { backend, stored } = await demo("demo-evidence", (seed) => {
    withRecords(seed);
    // Another card's full set of files does not limit this one.
    seed.taskEvidence = full((i) => ({
      ...STORED,
      uuid: `file-${i}`,
      taskCardUuid: "another-card",
      category: "photo" as const,
    }));
  });
  const card = (await stored()).taskCards![0];
  await backend.attachTaskEvidence(card.uuid, "parts-traceability", pdf());
  const s = await stored();
  const evidence = s.taskEvidence!.at(-1)!;
  expect(evidence).toMatchObject({
    taskCardUuid: card.uuid,
    category: "parts-traceability",
    name: "scan.pdf",
    url: expect.stringMatching(/^data:application\/pdf;base64,/),
  });
  expect(s.taskCards).toEqual([
    {
      ...card,
      technicianSignoff: null,
      inspectionSignoff: null,
      stepSignoffs: {},
      version: card.version + 1,
      updatedAt: evidence.uploadedAt,
    },
  ]);
  expect(s.audit[0]).toMatchObject({
    action: "taskCard.evidence",
    entityUuid: card.uuid,
    aircraftUuid: card.aircraftUuid,
    before: JSON.stringify(card),
    after: JSON.stringify({
      ...s.taskCards![0],
      evidenceName: "scan.pdf",
      category: "parts-traceability",
    }),
  });
});

it.each<
  [string, (s: Snapshot) => void, (backend: Backend, s: Snapshot) => unknown]
>([
  [
    "a job card",
    (s) =>
      (s.taskEvidence = full((i) => ({
        ...STORED,
        uuid: `file-${i}`,
        taskCardUuid: s.taskCards![0].uuid,
        category: "photo",
      }))),
    (backend, s) =>
      backend.attachTaskEvidence(s.taskCards![0].uuid, "photo", pdf()),
  ],
  [
    "a work order",
    (s) =>
      (s.workOrderAttachments = full((i) => ({
        ...STORED,
        uuid: `file-${i}`,
        workOrderUuid: s.workOrders![0].uuid,
      }))),
    (backend, s) => backend.attachWorkOrderFile(s.workOrders![0].uuid, pdf()),
  ],
  [
    "an inventory item",
    (s) =>
      (s.inventoryAttachments = full((i) => ({
        ...STORED,
        uuid: `file-${i}`,
        stockUuid: "engine",
        type: "application/pdf",
      }))),
    (backend) => backend.attachInventoryFile("engine", pdf()),
  ],
  [
    "a purchase order",
    (s) =>
      (s.purchaseOrderFiles = full((i) => ({
        ...STORED,
        uuid: `file-${i}`,
        poUuid: "po",
        type: "application/pdf",
      }))),
    (backend) => backend.attachPOFile("po", undefined, pdf()),
  ],
])(
  "refuses another attachment on %s that holds the maximum, as the server does",
  async (record, fill, attach) => {
    const { backend, stored } = await demo(`demo-full-${record}`, (seed) => {
      withRecords(seed);
      fill(seed);
    });
    const before = await stored();
    const error = await Promise.resolve(attach(backend, before)).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message: FULL });
    expect(await stored()).toEqual(before);
  },
);

const MANUAL: Manual = {
  uuid: "manual",
  aircraftUuid: "demo-206",
  title: "Pilot handbook",
  documentNumber: "PH-1",
  revision: "A",
  revisionDate: "2026-01-01",
  applicability: {
    kind: "aircraft",
    manufacturer: "Cessna",
    model: "206",
    partNumber: "",
  },
  filename: "handbook.pdf",
  size: 10,
  pageCount: 2,
  uploadedAt: 1,
  uploadedBy: "demo-admin",
};

it("audits a manual edit with the six editable fields before, as the server does", async () => {
  const { backend, stored } = await demo("demo-manual-edit", (seed) => {
    seed.manuals = [MANUAL];
  });
  const edit = {
    title: "Pilot handbook",
    documentNumber: "PH-2",
    revision: "B",
    revisionDate: "2026-02-01",
    aircraftUuid: "demo-208",
  };
  await backend.editManual(MANUAL.uuid, edit);
  const s = await stored();
  expect(s.manuals).toEqual([{ ...MANUAL, ...edit, applicability: undefined }]);
  expect(s.audit[0]).toMatchObject({
    action: "manual.edit",
    entityUuid: MANUAL.uuid,
    aircraftUuid: "demo-206",
    before: JSON.stringify({
      title: "Pilot handbook",
      documentNumber: "PH-1",
      revision: "A",
      revisionDate: "2026-01-01",
      aircraftUuid: "demo-206",
      applicability: MANUAL.applicability,
    }),
    after: JSON.stringify(edit),
  });
});

const PROGRAM = "demo-program";
const address = (uuid: string, name: string, version = 0) => ({
  uuid,
  version,
  name,
  address: addressSchema.parse({
    street: "123 Main St",
    city: "Wichita",
    region: "KS",
    postalCode: "67209",
    country: "USA",
    contactName: "Receiving",
    email: "receiving@example.com",
    phone: "316 555 0100",
  }),
});
const kept = (uuid: string, name: string, programUuid = PROGRAM) => ({
  ...address(uuid, name, 1),
  programUuid,
});

it("saves an address as its next version, named and confirmed", async () => {
  const { backend, stored } = await demo("demo-address");
  const saved = await backend.saveAddress(PROGRAM, address("a", " Hangar "));
  expect(saved).toEqual({
    ...address("a", "Hangar", 1),
    address: {
      ...address("a", "").address,
      addressName: "Hangar",
      confirmed: true,
    },
    programUuid: PROGRAM,
  });
  expect((await stored()).savedAddresses).toEqual([saved]);
});

it("audits an address edit as the server does: the program, before and after", async () => {
  const { backend, stored } = await demo("demo-address-audit");
  const first = await backend.saveAddress(PROGRAM, address("a", "Hangar"));
  const second = await backend.saveAddress(PROGRAM, {
    ...address("a", "Depot", 1),
  });
  const [edit, create] = (await stored()).audit;
  expect(create).toMatchObject({
    action: "address.saved",
    entityUuid: "a",
    programUuid: PROGRAM,
    before: undefined,
    after: JSON.stringify(first),
  });
  expect(edit).toMatchObject({
    action: "address.saved",
    programUuid: PROGRAM,
    before: JSON.stringify(first),
    after: JSON.stringify(second),
  });
  const history = await backend.auditPage({
    entityUuid: "a",
    cursor: null,
    numItems: 10,
  });
  expect(history.page.map((e) => e.uuid)).toEqual([edit.uuid, create.uuid]);
});

it.each<[string, (s: Snapshot) => void, ReturnType<typeof address>, string]>([
  [
    "a member who is not a program administrator",
    (s) => (s.user = { ...s.members[1], activeProgramUuid: PROGRAM }),
    address("a", "Hangar"),
    "Flight Program administrator required.",
  ],
  [
    "an incomplete entry",
    () => {},
    { ...address("a", "Hangar"), name: " " },
    "Enter an address name and complete the recipient name, address, email and phone fields.",
  ],
  [
    "an address of another program",
    (s) => (s.savedAddresses = [kept("a", "Hangar", "second")]),
    address("a", "Hangar", 1),
    "Address not found in this Flight Program.",
  ],
  [
    "a stale version",
    (s) => (s.savedAddresses = [kept("a", "Hangar")]),
    address("a", "Hangar"),
    "Address changed. Reopen it before saving.",
  ],
  [
    "a name another address uses",
    (s) => (s.savedAddresses = [kept("a", "Hangar")]),
    address("b", "HANGAR"),
    "An address with this name already exists in this program. Select it or use another name.",
  ],
  [
    "a new address beyond the 200 a program keeps",
    (s) =>
      (s.savedAddresses = Array.from({ length: 200 }, (_, i) =>
        kept(`kept-${i}`, `Hangar ${i}`),
      )),
    address("new", "Another hangar"),
    "A Flight Program can keep up to 200 saved addresses. Edit an existing address instead.",
  ],
])(
  "refuses an address save for %s with the server's message and changes nothing",
  async (_, edit, input, message) => {
    const { backend, stored } = await demo(`demo-address-${message}`, edit);
    const before = await stored();
    const error = await backend.saveAddress(PROGRAM, input).catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);

const MONITOR: FaaMonitor = {
  aircraftUuid: "demo-206",
  enabled: false,
  terms: [],
  error: "The FAA did not answer.",
  runId: "run-1",
  candidates: [],
};

it("configures an FAA monitor as the server does: the run and its error reset", async () => {
  const { backend, stored } = await demo("demo-faa-configure", (seed) => {
    seed.faaMonitors = [MONITOR];
  });
  await backend.faaCommand({
    kind: "configure",
    aircraftUuid: MONITOR.aircraftUuid,
    enabled: true,
    terms: ["IO-540"],
  });
  expect((await stored()).faaMonitors).toEqual([
    {
      ...MONITOR,
      enabled: true,
      terms: ["IO-540"],
      runId: "",
      error: "Settings changed. Run a check to verify coverage.",
    },
  ]);
});

// Roadmap Finding 59: the demo logged no FAA command or program selection,
// worded the permission refusal its own way and had no monitor cap.
it("audits an FAA command and a program selection as the server does", async () => {
  const { backend, stored } = await demo("demo-faa-audit");
  const command = {
    kind: "configure" as const,
    aircraftUuid: MONITOR.aircraftUuid,
    enabled: true,
    terms: ["IO-540"],
  };
  await backend.faaCommand(command);
  await backend.selectProgram(PROGRAM);
  const [selected, configured] = (await stored()).audit;
  expect(configured).toMatchObject({
    action: "faa.configure",
    entityUuid: MONITOR.aircraftUuid,
    aircraftUuid: MONITOR.aircraftUuid,
    programUuid: PROGRAM,
    after: JSON.stringify(command),
  });
  expect(selected).toMatchObject({
    action: "program.selected",
    entityUuid: PROGRAM,
    programUuid: PROGRAM,
  });
});

it("refuses a 26th monitored aircraft with the server's cap", async () => {
  const { backend, stored } = await demo("demo-faa-cap", (seed) => {
    const [first] = seed.aircraft;
    for (let i = 0; i < MAX_ENABLED_FAA_MONITORS; i++) {
      seed.aircraft.push({ ...first, uuid: `other-${i}` });
      (seed.faaMonitors ??= []).push({
        ...MONITOR,
        aircraftUuid: `other-${i}`,
        enabled: true,
      });
    }
  });
  const before = await stored();
  const error = await backend
    .faaCommand({
      kind: "configure",
      aircraftUuid: MONITOR.aircraftUuid,
      enabled: true,
      terms: [],
    })
    .catch((e) => e);
  expect(error).toBeInstanceOf(Rejection);
  expect(error).toMatchObject({
    message: `A Flight Program can monitor at most ${MAX_ENABLED_FAA_MONITORS} aircraft daily. Turn off monitoring on another aircraft first.`,
  });
  expect(await stored()).toEqual(before);
});

it.each<[string, (backend: Backend) => Promise<unknown>]>([
  [
    "Aircraft maintenance permission required.",
    (backend) =>
      backend.faaCommand({
        kind: "configure",
        aircraftUuid: "unknown-aircraft",
        enabled: true,
        terms: [],
      }),
  ],
  [
    "Candidate not found.",
    (backend) =>
      backend.faaCommand({
        kind: "review",
        aircraftUuid: MONITOR.aircraftUuid,
        id: "unknown",
        reason: "Not applicable",
      }),
  ],
  [
    "Flight Program access denied.",
    (backend) => backend.selectProgram("unknown-program"),
  ],
])(
  "refuses with the server's Rejection %s and changes nothing",
  async (message, run) => {
    const { backend, stored } = await demo(`demo-refuse-${message}`, (seed) => {
      seed.faaMonitors = [MONITOR];
    });
    const before = await stored();
    const error = await run(backend).catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);

it.each<[string, (s: Snapshot) => void, string]>([
  [
    "Inventory administrator access required.",
    (s) => {
      withRecords(s);
      s.user = { ...s.user, isAdmin: false, groupIds: [] };
    },
    "po",
  ],
  ["PO not found.", withRecords, "no-such-po"],
])(
  "refuses a purchase-order file with the server's %s",
  async (message, edit, poUuid) => {
    const { backend, stored } = await demo(`demo-po-file-${poUuid}`, edit);
    const before = await stored();
    const error = await backend
      .attachPOFile(poUuid, undefined, pdf())
      .catch((e) => e);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);

it("creates an account as the server does: administrators only, email and name normalized", async () => {
  const password = "a-long-demo-password-1";
  const { backend, stored } = await demo("demo-create-user");
  const id = await backend.createUser(
    " New@Example.TEST ",
    " New User ",
    password,
  );
  expect((await stored()).members.find((m) => m.id === id)).toMatchObject({
    email: "new@example.test",
    name: "New User",
  });
  const member = await demo("demo-create-user-member", (seed) => {
    seed.user = { ...seed.user, isAdmin: false };
  });
  const before = await member.stored();
  const error = await member.backend
    .createUser("other@example.test", "Other", password)
    .catch((e) => e);
  expect(error).toMatchObject({
    message: "Administrator permission required.",
  });
  expect(await member.stored()).toEqual(before);
});

it("refuses a group id no group has, as the server does", async () => {
  const { backend, stored } = await demo("demo-unknown-group");
  const before = await stored();
  const pilot = before.members.find((m) => !m.isAdmin)!;
  const error = await backend
    .updateUser({ ...pilot, groupIds: [...pilot.groupIds, "no-such-group"] })
    .catch((e) => e);
  expect(error).toBeInstanceOf(Rejection);
  expect(error).toMatchObject({ message: "Group not found." });
  expect(await stored()).toEqual(before);
});

// The seed plus a write-only group in the program and a group elsewhere.
function withGroups(s: Snapshot) {
  const group = (id: string, fields: Partial<Group>): Group => ({
    id,
    name: id,
    programUuid: PROGRAM,
    aircraftIds: [],
    permissions: ["read"],
    ...fields,
  });
  s.groups.push(
    group("writers", { permissions: ["flight"] }),
    group("elsewhere", { programUuid: "second" }),
  );
}

const PILOT = "demo-pilot";
it.each<[string, (backend: Backend) => Promise<unknown>, string]>([
  [
    "a group of another program",
    (backend) =>
      backend.updateProgramAccess(PILOT, PROGRAM, ["elsewhere"], false),
    "Users can only be assigned groups in this Flight Program.",
  ],
  [
    "no group",
    (backend) => backend.updateProgramAccess(PILOT, PROGRAM, [], false),
    "Select at least one permission group or remove program access.",
  ],
  [
    "groups without read access",
    (backend) =>
      backend.updateProgramAccess(PILOT, PROGRAM, ["writers"], false),
    "Select a group with read access.",
  ],
  [
    "groups without read access, adding someone",
    (backend) =>
      backend.addExistingProgramUser("jordan@example.test", PROGRAM, [
        "writers",
      ]),
    "Select a group with read access.",
  ],
  [
    "a group of another program, adding someone",
    (backend) =>
      backend.addExistingProgramUser("jordan@example.test", PROGRAM, [
        "demo-pilots",
        "elsewhere",
      ]),
    "Users can only be assigned groups in this Flight Program.",
  ],
])(
  "refuses a member's access with %s, with the server's message",
  async (label, run, message) => {
    const { backend, stored } = await demo(`demo-access-${label}`, withGroups);
    const before = await stored();
    const error = await run(backend).catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);

it("creates a program user with the email and name normalized and the groups once each", async () => {
  const { backend, stored } = await demo("demo-create-user");
  const id = await backend.createProgramUser(
    " Sam@Example.TEST ",
    " Sam Rivera ",
    "correct horse battery staple 42",
    PROGRAM,
    ["demo-pilots", "demo-pilots"],
  );
  expect((await stored()).members.at(-1)).toEqual({
    id,
    email: "sam@example.test",
    name: "Sam Rivera",
    active: true,
    isAdmin: false,
    activeProgramUuid: PROGRAM,
    groupIds: ["demo-pilots"],
  });
});

const GROUP = {
  name: "Mechanics",
  programUuid: PROGRAM,
  aircraftIds: ["demo-206"],
  permissions: ["read", "maintenance"] as Group["permissions"],
};

it("saves a group as the server stores it: name trimmed, no repeats, flags false", async () => {
  const { backend, stored } = await demo("demo-group-save");
  await backend.saveGroup({
    ...GROUP,
    name: "  Mechanics ",
    aircraftIds: ["demo-206", "demo-206"],
    permissions: ["read", "maintenance", "read"],
  });
  const s = await stored();
  const saved = s.groups.at(-1)!;
  expect(saved).toEqual({
    ...GROUP,
    programAdmin: false,
    owner: false,
    board: false,
    id: expect.any(String),
  });
  expect(s.audit[0]).toMatchObject({
    action: "group.saved",
    entityUuid: saved.id,
    programUuid: PROGRAM,
    after: JSON.stringify(saved),
  });
  // Tagged with its program, the row is in the administrator's history.
  const history = await backend.auditPage({ cursor: null, numItems: 10 });
  expect(history.page.map((e) => e.uuid)).toContain(s.audit[0].uuid);
});

it("logs program access changes under the program, as the server does", async () => {
  const { backend, stored } = await demo("demo-access-audit");
  const id = await backend.createProgramUser(
    "sam@example.test",
    "Sam Rivera",
    "correct horse battery staple 42",
    PROGRAM,
    ["demo-pilots"],
  );
  await backend.updateProgramAccess(id, PROGRAM, ["demo-pilots"], false);
  expect(
    (await stored()).audit
      .slice(0, 2)
      .map((e) => [e.action, e.entityUuid, e.programUuid]),
  ).toEqual([
    ["user.program_access_changed", id, PROGRAM],
    ["user.created", id, PROGRAM],
  ]);
});

it.each<[string, Partial<typeof GROUP> & { allAircraft?: boolean }, string]>([
  [
    "a name over 100 characters",
    { name: "x".repeat(101) },
    "Group name is required.",
  ],
  [
    "write permissions without read",
    { permissions: ["flight"] },
    "Write permissions also require read access.",
  ],
  [
    "no Flight Program",
    { programUuid: undefined, aircraftIds: [], allAircraft: true },
    "Select a Flight Program for this group.",
  ],
])(
  "refuses a group with %s, as the server does",
  async (_, fields, message) => {
    const { backend, stored } = await demo(`demo-group-${message}`);
    const before = await stored();
    const error = await backend
      .saveGroup({ ...GROUP, ...fields })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({ message });
    expect(await stored()).toEqual(before);
  },
);

it("logs a work-order save under the aircraft's program, as the server does", async () => {
  const { backend, stored } = await demo("demo-work-order");
  const command = workOrderCommand();
  await backend.workOrder(command);
  const [row] = (await stored()).audit;
  expect(row).toMatchObject({
    action: "workOrder.save",
    entityUuid: command.uuid,
    programUuid: "demo-program",
    aircraftUuid: command.fields.aircraftUuid,
  });
});

it("serves each open work order once when a recurring parts list is saved", async () => {
  let order = "";
  const { backend, stored } = await demo("demo-recurring", (seed) => {
    const ad = blankAD("demo-206");
    ad.applicability = "Applicable";
    ad.reviewRequired = false;
    ad.tasks = [{ ...blankADTask(), recurrence: "Recurring" }];
    seed.airworthiness = [ad];
    seed.workOrders = [];
    seed.taskCards = [];
    const command = workOrderCommand();
    command.tasks = [
      newWorkTask({ kind: "airworthiness", uuid: ad.tasks[0].uuid }, "AD"),
    ];
    order = saveWorkOrder(seed, command).uuid;
  });
  const task = (await stored()).airworthiness![0].tasks[0];
  await backend.partsRequest({
    kind: "save",
    requestUuid: crypto.randomUUID(),
    draft: requestDraftSchema.parse({
      uuid: "list",
      version: 0,
      source: { kind: "airworthiness", uuid: task.uuid },
      recurring: true,
      mode: "parts",
      date: "2026-10-20",
      engineer: "Tech",
      priority: "P2 Routine",
      requiredBy: "",
      currency: "USD",
      lines: [
        { uuid: "filter", partNumber: "F", description: "Filter", quantity: 1 },
      ],
    }),
  });
  const s = await stored();
  expect(
    s.partsRequests!.map((r) => [r.templateUuid, r.source.workOrderUuid]),
  ).toEqual([
    [undefined, ""],
    ["list", order],
  ]);
  expect(
    s.audit.filter((a) => a.action === "partsRequest.recurring"),
  ).toHaveLength(1);
});

it("saves engine limits per aircraft and audits engineTrend.limits on the aircraft, as the server does", async () => {
  const { backend, stored } = await demo("demo-engine-limits");
  const aircraftUuid = (await stored()).aircraft[0].uuid;
  expect(await backend.engineTrends(aircraftUuid)).toEqual({
    trends: [],
    limits: { chtMaxF: 435, oilPressureMinPsi: 25 },
  });
  await backend.engineTrend(aircraftUuid, {
    action: "limits",
    limits: { chtMaxF: 420, oilPressureMinPsi: 30 },
  });
  const s = await stored();
  expect(s.engineTrendLimits).toEqual([
    { chtMaxF: 420, oilPressureMinPsi: 30, aircraftUuid },
  ]);
  expect(s.audit[0]).toMatchObject({
    action: "engineTrend.limits",
    entityUuid: aircraftUuid,
    aircraftUuid,
  });
  expect((await backend.engineTrends(aircraftUuid)).limits).toEqual({
    chtMaxF: 420,
    oilPressureMinPsi: 30,
  });
});

it("files a certificate as pending and approves it as the server does, never the approver's own", async () => {
  const { backend, stored } = await demo("demo-certificates");
  const filed = { kind: "mechanic" as const, number: "M-1", issuedOn: "" };
  await backend.saveCertifications("demo-pilot", [filed]);
  await backend.saveCertifications("demo-admin", [filed]);
  const pilotOf = (s: Snapshot) =>
    s.members.find((m) => m.id === "demo-pilot")!;
  expect(pilotOf(await stored()).certifications).toEqual([
    { ...filed, pending: true },
  ]);
  expect(await backend.certificatesAwaitingApproval()).toEqual([
    { userId: "demo-pilot", name: "Jordan Lee", certificate: filed },
  ]);
  await expect(backend.approveCertificate("demo-admin", filed)).rejects.toThrow(
    /nobody their own/,
  );
  await backend.approveCertificate("demo-pilot", filed);
  const s = await stored();
  expect(pilotOf(s)).toMatchObject({
    certifications: [filed],
    licenseNumber: "M-1",
  });
  expect(
    s.audit
      .filter((a) => a.entityUuid === "demo-pilot")
      .map((a) => [a.action, a.before, a.after]),
  ).toEqual([
    [
      "user.certification_approved",
      JSON.stringify({ ...filed, pending: true }),
      JSON.stringify(filed),
    ],
    [
      "user.certification_filed",
      "null",
      JSON.stringify({ ...filed, pending: true }),
    ],
  ]);
});
