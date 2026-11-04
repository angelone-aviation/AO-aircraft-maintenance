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
import type { ConvexReactClient } from "convex/react";
import type { z } from "zod";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useWorkspace } from "./store";
import type { ActivateTemplateInput } from "../domain/activateTemplate";
import type {
  AddressLookupInput,
  AddressSuggestion,
} from "../domain/addressLookup";
import type { AircraftFileCategory } from "../domain/aircraftFiles";
import type {
  SpruceOrderSnapshot,
  SpruceProduct,
  SpruceStatus,
} from "../domain/aircraftSpruce";
import type { ADCommand } from "../domain/airworthiness";
import type { AuditPage, AuditPageRequest } from "../domain/auditHistory";
import type {
  Certification,
  CertificationFile,
  CertificationKind,
} from "../domain/certifications";
import type { ChecklistCommand } from "../domain/checklists";
import type { ComponentTemplate } from "../domain/componentTemplates";
import type { CostCommand } from "../domain/costs";
import type { DeferCommand } from "../domain/deferrals";
import type { DeleteTemplatesInput } from "../domain/deleteInspectionTemplates";
import type {
  EngineTrendCommand,
  EngineTrendData,
} from "../domain/engineTrends";
import type { FaaCommand } from "../domain/faa";
import type { faaCredentialInput } from "../domain/faaCredential";
import type { FaaSearchInput, FaaSearchResult } from "../domain/faaSearch";
import type { FleetCommand } from "../domain/fleet";
import type { PlanCommand } from "../domain/flightPlans";
import type { GroupAccessReport } from "../domain/groupAccessReview";
import type { GroupDeletionPlan } from "../domain/groupDeletion";
import type { InspectionTemplate } from "../domain/inspectionTemplates";
import type { ManagementCommand } from "../domain/management";
import type {
  ManualApplicability,
  ManualEdit,
  ManualInput,
} from "../domain/manuals";
import type { FlightInput, Group, Member, Operation } from "../domain/model";
import type { OffsiteCopy } from "../domain/offsiteBackups";
import type { RequestCommand } from "../domain/partsRequests";
import type { ProgramTransfer } from "../domain/programTransfers";
import type { POCommand } from "../domain/purchaseOrders";
import type { ReleaseStatement } from "../domain/releaseStatements";
import type { RequiredPart } from "../domain/requiredParts";
import type {
  AddressChoices,
  SavedAddress,
  SavedAddressInput,
} from "../domain/savedAddresses";
import type { LinkedIdentity } from "../domain/signInMethods";
import type { TaskCardCommand, TaskEvidence } from "../domain/taskCards";
import type { TaskCsvImport } from "../domain/taskCsv";
import type { WorkOrderCommand } from "../domain/workOrders";

/**
 * Every server read and write the screens make beyond the snapshot. Two
 * adapters implement it: {@link convexBackend}, and `demoBackend`, which runs
 * the same domain rules on the demo's fictional snapshot in the browser.
 *
 * - Only {@link Backend.submit} serves the offline outbox. Every other member
 *   needs a connection; the demo refuses writes offline with "Reconnect to
 *   make this change.".
 * - A mutation is one transaction: when it throws, nothing is written.
 *   Uploads and calls to outside services are actions that run in steps.
 * - Each write adds its change-log rows unless its doc says it writes none.
 * - A `Promise<unknown>` resolves once the write commits; ignore its value.
 * - Members without a `programUuid` parameter act in the workspace's active
 *   Flight Program, or on account-wide records.
 * - Parameters a member does not describe are what their names say:
 *   `command`, `input` and `records` are domain types the server parses
 *   again; `uuid`, `id` and `…Uuid` name a record; `file` is the user's file,
 *   whose type and size the server checks.
 *
 * @throws {ConvexError} From every member: the server's refusal, with the
 *   message the user sees. A refusal still thrown as a plain Error reads
 *   "Server Error" in production.
 */
export interface Backend {
  /**
   * Lists the program's saved ship-to addresses, sorted by name, and its
   * inventory locations, whose contacts only program administrators see.
   */
  addressChoices(programUuid: string): Promise<AddressChoices>;
  /**
   * Adds or edits a saved address as its next version, stored confirmed.
   * Program administrators only.
   *
   * @param input - The address and the version it was edited from; a stale
   *   version is refused.
   * @returns The address as saved.
   */
  saveAddress(
    programUuid: string,
    input: SavedAddressInput,
  ): Promise<SavedAddress>;
  /**
   * Suggests postal addresses for an address; only its postal fields go to
   * the lookup service.
   */
  lookupAddress(input: AddressLookupInput): Promise<AddressSuggestion[]>;
  /**
   * Tells a system administrator whether address lookup has a key, without
   * the key.
   *
   * @returns `configured`, and the settings `version` that
   *   {@link Backend.setAddressKey} expects.
   */
  addressSettings(): Promise<{ configured: boolean; version: number }>;
  /**
   * Replaces the address-lookup key once a test lookup with it succeeds, so a
   * refused key is never saved. System administrators only.
   *
   * @param input - The key in plain text (stored sealed) and the settings
   *   version.
   */
  setAddressKey(input: { key: string; version: number }): Promise<unknown>;

  /** Shows the program's Aircraft Spruce account, without its credentials. */
  spruceStatus(programUuid: string): Promise<SpruceStatus>;
  /**
   * Links the program to an Aircraft Spruce login once a small export proves
   * it works, replacing any earlier login and its catalog.
   *
   * @param input - The program, the account version the form loaded (a stale
   *   one is refused), and the login.
   */
  spruceLink(input: {
    programUuid: string;
    version: number;
    userid: string;
    password: string;
    apikey: string;
    currency: string;
  }): Promise<unknown>;
  /**
   * Unlinks the program's Aircraft Spruce login and drops its catalog.
   *
   * @param version - The account version settings showed; a stale one is
   *   refused.
   */
  spruceDisconnect(programUuid: string, version: number): Promise<unknown>;
  /**
   * Downloads the linked account's catalog as the program's searchable
   * catalog; writes no change-log row.
   *
   * @returns How many products the catalog holds.
   */
  spruceRefresh(programUuid: string): Promise<number>;
  /**
   * Searches the program's stored catalog; it never contacts Aircraft Spruce.
   *
   * @param search - The text to match.
   */
  spruceSearch(programUuid: string, search: string): Promise<SpruceProduct[]>;
  /**
   * Shows a purchase order's last synced supplier order lines.
   *
   * @returns Null when none were synced under the linked account.
   */
  spruceOrders(
    programUuid: string,
    poUuid: string,
  ): Promise<SpruceOrderSnapshot | null>;
  /**
   * Saves a purchase order's supplier order lines as its latest sync, leaving
   * inventory and the order unchanged; writes no change-log row.
   *
   * @param order - A supplier order number, or "" to match the PO number.
   * @returns How many lines were saved.
   */
  spruceSync(
    programUuid: string,
    poUuid: string,
    order: string,
  ): Promise<number>;

  /**
   * Applies a parts-request command with the stock it moves. Saving an active
   * recurring list also creates the requests it owes open work orders.
   */
  partsRequest(command: RequestCommand): Promise<unknown>;
  /**
   * Applies a purchase-order command (draft, issue, shipment, receipt) with
   * the stock, components and parts requests it changes.
   */
  purchaseOrder(command: POCommand): Promise<unknown>;
  /** Applies a cost command; an unchanged record is not saved or logged. */
  costs(command: CostCommand): Promise<unknown>;
  /**
   * Applies an inventory or inspection command; a replayed request id
   * changes nothing.
   */
  manage(command: ManagementCommand): Promise<unknown>;
  /**
   * Lists a purchase order's attachments with download links (null when the
   * stored file is unavailable). Inventory administrators only.
   */
  poFiles(
    uuid: string,
  ): Promise<
    { uuid: string; name: string; url: string | null; receiptUuid?: string }[]
  >;
  /**
   * Attaches a file to a purchase order, or to one of its receipts and the
   * items it received. Writes no change-log row.
   *
   * @param receiptUuid - The receipt the file belongs to, if any.
   */
  attachPOFile(
    uuid: string,
    receiptUuid: string | undefined,
    file: File,
  ): Promise<unknown>;
  /**
   * Removes a draft purchase order's attachment, and its stored file once no
   * other record uses it.
   */
  removePOFile(id: string): Promise<unknown>;
  /** Attaches a file to a stock item or component. */
  attachInventoryFile(stockUuid: string, file: File): Promise<unknown>;
  /**
   * Removes an item's attachment, and its stored file once no other record
   * uses it (a receipt's file is shared with the items received).
   */
  removeInventoryFile(id: string): Promise<unknown>;

  /**
   * Searches FAA DRS for ADs matching an aircraft and its selected
   * components.
   */
  searchFAA(input: FaaSearchInput): Promise<FaaSearchResult[]>;
  /**
   * Replaces the FAA key once a test search proves the FAA accepts it, so a
   * working key is never discarded for a bad one.
   *
   * @param input - The key, its renewal date and the settings version.
   */
  updateFaaKey(input: z.infer<typeof faaCredentialInput>): Promise<unknown>;
  /**
   * Configures an aircraft's FAA AD monitor, reviews a candidate it found, or
   * starts a check, at most once a minute.
   */
  faaCommand(command: FaaCommand): Promise<unknown>;
  /**
   * Applies an airworthiness directive command to the AD register; a
   * replayed request id changes nothing.
   */
  saveAD(command: ADCommand): Promise<unknown>;

  /**
   * Saves a checklist set as its next version; a replayed request id changes
   * nothing.
   *
   * @param command - The set and the version it was edited from; a set
   *   changed since is refused.
   */
  saveChecklist(command: ChecklistCommand): Promise<unknown>;
  /**
   * Imports reviewed task CSV rows, all or none: into a template as its next
   * version, or onto an inspection as draft job cards.
   */
  importTaskCsv(input: TaskCsvImport): Promise<unknown>;
  /** Saves templates into the program's library, all or none. */
  saveInspectionTemplates(records: InspectionTemplate[]): Promise<unknown>;
  /**
   * Activates a template on an aircraft or a component, with a draft job card
   * for each template task.
   */
  activateTemplate(input: ActivateTemplateInput): Promise<unknown>;
  /**
   * Deletes templates with the reusable job cards made from them and those
   * cards' evidence, all or none; activated inspections stay.
   *
   * @param input - The templates and cards the preview showed, at the
   *   versions it showed.
   */
  deleteInspectionTemplates(input: DeleteTemplatesInput): Promise<unknown>;
  /** Saves a component template as its next version. */
  saveComponentTemplate(input: ComponentTemplate): Promise<unknown>;
  /**
   * Adds a component template's chosen rows to an aircraft's component setup
   * list. Rows already added are skipped; no component is installed.
   *
   * @param input - The template and the version previewed, the aircraft, and
   *   the rows to add.
   */
  applyComponentTemplate(input: {
    templateUuid: string;
    version: number;
    aircraftUuid: string;
    rowIds: string[];
  }): Promise<unknown>;

  /**
   * Uploads a manual's PDF and saves the manual in the program active when
   * called. The server accepts only an upload matching the PDF's SHA-256.
   *
   * @throws {Error} "Manual upload failed. Please try again." when the upload
   *   URL refuses the PDF.
   */
  uploadManual(input: ManualInput, file: File): Promise<unknown>;
  /** Opens a manual the caller can read: a URL to its PDF. */
  openManual(uuid: string): Promise<string>;
  /** Renames a manual, keeping its PDF and references. */
  renameManual(uuid: string, title: string): Promise<unknown>;
  /**
   * Edits a manual's details, keeping its PDF; it may move to another
   * aircraft of the same program.
   *
   * @param input - The details; leaving out applicability clears it.
   */
  editManual(uuid: string, input: ManualEdit): Promise<unknown>;
  /** Sets the aircraft or component model a manual applies to. */
  setManualApplicability(
    uuid: string,
    applicability: ManualApplicability,
  ): Promise<unknown>;

  /**
   * Applies a work-order command. Copying an inspection's templates runs as
   * scheduled batches; see {@link Backend.resumeWorkOrderTemplates}.
   */
  workOrder(command: WorkOrderCommand): Promise<unknown>;
  /**
   * Restarts a work order's unfinished template copy from the batch it
   * stopped at; does nothing without one, or while its worker is queued or
   * running.
   */
  resumeWorkOrderTemplates(workOrderUuid: string): Promise<unknown>;
  /** Attaches a file to an open work order. */
  attachWorkOrderFile(workOrderUuid: string, file: File): Promise<unknown>;
  /** Removes an open work order's attachment. */
  removeWorkOrderFile(id: string): Promise<unknown>;
  /** Applies a job-card command; archived job cards are read-only. */
  taskCard(command: TaskCardCommand): Promise<unknown>;
  /**
   * Attaches evidence to an open job card, which clears its technician,
   * inspection and step sign-offs.
   *
   * @param category - The kind of evidence.
   */
  attachTaskEvidence(
    taskCardUuid: string,
    category: TaskEvidence["category"],
    file: File,
  ): Promise<unknown>;
  /** Removes evidence from an open, unsigned job card. */
  removeTaskEvidence(id: string): Promise<unknown>;

  /**
   * Sends one outbox entry, a flight or a problem report. Idempotent on the
   * entry's uuid; a flight that conflicts with the aircraft is held for review
   * with the totals unchanged.
   *
   * @param operation - The entry, stamped with its Flight Program.
   * @returns The entry's status: "review" for a held flight, else
   *   "accepted"; a resent entry gets the status stored for it.
   */
  submit(operation: Operation): Promise<{ status: string }>;
  /** Resolves an open problem report, describing the repair done. */
  resolve(uuid: string, resolution: string): Promise<unknown>;
  /** Records a deferral on a problem report, as the deferral rules allow. */
  deferDiscrepancy(command: DeferCommand): Promise<unknown>;
  /**
   * Saves the parts a problem report needs.
   *
   * @param version - The parts version edited; a stale one is refused.
   * @param parts - The required parts.
   */
  saveDiscrepancyParts(
    uuid: string,
    version: number,
    parts: RequiredPart[],
  ): Promise<unknown>;
  /**
   * Accepts or rejects a held or rejected flight with corrections, then
   * rebuilds the aircraft's totals from its flights. Program administrators
   * only.
   *
   * @param decision - Whether the flight counts.
   * @param reason - Why, for the change log.
   * @param input - The corrected flight.
   */
  review(
    uuid: string,
    decision: "accept" | "reject",
    reason: string,
    input: FlightInput,
  ): Promise<unknown>;
  /** Saves or cancels a flight plan. */
  savePlan(command: PlanCommand): Promise<unknown>;
  /** Lists an aircraft's engine-trend imports and limits (or the defaults). */
  engineTrends(aircraftUuid: string): Promise<EngineTrendData>;
  /**
   * Imports an engine-data summary, removes an import, or sets the limits; a
   * replayed request id changes nothing.
   */
  engineTrend(
    aircraftUuid: string,
    command: EngineTrendCommand,
  ): Promise<unknown>;

  /**
   * Saves an aircraft or a Flight Program; a replayed request id changes
   * nothing.
   */
  fleet(command: FleetCommand): Promise<unknown>;
  /** Sets an aircraft's photo, replacing any earlier one. */
  uploadAircraftPhoto(aircraftUuid: string, file: File): Promise<unknown>;
  /** Removes an aircraft's photo; logged even when it had none. */
  removeAircraftPhoto(aircraftUuid: string): Promise<unknown>;
  /**
   * Files a document copy, such as a Form 337, on the aircraft's record.
   *
   * @param category - The kind of document.
   */
  uploadAircraftFile(
    aircraftUuid: string,
    category: AircraftFileCategory,
    file: File,
  ): Promise<unknown>;
  /**
   * Archives a current document copy, keeping its row and stored file.
   *
   * @param reason - Why it is archived.
   */
  archiveAircraftFile(id: string, reason: string): Promise<unknown>;

  /**
   * Makes a Flight Program the caller's active one.
   *
   * @param programUuid - The program, or "" for a system administrator to
   *   see unassigned records.
   */
  selectProgram(programUuid: string): Promise<unknown>;
  /**
   * Moves an aircraft, component or location, with the records that depend
   * on it, from the active program to another. System administrators only;
   * existing change-log rows are never edited (ADR-0005).
   *
   * @param input - The record, the destination and the reason.
   */
  transferProgram(input: ProgramTransfer): Promise<unknown>;
  /**
   * Replaces a member's groups in one program, or removes their access to
   * it; groups in other programs stay.
   *
   * @param groupIds - The new groups; ignored when `remove`.
   * @param remove - Whether to remove the member's access instead.
   */
  updateProgramAccess(
    userId: string,
    programUuid: string,
    groupIds: string[],
    remove: boolean,
  ): Promise<unknown>;
  /**
   * Gives an active account with this email the selected groups.
   *
   * @param groupIds - Groups of that program, one with read access.
   * @returns The same message whether or not an active account uses the
   *   email, so the reply never reveals one.
   */
  addExistingProgramUser(
    email: string,
    programUuid: string,
    groupIds: string[],
  ): Promise<string>;
  /**
   * Creates a password account and grants it the program's groups.
   *
   * @param groupIds - Groups of that program; none means Observers.
   * @returns The new user's id.
   */
  createProgramUser(
    email: string,
    name: string,
    password: string,
    programUuid: string,
    groupIds: string[],
  ): Promise<string>;

  /**
   * Creates a password account with no groups. System administrators only.
   *
   * @returns The new user's id.
   */
  createUser(email: string, name: string, password: string): Promise<string>;
  /**
   * Saves an account's name, status, administrator flag, groups and, when
   * given, certifications. Disabling ends its sessions; the last active
   * administrator cannot be disabled or demoted. System administrators only.
   */
  updateUser(user: Member): Promise<unknown>;
  /**
   * Sets a new password, ends the account's sessions and clears its sign-in
   * lockout. System administrators only.
   */
  resetPassword(id: string, password: string): Promise<unknown>;
  /**
   * Lists linked Google or Microsoft accounts: the signed-in user's own, or
   * another user's for a system administrator.
   *
   * @param userId - The other user; omitted or "" for your own.
   */
  linkedIdentities(userId?: string): Promise<LinkedIdentity[]>;
  /**
   * Detaches a linked Google or Microsoft account; the person can link it
   * again by signing in. System administrators only.
   */
  removeIdentity(userId: string, id: string): Promise<unknown>;

  /** Saves the signed-in user's certificate number and type for logbooks. */
  saveLicense(licenseNumber: string, certificateType: string): Promise<unknown>;
  /** Saves the signed-in user's logbook phrases, in the order offered. */
  saveLogbookPhrases(phrases: string[]): Promise<unknown>;
  /**
   * Saves the signed-in user's named return-to-service wordings for
   * work-order close-out.
   */
  saveReleaseStatements(statements: ReleaseStatement[]): Promise<unknown>;
  /**
   * Replaces a member's certifications and the license fields derived from
   * them. The account owner or an administrator.
   */
  saveCertifications(
    userId: string,
    certifications: Certification[],
  ): Promise<unknown>;
  /** Lists the license copies filed for a member, without their files. */
  certificationFiles(userId: string): Promise<CertificationFile[]>;
  /**
   * Files a license copy for one of the member's saved certifications.
   *
   * @param kind - The certification the copy is for.
   */
  uploadCertification(
    userId: string,
    kind: CertificationKind,
    file: File,
  ): Promise<unknown>;
  /** A license copy's download URL, or null when its stored file is gone. */
  certificationFileUrl(id: string): Promise<string | null>;
  /** Deletes a license copy and its stored file. */
  deleteCertificationFile(id: string): Promise<unknown>;

  /**
   * System administrators: groups covering every program aircraft whose
   * change log does not show that choice (follow-up to #34).
   */
  groupAccessReview(): Promise<GroupAccessReport[]>;
  /**
   * Shows what deleting a group would do, for the administrator to confirm.
   *
   * @returns The group's members, whether each loses program access, and the
   *   `expected` value {@link Backend.deleteGroup} needs.
   */
  previewGroupDeletion(id: string): Promise<GroupDeletionPlan>;
  /**
   * Deletes a group as previewed, taking it out of its members' accounts and
   * memberships.
   *
   * @param expected - The preview's `expected`; refused when the group or its
   *   members changed since.
   */
  deleteGroup(id: string, expected: string): Promise<unknown>;
  /**
   * Creates a permission group, or edits one.
   *
   * @param group - The group, without an `id` to create one. `allAircraft`
   *   states that an empty aircraft list means every aircraft in the program
   *   (assertGroupAircraftChoice).
   */
  saveGroup(
    group: Omit<Group, "id"> & { id?: string; allAircraft?: boolean },
  ): Promise<unknown>;

  /**
   * Pages the change log newest first: one record's entries, one aircraft's,
   * or the program's.
   *
   * @param request - The filter, the previous page's cursor and the size.
   */
  auditPage(request: AuditPageRequest): Promise<AuditPage>;
  /**
   * Lists the keys of the alerts the signed-in user has marked read.
   *
   * @param programUuid - The Flight Program, or undefined outside one.
   */
  alertReads(programUuid: string | undefined): Promise<string[]>;
  /**
   * Marks alerts read for the signed-in user; writes no change-log row.
   *
   * @param programUuid - The Flight Program, or undefined outside one.
   * @param all - Also forget read keys not in `keys`, so only live alerts are
   *   kept.
   */
  markAlertsRead(
    programUuid: string | undefined,
    keys: string[],
    all: boolean,
  ): Promise<unknown>;
  /** Turns the signed-in user's alert emails on or off; no change-log row. */
  setAlertEmails(enabled: boolean): Promise<unknown>;
  /**
   * System administrators: the newest nightly off-site backup (ADR-0008);
   * null before the first one, and always in the demo.
   */
  latestOffsiteCopy(): Promise<OffsiteCopy | null>;
}

/**
 * The live Backend: each member calls one Convex function. Commands go as a
 * JSON `payload`, with the active Flight Program as the store holds it when
 * the member is called.
 *
 * @param client - The signed-in Convex client.
 * @returns A Backend over the deployment.
 */
export function convexBackend(client: ConvexReactClient): Backend {
  return {
    ...bindAddressCalls(client),
    ...bindSpruceCalls(client),
    ...bindInventoryCalls(client),
    ...bindAirworthinessCalls(client),
    ...bindTemplateCalls(client),
    ...bindManualCalls(client),
    ...bindWorkCalls(client),
    ...bindFlightCalls(client),
    ...bindAircraftCalls(client),
    ...bindProgramCalls(client),
    ...bindAccountCalls(client),
    ...bindCredentialCalls(client),
    ...bindGroupCalls(client),
    ...bindHistoryCalls(client),
  };
}

function bindAddressCalls(client: ConvexReactClient) {
  return {
    addressChoices: (programUuid) =>
      client.query(api.savedAddresses.list, { programUuid }),
    saveAddress: (programUuid, input) =>
      client.mutation(api.savedAddresses.save, {
        programUuid,
        payload: JSON.stringify(input),
      }),
    lookupAddress: (input) =>
      client.action(api.addressVerification.lookup, programCommand(input)),
    addressSettings: () => client.query(api.addressVerification.status, {}),
    setAddressKey: (input) =>
      client.action(api.addressVerification.setKey, input),
  } satisfies Partial<Backend>;
}

function bindSpruceCalls(client: ConvexReactClient) {
  return {
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
  } satisfies Partial<Backend>;
}

function bindInventoryCalls(client: ConvexReactClient) {
  return {
    partsRequest: (command) =>
      client.mutation(api.partsRequests.execute, programCommand(command)),
    purchaseOrder: (command) =>
      client.mutation(api.purchaseOrders.execute, programCommand(command)),
    costs: (command) =>
      client.mutation(api.costs.execute, programCommand(command)),
    manage: (command) =>
      client.mutation(api.management.execute, programCommand(command)),
    poFiles: (poUuid) =>
      client.query(api.purchaseOrders.files, inProgram({ poUuid })),
    attachPOFile: async (poUuid, receiptUuid, file) =>
      client.action(api.poFiles.upload, {
        ...inProgram({ poUuid, receiptUuid }),
        ...(await readFileFields(file)),
      }),
    removePOFile: (id) =>
      client.mutation(
        api.poFiles.remove,
        inProgram({ id: id as Id<"poFiles"> }),
      ),
    attachInventoryFile: async (stockUuid, file) =>
      client.action(
        api.inventoryFiles.upload,
        inProgram({ stockUuid, ...(await readFileFields(file)) }),
      ),
    removeInventoryFile: (id) =>
      client.mutation(
        api.inventoryFiles.remove,
        inProgram({ id: id as Id<"inventoryFiles"> }),
      ),
  } satisfies Partial<Backend>;
}

function bindAirworthinessCalls(client: ConvexReactClient) {
  return {
    searchFAA: (input) =>
      client.action(api.faaSearch.search, programCommand(input)),
    updateFaaKey: (input) => client.action(api.faaCredentials.replace, input),
    faaCommand: (command) =>
      client.mutation(api.faa.command, programCommand(command)),
    saveAD: (command) =>
      client.mutation(api.airworthiness.save, requestedCommand(command)),
  } satisfies Partial<Backend>;
}

function bindTemplateCalls(client: ConvexReactClient) {
  return {
    saveChecklist: (command) =>
      client.mutation(api.checklists.save, requestedCommand(command)),
    importTaskCsv: (input) =>
      client.mutation(api.taskImports.save, programCommand(input)),
    saveInspectionTemplates: (records) =>
      client.mutation(api.inspectionTemplates.save, programCommand(records)),
    activateTemplate: (input) =>
      client.mutation(api.inspectionTemplates.activate, programCommand(input)),
    deleteInspectionTemplates: (input) =>
      client.mutation(api.inspectionTemplates.remove, programCommand(input)),
    saveComponentTemplate: (input) =>
      client.mutation(api.componentTemplates.save, programCommand(input)),
    applyComponentTemplate: (input) =>
      client.mutation(api.componentTemplates.apply, programCommand(input)),
  } satisfies Partial<Backend>;
}

function bindManualCalls(client: ConvexReactClient) {
  return {
    uploadManual: (input, file) => uploadManual(client, input, file),
    openManual: (uuid) => client.query(api.manuals.open, inProgram({ uuid })),
    renameManual: (uuid, title) =>
      client.mutation(api.manuals.rename, inProgram({ uuid, title })),
    editManual: (uuid, input) =>
      client.mutation(api.manuals.edit, { uuid, ...programCommand(input) }),
    setManualApplicability: (uuid, applicability) =>
      client.mutation(api.manuals.setApplicability, {
        uuid,
        ...programCommand(applicability),
      }),
  } satisfies Partial<Backend>;
}

function bindWorkCalls(client: ConvexReactClient) {
  return {
    workOrder: (command) =>
      client.mutation(api.workOrders.save, programCommand(command)),
    resumeWorkOrderTemplates: (workOrderUuid) =>
      client.mutation(api.workOrderCopies.resume, inProgram({ workOrderUuid })),
    attachWorkOrderFile: async (workOrderUuid, file) =>
      client.action(
        api.workOrders.upload,
        inProgram({ workOrderUuid, ...(await readFileFields(file)) }),
      ),
    removeWorkOrderFile: (id) =>
      client.mutation(
        api.workOrders.removeFile,
        inProgram({ id: id as Id<"workOrderFiles"> }),
      ),
    taskCard: (command) =>
      client.mutation(api.taskCards.save, programCommand(command)),
    attachTaskEvidence: async (taskCardUuid, category, file) =>
      client.action(
        api.taskCards.upload,
        inProgram({ taskCardUuid, category, ...(await readFileFields(file)) }),
      ),
    removeTaskEvidence: (id) =>
      client.mutation(
        api.taskCards.removeEvidence,
        inProgram({ id: id as Id<"taskEvidence"> }),
      ),
  } satisfies Partial<Backend>;
}

function bindFlightCalls(client: ConvexReactClient) {
  return {
    submit: (operation) =>
      client.mutation(api.operations.submit, { operation }),
    resolve: (uuid, resolution) =>
      client.mutation(
        api.operations.resolveDiscrepancy,
        inProgram({ uuid, resolution }),
      ),
    deferDiscrepancy: (command) =>
      client.mutation(api.operations.deferDiscrepancy, programCommand(command)),
    saveDiscrepancyParts: (uuid, version, parts) =>
      client.mutation(api.operations.saveDiscrepancyParts, {
        uuid,
        version,
        ...programCommand(parts),
      }),
    review: (uuid, decision, reason, input) =>
      client.mutation(
        api.operations.reviewFlight,
        inProgram({ uuid, decision, reason, input }),
      ),
    savePlan: (command) =>
      client.mutation(api.flightPlans.save, programCommand(command)),
    engineTrends: (aircraftUuid) =>
      client.query(api.engineTrends.list, inProgram({ aircraftUuid })),
    engineTrend: (aircraftUuid, command) =>
      client.mutation(api.engineTrends.execute, {
        aircraftUuid,
        ...requestedCommand(command),
      }),
  } satisfies Partial<Backend>;
}

function bindAircraftCalls(client: ConvexReactClient) {
  return {
    fleet: (command) =>
      client.mutation(api.fleet.save, programCommand(command)),
    uploadAircraftPhoto: async (aircraftUuid, file) =>
      client.action(api.aircraftPhotos.upload, {
        ...inProgram({ aircraftUuid }),
        type: file.type,
        bytes: await file.arrayBuffer(),
      }),
    removeAircraftPhoto: (aircraftUuid) =>
      client.mutation(api.aircraftPhotos.remove, inProgram({ aircraftUuid })),
    uploadAircraftFile: async (aircraftUuid, category, file) =>
      client.action(
        api.aircraftFiles.upload,
        inProgram({ aircraftUuid, category, ...(await readFileFields(file)) }),
      ),
    archiveAircraftFile: (id, reason) =>
      client.mutation(
        api.aircraftFiles.archive,
        inProgram({ id: id as Id<"aircraftFiles">, reason }),
      ),
  } satisfies Partial<Backend>;
}

function bindProgramCalls(client: ConvexReactClient) {
  return {
    selectProgram: (programUuid) =>
      client.mutation(api.programs.select, { programUuid }),
    transferProgram: (input) =>
      client.mutation(api.programs.transfer, inProgram(input)),
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
  } satisfies Partial<Backend>;
}

function bindAccountCalls(client: ConvexReactClient) {
  return {
    createUser: (email, name, password) =>
      client.action(api.admin.createUser, { email, name, password }),
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
  } satisfies Partial<Backend>;
}

function bindCredentialCalls(client: ConvexReactClient) {
  return {
    saveLicense: (licenseNumber, certificateType) =>
      client.mutation(api.admin.saveLicense, {
        licenseNumber,
        certificateType,
      }),
    saveLogbookPhrases: (phrases) =>
      client.mutation(api.admin.saveLogbookPhrases, { phrases }),
    saveReleaseStatements: (statements) =>
      client.mutation(api.admin.saveReleaseStatements, { statements }),
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
        ...(await readFileFields(file)),
      }),
    certificationFileUrl: (id) =>
      client.query(api.certifications.fileUrl, {
        id: id as Id<"certificationFiles">,
      }),
    deleteCertificationFile: (id) =>
      client.mutation(api.certifications.remove, {
        id: id as Id<"certificationFiles">,
      }),
  } satisfies Partial<Backend>;
}

function bindGroupCalls(client: ConvexReactClient) {
  return {
    groupAccessReview: () => client.query(api.groupAudit.groupsToReview, {}),
    previewGroupDeletion: (id) =>
      client.query(
        api.groupDeletion.preview,
        inProgram({ id: id as Id<"groups"> }),
      ),
    deleteGroup: (id, expected) =>
      client.mutation(
        api.groupDeletion.remove,
        inProgram({ id: id as Id<"groups">, expected }),
      ),
    saveGroup: (group) =>
      client.mutation(api.admin.saveGroup, {
        ...group,
        id: group.id as Id<"groups"> | undefined,
      }),
  } satisfies Partial<Backend>;
}

function bindHistoryCalls(client: ConvexReactClient) {
  return {
    auditPage: (request) =>
      client.query(api.auditHistory.page, inProgram(request)),
    alertReads: (programUuid) =>
      client.query(api.alerts.readKeys, { programUuid }),
    markAlertsRead: (programUuid, keys, all) =>
      client.mutation(api.alerts.markRead, { programUuid, keys, all }),
    setAlertEmails: (enabled) =>
      client.mutation(api.alerts.setEmailPreference, { enabled }),
    latestOffsiteCopy: () => client.query(api.backups.latestOffsiteCopy, {}),
  } satisfies Partial<Backend>;
}

// The program is read once, before any upload, so the ticket and the finish
// step name the same program.
async function uploadManual(
  client: ConvexReactClient,
  input: ManualInput,
  file: File,
): Promise<unknown> {
  const programUuid = readActiveProgram();
  const sha256 = await hashFileBase64(file);
  const { ticket, url } = await client.mutation(api.manuals.beginUpload, {
    payload: JSON.stringify(input),
    sha256,
    programUuid,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  if (!response.ok) throw new Error("Manual upload failed. Please try again.");
  const { storageId } = (await response.json()) as {
    storageId: Id<"_storage">;
  };
  return client.action(api.manuals.finishUpload, {
    ticket,
    storageId,
    programUuid,
  });
}

async function hashFileBase64(file: File): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
  );
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readActiveProgram(): string | undefined {
  return useWorkspace.getState().snapshot?.activeProgramUuid;
}

function inProgram<T extends object>(fields: T) {
  return { ...fields, programUuid: readActiveProgram() };
}

function programCommand(command: unknown) {
  return inProgram({ payload: JSON.stringify(command) });
}

// One request id per call, which the Convex client resends unchanged if it
// retries the mutation; an id the caller chose for its intent is kept.
function requestedCommand(command: { requestUuid?: string }) {
  const requestUuid = command.requestUuid ?? crypto.randomUUID();
  return programCommand({ ...command, requestUuid });
}

async function readFileFields(file: File) {
  return { name: file.name, type: file.type, bytes: await file.arrayBuffer() };
}
