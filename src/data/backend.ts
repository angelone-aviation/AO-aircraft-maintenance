/**
 * Responsibility: The Backend contract between the workspace and its two
 *   adapters, and the Convex adapter that sends each call to one server
 *   function.
 * Layer: Data. A thin client over convex/_generated/api; no rules, no UI.
 * Dependencies: convex/react, convex/_generated (api, dataModel),
 *   src/data/store, src/domain (command, input and record types), zod (types).
 *
 * The server re-checks every argument. Ids arrive from the server snapshot as
 * strings; the `Id` casts are safe because Convex checks each id's table.
 */
import type { GroupDeletionPlan } from "../domain/groupDeletion";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import type { DeferCommand } from "../domain/deferrals";
import type {
  Certification,
  CertificationFile,
  CertificationKind,
} from "../domain/certifications";
import type { ReleaseStatement } from "../domain/releaseStatements";
import type { ManualInput, ManualApplicability } from "../domain/manuals";
import type { TaskCardCommand, TaskEvidence } from "../domain/taskCards";
import type { WorkOrderCommand } from "../domain/workOrders";
import type { PlanCommand } from "../domain/flightPlans";
import type { ProgramTransfer } from "../domain/programTransfers";
import { useWorkspace } from "./store";
import type { FleetCommand } from "../domain/fleet";
import type { ManagementCommand } from "../domain/management";
import type { FlightInput, Group, Member, Operation } from "../domain/model";
import type { ConvexReactClient } from "convex/react";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
export interface Backend {
  addressChoices(
    programUuid: string,
  ): Promise<import("../domain/savedAddresses").AddressChoices>;
  saveAddress(
    programUuid: string,
    input: import("../domain/savedAddresses").SavedAddressInput,
  ): Promise<import("../domain/savedAddresses").SavedAddress>;
  spruceStatus(
    programUuid: string,
  ): Promise<import("../domain/aircraftSpruce").SpruceStatus>;
  spruceLink(input: {
    programUuid: string;
    version: number;
    userid: string;
    password: string;
    apikey: string;
    currency: string;
  }): Promise<unknown>;
  spruceDisconnect(programUuid: string, version: number): Promise<unknown>;
  spruceRefresh(programUuid: string): Promise<number>;
  spruceSearch(
    programUuid: string,
    search: string,
  ): Promise<import("../domain/aircraftSpruce").SpruceProduct[]>;
  spruceOrders(
    programUuid: string,
    poUuid: string,
  ): Promise<import("../domain/aircraftSpruce").SpruceOrderSnapshot | null>;
  spruceSync(
    programUuid: string,
    poUuid: string,
    order: string,
  ): Promise<number>;
  addressSettings(): Promise<{ configured: boolean; version: number }>;
  /** System administrators: the newest nightly off-site backup (ADR-0008);
   * null before the first one, and always in the demo. */
  latestOffsiteCopy(): Promise<
    import("../domain/offsiteBackups").OffsiteCopy | null
  >;
  setAddressKey(input: { key: string; version: number }): Promise<unknown>;
  lookupAddress(
    input: import("../domain/addressLookup").AddressLookupInput,
  ): Promise<import("../domain/addressLookup").AddressSuggestion[]>;
  partsRequest(
    command: import("../domain/partsRequests").RequestCommand,
  ): Promise<unknown>;
  poFiles(
    uuid: string,
  ): Promise<
    { uuid: string; name: string; url: string | null; receiptUuid?: string }[]
  >;
  attachPOFile(
    uuid: string,
    receiptUuid: string | undefined,
    file: File,
  ): Promise<unknown>;

  purchaseOrder(
    command: import("../domain/purchaseOrders").POCommand,
  ): Promise<unknown>;
  costs(command: import("../domain/costs").CostCommand): Promise<unknown>;

  searchFAA(
    input: import("../domain/faaSearch").FaaSearchInput,
  ): Promise<import("../domain/faaSearch").FaaSearchResult[]>;
  updateFaaKey(
    input: import("zod").infer<
      typeof import("../domain/faaCredential").faaCredentialInput
    >,
  ): Promise<unknown>;
  faaCommand(command: import("../domain/faa").FaaCommand): Promise<unknown>;
  saveAD(
    command: import("../domain/airworthiness").ADCommand,
  ): Promise<unknown>;
  saveChecklist(
    command: import("../domain/checklists").ChecklistCommand,
  ): Promise<unknown>;
  attachInventoryFile(stockUuid: string, file: File): Promise<unknown>;
  saveReleaseStatements(statements: ReleaseStatement[]): Promise<unknown>;
  saveLogbookPhrases(phrases: string[]): Promise<unknown>;
  saveDiscrepancyParts(
    uuid: string,
    version: number,
    parts: import("../domain/requiredParts").RequiredPart[],
  ): Promise<unknown>;
  saveLicense(licenseNumber: string, certificateType: string): Promise<unknown>;
  importTaskCsv(
    input: import("../domain/taskCsv").TaskCsvImport,
  ): Promise<unknown>;
  deleteInspectionTemplates(
    input: import("../domain/deleteInspectionTemplates").DeleteTemplatesInput,
  ): Promise<unknown>;
  activateTemplate(
    input: import("../domain/activateTemplate").ActivateTemplateInput,
  ): Promise<unknown>;
  saveInspectionTemplates(
    records: import("../domain/inspectionTemplates").InspectionTemplate[],
  ): Promise<unknown>;
  editManual(
    uuid: string,
    input: import("../domain/manuals").ManualEdit,
  ): Promise<unknown>;
  saveComponentTemplate(
    input: import("../domain/componentTemplates").ComponentTemplate,
  ): Promise<unknown>;
  applyComponentTemplate(input: {
    templateUuid: string;
    version: number;
    aircraftUuid: string;
    rowIds: string[];
  }): Promise<unknown>;
  renameManual(uuid: string, title: string): Promise<unknown>;
  setManualApplicability(
    uuid: string,
    applicability: ManualApplicability,
  ): Promise<unknown>;
  uploadManual(input: ManualInput, file: File): Promise<unknown>;
  openManual(uuid: string): Promise<string>;
  taskCard(command: TaskCardCommand): Promise<unknown>;
  attachTaskEvidence(
    taskCardUuid: string,
    category: TaskEvidence["category"],
    file: File,
  ): Promise<unknown>;
  workOrder(command: WorkOrderCommand): Promise<unknown>;
  resumeWorkOrderTemplates(workOrderUuid: string): Promise<unknown>;
  attachWorkOrderFile(workOrderUuid: string, file: File): Promise<unknown>;
  auditPage(
    request: import("../domain/auditHistory").AuditPageRequest,
  ): Promise<import("../domain/auditHistory").AuditPage>;
  removeInventoryFile(id: string): Promise<unknown>;
  removeWorkOrderFile(id: string): Promise<unknown>;
  removeTaskEvidence(id: string): Promise<unknown>;
  removePOFile(id: string): Promise<unknown>;
  savePlan(command: PlanCommand): Promise<unknown>;
  transferProgram(input: ProgramTransfer): Promise<unknown>;
  selectProgram(programUuid: string): Promise<unknown>;
  fleet(command: FleetCommand): Promise<unknown>;
  manage(command: ManagementCommand): Promise<unknown>;
  submit(operation: Operation): Promise<{ status: string }>;
  engineTrends(
    aircraftUuid: string,
  ): Promise<import("../domain/engineTrends").EngineTrendData>;
  engineTrend(
    aircraftUuid: string,
    command: import("../domain/engineTrends").EngineTrendCommand,
  ): Promise<unknown>;
  resolve(uuid: string, resolution: string): Promise<unknown>;
  deferDiscrepancy(command: DeferCommand): Promise<unknown>;
  review(
    uuid: string,
    decision: "accept" | "reject",
    reason: string,
    input: FlightInput,
  ): Promise<unknown>;
  updateProgramAccess(
    userId: string,
    programUuid: string,
    groupIds: string[],
    remove: boolean,
  ): Promise<unknown>;
  // Resolves to the same message whether or not an active account uses the email.
  addExistingProgramUser(
    email: string,
    programUuid: string,
    groupIds: string[],
  ): Promise<string>;
  createProgramUser(
    email: string,
    name: string,
    password: string,
    programUuid: string,
    groupIds: string[],
  ): Promise<string>;
  uploadAircraftPhoto(aircraftUuid: string, file: File): Promise<unknown>;
  removeAircraftPhoto(aircraftUuid: string): Promise<unknown>;
  uploadAircraftFile(
    aircraftUuid: string,
    category: import("../domain/aircraftFiles").AircraftFileCategory,
    file: File,
  ): Promise<unknown>;
  archiveAircraftFile(id: string, reason: string): Promise<unknown>;
  createUser(email: string, name: string, password: string): Promise<string>;
  updateUser(user: Member): Promise<unknown>;
  saveCertifications(
    userId: string,
    certifications: Certification[],
  ): Promise<unknown>;
  certificationFiles(userId: string): Promise<CertificationFile[]>;
  uploadCertification(
    userId: string,
    kind: CertificationKind,
    file: File,
  ): Promise<unknown>;
  certificationFileUrl(id: string): Promise<string | null>;
  deleteCertificationFile(id: string): Promise<unknown>;
  /** System administrators: groups covering every program aircraft whose
   * change log does not show that choice (follow-up to #34). */
  groupAccessReview(): Promise<GroupAccessReport[]>;
  previewGroupDeletion(id: string): Promise<GroupDeletionPlan>;
  deleteGroup(id: string, expected: string): Promise<unknown>;
  /** `allAircraft` states explicitly that an empty list means every aircraft
   * in the program (assertGroupAircraftChoice). */
  saveGroup(
    group: Omit<Group, "id"> & { id?: string; allAircraft?: boolean },
  ): Promise<unknown>;
  resetPassword(id: string, password: string): Promise<unknown>;
  /** Linked Google or Microsoft accounts: the signed-in user's own, or with
   * `userId` (system administrators) that user's. */
  linkedIdentities(
    userId?: string,
  ): Promise<import("../domain/signInMethods").LinkedIdentity[]>;
  removeIdentity(userId: string, id: string): Promise<unknown>;
  alertReads(programUuid: string | undefined): Promise<string[]>;
  markAlertsRead(
    programUuid: string | undefined,
    keys: string[],
    all: boolean,
  ): Promise<unknown>;
  setAlertEmails(enabled: boolean): Promise<unknown>;
}
// IDs originate in the server snapshot; Convex validates their table on receipt.
export function convexBackend(client: ConvexReactClient): Backend {
  const programUuid = () => useWorkspace.getState().snapshot?.activeProgramUuid;
  return {
    addressChoices: (programUuid) =>
      client.query(api.savedAddresses.list, { programUuid }),
    saveAddress: (programUuid, input) =>
      client.mutation(api.savedAddresses.save, {
        programUuid,
        payload: JSON.stringify(input),
      }),
    spruceStatus: (programUuid) =>
      client.query(api.aircraftSpruce.status, { programUuid }),
    spruceLink: (input) => client.action(api.aircraftSpruceActions.link, input),
    spruceDisconnect: (programUuid, version) =>
      client.mutation(api.aircraftSpruce.disconnect, { programUuid, version }),
    spruceRefresh: (programUuid) =>
      client.action(api.aircraftSpruceActions.refresh, { programUuid }),
    spruceSearch: (programUuid, search) =>
      client.action(api.aircraftSpruceActions.search, { programUuid, search }),
    spruceOrders: (programUuid, poUuid) =>
      client.query(api.aircraftSpruce.orders, { programUuid, poUuid }),
    spruceSync: (programUuid, poUuid, order) =>
      client.action(api.aircraftSpruceActions.sync, {
        programUuid,
        poUuid,
        order,
      }),
    partsRequest: (command) =>
      client.mutation(api.partsRequests.execute, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    addressSettings: () => client.query(api.addressVerification.status, {}),
    latestOffsiteCopy: () => client.query(api.backups.latestOffsiteCopy, {}),
    setAddressKey: (input) =>
      client.action(api.addressVerification.setKey, input),
    lookupAddress: (input) =>
      client.action(api.addressVerification.lookup, {
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    poFiles: (poUuid) =>
      client.query(api.purchaseOrders.files, {
        poUuid,
        programUuid: programUuid(),
      }),
    attachPOFile: async (poUuid, receiptUuid, file) =>
      client.action(api.poFiles.upload, {
        poUuid,
        receiptUuid,
        programUuid: programUuid(),
        name: file.name,
        type: file.type,
        bytes: await file.arrayBuffer(),
      }),
    purchaseOrder: (command) =>
      client.mutation(api.purchaseOrders.execute, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    costs: (command) =>
      client.mutation(api.costs.execute, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    searchFAA: (input) =>
      client.action(api.faaSearch.search, {
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    updateFaaKey: (input) => client.action(api.faaCredentials.replace, input),
    faaCommand: (command) =>
      client.mutation(api.faa.command, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    saveAD: (command) =>
      client.mutation(api.airworthiness.save, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    saveChecklist: (command) =>
      client.mutation(api.checklists.save, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    saveDiscrepancyParts: (uuid, version, parts) =>
      client.mutation(api.operations.saveDiscrepancyParts, {
        uuid,
        version,
        payload: JSON.stringify(parts),
        programUuid: programUuid(),
      }),
    importTaskCsv: (input) =>
      client.mutation(api.taskImports.save, {
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    deleteInspectionTemplates: (input) =>
      client.mutation(api.inspectionTemplates.remove, {
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    activateTemplate: (input) =>
      client.mutation(api.inspectionTemplates.activate, {
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    saveInspectionTemplates: (records) =>
      client.mutation(api.inspectionTemplates.save, {
        payload: JSON.stringify(records),
        programUuid: programUuid(),
      }),
    editManual: (uuid, input) =>
      client.mutation(api.manuals.edit, {
        uuid,
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    saveComponentTemplate: (input) =>
      client.mutation(api.componentTemplates.save, {
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    applyComponentTemplate: (input) =>
      client.mutation(api.componentTemplates.apply, {
        payload: JSON.stringify(input),
        programUuid: programUuid(),
      }),
    renameManual: (uuid, title) =>
      client.mutation(api.manuals.rename, {
        uuid,
        title,
        programUuid: programUuid(),
      }),
    setManualApplicability: (uuid, applicability) =>
      client.mutation(api.manuals.setApplicability, {
        uuid,
        payload: JSON.stringify(applicability),
        programUuid: programUuid(),
      }),
    uploadManual: async (input, file) => {
      const program = programUuid();
      // The server claims only a blob with exactly these bytes for this ticket.
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
      );
      let binary = "";
      for (const byte of hash) binary += String.fromCharCode(byte);
      const { ticket, url } = await client.mutation(api.manuals.beginUpload, {
        payload: JSON.stringify(input),
        sha256: btoa(binary),
        programUuid: program,
      });
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: file,
      });
      if (!response.ok)
        throw new Error("Manual upload failed. Please try again.");
      const { storageId } = await response.json();
      return client.action(api.manuals.finishUpload, {
        ticket,
        storageId,
        programUuid: program,
      });
    },
    openManual: (uuid) =>
      client.query(api.manuals.open, { uuid, programUuid: programUuid() }),
    taskCard: (command) =>
      client.mutation(api.taskCards.save, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    attachTaskEvidence: async (taskCardUuid, category, file) =>
      client.action(api.taskCards.upload, {
        taskCardUuid,
        category,
        name: file.name,
        type: file.type,
        bytes: await file.arrayBuffer(),
        programUuid: programUuid(),
      }),
    resumeWorkOrderTemplates: (workOrderUuid) =>
      client.mutation(api.workOrderCopies.resume, {
        workOrderUuid,
        programUuid: programUuid(),
      }),
    workOrder: (command) =>
      client.mutation(api.workOrders.save, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    attachInventoryFile: async (stockUuid, file) =>
      client.action(api.inventoryFiles.upload, {
        stockUuid,
        name: file.name,
        type: file.type,
        bytes: await file.arrayBuffer(),
        programUuid: programUuid(),
      }),
    attachWorkOrderFile: async (workOrderUuid, file) =>
      client.action(api.workOrders.upload, {
        workOrderUuid,
        name: file.name,
        type: file.type,
        bytes: await file.arrayBuffer(),
        programUuid: programUuid(),
      }),
    auditPage: (request) =>
      client.query(api.auditHistory.page, {
        ...request,
        programUuid: programUuid(),
      }),
    removeInventoryFile: (id) =>
      client.mutation(api.inventoryFiles.remove, {
        id: id as Id<"inventoryFiles">,
        programUuid: programUuid(),
      }),
    removeWorkOrderFile: (id) =>
      client.mutation(api.workOrders.removeFile, {
        id: id as Id<"workOrderFiles">,
        programUuid: programUuid(),
      }),
    removeTaskEvidence: (id) =>
      client.mutation(api.taskCards.removeEvidence, {
        id: id as Id<"taskEvidence">,
        programUuid: programUuid(),
      }),
    removePOFile: (id) =>
      client.mutation(api.poFiles.remove, {
        id: id as Id<"poFiles">,
        programUuid: programUuid(),
      }),
    savePlan: (command) =>
      client.mutation(api.flightPlans.save, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    transferProgram: (input) =>
      client.mutation(api.programs.transfer, {
        ...input,
        programUuid: programUuid(),
      }),
    selectProgram: (programUuid) =>
      client.mutation(api.programs.select, { programUuid }),
    fleet: (command) =>
      client.mutation(api.fleet.save, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    manage: (command) =>
      client.mutation(api.management.execute, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    submit: (operation) =>
      client.mutation(api.operations.submit, { operation }),
    deferDiscrepancy: (command) =>
      client.mutation(api.operations.deferDiscrepancy, {
        payload: JSON.stringify(command),
        programUuid: programUuid(),
      }),
    engineTrends: (aircraftUuid) =>
      client.query(api.engineTrends.list, {
        aircraftUuid,
        programUuid: programUuid(),
      }),
    engineTrend: (aircraftUuid, command) =>
      client.mutation(api.engineTrends.execute, {
        aircraftUuid,
        programUuid: programUuid(),
        payload: JSON.stringify(command),
      }),
    resolve: (uuid, resolution) =>
      client.mutation(api.operations.resolveDiscrepancy, {
        uuid,
        resolution,
        programUuid: programUuid(),
      }),
    review: (uuid, decision, reason, input) =>
      client.mutation(api.operations.reviewFlight, {
        uuid,
        programUuid: programUuid(),
        decision,
        reason,
        input,
      }),
    updateProgramAccess: (userId, programUuid, groupIds, remove) =>
      client.mutation(api.programUsers.updateAccess, {
        userId: userId as Id<"users">,
        programUuid,
        groupIds: groupIds as Id<"groups">[],
        remove,
      }),
    addExistingProgramUser: (email, programUuid, groupIds) =>
      client.mutation(api.programUsers.addExisting, {
        email,
        programUuid,
        groupIds: groupIds as Id<"groups">[],
      }),
    createProgramUser: (email, name, password, programUuid, groupIds) =>
      client.action(api.programUsers.create, {
        email,
        name,
        password,
        programUuid,
        groupIds: groupIds as Id<"groups">[],
      }),
    uploadAircraftPhoto: async (aircraftUuid, file) =>
      client.action(api.aircraftPhotos.upload, {
        aircraftUuid,
        programUuid: programUuid(),
        type: file.type,
        bytes: await file.arrayBuffer(),
      }),
    removeAircraftPhoto: (aircraftUuid) =>
      client.mutation(api.aircraftPhotos.remove, {
        aircraftUuid,
        programUuid: programUuid(),
      }),
    uploadAircraftFile: async (aircraftUuid, category, file) =>
      client.action(api.aircraftFiles.upload, {
        aircraftUuid,
        category,
        name: file.name,
        type: file.type,
        bytes: await file.arrayBuffer(),
        programUuid: programUuid(),
      }),
    archiveAircraftFile: (id, reason) =>
      client.mutation(api.aircraftFiles.archive, {
        id: id as Id<"aircraftFiles">,
        reason,
        programUuid: programUuid(),
      }),
    createUser: (email, name, password) =>
      client.action(api.admin.createUser, { email, name, password }),
    saveReleaseStatements: (statements) =>
      client.mutation(api.admin.saveReleaseStatements, { statements }),
    saveLogbookPhrases: (phrases) =>
      client.mutation(api.admin.saveLogbookPhrases, { phrases }),
    saveLicense: (licenseNumber, certificateType) =>
      client.mutation(api.admin.saveLicense, {
        licenseNumber,
        certificateType,
      }),
    saveCertifications: (userId, certifications) =>
      client.mutation(api.certifications.save, {
        userId: userId as Id<"users">,
        payload: JSON.stringify(certifications),
      }),
    certificationFiles: (userId) =>
      client.query(api.certifications.list, { userId: userId as Id<"users"> }),
    uploadCertification: async (userId, kind, file) =>
      client.action(api.certifications.upload, {
        userId: userId as Id<"users">,
        kind,
        name: file.name,
        type: file.type,
        bytes: await file.arrayBuffer(),
      }),
    certificationFileUrl: (id) =>
      client.query(api.certifications.fileUrl, {
        id: id as Id<"certificationFiles">,
      }),
    deleteCertificationFile: (id) =>
      client.mutation(api.certifications.remove, {
        id: id as Id<"certificationFiles">,
      }),
    updateUser: (user) =>
      client.mutation(api.admin.updateUser, {
        id: user.id as Id<"users">,
        name: user.name,
        certificationsPayload:
          user.certifications === undefined
            ? undefined
            : JSON.stringify(user.certifications),
        active: user.active,
        isAdmin: user.isAdmin,
        groupIds: user.groupIds as Id<"groups">[],
      }),
    groupAccessReview: () => client.query(api.groupAudit.groupsToReview, {}),
    previewGroupDeletion: (id) =>
      client.query(api.groupDeletion.preview, {
        id: id as Id<"groups">,
        programUuid: programUuid(),
      }),
    deleteGroup: (id, expected) =>
      client.mutation(api.groupDeletion.remove, {
        id: id as Id<"groups">,
        programUuid: programUuid(),
        expected,
      }),
    saveGroup: (group) =>
      client.mutation(api.admin.saveGroup, {
        ...group,
        id: group.id as Id<"groups"> | undefined,
      }),
    resetPassword: (id, password) =>
      client.action(api.admin.resetPassword, {
        id: id as Id<"users">,
        password,
      }),
    linkedIdentities: (userId) =>
      userId
        ? client.query(api.identities.forUser, {
            userId: userId as Id<"users">,
          })
        : client.query(api.identities.mine, {}),
    removeIdentity: (userId, id) =>
      client.mutation(api.identities.remove, {
        userId: userId as Id<"users">,
        id: id as Id<"authAccounts">,
      }),
    alertReads: (programUuid) =>
      client.query(api.alerts.readKeys, { programUuid }),
    markAlertsRead: (programUuid, keys, all) =>
      client.mutation(api.alerts.markRead, { programUuid, keys, all }),
    setAlertEmails: (enabled) =>
      client.mutation(api.alerts.setEmailPreference, { enabled }),
  };
}
