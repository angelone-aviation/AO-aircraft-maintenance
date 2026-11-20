/**
 * Responsibility: Pins the Convex adapter: the server function each Backend
 *   method calls, as a query, mutation or action, and the arguments it sends,
 *   request ids included.
 * Layer: Test. Vitest suite over a recording fake client; never shipped.
 * Dependencies: src/data/backend.ts, src/data/store.ts, src/data/demo.ts,
 *   src/domain/checklists.ts (types), convex/react, convex/server.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { convexBackend, type Backend } from "./backend";
import type { ChecklistCommand } from "../domain/checklists";
import { useWorkspace } from "./store";
import { demoSnapshot } from "./demo";

type CallKind = "query" | "mutation" | "action";

interface RecordedCall {
  kind: CallKind;
  name: string;
  args: Record<string, unknown>;
}

interface Case {
  method: keyof Backend;
  call: (backend: Backend) => Promise<unknown>;
  kind: CallKind;
  name: string;
  args: Record<string, unknown>;
}

const ACTIVE_PROGRAM = "program-active";
const OTHER_PROGRAM = "program-other";
const REPLY = { from: "server" };
const FILE_TEXT = "file-bytes";
// SHA-256 of FILE_TEXT, base64 (`openssl dgst -sha256 -binary | base64`).
const FILE_SHA256 = "EwFaPPAsBdr776s7MxNQ2zSOcOhvTkPnPzJUc5V/Clw=";
const UPLOAD_URL = "https://upload.example/manual";

// The adapter only serializes commands, so one opaque value stands in for
// every command type.
const COMMAND = { kind: "test-command" };
const PAYLOAD = JSON.stringify(COMMAND);
const opaque = <T>(): T => COMMAND as unknown as T;
const CHOSEN_REQUEST_UUID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const file = () =>
  new File([FILE_TEXT], "evidence.pdf", { type: "application/pdf" });
const fileArgs = () => ({
  name: "evidence.pdf",
  type: "application/pdf",
  bytes: FILE_TEXT,
});
const command = () => ({ payload: PAYLOAD, programUuid: ACTIVE_PROGRAM });
const PUSH_SUBSCRIPTION = {
  endpoint: "https://push.example/sub/1",
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
  userAgent: "Test browser",
};
// The id crypto.randomUUID gives in these tests, for commands that carry one.
const REQUEST_UUID = "8d7c6b5a-4e3f-4a1b-9c8d-7e6f5a4b3c2d";
const requested = () => ({
  payload: JSON.stringify({ ...COMMAND, requestUuid: REQUEST_UUID }),
  programUuid: ACTIVE_PROGRAM,
});

const SPRUCE_LOGIN = {
  programUuid: OTHER_PROGRAM,
  version: 3,
  userid: "user",
  password: "secret",
  apikey: "key",
  currency: "USD",
};
const PAGE_REQUEST = { entityUuid: "record-1", cursor: null, numItems: 25 };
const HISTORY_REQUEST = {
  aircraftUuid: "aircraft-1",
  cursor: '[1,"u"]',
  numItems: 25,
};
const FLIGHT_RANGE = { aircraftUuid: "aircraft-1", from: 1, to: 2 };
const TRANSFER = {
  kind: "aircraft" as const,
  uuid: "aircraft-1",
  destination: OTHER_PROGRAM,
  reason: "Moved base",
};

beforeEach(() => {
  useWorkspace.setState({
    snapshot: { ...demoSnapshot(), activeProgramUuid: ACTIVE_PROGRAM },
  });
  vi.spyOn(crypto, "randomUUID").mockReturnValue(REQUEST_UUID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useWorkspace.setState({ snapshot: null });
});

const CASES: Case[] = [
  {
    method: "addressChoices",
    call: (b) => b.addressChoices(OTHER_PROGRAM),
    kind: "query",
    name: "savedAddresses:list",
    args: { programUuid: OTHER_PROGRAM },
  },
  {
    method: "saveAddress",
    call: (b) => b.saveAddress(OTHER_PROGRAM, opaque()),
    kind: "mutation",
    name: "savedAddresses:save",
    args: { programUuid: OTHER_PROGRAM, payload: PAYLOAD },
  },
  {
    method: "spruceStatus",
    call: (b) => b.spruceStatus(OTHER_PROGRAM),
    kind: "query",
    name: "aircraftSpruce:status",
    args: { programUuid: OTHER_PROGRAM },
  },
  {
    method: "spruceLink",
    call: (b) => b.spruceLink(SPRUCE_LOGIN),
    kind: "action",
    name: "aircraftSpruceActions:link",
    args: SPRUCE_LOGIN,
  },
  {
    method: "spruceDisconnect",
    call: (b) => b.spruceDisconnect(OTHER_PROGRAM, 3),
    kind: "mutation",
    name: "aircraftSpruce:disconnect",
    args: { programUuid: OTHER_PROGRAM, version: 3 },
  },
  {
    method: "spruceRefresh",
    call: (b) => b.spruceRefresh(OTHER_PROGRAM),
    kind: "action",
    name: "aircraftSpruceActions:refresh",
    args: { programUuid: OTHER_PROGRAM },
  },
  {
    method: "spruceSearch",
    call: (b) => b.spruceSearch(OTHER_PROGRAM, "filter"),
    kind: "action",
    name: "aircraftSpruceActions:search",
    args: { programUuid: OTHER_PROGRAM, search: "filter" },
  },
  {
    method: "spruceOrders",
    call: (b) => b.spruceOrders(OTHER_PROGRAM, "po-1"),
    kind: "query",
    name: "aircraftSpruce:orders",
    args: { programUuid: OTHER_PROGRAM, poUuid: "po-1" },
  },
  {
    method: "spruceSync",
    call: (b) => b.spruceSync(OTHER_PROGRAM, "po-1", "order-7"),
    kind: "action",
    name: "aircraftSpruceActions:sync",
    args: { programUuid: OTHER_PROGRAM, poUuid: "po-1", order: "order-7" },
  },
  {
    method: "addressSettings",
    call: (b) => b.addressSettings(),
    kind: "query",
    name: "addressVerification:status",
    args: {},
  },
  {
    method: "setAddressKey",
    call: (b) => b.setAddressKey({ key: "key", version: 2 }),
    kind: "action",
    name: "addressVerification:setKey",
    args: { key: "key", version: 2 },
  },
  {
    method: "lookupAddress",
    call: (b) => b.lookupAddress(opaque()),
    kind: "action",
    name: "addressVerification:lookup",
    args: command(),
  },
  {
    method: "latestOffsiteCopy",
    call: (b) => b.latestOffsiteCopy(),
    kind: "query",
    name: "backups:latestOffsiteCopy",
    args: {},
  },
  {
    method: "partsRequest",
    call: (b) => b.partsRequest(opaque()),
    kind: "mutation",
    name: "partsRequests:execute",
    args: command(),
  },
  {
    method: "purchaseOrder",
    call: (b) => b.purchaseOrder(opaque()),
    kind: "mutation",
    name: "purchaseOrders:execute",
    args: command(),
  },
  {
    method: "costs",
    call: (b) => b.costs(opaque()),
    kind: "mutation",
    name: "costs:execute",
    args: requested(),
  },
  {
    method: "poFiles",
    call: (b) => b.poFiles("po-1"),
    kind: "query",
    name: "purchaseOrders:files",
    args: { poUuid: "po-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "attachPOFile",
    call: (b) => b.attachPOFile("po-1", "receipt-1", file()),
    kind: "action",
    name: "poFiles:upload",
    args: {
      poUuid: "po-1",
      receiptUuid: "receipt-1",
      programUuid: ACTIVE_PROGRAM,
      ...fileArgs(),
    },
  },
  {
    method: "removePOFile",
    call: (b) => b.removePOFile("file-1"),
    kind: "mutation",
    name: "poFiles:remove",
    args: { id: "file-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "attachInventoryFile",
    call: (b) => b.attachInventoryFile("stock-1", file()),
    kind: "action",
    name: "inventoryFiles:upload",
    args: { stockUuid: "stock-1", ...fileArgs(), programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "removeInventoryFile",
    call: (b) => b.removeInventoryFile("file-1"),
    kind: "mutation",
    name: "inventoryFiles:remove",
    args: { id: "file-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "searchFAA",
    call: (b) => b.searchFAA(opaque()),
    kind: "action",
    name: "faaSearch:search",
    args: command(),
  },
  {
    method: "updateFaaKey",
    call: (b) => b.updateFaaKey(opaque()),
    kind: "action",
    name: "faaCredentials:replace",
    args: COMMAND,
  },
  {
    method: "faaCommand",
    call: (b) => b.faaCommand(opaque()),
    kind: "mutation",
    name: "faa:command",
    args: command(),
  },
  {
    method: "saveAD",
    call: (b) => b.saveAD(opaque()),
    kind: "mutation",
    name: "airworthiness:save",
    args: requested(),
  },
  {
    method: "saveChecklist",
    call: (b) => b.saveChecklist(opaque()),
    kind: "mutation",
    name: "checklists:save",
    args: requested(),
  },
  {
    method: "importTaskCsv",
    call: (b) => b.importTaskCsv(opaque()),
    kind: "mutation",
    name: "taskImports:save",
    args: { ...command(), requestUuid: REQUEST_UUID },
  },
  {
    method: "deleteInspectionTemplates",
    call: (b) => b.deleteInspectionTemplates(opaque()),
    kind: "mutation",
    name: "inspectionTemplates:remove",
    args: { ...command(), requestUuid: REQUEST_UUID },
  },
  {
    method: "activateTemplate",
    call: (b) => b.activateTemplate(opaque()),
    kind: "mutation",
    name: "inspectionTemplates:activate",
    args: { ...command(), requestUuid: REQUEST_UUID },
  },
  {
    method: "saveInspectionTemplates",
    call: (b) => b.saveInspectionTemplates(opaque()),
    kind: "mutation",
    name: "inspectionTemplates:save",
    args: { ...command(), requestUuid: REQUEST_UUID },
  },
  {
    method: "saveComponentTemplate",
    call: (b) => b.saveComponentTemplate(opaque()),
    kind: "mutation",
    name: "componentTemplates:save",
    args: requested(),
  },
  {
    method: "applyComponentTemplate",
    call: (b) => b.applyComponentTemplate(opaque()),
    kind: "mutation",
    name: "componentTemplates:apply",
    args: requested(),
  },
  {
    method: "editManual",
    call: (b) => b.editManual("manual-1", opaque()),
    kind: "mutation",
    name: "manuals:edit",
    args: { uuid: "manual-1", ...command() },
  },
  {
    method: "renameManual",
    call: (b) => b.renameManual("manual-1", "Pilot handbook"),
    kind: "mutation",
    name: "manuals:rename",
    args: {
      uuid: "manual-1",
      title: "Pilot handbook",
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "setManualApplicability",
    call: (b) => b.setManualApplicability("manual-1", opaque()),
    kind: "mutation",
    name: "manuals:setApplicability",
    args: { uuid: "manual-1", ...command() },
  },
  {
    method: "taskCard",
    call: (b) => b.taskCard(opaque()),
    kind: "mutation",
    name: "taskCards:save",
    args: requested(),
  },
  {
    method: "attachTaskEvidence",
    call: (b) => b.attachTaskEvidence("task-1", "photo", file()),
    kind: "action",
    name: "taskCards:upload",
    args: {
      taskCardUuid: "task-1",
      category: "photo",
      ...fileArgs(),
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "removeTaskEvidence",
    call: (b) => b.removeTaskEvidence("evidence-1"),
    kind: "mutation",
    name: "taskCards:removeEvidence",
    args: { id: "evidence-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "workOrder",
    call: (b) => b.workOrder(opaque()),
    kind: "mutation",
    name: "workOrders:save",
    args: requested(),
  },
  {
    method: "resumeWorkOrderTemplates",
    call: (b) => b.resumeWorkOrderTemplates("order-1"),
    kind: "mutation",
    name: "workOrderCopies:resume",
    args: { workOrderUuid: "order-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "attachWorkOrderFile",
    call: (b) => b.attachWorkOrderFile("order-1", file()),
    kind: "action",
    name: "workOrders:upload",
    args: {
      workOrderUuid: "order-1",
      ...fileArgs(),
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "removeWorkOrderFile",
    call: (b) => b.removeWorkOrderFile("file-1"),
    kind: "mutation",
    name: "workOrders:removeFile",
    args: { id: "file-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "submit",
    call: (b) => b.submit(opaque()),
    kind: "mutation",
    name: "operations:submit",
    args: { operation: COMMAND },
  },
  {
    method: "resolve",
    call: (b) => b.resolve("report-1", "Replaced the fuse."),
    kind: "mutation",
    name: "operations:resolveDiscrepancy",
    args: {
      uuid: "report-1",
      resolution: "Replaced the fuse.",
      requestUuid: REQUEST_UUID,
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "deferDiscrepancy",
    call: (b) => b.deferDiscrepancy(opaque()),
    kind: "mutation",
    name: "operations:deferDiscrepancy",
    args: requested(),
  },
  {
    method: "saveDiscrepancyParts",
    call: (b) => b.saveDiscrepancyParts("report-1", 4, opaque()),
    kind: "mutation",
    name: "operations:saveDiscrepancyParts",
    args: {
      uuid: "report-1",
      version: 4,
      ...command(),
      requestUuid: REQUEST_UUID,
    },
  },
  {
    method: "review",
    call: (b) => b.review("flight-1", "accept", "Checked", opaque()),
    kind: "mutation",
    name: "operations:reviewFlight",
    args: {
      uuid: "flight-1",
      programUuid: ACTIVE_PROGRAM,
      decision: "accept",
      reason: "Checked",
      input: COMMAND,
      requestUuid: REQUEST_UUID,
    },
  },
  {
    method: "savePlan",
    call: (b) => b.savePlan(opaque()),
    kind: "mutation",
    name: "flightPlans:save",
    args: requested(),
  },
  {
    method: "engineTrends",
    call: (b) => b.engineTrends("aircraft-1"),
    kind: "query",
    name: "engineTrends:list",
    args: { aircraftUuid: "aircraft-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "engineTrend",
    call: (b) => b.engineTrend("aircraft-1", opaque()),
    kind: "mutation",
    name: "engineTrends:execute",
    args: { aircraftUuid: "aircraft-1", ...requested() },
  },
  {
    method: "fleet",
    call: (b) => b.fleet(opaque()),
    kind: "mutation",
    name: "fleet:save",
    args: command(),
  },
  {
    method: "manage",
    call: (b) => b.manage(opaque()),
    kind: "mutation",
    name: "management:execute",
    args: command(),
  },
  {
    method: "uploadAircraftPhoto",
    call: (b) => b.uploadAircraftPhoto("aircraft-1", file()),
    kind: "action",
    name: "aircraftPhotos:upload",
    args: {
      aircraftUuid: "aircraft-1",
      programUuid: ACTIVE_PROGRAM,
      type: "application/pdf",
      bytes: FILE_TEXT,
    },
  },
  {
    method: "removeAircraftPhoto",
    call: (b) => b.removeAircraftPhoto("aircraft-1"),
    kind: "mutation",
    name: "aircraftPhotos:remove",
    args: { aircraftUuid: "aircraft-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "uploadAircraftFile",
    call: (b) => b.uploadAircraftFile("aircraft-1", "form-337", file()),
    kind: "action",
    name: "aircraftFiles:upload",
    args: {
      aircraftUuid: "aircraft-1",
      category: "form-337",
      ...fileArgs(),
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "uploadAircraftFile",
    call: (b) =>
      b.uploadAircraftFile("aircraft-1", "logbook-page", file(), {
        linkedKind: "flight",
        linkedUuid: "flight-1",
      }),
    kind: "action",
    name: "aircraftFiles:upload",
    args: {
      aircraftUuid: "aircraft-1",
      category: "logbook-page",
      linkedKind: "flight",
      linkedUuid: "flight-1",
      ...fileArgs(),
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "archiveAircraftFile",
    call: (b) => b.archiveAircraftFile("file-1", "Superseded"),
    kind: "mutation",
    name: "aircraftFiles:archive",
    args: { id: "file-1", reason: "Superseded", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "fileLinks",
    call: (b) => b.fileLinks([{ kind: "aircraftPhoto", id: "demo-206" }]),
    kind: "mutation",
    name: "fileLinks:links",
    args: {
      files: [{ kind: "aircraftPhoto", id: "demo-206" }],
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "selectProgram",
    call: (b) => b.selectProgram(OTHER_PROGRAM),
    kind: "mutation",
    name: "programs:select",
    args: { programUuid: OTHER_PROGRAM },
  },
  {
    method: "transferProgram",
    call: (b) => b.transferProgram(TRANSFER),
    kind: "mutation",
    name: "programs:transfer",
    args: {
      ...TRANSFER,
      requestUuid: REQUEST_UUID,
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "updateProgramAccess",
    call: (b) =>
      b.updateProgramAccess("user-1", OTHER_PROGRAM, ["group-1"], true),
    kind: "mutation",
    name: "programUsers:updateAccess",
    args: {
      userId: "user-1",
      programUuid: OTHER_PROGRAM,
      groupIds: ["group-1"],
      remove: true,
    },
  },
  {
    method: "addExistingProgramUser",
    call: (b) =>
      b.addExistingProgramUser("a@example.com", OTHER_PROGRAM, ["group-1"]),
    kind: "mutation",
    name: "programUsers:addExisting",
    args: {
      email: "a@example.com",
      programUuid: OTHER_PROGRAM,
      groupIds: ["group-1"],
    },
  },
  {
    method: "createProgramUser",
    call: (b) =>
      b.createProgramUser("a@example.com", "Ann", "pw", OTHER_PROGRAM, []),
    kind: "action",
    name: "programUsers:create",
    args: {
      email: "a@example.com",
      name: "Ann",
      password: "pw",
      programUuid: OTHER_PROGRAM,
      groupIds: [],
    },
  },
  {
    method: "createUser",
    call: (b) => b.createUser("a@example.com", "Ann", "pw"),
    kind: "action",
    name: "admin:createUser",
    args: { email: "a@example.com", name: "Ann", password: "pw" },
  },
  {
    method: "resetPassword",
    call: (b) => b.resetPassword("user-1", "pw"),
    kind: "action",
    name: "admin:resetPassword",
    args: { id: "user-1", password: "pw" },
  },
  {
    method: "linkedIdentities",
    call: (b) => b.linkedIdentities("user-1"),
    kind: "query",
    name: "identities:forUser",
    args: { userId: "user-1" },
  },
  {
    method: "linkedIdentities",
    call: (b) => b.linkedIdentities(),
    kind: "query",
    name: "identities:mine",
    args: {},
  },
  {
    method: "linkedIdentities",
    call: (b) => b.linkedIdentities(""),
    kind: "query",
    name: "identities:mine",
    args: {},
  },
  {
    method: "removeIdentity",
    call: (b) => b.removeIdentity("user-1", "account-1"),
    kind: "mutation",
    name: "identities:remove",
    args: { userId: "user-1", id: "account-1" },
  },
  {
    method: "saveReleaseStatements",
    call: (b) => b.saveReleaseStatements([{ label: "RTS", text: "Returned" }]),
    kind: "mutation",
    name: "admin:saveReleaseStatements",
    args: { statements: [{ label: "RTS", text: "Returned" }] },
  },
  {
    method: "saveLogbookPhrases",
    call: (b) => b.saveLogbookPhrases(["Performed"]),
    kind: "mutation",
    name: "admin:saveLogbookPhrases",
    args: { phrases: ["Performed"] },
  },
  {
    method: "certificatesAwaitingApproval",
    call: (b) => b.certificatesAwaitingApproval(),
    kind: "query",
    name: "certifications:awaitingApproval",
    args: { programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "approveCertificate",
    call: (b) => b.approveCertificate("user-1", opaque()),
    kind: "mutation",
    name: "certifications:approve",
    args: {
      userId: "user-1",
      programUuid: ACTIVE_PROGRAM,
      certificate: PAYLOAD,
    },
  },
  {
    method: "saveCertifications",
    call: (b) => b.saveCertifications("user-1", opaque()),
    kind: "mutation",
    name: "certifications:save",
    args: { userId: "user-1", payload: PAYLOAD },
  },
  {
    method: "certificationFiles",
    call: (b) => b.certificationFiles("user-1"),
    kind: "query",
    name: "certifications:list",
    args: { userId: "user-1" },
  },
  {
    method: "uploadCertification",
    call: (b) => b.uploadCertification("user-1", "mechanic", file()),
    kind: "action",
    name: "certifications:upload",
    args: { userId: "user-1", kind: "mechanic", ...fileArgs() },
  },
  {
    method: "deleteCertificationFile",
    call: (b) => b.deleteCertificationFile("copy-1"),
    kind: "mutation",
    name: "certifications:remove",
    args: { id: "copy-1" },
  },
  {
    method: "updateUser",
    call: (b) =>
      b.updateUser({
        id: "user-1",
        name: "Ann",
        email: "a@example.com",
        active: false,
        isAdmin: true,
        groupIds: ["group-1"],
      }),
    kind: "mutation",
    name: "admin:updateUser",
    args: {
      id: "user-1",
      name: "Ann",
      certificationsPayload: undefined,
      active: false,
      isAdmin: true,
      groupIds: ["group-1"],
    },
  },
  {
    method: "updateUser",
    call: (b) =>
      b.updateUser({
        id: "user-1",
        name: "Ann",
        email: "a@example.com",
        active: true,
        isAdmin: false,
        groupIds: [],
        certifications: [],
      }),
    kind: "mutation",
    name: "admin:updateUser",
    args: {
      id: "user-1",
      name: "Ann",
      certificationsPayload: "[]",
      active: true,
      isAdmin: false,
      groupIds: [],
    },
  },
  {
    method: "groupAccessReview",
    call: (b) => b.groupAccessReview(),
    kind: "query",
    name: "groupAudit:groupsToReview",
    args: {},
  },
  {
    method: "previewGroupDeletion",
    call: (b) => b.previewGroupDeletion("group-1"),
    kind: "query",
    name: "groupDeletion:preview",
    args: { id: "group-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "deleteGroup",
    call: (b) => b.deleteGroup("group-1", "plan-1"),
    kind: "mutation",
    name: "groupDeletion:remove",
    args: { id: "group-1", programUuid: ACTIVE_PROGRAM, expected: "plan-1" },
  },
  {
    method: "saveGroup",
    call: (b) =>
      b.saveGroup({
        id: "group-1",
        name: "Pilots",
        aircraftIds: [],
        allAircraft: true,
        permissions: ["read"],
      }),
    kind: "mutation",
    name: "admin:saveGroup",
    args: {
      id: "group-1",
      name: "Pilots",
      aircraftIds: [],
      allAircraft: true,
      permissions: ["read"],
    },
  },
  {
    method: "saveGroup",
    call: (b) =>
      b.saveGroup({ name: "Pilots", aircraftIds: [], permissions: [] }),
    kind: "mutation",
    name: "admin:saveGroup",
    args: { id: undefined, name: "Pilots", aircraftIds: [], permissions: [] },
  },
  {
    method: "auditPage",
    call: (b) => b.auditPage(PAGE_REQUEST),
    kind: "query",
    name: "auditHistory:page",
    args: { ...PAGE_REQUEST, programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "auditSummary",
    call: (b) => b.auditSummary({ from: "2026-11-03", to: "2026-11-09" }),
    kind: "query",
    name: "auditHistory:summary",
    args: { from: "2026-11-03", to: "2026-11-09", programUuid: ACTIVE_PROGRAM },
  },
  ...(["flights", "discrepancies", "workOrders"] as const).map(
    (kind): Case => ({
      method: "historyPage",
      call: (b) => b.historyPage({ kind, ...HISTORY_REQUEST }),
      kind: "query",
      name: `history:${kind}`,
      args: { ...HISTORY_REQUEST, programUuid: ACTIVE_PROGRAM },
    }),
  ),
  {
    method: "historyPage",
    call: (b) =>
      b.historyPage({
        kind: "flights",
        status: "rejected",
        ...HISTORY_REQUEST,
      }),
    kind: "query",
    name: "history:flights",
    args: {
      status: "rejected",
      ...HISTORY_REQUEST,
      programUuid: ACTIVE_PROGRAM,
    },
  },
  {
    method: "workOrderHistory",
    call: (b) => b.workOrderHistory("work-order-1"),
    kind: "query",
    name: "history:workOrder",
    args: { uuid: "work-order-1", programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "flightsInRange",
    call: (b) => b.flightsInRange(FLIGHT_RANGE),
    kind: "query",
    name: "history:flightsInRange",
    args: { ...FLIGHT_RANGE, programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "alertReads",
    call: (b) => b.alertReads(OTHER_PROGRAM),
    kind: "query",
    name: "alerts:readKeys",
    args: { programUuid: OTHER_PROGRAM },
  },
  {
    method: "markAlertsRead",
    call: (b) => b.markAlertsRead(undefined, ["alert-1"], true),
    kind: "mutation",
    name: "alerts:markRead",
    args: { programUuid: undefined, keys: ["alert-1"], all: true },
  },
  {
    method: "forgetAlertReads",
    call: (b) => b.forgetAlertReads(OTHER_PROGRAM, ["alert-1"]),
    kind: "mutation",
    name: "alerts:forgetRead",
    args: { programUuid: OTHER_PROGRAM, keys: ["alert-1"] },
  },
  {
    method: "setAlertEmails",
    call: (b) => b.setAlertEmails(false),
    kind: "mutation",
    name: "alerts:setEmailPreference",
    args: { enabled: false },
  },
  {
    method: "setUrgentAlertEmails",
    call: (b) => b.setUrgentAlertEmails(true),
    kind: "mutation",
    name: "urgentAlerts:setUrgentEmailPreference",
    args: { enabled: true },
  },
  {
    method: "expiringDate",
    call: (b) => b.expiringDate(opaque()),
    kind: "mutation",
    name: "expiringItems:save",
    args: requested(),
  },
  {
    method: "pushPublicKey",
    call: (b) => b.pushPublicKey(),
    kind: "query",
    name: "pushSubscriptions:publicKey",
    args: {},
  },
  {
    method: "subscribePush",
    call: (b) => b.subscribePush(PUSH_SUBSCRIPTION),
    kind: "mutation",
    name: "pushSubscriptions:subscribe",
    args: { ...PUSH_SUBSCRIPTION, programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "unsubscribePush",
    call: (b) => b.unsubscribePush(PUSH_SUBSCRIPTION.endpoint),
    kind: "mutation",
    name: "pushSubscriptions:unsubscribe",
    args: { endpoint: PUSH_SUBSCRIPTION.endpoint, programUuid: ACTIVE_PROGRAM },
  },
  {
    method: "pushDeviceHeld",
    call: (b) => b.pushDeviceHeld(PUSH_SUBSCRIPTION.endpoint),
    kind: "query",
    name: "pushSubscriptions:held",
    args: { endpoint: PUSH_SUBSCRIPTION.endpoint },
  },
  {
    method: "alertEmailEnabled",
    call: (b) => b.alertEmailEnabled(),
    kind: "query",
    name: "alerts:emailEnabled",
    args: {},
  },
  {
    method: "signInProviders",
    call: (b) => b.signInProviders(),
    kind: "query",
    name: "identities:providers",
    args: {},
  },
];

it.each(CASES)(
  "$method calls the $kind $name with its arguments",
  async ({ call, kind, name, args }) => {
    const { backend, calls } = recordingBackend();
    await expect(call(backend)).resolves.toBe(REPLY);
    expect(calls).toEqual([{ kind, name, args }]);
  },
);

it("covers every adapter method", () => {
  const covered = new Set<string>(CASES.map((c) => c.method));
  covered.add("uploadManual");
  covered.add("openManual");
  covered.add("certificationFileUrl");
  const methods = Object.keys(recordingBackend().backend).sort();
  expect(methods).toEqual([...covered].sort());
});

it("reads the active Flight Program when each method is called", async () => {
  const { backend, calls } = recordingBackend();
  useWorkspace.setState({ snapshot: null });
  await backend.workOrder(opaque());
  useWorkspace.setState({
    snapshot: { ...demoSnapshot(), activeProgramUuid: OTHER_PROGRAM },
  });
  await backend.workOrder(opaque());
  expect(calls.map((c) => c.args.programUuid)).toEqual([
    undefined,
    OTHER_PROGRAM,
  ]);
});

it("sends a new request id with each AD, checklist, engine-trend, cost, job-card, deferral, component-template, work-order and flight-plan command", async () => {
  vi.restoreAllMocks();
  const { backend, calls } = recordingBackend();
  await backend.saveAD(opaque());
  await backend.saveAD(opaque());
  await backend.saveChecklist(opaque());
  await backend.engineTrend("aircraft-1", opaque());
  await backend.costs(opaque());
  await backend.taskCard(opaque());
  await backend.deferDiscrepancy(opaque());
  await backend.saveComponentTemplate(opaque());
  await backend.applyComponentTemplate(opaque());
  await backend.workOrder(opaque());
  await backend.savePlan(opaque());
  const ids = calls.map(
    (c) => JSON.parse(c.args.payload as string).requestUuid,
  );
  expect(new Set(ids).size).toBe(11);
  for (const id of ids) expect(id).toMatch(UUID);
});

it("sends a new request id beside the arguments of a resolution, a parts list, a flight review, a transfer, a task import and template commands", async () => {
  vi.restoreAllMocks();
  const { backend, calls } = recordingBackend();
  await backend.resolve("report-1", "Fixed");
  await backend.resolve("report-1", "Fixed");
  await backend.saveDiscrepancyParts("report-1", 4, opaque());
  await backend.review("flight-1", "accept", "Checked", opaque());
  await backend.transferProgram(TRANSFER);
  await backend.importTaskCsv(opaque());
  await backend.saveInspectionTemplates(opaque());
  await backend.activateTemplate(opaque());
  await backend.deleteInspectionTemplates(opaque());
  const ids = calls.map((c) => c.args.requestUuid);
  expect(new Set(ids).size).toBe(9);
  for (const id of ids) expect(id).toMatch(UUID);
});

it("keeps a request id the caller chose for its intent", async () => {
  const chosen = { ...COMMAND, requestUuid: CHOSEN_REQUEST_UUID };
  const { backend, calls } = recordingBackend();
  await backend.saveChecklist(chosen as unknown as ChecklistCommand);
  expect(calls[0].args.payload).toBe(JSON.stringify(chosen));
});

it("opens a manual and a license copy through their links", async () => {
  const link = { url: "https://test.convex.site/files/v1/token", expiresAt: 1 };
  const { backend, calls } = recordingBackend({ "fileLinks:links": [link] });
  await expect(backend.openManual("manual-1")).resolves.toBe(link.url);
  await expect(backend.certificationFileUrl("copy-1")).resolves.toBe(link.url);
  const asked = (kind: string, id: string) => ({
    kind: "mutation",
    name: "fileLinks:links",
    args: { files: [{ kind, id }], programUuid: ACTIVE_PROGRAM },
  });
  expect(calls).toEqual([
    asked("manual", "manual-1"),
    asked("certificationFile", "copy-1"),
  ]);
  const refused = recordingBackend({ "fileLinks:links": [null] }).backend;
  await expect(refused.openManual("hidden")).rejects.toThrow(
    "Manual is not available in this workspace.",
  );
  await expect(refused.certificationFileUrl("gone")).resolves.toBeNull();
});

it("uploadManual posts the PDF and finishes where it began", async () => {
  const pdf = file();
  const fetchMock = vi.fn(async () => {
    useWorkspace.setState({ snapshot: null });
    return new Response(JSON.stringify({ storageId: "storage-1" }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const { backend, calls } = recordingBackend({
    "manuals:beginUpload": { ticket: "ticket-1", url: UPLOAD_URL },
  });
  await expect(backend.uploadManual(opaque(), pdf)).resolves.toBe(REPLY);
  expect(fetchMock).toHaveBeenCalledWith(UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: pdf,
  });
  expect(calls).toEqual([
    {
      kind: "mutation",
      name: "manuals:beginUpload",
      args: { ...command(), sha256: FILE_SHA256 },
    },
    {
      kind: "action",
      name: "manuals:finishUpload",
      args: {
        ticket: "ticket-1",
        storageId: "storage-1",
        programUuid: ACTIVE_PROGRAM,
      },
    },
  ]);
});

it("uploadManual refuses a failed upload before finishing it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );
  const { backend, calls } = recordingBackend({
    "manuals:beginUpload": { ticket: "ticket-1", url: UPLOAD_URL },
  });
  await expect(backend.uploadManual(opaque(), file())).rejects.toThrow(
    "Manual upload failed. Please try again.",
  );
  expect(calls.map((c) => c.name)).toEqual(["manuals:beginUpload"]);
});

function recordingBackend(replies: Record<string, unknown> = {}) {
  const calls: RecordedCall[] = [];
  const record =
    (kind: CallKind) =>
    (ref: FunctionReference<CallKind>, args: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      calls.push({ kind, name, args: readBytesAsText(args) });
      return Promise.resolve(name in replies ? replies[name] : REPLY);
    };
  const client = {
    query: record("query"),
    mutation: record("mutation"),
    action: record("action"),
  };
  // The adapter calls only query, mutation and action on the client.
  const backend = convexBackend(client as unknown as ConvexReactClient);
  return { backend, calls };
}

// Any two ArrayBuffers are equal to toEqual, so uploaded bytes are compared
// as text.
function readBytesAsText(args: Record<string, unknown>) {
  const { bytes } = args;
  if (!(bytes instanceof ArrayBuffer)) return args;
  return { ...args, bytes: new TextDecoder().decode(bytes) };
}
