/**
 * Responsibility: Pins tenant isolation: users working in Flight Program B call
 *   every public function on program A's records and get nothing of A's; a
 *   board member of B is refused every write and reads only the board
 *   whitelist.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/schema.ts, convex/sampleProgram.ts (program A),
 *   convex/memberships.ts, convex/_generated, src/domain/faaSearch.ts,
 *   tests/fixtures/fileLinks.ts.
 *
 * Refusals are pinned by message: one that reads differently for another
 * program's record tells the caller it exists, as flight review's once did.
 */
import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type StorageActionWriter,
} from "convex/server";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { PROGRAM as PROGRAM_A } from "./sampleProgram";
import { syncMemberships } from "./memberships";
import { blankSearch, searchAssets } from "../src/domain/faaSearch";
import { STALE_RECORD_MESSAGE } from "../src/domain/rejection";
import { FILE_LINKS } from "../tests/fixtures/fileLinks";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const TABLES = Object.keys(schema.tables) as TableNames[];
const STORAGE = "_storage";
const PROGRAM_B = "program-b";
const IN_A = { programUuid: PROGRAM_A };
const B_AIRCRAFT = "b-aircraft-1";
const ROOT_EMAIL = "root@example.test";
const ALICE_EMAIL = "alice@example.test";
const SESSION_MS = 86_400_000;
// sampleProgram.attach files exactly one example PDF per sample aircraft.
const SAMPLE_PDFS = 4;
const PDF = "%PDF-1.4";
const PDF_TYPE = "application/pdf";
const PDF_FILE = {
  name: "file.pdf",
  type: PDF_TYPE,
  bytes: new TextEncoder().encode(PDF).buffer,
};
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).buffer;
// A well-formed base64 SHA-256; no file is ever uploaded against it.
const SHA256 = `${"A".repeat(43)}=`;
const NEW_ACCOUNT = {
  email: "new@example.test",
  name: "New User",
  password: "correct horse battery staple",
};
const ADDRESS_UUID = "11111111-1111-4111-8111-111111111111";
const ADDRESS = {
  organization: "A depot",
  street: "1 Main St",
  street2: "",
  city: "Town",
  region: "TX",
  postalCode: "75001",
  country: "United States",
  contactName: "Alice",
  email: ALICE_EMAIL,
  phone: "555-555-0100",
  confirmed: false,
};
const FLIGHT = {
  startTime: "2026-01-01T10:00:00Z",
  hobbsOn: 3600,
  landings: 1,
  cycles: 1,
  origin: "AAA",
  destination: "BBB",
  operation: "Mission",
  flightRules: "VFR",
  remarks: "",
  discrepancy: "",
} as const;

const AIRCRAFT_DENIED = "You do not have permission for this aircraft.";
const MAINTENANCE = "Aircraft maintenance permission required.";
const FLIGHT_PERMISSION = "Aircraft flight permission required.";
const FLIGHT_NOT_FOUND = "Flight not found.";
const WORK_ORDER_NOT_FOUND = "Work order not found.";
const MANUAL_MAINTENANCE = "Maintenance access is required.";
const WORK_ORDER_DENIED = "Work order maintenance access denied.";
const CHECKLIST_DENIED = "Checklist editing permission denied.";
const PERMISSION_DENIED = "Permission denied.";
const INVENTORY_ADMIN =
  "Inventory administrator access to this item is required.";
const LICENSE_OWNER =
  "Only the account owner or an administrator may access license records.";
const APPROVER_ONLY =
  "Only a system administrator, or a Flight Program administrator of the member's program, may approve their certificates, and nobody their own.";
const STALE_PROGRAM =
  "Flight Program changed. Reopen the form in the correct program.";
const ADMIN = "Administrator permission required.";
const FOREIGN_GROUP =
  "Users can only be assigned groups in this Flight Program.";
const RECORD_TAKEN = "Record belongs to another Flight Program.";
const PO_NOT_FOUND = "PO not found.";
const HISTORY_NOT_FOUND = "History not found.";
const GROUP_NOT_FOUND = "Permission group not found.";
const ATTACHMENT_NOT_FOUND = "Attachment not found.";
const DOCUMENT_NOT_FOUND = "Document not found.";
const LICENSE_COPY_NOT_FOUND = "License copy not found.";
const EVIDENCE_NOT_FOUND = "Evidence not found.";
const NO_SESSION = "An active account and session are required.";

type Kind = "query" | "mutation" | "action";
type Convex = TestConvex<typeof schema>;
type Client = ReturnType<Convex["withIdentity"]>;
type Outcome = { refused: string } | { returned: unknown };
type Dump = Record<string, string>;
type FirstRows = { [T in TableNames]: Doc<T> };
type ProgramA = Awaited<ReturnType<typeof readProgramA>>;
type ArgsOf<F extends FunctionReference<Kind>> = NoInfer<
  (a: ProgramA, me: Id<"users">) => FunctionArgs<F>
>;

/** A stored record's JSON; cases send it back whole or read its version. */
interface Payload {
  uuid: string;
  version: number;
  [field: string]: unknown;
}

/** One call on A by someone working in B, and the answer it must get. */
interface Case {
  /** The function as `module:name`, the form the coverage check lists. */
  fn: string;
  kind: Kind;
  /** What of A's the call aims at; completes the test name. */
  target: string;
  call: (client: Client, a: ProgramA, me: Id<"users">) => Promise<unknown>;
  expected: Outcome;
  /** A member of A may make this call legitimately; only outsiders try. */
  outsiderOnly?: boolean;
}

/** A call not yet pinned: `refuses` or `returns` completes the case. */
interface Attempt {
  refuses: (message: string) => Case;
  returns: (value: unknown) => Case;
}

// Public functions that reach no Flight Program record, and why.
const NOT_PROGRAM_SCOPED: Record<string, string> = {
  "fileTokens:serve":
    "Serves only a file named by a signed link that fileLinks:links issued; the issuing call is attacked.",
  "identities:providers": "Lists the enabled sign-in buttons, before sign-in.",
  "auth:signIn": "Convex Auth's sign-in; the caller has no session yet.",
  "auth:signOut": "Convex Auth; ends the caller's own session.",
  "auth:isAuthenticated": "Convex Auth; answers for the caller's own session.",
  "identities:mine": "Lists the caller's own linked identities.",
  "operations:signedInUser": "Returns the caller's own user id.",
  "admin:saveLogbookPhrases": "Writes the caller's own logbook phrases.",
  "admin:saveReleaseStatements": "Writes the caller's own release statements.",
  "alerts:setEmailPreference": "Writes the caller's own alert-email choice.",
  "urgentAlerts:setUrgentEmailPreference":
    "Writes the caller's own urgent-alert email choice.",
  "pushSubscriptions:publicKey":
    "Returns the deployment's public push key, the same for everyone.",
  "pushSubscriptions:held": "Answers for the caller's own device only.",
  "alerts:emailEnabled":
    "Says whether the deployment sends email, the same for everyone.",
};
const EXPIRING_UUID = "22222222-2222-4222-8222-222222222222";
const PUSH_SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/b-device",
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
};

const CASES: Case[] = [
  callQuery(api.operations.snapshot, "its own snapshot", () => ({})).returns(
    expect.objectContaining({ activeProgramUuid: PROGRAM_B }),
  ),
  callMutation(api.operations.submit, "a flight on A's aircraft", (a, me) => ({
    operation: buildFlight(me, a.row.aircraft.uuid),
  })).refuses(AIRCRAFT_DENIED),
  callMutation(api.operations.submit, "a flight under A's plan", (a, me) => ({
    operation: buildFlight(me, B_AIRCRAFT, a.row.flightPlans.uuid),
  })).refuses("Flight plan is unavailable for this aircraft."),
  callMutation(api.operations.submit, "a report on A's flight", (a, me) => ({
    operation: stampB({
      kind: "discrepancy",
      uuid: crypto.randomUUID(),
      authorId: me,
      aircraftUuid: B_AIRCRAFT,
      flightUuid: a.row.flights.uuid,
      description: "Seen on A's flight.",
    }),
  })).refuses("Linked flight does not belong to this aircraft."),
  callMutation(api.operations.resolveDiscrepancy, "A's report", (a) =>
    stampB({ uuid: a.row.discrepancies.uuid, resolution: "Fixed." }),
  ).refuses(AIRCRAFT_DENIED),
  callMutation(api.operations.deferDiscrepancy, "A's report", (a) =>
    sendInB({
      uuid: a.row.discrepancies.uuid,
      foundOn: "2026-01-01",
      deferredOn: "2026-01-01",
      deferral: { type: "mel", melItem: "1", category: "C", placard: "Inop" },
    }),
  ).refuses(AIRCRAFT_DENIED),
  callMutation(api.operations.saveDiscrepancyParts, "A's report", (a) =>
    stampB({
      uuid: a.row.discrepancies.uuid,
      version: a.row.discrepancies.partsVersion ?? 0,
      payload: "[]",
    }),
  ).refuses(PERMISSION_DENIED),
  callMutation(api.operations.reviewFlight, "A's flight", (a) =>
    buildReview(a.row.flights, a.row.aircraft.uuid),
  ).refuses(AIRCRAFT_DENIED),
  callMutation(api.operations.reviewFlight, "A's flight, as B's", (a) =>
    buildReview(a.row.flights, B_AIRCRAFT),
  ).refuses("Flight not found."),
  callMutation(api.workOrders.save, "templates into A's work order", (a) =>
    sendInB({ action: "copyTemplates", ...readVersion(a.row.workOrders) }),
  ).refuses(WORK_ORDER_DENIED),
  callMutation(api.workOrders.save, "A's work order uuid on B's", (a) =>
    sendInB({
      action: "save",
      uuid: a.row.workOrders.uuid,
      version: 0,
      fields: { ...parsePayload(a.row.workOrders), aircraftUuid: B_AIRCRAFT },
      componentUuids: [],
      tasks: [],
    }),
  ).refuses(WORK_ORDER_DENIED),
  callMutation(api.workOrders.removeFile, "A's work order file", (a) =>
    stampB({ id: a.row.workOrderFiles._id }),
  ).refuses(ATTACHMENT_NOT_FOUND),
  callAction(api.workOrders.upload, "A's work order", (a) =>
    stampB({ workOrderUuid: a.row.workOrders.uuid, ...PDF_FILE }),
  ).refuses(WORK_ORDER_NOT_FOUND),
  callMutation(api.workOrderCopies.resume, "A's work order", (a) => ({
    workOrderUuid: a.row.workOrders.uuid,
    programUuid: PROGRAM_B,
  })).refuses(WORK_ORDER_DENIED),
  callMutation(api.costs.execute, "a cost on A's work order", (a) =>
    sendInB(
      buildCommand("other.add", {
        workOrderUuid: a.row.workOrders.uuid,
        entry: {
          uuid: crypto.randomUUID(),
          date: "2026-01-01",
          description: "Hangar fee",
          amountCents: 100,
        },
      }),
    ),
  ).refuses("Work order not found."),
  callMutation(api.taskCards.save, "a signature on A's job card", (a) =>
    sendInB({
      action: "sign",
      kind: "technician",
      ...readVersion(a.row.taskCards),
    }),
  ).refuses("Job card maintenance access denied."),
  callMutation(api.taskCards.save, "A's job card uuid on B's", (a) =>
    sendInB({
      action: "save",
      uuid: a.row.taskCards.uuid,
      version: 0,
      fields: {
        ...parsePayload(a.row.taskCards),
        aircraftUuid: B_AIRCRAFT,
        workOrderUuid: "",
        workTaskUuid: "",
        inspectionUuid: "",
        componentUuid: "",
      },
    }),
  ).refuses(RECORD_TAKEN),
  callMutation(api.taskCards.removeEvidence, "A's job card evidence", (a) =>
    stampB({ id: a.row.taskEvidence._id }),
  ).refuses(EVIDENCE_NOT_FOUND),
  callAction(api.taskCards.upload, "evidence on A's job card", (a) =>
    stampB({
      taskCardUuid: a.row.taskCards.uuid,
      category: "supporting-document",
      ...PDF_FILE,
    }),
  ).refuses("An open job card and maintenance access are required."),
  callMutation(api.taskImports.save, "job cards into A's inspection", (a) =>
    sendInB({
      csv: "Item,Instruction\n1,Inspect",
      targetKind: "inspection",
      targetUuid: a.row.inspections.uuid,
      targetVersion: a.row.inspections.version ?? 0,
      reviewed: true,
    }),
  ).refuses("Target is unavailable or maintenance access is denied."),
  callMutation(api.management.execute, "A's stock item", (a) =>
    sendInB(buildCommand("record.save", { record: a.stock })),
  ).refuses("Use an explicit Flight Program transfer."),
  callMutation(api.management.execute, "A's stock item, as B's", (a) =>
    sendInB(
      buildCommand("record.save", {
        record: stampB({ ...a.stock, version: 0 }),
      }),
    ),
  ).refuses("Storage location must belong to this Flight Program."),
  callMutation(api.management.execute, "A's inspection", (a) =>
    sendInB(
      buildCommand("inspection.save", {
        record: stripSystemFields(a.row.inspections),
      }),
    ),
  ).refuses(PERMISSION_DENIED),
  callMutation(api.inventoryFiles.remove, "A's stock file", (a) =>
    stampB({ id: a.row.inventoryFiles._id }),
  ).refuses(ATTACHMENT_NOT_FOUND),
  callAction(api.inventoryFiles.upload, "a file on A's stock", (a) =>
    stampB({ stockUuid: a.row.inventoryFiles.stockUuid, ...PDF_FILE }),
  ).refuses(INVENTORY_ADMIN),
  callMutation(api.purchaseOrders.execute, "A's purchase order", (a) =>
    sendInB(buildCancel(a.row.purchaseOrders)),
  ).refuses("Purchase order not found."),
  callQuery(api.purchaseOrders.files, "A's purchase order", (a) =>
    stampB({ poUuid: a.row.purchaseOrders.uuid }),
  ).refuses(PO_NOT_FOUND),
  callMutation(api.poFiles.remove, "A's purchase order file", (a) =>
    stampB({ id: a.row.poFiles._id }),
  ).refuses(ATTACHMENT_NOT_FOUND),
  callMutation(FILE_LINKS, "a link to A's purchase order file", (a) =>
    stampB({ files: [{ kind: "poFile", id: a.row.poFiles._id }] }),
  ).returns([null]),
  callAction(api.poFiles.upload, "a file on A's purchase order", (a) =>
    stampB({ poUuid: a.row.purchaseOrders.uuid, ...PDF_FILE }),
  ).refuses(PO_NOT_FOUND),
  callQuery(api.aircraftSpruce.orders, "A's purchase order", (a) =>
    stampB({ poUuid: a.row.purchaseOrders.uuid }),
  ).returns(null),
  callAction(api.aircraftSpruceActions.sync, "A's purchase order", (a) =>
    stampB({ poUuid: a.row.purchaseOrders.uuid, order: "" }),
  ).refuses("PO not found in this Flight Program."),
  callMutation(api.partsRequests.execute, "A's parts request", (a) =>
    sendInB(buildCancel(a.row.partsRequests)),
  ).refuses("Request changed. Reopen it before saving."),
  callMutation(api.airworthiness.save, "A's AD", (a) =>
    sendInB({ kind: "save", record: parsePayload(a.row.airworthiness) }),
  ).refuses(MAINTENANCE),
  callMutation(api.checklists.save, "A's checklist", (a) =>
    sendInB(buildChecklistSave(a, {})),
  ).refuses(CHECKLIST_DENIED),
  callMutation(api.checklists.save, "A's checklist, as B's", (a) =>
    sendInB(buildChecklistSave(a, stampB({ aircraftUuid: "" }))),
  ).refuses(CHECKLIST_DENIED),
  callMutation(api.flightPlans.save, "A's flight plan", (a) =>
    sendInB(buildPlanSave(a, {})),
  ).refuses(AIRCRAFT_DENIED),
  callMutation(api.flightPlans.save, "A's plan uuid on B's aircraft", (a) =>
    sendInB(buildPlanSave(a, { aircraftUuid: B_AIRCRAFT, version: 0 })),
  ).refuses("Plan ID already used."),
  callMutation(api.inspectionTemplates.save, "A's template", (a) =>
    sendInB([parsePayload(a.row.inspectionTemplates)]),
  ).refuses("Template belongs to another Flight Program."),
  callMutation(api.inspectionTemplates.remove, "A's template", (a) =>
    sendInB({
      templates: [readVersion(a.row.inspectionTemplates)],
      taskCards: [],
    }),
  ).refuses(
    "A selected template is unavailable in this Flight Program. Refresh the list.",
  ),
  callMutation(api.inspectionTemplates.activate, "A's template on B's", (a) =>
    sendInB({
      templateUuid: a.row.inspectionTemplates.uuid,
      templateVersion: readVersion(a.row.inspectionTemplates).version,
      targetUuid: B_AIRCRAFT,
      mode: "recurring",
      description: "Annual",
      reviewed: true,
    }),
  ).refuses("Template is unavailable in this Flight Program."),
  callMutation(api.componentTemplates.save, "A's template uuid, as B's", (a) =>
    sendInB(stampB({ ...parsePayload(a.row.componentTemplates), version: 0 })),
  ).refuses(RECORD_TAKEN),
  callMutation(api.componentTemplates.apply, "A's template on B's", (a) =>
    sendInB({
      templateUuid: a.row.componentTemplates.uuid,
      version: readVersion(a.row.componentTemplates).version,
      aircraftUuid: B_AIRCRAFT,
      rowIds: ["1"],
    }),
  ).refuses("Template and aircraft maintenance access required."),
  callQuery(api.engineTrends.list, "A's aircraft", (a) =>
    stampB({ aircraftUuid: a.row.aircraft.uuid }),
  ).refuses("Aircraft read permission required."),
  callMutation(api.engineTrends.execute, "A's aircraft", (a) => ({
    aircraftUuid: a.row.aircraft.uuid,
    ...sendInB({ action: "remove", uuid: crypto.randomUUID() }),
  })).refuses(MAINTENANCE),
  callMutation(api.faa.command, "an AD check of A's aircraft", (a) =>
    sendInB({ kind: "check", aircraftUuid: a.row.aircraft.uuid }),
  ).refuses(MAINTENANCE),
  callAction(api.faaSearch.search, "an AD search on A's aircraft", (a) =>
    sendInB(buildSearch(a.row.aircraft)),
  ).refuses(MAINTENANCE),
  callMutation(api.fleet.save, "A's aircraft", (a) =>
    sendInB(buildCommand("aircraft.save", { aircraft: copyAircraft(a, {}) })),
  ).refuses(STALE_RECORD_MESSAGE),
  callMutation(api.fleet.save, "A's aircraft uuid, as new", (a) =>
    sendInB(
      buildCommand("aircraft.save", {
        aircraft: copyAircraft(a, { registration: "N0NEW", version: 0 }),
      }),
    ),
  ).refuses("Aircraft belongs to another Flight Program."),
  callMutation(api.fleet.save, "A's program", (a) =>
    sendInB(
      buildCommand("program.save", {
        program: { ...stripSystemFields(a.row.programs), name: "Renamed by B" },
      }),
    ),
  ).refuses(ADMIN),
  callMutation(api.programs.transfer, "A's aircraft", (a) =>
    stampB({
      kind: "aircraft",
      uuid: a.row.aircraft.uuid,
      destination: PROGRAM_B,
      reason: "Ours now.",
    }),
  ).refuses("System administrator required for Flight Program transfers."),
  {
    ...callMutation(api.programs.select, "program A", () => IN_A).refuses(
      "Flight Program access denied.",
    ),
    outsiderOnly: true,
  },
  callMutation(FILE_LINKS, "a link to A's manual", (a) =>
    stampB({ files: [{ kind: "manual", id: a.row.manuals.uuid }] }),
  ).returns([null]),
  callMutation(api.manuals.rename, "A's manual", (a) =>
    stampB({ uuid: a.row.manuals.uuid, title: "Renamed by B" }),
  ).refuses(MANUAL_MAINTENANCE),
  callMutation(api.manuals.edit, "A's manual", (a) =>
    stampB({ uuid: a.row.manuals.uuid, payload: "{}" }),
  ).refuses(MANUAL_MAINTENANCE),
  callMutation(api.manuals.setApplicability, "A's manual", (a) =>
    stampB({ uuid: a.row.manuals.uuid, payload: "{}" }),
  ).refuses(MANUAL_MAINTENANCE),
  callMutation(api.manuals.beginUpload, "a manual for A's aircraft", (a) => ({
    sha256: SHA256,
    ...sendInB(describeManual(a.row.aircraft.uuid)),
  })).refuses("Maintenance access is required to upload a manual."),
  callAction(api.manuals.finishUpload, "Alice's upload of A's file", (a) =>
    stampB({
      ticket: a.row.manualUploads._id,
      storageId: a.row.manuals.storageId,
    }),
  ).refuses("Upload expired. Please upload again."),
  callAction(api.aircraftPhotos.upload, "A's aircraft", (a) =>
    stampB({
      aircraftUuid: a.row.aircraft.uuid,
      type: "image/png",
      bytes: PNG_BYTES,
    }),
  ).refuses(MAINTENANCE),
  callMutation(api.aircraftPhotos.remove, "A's aircraft photo", (a) =>
    stampB({ aircraftUuid: a.row.aircraft.uuid }),
  ).refuses(MAINTENANCE),
  callMutation(api.aircraftFiles.archive, "A's Form 337", (a) =>
    stampB({ id: a.row.aircraftFiles._id, reason: "Superseded." }),
  ).refuses(DOCUMENT_NOT_FOUND),
  callMutation(FILE_LINKS, "a link to A's Form 337", (a) =>
    stampB({ files: [{ kind: "aircraftFile", id: a.row.aircraftFiles._id }] }),
  ).returns([null]),
  callAction(api.aircraftFiles.upload, "a Form 337 on A's aircraft", (a) =>
    stampB({
      aircraftUuid: a.row.aircraft.uuid,
      category: "form-337",
      ...PDF_FILE,
    }),
  ).refuses(MAINTENANCE),
  callAction(api.aircraftFiles.upload, "a photo of A's flight line", (a) =>
    stampB({
      aircraftUuid: a.row.aircraft.uuid,
      category: "logbook-page",
      linkedKind: "flight",
      linkedUuid: a.row.flights.uuid,
      ...PDF_FILE,
    }),
  ).refuses(FLIGHT_PERMISSION),
  // B may write its own aircraft, but A's records are not on it.
  callAction(
    api.aircraftFiles.upload,
    "a photo filing A's flight on B's aircraft",
    (a) =>
      stampB({
        aircraftUuid: B_AIRCRAFT,
        category: "logbook-page",
        linkedKind: "flight",
        linkedUuid: a.row.flights.uuid,
        ...PDF_FILE,
      }),
  ).refuses(FLIGHT_NOT_FOUND),
  callAction(
    api.aircraftFiles.upload,
    "a photo filing A's work order on B's aircraft",
    (a) =>
      stampB({
        aircraftUuid: B_AIRCRAFT,
        category: "logbook-page",
        linkedKind: "work-order",
        linkedUuid: a.row.workOrders.uuid,
        ...PDF_FILE,
      }),
  ).refuses(WORK_ORDER_NOT_FOUND),
  callQuery(api.auditHistory.page, "A's work order history", (a) =>
    stampB({ entityUuid: a.row.workOrders.uuid, cursor: null, numItems: 50 }),
  ).refuses(HISTORY_NOT_FOUND),
  callQuery(api.auditHistory.page, "A's aircraft history", (a) =>
    stampB({ aircraftUuid: a.row.aircraft.uuid, cursor: null, numItems: 50 }),
  ).refuses(HISTORY_NOT_FOUND),
  callQuery(api.auditHistory.page, "its own history", () =>
    stampB({ cursor: null, numItems: 50 }),
  ).returns(expect.objectContaining({ page: [] })),
  callQuery(api.auditHistory.summary, "its own week", () =>
    stampB({ from: "2026-01-01", to: "2026-12-31" }),
  ).returns(expect.objectContaining({ truncated: false })),
  callQuery(api.alerts.readKeys, "program A", () => IN_A).refuses(
    STALE_PROGRAM,
  ),
  callMutation(api.alerts.markRead, "program A", () =>
    stampA({ keys: ["inspection-due"] }),
  ).refuses(STALE_PROGRAM),
  callMutation(api.alerts.forgetRead, "program A", () =>
    stampA({ keys: ["inspection-due"] }),
  ).refuses(STALE_PROGRAM),
  callMutation(api.expiringItems.save, "A's expiring date", (a) =>
    sendInB({
      action: "archive",
      uuid: a.row.expiringItems.uuid,
      version: readVersion(a.row.expiringItems).version,
    }),
  ).refuses("Expiring date not found."),
  callMutation(api.expiringItems.save, "A's expiring date uuid, as B's", (a) =>
    sendInB({
      action: "save",
      item: {
        ...parsePayload(a.row.expiringItems),
        programUuid: PROGRAM_B,
        version: 0,
      },
    }),
  ).refuses(RECORD_TAKEN),
  callMutation(api.expiringItems.save, "a system-wide expiring date", () =>
    sendInB({
      action: "save",
      item: {
        uuid: crypto.randomUUID(),
        kind: "secret",
        label: "Deployment secret",
        expiresOn: "2030-01-01",
        version: 0,
      },
    }),
  ).refuses(ADMIN),
  callMutation(api.pushSubscriptions.subscribe, "program A", () =>
    stampA(PUSH_SUBSCRIPTION),
  ).refuses(STALE_PROGRAM),
  callMutation(api.pushSubscriptions.unsubscribe, "program A", () =>
    stampA({ endpoint: PUSH_SUBSCRIPTION.endpoint }),
  ).refuses(STALE_PROGRAM),
  callQuery(api.savedAddresses.list, "program A", () => IN_A).refuses(
    STALE_PROGRAM,
  ),
  callMutation(api.savedAddresses.save, "A's saved address", () =>
    sendInB({ uuid: ADDRESS_UUID, version: 1, name: "B's", address: ADDRESS }),
  ).refuses("Address not found in this Flight Program."),
  callAction(api.addressVerification.lookup, "program A", () =>
    stampA({ payload: JSON.stringify(ADDRESS) }),
  ).refuses(STALE_PROGRAM),
  callQuery(api.aircraftSpruce.status, "program A", () => IN_A).refuses(
    STALE_PROGRAM,
  ),
  callMutation(api.aircraftSpruce.disconnect, "program A", () =>
    stampA({ version: 0 }),
  ).refuses(STALE_PROGRAM),
  callAction(api.aircraftSpruceActions.link, "program A", () =>
    stampA({
      version: 0,
      userid: "b-buyer",
      password: "not-a-real-password",
      apikey: "not-a-real-key",
      currency: "USD",
    }),
  ).refuses(STALE_PROGRAM),
  callAction(
    api.aircraftSpruceActions.refresh,
    "program A",
    () => IN_A,
  ).refuses(STALE_PROGRAM),
  callAction(api.aircraftSpruceActions.search, "program A", () =>
    stampA({ search: "filter" }),
  ).refuses(STALE_PROGRAM),
  callQuery(api.groupDeletion.preview, "A's administrators", (a) =>
    stampB({ id: a.adminGroup }),
  ).refuses(GROUP_NOT_FOUND),
  callMutation(api.groupDeletion.remove, "A's administrators", (a) =>
    stampB({ id: a.adminGroup, expected: "Administrators" }),
  ).refuses(GROUP_NOT_FOUND),
  callMutation(api.admin.saveGroup, "A's administrators, into B", (a) =>
    stampB({
      id: a.adminGroup,
      name: "Admins",
      aircraftIds: [],
      permissions: ["read"],
    }),
  ).refuses("A permission group cannot be moved to another Flight Program."),
  callMutation(api.admin.saveGroup, "a B group over A's aircraft", (a) =>
    stampB({
      name: "Reach",
      aircraftIds: [a.row.aircraft.uuid],
      permissions: ["read"],
    }),
  ).refuses("Group aircraft must belong to its Flight Program."),
  callMutation(api.programUsers.updateAccess, "itself, into A", (a, me) =>
    stampB({ userId: me, groupIds: [a.adminGroup], remove: false }),
  ).refuses(FOREIGN_GROUP),
  callMutation(api.programUsers.addExisting, "Alice, into A", (a) =>
    stampB({ email: ALICE_EMAIL, groupIds: [a.adminGroup] }),
  ).refuses(FOREIGN_GROUP),
  callAction(api.programUsers.create, "an account in A", (a) =>
    stampB({ ...NEW_ACCOUNT, groupIds: [a.adminGroup] }),
  ).refuses(FOREIGN_GROUP),
  callQuery(api.certifications.list, "Alice's licenses", (a) => ({
    userId: a.alice,
  })).refuses(LICENSE_OWNER),
  callMutation(api.certifications.save, "Alice's licenses", (a) => ({
    userId: a.alice,
    payload: "[]",
  })).refuses(LICENSE_OWNER),
  callMutation(FILE_LINKS, "a link to Alice's license copy", (a) =>
    stampB({
      files: [{ kind: "certificationFile", id: a.row.certificationFiles._id }],
    }),
  ).returns([null]),
  callMutation(api.certifications.remove, "Alice's license copy", (a) => ({
    id: a.row.certificationFiles._id,
  })).refuses(LICENSE_COPY_NOT_FOUND),
  callAction(api.certifications.upload, "a license copy for Alice", (a) => ({
    userId: a.alice,
    kind: "ap",
    ...PDF_FILE,
  })).refuses(LICENSE_OWNER),
  callMutation(api.certifications.approve, "Alice's certificate", (a) =>
    stampB({
      userId: a.alice,
      certificate: JSON.stringify({
        kind: "mechanic",
        number: "1",
        issuedOn: "",
      }),
    }),
  ).refuses(APPROVER_ONLY),
  callQuery(api.certifications.awaitingApproval, "Alice's certificates", () =>
    stampB({}),
  ).returns([]),
  callMutation(api.admin.updateUser, "itself, into A", (a, me) => ({
    id: me,
    active: true,
    isAdmin: false,
    groupIds: [a.adminGroup],
  })).refuses(ADMIN),
  callAction(api.admin.createUser, "an account", () => NEW_ACCOUNT).refuses(
    ADMIN,
  ),
  callAction(api.admin.resetPassword, "Alice's password", (a) => ({
    id: a.alice,
    password: NEW_ACCOUNT.password,
  })).refuses(ADMIN),
  callQuery(api.identities.forUser, "Alice's sign-ins", (a) => ({
    userId: a.alice,
  })).refuses(ADMIN),
  callMutation(api.identities.remove, "Alice's Google sign-in", (a) => ({
    userId: a.alice,
    id: a.row.authAccounts._id,
  })).refuses(ADMIN),
  callMutation(api.defaultGroups.initialize, "program A", () => IN_A).refuses(
    ADMIN,
  ),
  callQuery(api.groupAudit.groupsToReview, "all groups", () => ({})).refuses(
    ADMIN,
  ),
  callQuery(api.backups.latestOffsiteCopy, "backups", () => ({})).refuses(
    ADMIN,
  ),
  callQuery(api.addressVerification.status, "the key", () => ({})).refuses(
    ADMIN,
  ),
  callAction(api.addressVerification.setKey, "the key", () => ({
    key: "not-a-real-key",
    version: 0,
  })).refuses(ADMIN),
  callAction(api.faaCredentials.replace, "the FAA key", () => ({
    key: "not-a-real-key",
    expiresOn: "2099-01-01",
    version: 0,
  })).refuses(ADMIN),
];

const ATTACKERS = [
  { label: "B's program administrator", memberOfA: false },
  { label: "B's administrator who also reads A", memberOfA: true },
];

describe.each(ATTACKERS)("$label", ({ memberOfA }) => {
  let world: Awaited<ReturnType<typeof seedWorld>>;
  let before: Dump;

  beforeAll(async () => {
    world = await seedWorld(memberOfA);
    before = await dumpDatabase(world.t);
  });

  it.each(CASES.filter((c) => !(memberOfA && c.outsiderOnly)))(
    "$fn: $target",
    async ({ call, expected }) => {
      const outcome = await settle(call(world.attacker, world.a, world.me));
      expect(outcome).toEqual(expected);
      expect(findNamesOfA(outcome, world.a, memberOfA)).toEqual([]);
    },
  );

  // These two run after every case above: vitest runs a file's tests in order.
  it("changes, adds and deletes no row", async () => {
    const changed = listChanges(before, await dumpDatabase(world.t));
    expect(changed.filter((key) => !key.startsWith(STORAGE))).toEqual([]);
  });

  it("deletes no stored file and stores none", async () => {
    const changed = listChanges(before, await dumpDatabase(world.t));
    expect(changed.filter((key) => key.startsWith(STORAGE))).toEqual([]);
  });
});

// A board member of B holds read-only access to B's whole fleet. Whatever a
// case sends, every write is refused, nothing of A's comes back, and the
// snapshot is the board whitelist: no flights, change log, rates or people.
describe("B's board member", () => {
  let world: Awaited<ReturnType<typeof seedWorld>>;
  let before: Dump;

  beforeAll(async () => {
    world = await seedWorld(false, "board");
    before = await dumpDatabase(world.t);
  });

  it.each(CASES)("$fn: $target", async ({ kind, call }) => {
    const outcome = await settle(call(world.attacker, world.a, world.me));
    expect(findNamesOfA(outcome, world.a, false)).toEqual([]);
    if (kind !== "query") expect(outcome).toHaveProperty("refused");
  });

  it("reads only the board whitelist of its own program", async () => {
    const view = (await world.attacker.query(api.operations.snapshot, {}))!;
    expect(view.activeProgramUuid).toBe(PROGRAM_B);
    expect(view.aircraft.map((a) => a.uuid)).toEqual([B_AIRCRAFT]);
    expect(view.flights).toEqual([]);
    expect(view.audit).toEqual([]);
    expect(view.members.map((m) => m.id)).toEqual([view.user.id]);
    expect(view.costs).toBeUndefined();
    expect(view.boardCosts?.map((c) => c.aircraftUuid)).toEqual([B_AIRCRAFT]);
    expect(JSON.stringify(view)).not.toMatch(/rateCents|laborRateCents/);
  });

  it("changes, adds and deletes no row or file", async () => {
    expect(listChanges(before, await dumpDatabase(world.t))).toEqual([]);
  });
});

// Security review T4: an id that names A's record must be refused exactly
// as one whose record is gone, and an anonymous caller must meet the session
// check before any read, or either could tell that A's record exists.
type IdTable =
  | "aircraftFiles"
  | "certificationFiles"
  | "inventoryFiles"
  | "poFiles"
  | "taskEvidence"
  | "workOrderFiles";
type Caller = Pick<Client, "query" | "mutation">;
const ID_CASES: {
  fn: string;
  table: IdTable;
  call: (client: Caller, id: string) => Promise<unknown>;
}[] = [
  {
    fn: "aircraftFiles:archive",
    table: "aircraftFiles",
    call: (c, id) =>
      c.mutation(
        api.aircraftFiles.archive,
        stampB({ id: asId<"aircraftFiles">(id), reason: "Superseded." }),
      ),
  },
  {
    fn: "certifications:remove",
    table: "certificationFiles",
    call: (c, id) =>
      c.mutation(api.certifications.remove, {
        id: asId<"certificationFiles">(id),
      }),
  },
  {
    fn: "inventoryFiles:remove",
    table: "inventoryFiles",
    call: (c, id) =>
      c.mutation(
        api.inventoryFiles.remove,
        stampB({ id: asId<"inventoryFiles">(id) }),
      ),
  },
  {
    fn: "poFiles:remove",
    table: "poFiles",
    call: (c, id) =>
      c.mutation(api.poFiles.remove, stampB({ id: asId<"poFiles">(id) })),
  },
  {
    fn: "taskCards:removeEvidence",
    table: "taskEvidence",
    call: (c, id) =>
      c.mutation(
        api.taskCards.removeEvidence,
        stampB({ id: asId<"taskEvidence">(id) }),
      ),
  },
  {
    fn: "workOrders:removeFile",
    table: "workOrderFiles",
    call: (c, id) =>
      c.mutation(
        api.workOrders.removeFile,
        stampB({ id: asId<"workOrderFiles">(id) }),
      ),
  },
];
// A link to another program's file answers as one to a deleted file does:
// null, not a refusal, since a link request names many files at once.
const LINK_CASES = [
  ["aircraftFiles", "aircraftFile"],
  ["certificationFiles", "certificationFile"],
  ["inventoryFiles", "inventoryFile"],
  ["poFiles", "poFile"],
  ["taskEvidence", "taskEvidence"],
  ["workOrderFiles", "workOrderFile"],
] as const;

describe("an id of A's record", () => {
  let world: Awaited<ReturnType<typeof seedWorld>>;

  beforeAll(async () => {
    world = await seedWorld(false);
  });

  it.each(ID_CASES)(
    "$fn: refused as if the record were gone",
    async ({ table, call }) => {
      const theirs = world.a.row[table]._id;
      const gone = await copyThenDelete(world.t, table, theirs);
      const outsider = await settle(call(world.attacker, theirs));
      expect(outsider).toHaveProperty("refused");
      expect(outsider).toEqual(await settle(call(world.attacker, gone)));
      for (const id of [theirs, gone])
        expect(await settle(call(world.t, id))).toEqual({
          refused: NO_SESSION,
        });
    },
  );

  it.each(LINK_CASES)(
    "fileLinks:links: a link to one of %s answers as for a gone one",
    async (table, kind) => {
      const ask = (client: Caller, id: string) =>
        client.mutation(FILE_LINKS, stampB({ files: [{ kind, id }] }));
      const theirs = world.a.row[table]._id;
      const gone = await copyThenDelete(world.t, table, theirs);
      const outsider = await settle(ask(world.attacker, theirs));
      expect(outsider).toEqual({ returned: [null] });
      expect(outsider).toEqual(await settle(ask(world.attacker, gone)));
      for (const id of [theirs, gone])
        expect(await settle(ask(world.t, id))).toEqual({ refused: NO_SESSION });
    },
  );
});

it("attacks every public function, or says why it need not", async () => {
  const exported = await listPublicFunctions();
  const covered = new Set([
    ...CASES.map((c) => c.fn),
    ...Object.keys(NOT_PROGRAM_SCOPED),
  ]);
  expect(exported.filter((fn) => !covered.has(fn))).toEqual([]);
  expect([...covered].filter((fn) => !exported.includes(fn))).toEqual([]);
});

function callQuery<F extends FunctionReference<"query">>(
  fn: F,
  target: string,
  args: ArgsOf<F>,
): Attempt {
  const ref: FunctionReference<"query"> = fn;
  return attempt(fn, "query", target, (c, a, me) => c.query(ref, args(a, me)));
}

function callMutation<F extends FunctionReference<"mutation">>(
  fn: F,
  target: string,
  args: ArgsOf<F>,
): Attempt {
  const ref: FunctionReference<"mutation"> = fn;
  return attempt(fn, "mutation", target, (c, a, me) =>
    c.mutation(ref, args(a, me)),
  );
}

function callAction<F extends FunctionReference<"action">>(
  fn: F,
  target: string,
  args: ArgsOf<F>,
): Attempt {
  const ref: FunctionReference<"action"> = fn;
  return attempt(fn, "action", target, (c, a, me) =>
    c.action(ref, args(a, me)),
  );
}

function attempt(
  fn: FunctionReference<Kind>,
  kind: Kind,
  target: string,
  call: Case["call"],
): Attempt {
  const name = getFunctionName(fn);
  const pin = (expected: Outcome) => ({
    fn: name,
    kind,
    target,
    call,
    expected,
  });
  return {
    refuses: (message) => pin({ refused: message }),
    returns: (value) => pin({ returned: value }),
  };
}

// A refusal is the answer most cases expect, so it becomes a value to compare.
function settle(call: Promise<unknown>): Promise<Outcome> {
  return call.then(
    (value) => ({ returned: value }),
    (error: unknown) => ({ refused: readMessage(error) }),
  );
}

function readMessage(error: unknown): string {
  if (error instanceof ConvexError) return String(error.data);
  return error instanceof Error ? error.message : String(error);
}

// A member of A may know A exists, since it can switch to A; no one working
// in B may see any of A's records.
function findNamesOfA(outcome: Outcome, a: ProgramA, memberOfA: boolean) {
  const text = JSON.stringify(outcome);
  const names = memberOfA ? a.recordUuids : [PROGRAM_A, ...a.recordUuids];
  return names.filter((name) => text.includes(name));
}

// The tests pass ids of several tables through one signature.
function asId<T extends TableNames>(id: string): Id<T> {
  return id as Id<T>;
}

// An id of `table` that no row holds any longer: a copy of the row, deleted.
async function copyThenDelete(t: Convex, table: IdTable, id: string) {
  return t.run(async (ctx) => {
    const row = await ctx.db.get(asId<IdTable>(id));
    const { _id, _creationTime, ...fields } = row!;
    const copy = await ctx.db.insert(table, fields as never);
    await ctx.db.delete(copy);
    return copy as string;
  });
}

function stampA<T extends object>(fields: T) {
  return { ...fields, programUuid: PROGRAM_A };
}

function stampB<T extends object>(fields: T) {
  return { ...fields, programUuid: PROGRAM_B };
}

function sendInB(payload: unknown) {
  return stampB({ payload: JSON.stringify(payload) });
}

function parsePayload(row: { payload: string }) {
  return JSON.parse(row.payload) as Payload;
}

function readVersion(row: { payload: string }) {
  const { uuid, version } = parsePayload(row);
  return { uuid, version };
}

function buildCommand(action: string, fields: object) {
  return {
    action,
    requestUuid: crypto.randomUUID(),
    reason: "Ours",
    ...fields,
  };
}

function buildCancel(row: { payload: string }) {
  const command = { kind: "cancel", requestUuid: crypto.randomUUID() };
  return { ...command, reason: "Not needed.", ...readVersion(row) };
}

function buildChecklistSave(a: ProgramA, changes: object) {
  const record = parsePayload(a.row.checklists);
  return { record: { ...record, ...changes }, baseVersion: record.version };
}

function buildPlanSave(a: ProgramA, changes: Partial<Payload>) {
  const plan = { ...parsePayload(a.row.flightPlans), ...changes };
  return { plan, baseVersion: plan.version };
}

function copyAircraft(a: ProgramA, changes: object) {
  return {
    ...stripSystemFields(a.row.aircraft),
    programUuid: undefined,
    ...changes,
  };
}

function describeManual(aircraftUuid: string) {
  return {
    aircraftUuid,
    title: "Manual",
    documentNumber: "",
    revision: "1",
    revisionDate: "",
    filename: "manual.pdf",
    size: PDF.length,
    pageCount: 1,
  };
}

function buildSearch(aircraft: Doc<"aircraft">) {
  const assets = searchAssets({ aircraft: [aircraft] }, aircraft.uuid);
  return blankSearch(aircraft.uuid, assets);
}

function buildFlight(me: Id<"users">, aircraftUuid: string, plan?: string) {
  const input = { ...FLIGHT, aircraftUuid, pilotId: me, flightPlanUuid: plan };
  const flight = { kind: "flight" as const, uuid: crypto.randomUUID(), input };
  return stampB({ ...flight, authorId: me, baseVersion: 0 });
}

function buildReview(flight: Doc<"flights">, aircraftUuid: string) {
  const { pilotId, startTime, hobbsOn, landings, cycles, origin } = flight;
  const { destination, operation, flightRules, remarks, discrepancy } = flight;
  return stampB({
    uuid: flight.uuid,
    requestUuid: crypto.randomUUID(),
    decision: "reject" as const,
    reason: "Not our flight.",
    input: {
      aircraftUuid,
      pilotId,
      startTime,
      hobbsOn,
      landings,
      cycles,
      origin,
      destination,
      operation,
      flightRules,
      remarks,
      discrepancy,
    },
  });
}

function stripSystemFields<T extends { _id: string; _creationTime: number }>(
  doc: T,
) {
  const { _id, _creationTime, ...fields } = doc;
  return fields;
}

async function seedWorld(
  memberOfA: boolean,
  role: "admin" | "board" = "admin",
) {
  const t = convexTest(schema, modules);
  await seedSampleProgram(t);
  const people = await t.run(async (ctx) => {
    const groups = await addProgramB(ctx);
    const alice = await addUser(ctx, ALICE_EMAIL, [groups.aAdmins], PROGRAM_A);
    await addFilesOfA(ctx, alice.id);
    const own = role === "board" ? groups.bBoard : groups.bAdmins;
    const attackerGroups = memberOfA ? [own, groups.aReaders] : [own];
    const email = "attacker@example.test";
    const attacker = await addUser(ctx, email, attackerGroups, PROGRAM_B);
    return { alice, attacker };
  });
  await addRecordsOfA(t, t.withIdentity(people.alice));
  const a = await t.run((ctx) => readProgramA(ctx, people.alice.id));
  const attacker = t.withIdentity(people.attacker);
  return { t, a, me: people.attacker.id, attacker };
}

async function seedSampleProgram(t: Convex) {
  const email = ROOT_EMAIL;
  const root = { name: "Root", email, active: true, isAdmin: true };
  await t.run((ctx) => ctx.db.insert("users", { ...root, groupIds: [] }));
  await t.mutation(internal.sampleProgram.seed, { email });
  const files = await t.run(async (ctx) => {
    const stored = [];
    for (let i = 0; i < SAMPLE_PDFS; i++)
      stored.push({ storageId: await storePdf(ctx), size: PDF.length });
    return stored;
  });
  await t.mutation(internal.sampleProgram.attach, { files, email });
}

// Program B copies A's program and first aircraft, so every shape a case
// sends is valid in B and only the program boundary can refuse it.
async function addProgramB(ctx: MutationCtx) {
  const program = (await ctx.db.query("programs").first())!;
  const aircraft = (await ctx.db.query("aircraft").first())!;
  const name = "Program B";
  await ctx.db.insert("programs", {
    ...stripSystemFields(program),
    uuid: PROGRAM_B,
    name,
  });
  await ctx.db.insert(
    "aircraft",
    stampB({
      ...stripSystemFields(aircraft),
      uuid: B_AIRCRAFT,
      registration: "N0B",
      program: name,
    }),
  );
  const aGroups = await ctx.db
    .query("groups")
    .withIndex("program", (q) => q.eq("programUuid", PROGRAM_A))
    .collect();
  const bAdmins = await ctx.db.insert("groups", {
    programUuid: PROGRAM_B,
    name: "B administrators",
    programAdmin: true,
    aircraftIds: [],
    permissions: ["read", "flight", "discrepancy", "resolve", "maintenance"],
  });
  const bBoard = await ctx.db.insert("groups", {
    programUuid: PROGRAM_B,
    name: "B board",
    board: true,
    aircraftIds: [],
    permissions: ["read"],
  });
  const aAdmins = aGroups.find((g) => g.programAdmin)!._id;
  const aReaders = aGroups.find(
    (g) =>
      !g.programAdmin &&
      !g.owner &&
      !g.board &&
      g.permissions.join() === "read",
  )!._id;
  return { bAdmins, bBoard, aAdmins, aReaders };
}

async function addUser(
  ctx: MutationCtx,
  email: string,
  groupIds: Id<"groups">[],
  activeProgramUuid: string,
) {
  const name = email.split("@")[0];
  const id = await ctx.db.insert("users", {
    name,
    email,
    active: true,
    isAdmin: false,
    groupIds,
    activeProgramUuid,
  });
  await syncMemberships(ctx, id);
  const expirationTime = Date.now() + SESSION_MS;
  const session = await ctx.db.insert("authSessions", {
    userId: id,
    expirationTime,
  });
  return { id, subject: `${id}|${session}` };
}

// SAMPLE seeds none of these; each is the target of a case.
async function addFilesOfA(
  ctx: MutationCtx & { storage: StorageActionWriter },
  alice: Id<"users">,
) {
  const aircraftUuid = (await ctx.db.query("aircraft").first())!.uuid;
  const file = { type: PDF_TYPE, size: PDF.length, uploadedAt: Date.now() };
  const certificate = { userId: alice, kind: "ap", name: "certificate.pdf" };
  const form337 = {
    aircraftUuid,
    category: "form-337" as const,
    name: "337.pdf",
  };
  await ctx.db.insert("certificationFiles", {
    ...certificate,
    ...file,
    storageId: await storePdf(ctx),
  });
  await ctx.db.insert("aircraftFiles", {
    ...form337,
    ...file,
    storageId: await storePdf(ctx),
  });
  const storageId = await storePdf(ctx);
  await ctx.db.insert("aircraftPhotos", { aircraftUuid, storageId });
  const google = { provider: "google", providerAccountId: "alice" };
  await ctx.db.insert("authAccounts", { userId: alice, ...google });
  const name = ADDRESS.organization;
  await ctx.db.insert(
    "savedAddresses",
    stampA({
      uuid: ADDRESS_UUID,
      version: 1,
      name,
      nameKey: name.toLowerCase(),
      address: ADDRESS,
    }),
  );
}

// Alice writes these through the app, so their stored shape is the real one.
async function addRecordsOfA(t: Convex, alice: Client) {
  const { aircraft, inspection } = await t.run(async (ctx) => ({
    aircraft: (await ctx.db.query("aircraft").first())!,
    inspection: (await ctx.db.query("inspections").first())!,
  }));
  const sendInA = (payload: unknown) =>
    stampA({ payload: JSON.stringify(payload) });
  const { make, model } = aircraft;
  const row = { id: "1", componentType: "Engine", partNumber: "P1", model };
  const template = { name: "Engines", make, model, rows: [row] };
  await alice.mutation(
    api.componentTemplates.save,
    sendInA({ ...template, uuid: crypto.randomUUID(), version: 0 }),
  );
  const draft = draftPartsRequest(inspection.uuid);
  await alice.mutation(
    api.partsRequests.execute,
    sendInA({ kind: "save", requestUuid: crypto.randomUUID(), draft }),
  );
  const manual = sendInA(describeManual(aircraft.uuid));
  await alice.mutation(api.manuals.beginUpload, { ...manual, sha256: SHA256 });
  await alice.mutation(
    api.expiringItems.save,
    sendInA({
      action: "save",
      item: {
        uuid: EXPIRING_UUID,
        programUuid: PROGRAM_A,
        kind: "insurance",
        label: "Hull policy",
        expiresOn: "2030-01-01",
        version: 0,
      },
    }),
  );
}

function draftPartsRequest(inspectionUuid: string) {
  const line = { partNumber: "P1", description: "Filter", quantity: 1 };
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    source: { kind: "inspection", uuid: inspectionUuid },
    mode: "parts",
    date: "2026-01-01",
    engineer: "Alice",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [{ ...line, uuid: crypto.randomUUID() }],
  };
}

function storePdf(ctx: { storage: StorageActionWriter }) {
  return ctx.storage.store(new Blob([PDF], { type: PDF_TYPE }));
}

// The first row of every table a case reads is A's: the seed adds B's program,
// aircraft and group after A's rows.
async function readProgramA(ctx: MutationCtx, alice: Id<"users">) {
  const firsts = await Promise.all(
    TABLES.map(async (table) => [table, await ctx.db.query(table).first()]),
  );
  const groups = await ctx.db
    .query("groups")
    .withIndex("program", (q) => q.eq("programUuid", PROGRAM_A))
    .collect();
  const management = await ctx.db.query("management").collect();
  return {
    row: Object.fromEntries(firsts) as FirstRows,
    alice,
    adminGroup: groups.find((g) => g.programAdmin)!._id,
    stock: management.map(parsePayload).find((r) => r.kind === "stock")!,
    recordUuids: await listRecordUuids(ctx),
  };
}

// Program uuids are left out: B's fills B's own answers, and findNamesOfA treats
// A's apart.
async function listRecordUuids(ctx: MutationCtx): Promise<string[]> {
  const tables = TABLES.filter((table) => table !== "programs");
  const rows = await Promise.all(
    tables.map((table) => ctx.db.query(table).collect()),
  );
  return rows
    .flat()
    .flatMap((row) => ("uuid" in row ? [row.uuid] : []))
    .filter((uuid) => uuid !== B_AIRCRAFT);
}

async function dumpDatabase(t: Convex): Promise<Dump> {
  return t.run(async (ctx) => {
    const tables = await Promise.all(
      TABLES.map(async (table) =>
        (await ctx.db.query(table).collect())
          .filter((row) => !isOwnAllowance(row))
          .map((row) => keyRow(table, row)),
      ),
    );
    const files = await ctx.db.system.query(STORAGE).collect();
    return Object.fromEntries([
      ...tables.flat(),
      ...files.map((file) => keyRow(STORAGE, file)),
    ]);
  });
}

// Characterizes current behaviour: Spruce sync spends one of B's own hourly
// syncs before it looks the purchase order up. That counter is B's, not A's.
function isOwnAllowance(row: object) {
  return "key" in row && row.key === `spruce:sync:program:${PROGRAM_B}`;
}

function keyRow(table: string, row: { _id: string }): [string, string] {
  return [`${table}/${row._id}`, JSON.stringify(row)];
}

function listChanges(before: Dump, after: Dump): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]);
}

async function listPublicFunctions(): Promise<string[]> {
  const paths = Object.keys(modules).filter(
    (path) => !path.startsWith("./_generated/"),
  );
  const names = await Promise.all(paths.map(listModuleFunctions));
  return names.flat().sort();
}

async function listModuleFunctions(path: string): Promise<string[]> {
  const module = path.slice("./".length, -".ts".length);
  const exports = Object.entries((await modules[path]()) as object);
  return exports
    .filter(([, value]) => isPublicFunction(value))
    .map(([name]) => `${module}:${name}`);
}

// Convex's builders mark what they register. Reading the marks, not the
// builder's name, also finds a function made with a custom builder.
function isPublicFunction(value: unknown): boolean {
  if (typeof value !== "function") return false;
  const marks = value as { isPublic?: boolean; isHttp?: boolean };
  return marks.isPublic === true || marks.isHttp === true;
}
