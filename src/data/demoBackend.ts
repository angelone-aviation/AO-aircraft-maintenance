/**
 * Responsibility: The demo adapter of Backend: every command runs the shared
 *   domain rules on the full fictional snapshot kept on the device.
 * Layer: Data. Browser only; no Convex server, no React.
 * Dependencies: ./backend, ./store (types), ./local, ./demoAircraftFiles,
 *   convex/values (ConvexError), and the src/domain modules it runs.
 */
import {
  groupDeletionPlan,
  deletePermissionGroup,
} from "../domain/groupDeletion";
import {
  ADD_EXISTING_RESULT,
  EMAIL_UNAVAILABLE,
  assertAccountAdministrator,
  assertKnownGroups,
  assertAccessGroups,
  assertGrantsRead,
  assertProgramGroups,
  normalizeAccount,
  normalizeGroup,
  programGroupIds,
} from "../domain/accountRules";
import { validateAircraftPhoto } from "../domain/aircraftPhotos";
import { assertAttachmentRoom, withNewEvidence } from "../domain/attachments";
import { demoAircraftFiles, readDataUrl } from "./demoAircraftFiles";
import { missingDefaultGroups } from "../domain/defaultPermissionGroups";
import {
  certificationSchema,
  certificationsSchema,
  memberLicense,
  validateCertificationFile,
  type Certification,
} from "../domain/certifications";
import {
  approveCertification,
  CERTIFICATE_APPROVERS_ONLY,
  certificatesAwaitingApproval,
  certificationChanges,
  fileCertifications,
  mayApproveCertificates,
} from "../domain/certificateApproval";
import {
  parseAddressSave,
  saveAddress,
  savedAddressNameKey,
  type SavedAddress,
  type StoredAddresses,
} from "../domain/savedAddresses";
import {
  applyRequestCommand,
  generateRecurringRequests,
} from "../domain/partsRequests";
import {
  saveComponentTemplate,
  applyComponentTemplate,
} from "../domain/componentTemplates";
import {
  applyPOCommand,
  poAttachmentRemovable,
} from "../domain/purchaseOrders";
import { applyCostCommand } from "../domain/costs";
import { faaCommandSchema, runFaaCommand } from "../domain/faa";
import { selectProgram } from "../domain/programSelection";
import { applyADCommand } from "../domain/airworthiness";
import { deleteInspectionTemplates } from "../domain/deleteInspectionTemplates";
import { submitOperation } from "../domain/flightSubmission";
import { auditEntry } from "../domain/changeLog";
import { reviewFlight } from "../domain/flightReview";
import { saveChecklist } from "../domain/checklists";
import {
  inventoryAttachmentAccess,
  validateInventoryFile,
  assertFileContents,
  poAttachmentChanges,
  receiptItemUuids,
} from "../domain/inventoryAttachments";
import { releaseStatementsSchema } from "../domain/releaseStatements";
import { logbookPhrasesSchema } from "../domain/logbookWording";
import { saveDiscrepancyParts } from "../domain/requiredParts";
import { importTaskCsv } from "../domain/taskCsv";
import { activateTemplate } from "../domain/activateTemplate";
import { saveInspectionTemplates } from "../domain/inspectionTemplates";
import {
  assertManualMaintainer,
  editManual,
  manualInputSchema,
  renameManual,
  setManualApplicability,
  validateManualFile,
  type Manual,
  type ManualChange,
} from "../domain/manuals";
import {
  applyTaskCardCommand,
  taskWritable,
  evidenceRemovable,
} from "../domain/taskCards";
import {
  saveWorkOrder,
  validateWorkOrderFile,
  isOpenWorkOrder,
} from "../domain/workOrders";
import { saveFlightPlan } from "../domain/flightPlans";
import { transferProgram } from "../domain/programTransfers";
import {
  activeProgram,
  scopedSnapshot,
  auditVisible,
  programPermission,
  readsAccountWideAudit,
} from "../domain/programs";
import { applyFleet } from "../domain/fleet";
import {
  canPageAuditFilter,
  HISTORY_NOT_FOUND,
  pageAuditEntries,
} from "../domain/auditHistory";
import { summarizeAudit } from "../domain/auditSummary";
import {
  applyEngineTrendCommand,
  defaultEngineLimits,
} from "../domain/engineTrends";
import { applyManagement } from "../domain/management";
import { applyExpiringCommand } from "../domain/expiringItems";
import { ConvexError } from "convex/values";
import { Rejection, StaleRecordRejection } from "../domain/rejection";
import type { AuditEntry, Discrepancy, Snapshot } from "../domain/model";
import { can, localDate } from "../domain/model";
import { deferDiscrepancy, resolveDiscrepancy } from "../domain/deferrals";
import * as local from "./local";
import { groupAccessReports } from "../domain/groupAccessReview";
import type { Backend } from "./backend";
import type { Workspace } from "./store";
type DemoWorkspace = { getState(): Workspace };
/**
 * The local demo's Backend: every command runs the shared domain rules on the
 * full demo snapshot in IndexedDB, saves it, and hands the workspace its
 * scoped view, as the server's snapshot query would.
 *
 * @param workspace - The demo workspace, read for its namespace and state.
 * @returns The adapter. Its writes run one at a time, need `online`, and
 *   throw the domain's refusals unchanged; outbox entries it refuses throw a
 *   ConvexError, so the Sync center holds them.
 */
export function demoBackend(workspace: DemoWorkspace): Backend {
  // Serialize read-modify-write so concurrent demo commands cannot overwrite
  // each other's changes.
  let tail: Promise<unknown> = Promise.resolve();
  function modify(fn: (s: Snapshot) => void) {
    const run = tail.then(async () => {
      const current = workspace.getState();
      if (!current.online) throw new Error("Reconnect to make this change.");
      const stored = await local.readSnapshot(current.namespace + ":all");
      const s = structuredClone(stored ?? current.snapshot!);
      try {
        fn(s);
      } catch (error) {
        // Another tab saved since this one loaded: show the stored records,
        // as the server's live snapshot would, so the stale-save review
        // compares the draft with what is saved now.
        if (stored && error instanceof StaleRecordRejection)
          await current.receive(scopedSnapshot(stored));
        throw error;
      }
      s.syncedAt = Date.now();
      await local.saveSnapshot(current.namespace + ":all", s);
      await current.receive(scopedSnapshot(s));
    });
    tail = run.catch(() => undefined);
    return run;
  }
  // Demo validation failures behave like server rejections: resending the
  // same entry cannot succeed, so the Sync center marks it for attention.
  const rejectPermanently = (fn: (s: Snapshot) => void) => (s: Snapshot) => {
    try {
      fn(s);
    } catch (error) {
      throw new ConvexError(
        error instanceof Error ? error.message : "Entry rejected.",
      );
    }
  };
  function audit(
    s: Snapshot,
    action: string,
    entityUuid: string,
    aircraftUuid?: string,
    reason?: string,
    before?: unknown,
    after?: unknown,
  ) {
    const entry: AuditEntry = {
      uuid: crypto.randomUUID(),
      at: Date.now(),
      actorId: s.user.id,
      action,
      entityUuid,
      aircraftUuid,
      reason,
      before: before === undefined ? undefined : JSON.stringify(before),
      after: after === undefined ? undefined : JSON.stringify(after),
    };
    s.audit.unshift(entry);
  }
  // Files certifications as the server's recordCertifications does: a new
  // or changed one waits for approval; each change is logged.
  function recordCertifications(
    s: Snapshot,
    userId: string,
    submitted: Certification[],
  ) {
    const before = s.members.find((m) => m.id === userId)?.certifications;
    const certifications = fileCertifications(before, submitted);
    storeCertifications(s, userId, certifications);
    for (const change of certificationChanges(before, certifications))
      audit(
        s,
        change.action,
        userId,
        undefined,
        undefined,
        change.before,
        change.after,
      );
  }
  function storeCertifications(
    s: Snapshot,
    userId: string,
    certifications: Certification[],
  ) {
    const fields = { certifications, ...memberLicense({ certifications }) };
    s.members = s.members.map((m) =>
      m.id === userId ? { ...m, ...fields } : m,
    );
    if (s.user.id === userId) s.user = { ...s.user, ...fields };
  }
  // The server's approve mutation, on the demo's records.
  function approveDemoCertificate(
    s: Snapshot,
    userId: string,
    reviewed: Certification,
  ) {
    const holder = s.members.find((m) => m.id === userId);
    if (!holder) throw new Error("User not found.");
    if (!mayApproveCertificates(s, holder))
      throw new Rejection(CERTIFICATE_APPROVERS_ONLY);
    const before = holder.certifications ?? [];
    const certifications = approveCertification(before, reviewed);
    storeCertifications(s, userId, certifications);
    const ofKind = (list: Certification[]) =>
      list.find((c) => c.kind === reviewed.kind);
    audit(
      s,
      "user.certification_approved",
      userId,
      undefined,
      undefined,
      ofKind(before),
      ofKind(certifications),
    );
  }
  // Rows about a program's groups, memberships and addresses name the
  // program, as the server's do: the history filter reads that tag.
  function auditProgramRow(
    s: Snapshot,
    action: string,
    entityUuid: string,
    programUuid: string | undefined,
    values: { before?: unknown; after?: unknown } = {},
  ) {
    s.audit.unshift(
      auditEntry(s, { action, entityUuid, programUuid, ...values }),
    );
  }
  // Writes a checked manual change and its change-log row, as the server does.
  function saveManualChange<T>(
    s: Snapshot,
    action: string,
    manual: Manual,
    change: ManualChange<T>,
  ) {
    audit(
      s,
      action,
      manual.uuid,
      manual.aircraftUuid,
      undefined,
      change.before,
      change.after,
    );
    Object.assign(manual, change.patch);
  }
  return {
    importTaskCsv: (input) =>
      modify((s) => {
        importTaskCsv(s, input);
      }),
    deleteInspectionTemplates: (input) =>
      modify((s) => {
        deleteInspectionTemplates(s, input);
      }),
    activateTemplate: (input) =>
      modify((s) => {
        activateTemplate(s, input);
      }),
    saveInspectionTemplates: (records) =>
      modify((s) => {
        saveInspectionTemplates(s, records);
      }),
    editManual: (uuid, raw) =>
      modify((s) => {
        const m = maintainedManual(s, uuid);
        saveManualChange(s, "manual.edit", m, editManual(s, m, raw));
      }),
    saveComponentTemplate: (input) =>
      modify((s) => {
        saveComponentTemplate(s, input);
      }),
    applyComponentTemplate: (input) =>
      modify((s) => {
        applyComponentTemplate(s, input);
      }),
    renameManual: (uuid, raw) =>
      modify((s) => {
        const m = maintainedManual(s, uuid);
        saveManualChange(s, "manual.rename", m, renameManual(s, m, raw));
      }),
    setManualApplicability: (uuid, raw) =>
      modify((s) => {
        const m = maintainedManual(s, uuid);
        const change = setManualApplicability(s, m, raw);
        saveManualChange(s, "manual.applicability", m, change);
      }),
    uploadManual: async (raw, file) => {
      const input = manualInputSchema.parse(raw);
      validateManualFile(file);
      if (file.size !== input.size) throw new Error("File size changed.");
      const uuid = crypto.randomUUID();
      const current = workspace.getState();
      if (
        !current.snapshot ||
        !can(current.snapshot, input.aircraftUuid, "maintenance")
      )
        throw new Error("Maintenance access is required.");
      await local.saveManualBlob(current.namespace, uuid, file);
      await modify((s) => {
        if (!can(s, input.aircraftUuid, "maintenance"))
          throw new Error("Maintenance access is required.");
        s.manuals = [
          ...(s.manuals ?? []),
          { ...input, uuid, uploadedAt: Date.now(), uploadedBy: s.user.id },
        ];
        audit(
          s,
          "manual.upload",
          uuid,
          input.aircraftUuid,
          undefined,
          undefined,
          input,
        );
      });
    },
    openManual: async (uuid) => {
      const current = workspace.getState();
      const m = current.snapshot?.manuals?.find((m) => m.uuid === uuid);
      if (
        !m ||
        !current.snapshot ||
        !can(current.snapshot, m.aircraftUuid, "read")
      )
        throw new Error("Manual is not available.");
      const file = await local.readManualBlob(current.namespace, uuid);
      if (!file) throw new Error("Manual file is unavailable in this browser.");
      return URL.createObjectURL(file);
    },
    taskCard: (command) =>
      modify((s) => {
        applyTaskCardCommand(s, command);
      }),
    attachTaskEvidence: async (taskCardUuid, category, file) => {
      validateWorkOrderFile(file.name, file.type, file.size);
      const url = await readDataUrl(file);
      await modify((s) => {
        const t = s.taskCards?.find((t) => t.uuid === taskCardUuid);
        if (!t || !taskWritable(s, t))
          throw new Error(
            "An open job card and maintenance access are required.",
          );
        assertRoomAmong(s.taskEvidence, (f) => f.taskCardUuid === t.uuid);
        const now = Date.now();
        s.taskEvidence = [
          ...(s.taskEvidence ?? []),
          {
            uuid: crypto.randomUUID(),
            taskCardUuid,
            category,
            name: file.name,
            size: file.size,
            uploadedAt: now,
            url,
          },
        ];
        const next = withNewEvidence(t, now);
        s.taskCards = s.taskCards!.map((card) => (card === t ? next : card));
        audit(s, "taskCard.evidence", t.uuid, t.aircraftUuid, undefined, t, {
          ...next,
          evidenceName: file.name,
          category,
        });
      });
    },
    removeTaskEvidence: (id) =>
      modify((s) => {
        const file = s.taskEvidence?.find((f) => f.uuid === id);
        const t = s.taskCards?.find((t) => t.uuid === file?.taskCardUuid);
        if (!file || !t) throw new Error("Evidence not found.");
        if (!evidenceRemovable(s, t))
          throw new Error(
            "Evidence can be deleted only from an open, unsigned job card.",
          );
        s.taskEvidence = s.taskEvidence!.filter((f) => f.uuid !== id);
        audit(
          s,
          "taskCard.evidence_removed",
          t.uuid,
          t.aircraftUuid,
          undefined,
          { name: file.name, category: file.category },
        );
      }),
    removeInventoryFile: (id) =>
      modify((s) => {
        const file = s.inventoryAttachments?.find((f) => f.uuid === id);
        if (!file) throw new Error("Attachment not found.");
        inventoryAttachmentAccess(s, file.stockUuid);
        s.inventoryAttachments = s.inventoryAttachments!.filter(
          (f) => f.uuid !== id,
        );
        audit(
          s,
          "inventory.attachment_removed",
          file.stockUuid,
          undefined,
          "Inventory attachment removed",
          { name: file.name, size: file.size },
        );
      }),
    removeWorkOrderFile: (id) =>
      modify((s) => {
        const file = s.workOrderAttachments?.find((f) => f.uuid === id);
        const w = s.workOrders?.find((w) => w.uuid === file?.workOrderUuid);
        if (!file || !w) throw new Error("Attachment not found.");
        if (!can(s, w.aircraftUuid, "maintenance") || !isOpenWorkOrder(w))
          throw new Error(
            "An open work order and maintenance access are required.",
          );
        s.workOrderAttachments = s.workOrderAttachments!.filter(
          (f) => f.uuid !== id,
        );
        audit(
          s,
          "workOrder.attachment_removed",
          w.uuid,
          w.aircraftUuid,
          undefined,
          { name: file.name },
        );
      }),
    removePOFile: (id) =>
      modify((s) => {
        const file = s.purchaseOrderFiles?.find((f) => f.uuid === id);
        const po = s.purchaseOrders?.find((p) => p.uuid === file?.poUuid);
        if (
          !file ||
          !po ||
          !programPermission(s, "admin") ||
          po.programUuid !== activeProgram(s)
        )
          throw Error("PO access denied.");
        if (!poAttachmentRemovable(po))
          throw Error(
            "Attachments can be deleted only while the PO is a draft.",
          );
        s.purchaseOrderFiles = s.purchaseOrderFiles!.filter(
          (f) => f.uuid !== id,
        );
        audit(
          s,
          "purchaseOrder.attachment_removed",
          po.uuid,
          undefined,
          undefined,
          { name: file.name, size: file.size },
        );
      }),
    resumeWorkOrderTemplates: async () => {},
    workOrder: (command) =>
      modify((s) => {
        const before = s.workOrders?.find((w) => w.uuid === command.uuid);
        const after = saveWorkOrder(s, command);
        generateRecurringRequests(s, after);
        s.audit.unshift(
          auditEntry(s, {
            action: "workOrder." + command.action,
            entityUuid: after.uuid,
            aircraftUuid: after.aircraftUuid,
            reason:
              command.action === "revise" ||
              command.action === "correctComponent"
                ? command.reason
                : undefined,
            before,
            after,
          }),
        );
      }),
    attachInventoryFile: async (stockUuid, file) => {
      validateInventoryFile(file.name, file.type, file.size);
      assertFileContents(file.type, await file.arrayBuffer());
      const url = await readDataUrl(file);
      await modify((s) => {
        inventoryAttachmentAccess(s, stockUuid);
        assertRoomAmong(
          s.inventoryAttachments,
          (f) => f.stockUuid === stockUuid,
        );
        s.inventoryAttachments = [
          ...(s.inventoryAttachments ?? []),
          {
            uuid: crypto.randomUUID(),
            stockUuid,
            name: file.name,
            type: file.type,
            size: file.size,
            uploadedAt: Date.now(),
            url,
          },
        ];
        audit(
          s,
          "inventory.attachment",
          stockUuid,
          undefined,
          "Inventory attachment uploaded",
          undefined,
          { name: file.name, size: file.size },
        );
      });
    },
    attachWorkOrderFile: async (workOrderUuid, file) => {
      validateWorkOrderFile(file.name, file.type, file.size);
      const url = await readDataUrl(file);
      await modify((s) => {
        const w = s.workOrders?.find((w) => w.uuid === workOrderUuid);
        if (!w || !can(s, w.aircraftUuid, "maintenance") || !isOpenWorkOrder(w))
          throw new Error(
            "An open work order and maintenance access are required.",
          );
        assertRoomAmong(
          s.workOrderAttachments,
          (f) => f.workOrderUuid === w.uuid,
        );
        s.workOrderAttachments = [
          ...(s.workOrderAttachments ?? []),
          {
            uuid: crypto.randomUUID(),
            workOrderUuid,
            name: file.name,
            size: file.size,
            uploadedAt: Date.now(),
            url,
          },
        ];
        audit(
          s,
          "workOrder.attachment",
          w.uuid,
          w.aircraftUuid,
          undefined,
          undefined,
          { name: file.name },
        );
      });
    },
    searchFAA: async () => {
      throw Error(
        "Live FAA searches require the connected app. Demo mode cannot search FAA.",
      );
    },
    updateFaaKey: async () => {
      throw Error(
        "Key updates require the connected backend. Demo mode never stores API keys.",
      );
    },
    faaCommand: (command) =>
      modify((s) => {
        const cmd = faaCommandSchema.parse(command);
        const { monitor, entry } = runFaaCommand(s, cmd, Date.now());
        if (cmd.kind === "check")
          throw Error(
            "Live FAA checks require a connected backend; demo mode cannot check the FAA.",
          );
        s.faaMonitors = [
          ...(s.faaMonitors ?? []).filter(
            (x) => x.aircraftUuid !== monitor.aircraftUuid,
          ),
          monitor,
        ];
        s.audit.unshift(entry);
      }),
    saveAD: (command) =>
      modify((s) => {
        applyADCommand(s, command);
      }),
    partsRequest: (command) =>
      modify((s) => {
        applyRequestCommand(s, command);
      }),
    engineTrends: async (aircraftUuid) => {
      const s = workspace.getState().snapshot!;
      if (!can(s, aircraftUuid, "read"))
        throw Error("Aircraft read permission required.");
      return engineTrendData(s, aircraftUuid);
    },
    engineTrend: (aircraftUuid, command) =>
      modify((s) => {
        if (!can(s, aircraftUuid, "maintenance"))
          throw Error("Aircraft maintenance permission required.");
        const data = engineTrendData(s, aircraftUuid);
        const result = applyEngineTrendCommand(data, command, {
          aircraftUuid,
          actorId: s.user.id,
          now: Date.now(),
        });
        s.engineTrends = [
          ...(s.engineTrends ?? []).filter(
            (t) => t.aircraftUuid !== aircraftUuid,
          ),
          ...result.trends,
        ];
        if (command.action === "limits")
          s.engineTrendLimits = [
            ...(s.engineTrendLimits ?? []).filter(
              (l) => l.aircraftUuid !== aircraftUuid,
            ),
            { ...result.limits, aircraftUuid },
          ];
        audit(
          s,
          ENGINE_TREND_ACTIONS[command.action],
          command.action === "limits" ? aircraftUuid : command.uuid,
          aircraftUuid,
        );
      }),
    addressChoices: async (programUuid) => {
      const s = workspace.getState().snapshot!;
      if (s.activeProgramUuid !== programUuid)
        throw Error("Flight Program changed.");
      return {
        entries: (s.savedAddresses ?? []).filter(
          (a) => a.programUuid === programUuid,
        ),
        locations: (s.management ?? [])
          .filter((r) => r.kind === "location" && r.programUuid === programUuid)
          .map((r) => {
            if (r.kind !== "location") throw Error("Invalid location");
            return {
              uuid: r.uuid,
              name: r.name,
              address: r.addressDetails,
              legacy: r.address,
            };
          }),
      };
    },
    saveAddress: async (programUuid, input) => {
      let saved!: SavedAddress;
      await modify((s) => {
        if (
          s.user.activeProgramUuid !== programUuid &&
          s.activeProgramUuid !== programUuid
        )
          throw Error("Flight Program changed.");
        const parsed = parseAddressSave(s, programUuid, input);
        const stored = storedAddresses(s, programUuid, parsed);
        saved = saveAddress(programUuid, parsed, stored);
        s.savedAddresses = [
          ...(s.savedAddresses ?? []).filter((a) => a.uuid !== saved.uuid),
          saved,
        ];
        auditProgramRow(s, "address.saved", saved.uuid, programUuid, {
          before: stored.previous ?? undefined,
          after: saved,
        });
      });
      return saved;
    },
    spruceStatus: async () => ({ configured: false, version: 0 }),
    spruceLink: async () => {
      throw Error("Connect to the live app to link Aircraft Spruce.");
    },
    spruceDisconnect: async () => {
      throw Error("Connect to the live app.");
    },
    spruceRefresh: async () => {
      throw Error("Connect to the live app.");
    },
    spruceSearch: async () => {
      throw Error("Connect to the live app.");
    },
    spruceOrders: async () => null,
    spruceSync: async () => {
      throw Error("Connect to the live app.");
    },
    addressSettings: async () => ({ configured: false, version: 0 }),
    // Off-site backups run only on the production deployment.
    latestOffsiteCopy: async () => null,
    setAddressKey: async () => {
      throw Error("Connect to the live app to configure address verification.");
    },
    lookupAddress: async () => {
      throw Error(
        "External address lookups are available in the connected app, not demo mode.",
      );
    },
    poFiles: async (poUuid) =>
      (workspace.getState().snapshot?.purchaseOrderFiles ?? []).filter(
        (f) => f.poUuid === poUuid,
      ),
    attachPOFile: async (poUuid, receiptUuid, file) => {
      validateInventoryFile(file.name, file.type, file.size);
      assertFileContents(file.type, await file.arrayBuffer());
      const url = await readDataUrl(file);
      await modify((s) => {
        if (!programPermission(s, "admin"))
          throw Error("Inventory administrator access required.");
        const po = s.purchaseOrders?.find((p) => p.uuid === poUuid);
        if (!po || po.programUuid !== activeProgram(s))
          throw Error("PO not found.");
        const receipt = po.receipts.find((r) => r.uuid === receiptUuid);
        if (receiptUuid && !receipt) throw Error("Receipt not found.");
        assertRoomAmong(s.purchaseOrderFiles, (f) => f.poUuid === po.uuid);
        const f = {
          uuid: crypto.randomUUID(),
          poUuid,
          receiptUuid,
          name: file.name,
          type: file.type,
          size: file.size,
          url,
          uploadedAt: Date.now(),
        };
        s.purchaseOrderFiles = [...(s.purchaseOrderFiles ?? []), f];
        for (const stockUuid of receiptItemUuids(receipt))
          s.inventoryAttachments = [
            ...(s.inventoryAttachments ?? []),
            { ...f, uuid: crypto.randomUUID(), stockUuid },
          ];
        for (const change of poAttachmentChanges(po, receipt, file))
          s.audit.unshift(auditEntry(s, change));
      });
    },
    purchaseOrder: (command) =>
      modify((s) => {
        applyPOCommand(s, command);
      }),
    costs: (command) =>
      modify((s) => {
        applyCostCommand(s, command);
      }),
    saveChecklist: (command) =>
      modify((s) => {
        saveChecklist(s, command);
      }),
    savePlan: (command) =>
      modify((s) => {
        saveFlightPlan(s, command);
      }),
    transferProgram: (input) => modify((s) => transferProgram(s, input)),
    selectProgram: (programUuid) =>
      modify((s) => {
        s.audit.unshift(selectProgram(s, programUuid));
      }),
    fleet: (command) =>
      modify((s) => {
        if (s.audit.some((a) => a.uuid === command.requestUuid)) return;
        const creating =
          command.action === "program.save" &&
          !s.programs?.some((p) => p.uuid === command.program.uuid);
        const result = applyFleet(s, command);
        if (creating && result.program) {
          for (const group of missingDefaultGroups(
            s.groups.filter((g) => g.programUuid === result.program!.uuid),
          )) {
            const next = {
              ...structuredClone(group),
              id: crypto.randomUUID(),
              programUuid: result.program.uuid,
            };
            s.groups.push(next);
            audit(
              s,
              "group.saved",
              next.id,
              undefined,
              undefined,
              undefined,
              next,
            );
          }
        }
      }),
    manage: (command) =>
      modify((s) => {
        if (s.audit.some((a) => a.uuid === command.requestUuid)) return;
        applyManagement(s, command);
      }),
    async submit(op) {
      let status = "accepted";
      await modify(
        rejectPermanently((s) => {
          const aircraftUuid =
            op.kind === "flight" ? op.input.aircraftUuid : op.aircraftUuid;
          if (
            op.programUuid !== activeProgram(s) ||
            !can(
              s,
              aircraftUuid,
              op.kind === "flight" ? "flight" : "discrepancy",
            )
          )
            throw new Error("Flight Program access denied.");
          const result = submitOperation(s, op, {
            now: Date.now(),
            today: localDate(),
          });
          status = result.status;
          if (!result.changes) return;
          const { stock, flight, aircraft, discrepancy } = result.changes;
          for (const change of stock)
            s.management = s.management?.map((r) =>
              r.uuid === change.before.uuid ? change.after : r,
            );
          if (flight) s.flights.push(flight);
          if (aircraft)
            s.aircraft = s.aircraft.map((a) =>
              a.uuid === aircraft.uuid ? aircraft : a,
            );
          if (discrepancy) s.discrepancies.push(discrepancy);
          for (const e of result.changes.audit) s.audit.unshift(e);
        }),
      );
      return { status };
    },
    saveDiscrepancyParts: (uuid, version, parts) =>
      modify((s) => {
        saveDiscrepancyParts(s, uuid, version, parts);
      }),
    deferDiscrepancy: (command) =>
      modify((s) => replaceReport(s, deferDiscrepancy(s, command))),
    resolve: (uuid, resolution) =>
      modify((s) => replaceReport(s, resolveDiscrepancy(s, uuid, resolution))),
    review: (uuid, decision, reason, input) =>
      modify((s) => {
        const changes = reviewFlight(s, { uuid, decision, reason, input });
        s.aircraft = s.aircraft.map((a) =>
          a.uuid === changes.aircraft.uuid ? changes.aircraft : a,
        );
        s.flights = s.flights.map((f) =>
          f.uuid === uuid
            ? { ...f, ...changes.reviewed }
            : (changes.flights.find((r) => r.uuid === f.uuid) ?? f),
        );
        for (const e of changes.audit) s.audit.unshift(e);
      }),
    updateProgramAccess: (userId, programUuid, groupIds, remove) =>
      modify((s) => {
        if (
          activeProgram(s) !== programUuid ||
          !programPermission(s, "admin", programUuid)
        )
          throw Error("Flight Program administrator required.");
        assertProgramGroups(s.groups, programUuid, groupIds);
        const user = s.members.find((m) => m.id === userId);
        const local = (id: string) =>
          s.groups.some((g) => g.id === id && g.programUuid === programUuid);
        if (!user || !user.groupIds.some(local))
          throw Error("User is not a member of this Flight Program.");
        const chosen = remove ? [] : [...new Set(groupIds)];
        if (!remove) assertAccessGroups(s.groups, chosen);
        user.groupIds = [
          ...user.groupIds.filter((id) => !local(id)),
          ...chosen,
        ];
        if (user.id === s.user.id)
          s.user = { ...s.user, groupIds: user.groupIds };
        auditProgramRow(s, "user.program_access_changed", user.id, programUuid);
      }),
    addExistingProgramUser: async (email, programUuid, groupIds) => {
      await modify((s) => {
        if (
          activeProgram(s) !== programUuid ||
          !programPermission(s, "admin", programUuid)
        )
          throw Error("Flight Program administrator required.");
        assertProgramGroups(s.groups, programUuid, groupIds);
        assertGrantsRead(s.groups, groupIds);
        const user = s.members.find(
          (m) =>
            m.active && m.email.toLowerCase() === email.trim().toLowerCase(),
        );
        // Same answer whether or not the account exists, as on the server.
        if (!user) return;
        user.groupIds = [...new Set([...user.groupIds, ...groupIds])];
        if (user.id === s.user.id)
          s.user = { ...s.user, groupIds: user.groupIds };
        auditProgramRow(s, "user.program_access_added", user.id, programUuid);
      });
      return ADD_EXISTING_RESULT;
    },
    createProgramUser: async (
      email,
      name,
      password,
      programUuid,
      requestedGroups,
    ) => {
      const id = crypto.randomUUID();
      const { passwordProblem } = await import("../domain/passwordRules");
      await modify((s) => {
        if (
          activeProgram(s) !== programUuid ||
          !programPermission(s, "admin", programUuid)
        )
          throw Error("Flight Program administrator permission required.");
        assertProgramGroups(s.groups, programUuid, requestedGroups);
        const account = normalizeAccount(email, name);
        const problem = passwordProblem(password, account.email);
        if (problem) throw Error(problem);
        if (s.members.some((m) => m.email.toLowerCase() === account.email))
          throw Error(EMAIL_UNAVAILABLE);
        const groupIds = programGroupIds(
          s.groups,
          programUuid,
          requestedGroups,
        );
        s.members.push({
          id,
          ...account,
          active: true,
          isAdmin: false,
          activeProgramUuid: programUuid,
          groupIds,
        });
        auditProgramRow(s, "user.created", id, programUuid);
      });
      return id;
    },
    uploadAircraftPhoto: async (aircraftUuid, file) => {
      validateAircraftPhoto(file.type, file.size);
      const photoUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(Error("Unable to read photo."));
        reader.readAsDataURL(file);
      });
      await modify((s) => {
        if (!can(s, aircraftUuid, "maintenance"))
          throw Error("Aircraft maintenance permission required.");
        s.aircraft = s.aircraft.map((a) =>
          a.uuid === aircraftUuid ? { ...a, photoUrl } : a,
        );
      });
    },
    removeAircraftPhoto: (aircraftUuid) =>
      modify((s) => {
        if (!can(s, aircraftUuid, "maintenance"))
          throw Error("Aircraft maintenance permission required.");
        s.aircraft = s.aircraft.map((a) =>
          a.uuid === aircraftUuid ? { ...a, photoUrl: undefined } : a,
        );
      }),
    uploadAircraftFile: (aircraftUuid, category, file, link) =>
      demoAircraftFiles.upload(
        modify,
        audit,
        { aircraftUuid, category, ...link },
        file,
      ),
    archiveAircraftFile: (id, reason) =>
      demoAircraftFiles.archive(modify, audit, id, reason),
    createUser: async (rawEmail, rawName, password) => {
      const id = crypto.randomUUID();
      const { passwordProblem } = await import("../domain/passwordRules");
      await modify((s) => {
        assertAccountAdministrator(s.user);
        const { email, name } = normalizeAccount(rawEmail, rawName);
        const problem = passwordProblem(password, email);
        if (problem) throw new Error(problem);
        if (s.members.some((m) => m.email.toLowerCase() === email))
          throw new Error(EMAIL_UNAVAILABLE);
        const user = {
          id,
          name,
          email,
          active: true,
          isAdmin: false,
          groupIds: [],
        };
        s.members.push(user);
        audit(s, "user.created", user.id);
      });
      return id;
    },
    saveReleaseStatements: (statements) =>
      modify((s) => {
        const releaseStatements = releaseStatementsSchema.parse(statements);
        s.user = { ...s.user, releaseStatements };
        s.members = s.members.map((m) =>
          m.id === s.user.id ? { ...m, releaseStatements } : m,
        );
        audit(s, "user.release_statements_updated", s.user.id);
      }),
    saveLogbookPhrases: (phrases) =>
      modify((s) => {
        const logbookPhrases = logbookPhrasesSchema.parse(phrases);
        s.user = { ...s.user, logbookPhrases };
        s.members = s.members.map((m) =>
          m.id === s.user.id ? { ...m, logbookPhrases } : m,
        );
        audit(s, "user.logbook_phrases_updated", s.user.id);
      }),
    saveCertifications: (userId, rows) =>
      modify((s) => {
        if (userId !== s.user.id && !s.user.isAdmin)
          throw Error("Permission denied.");
        recordCertifications(s, userId, certificationsSchema.parse(rows));
      }),
    certificatesAwaitingApproval: async () => {
      const current = workspace.getState();
      const s =
        (await local.readSnapshot(current.namespace + ":all")) ??
        current.snapshot!;
      return certificatesAwaitingApproval(s, s.members);
    },
    approveCertificate: (userId, certificate) =>
      modify((s) =>
        approveDemoCertificate(
          s,
          userId,
          certificationSchema.parse(certificate),
        ),
      ),
    certificationFiles: async (userId) =>
      (workspace.getState().snapshot?.certificationFiles ?? []).filter(
        (f) => f.userId === userId,
      ),
    certificationFileUrl: async (id) =>
      workspace
        .getState()
        .snapshot?.certificationFiles?.find((f) => f.id === id)?.url ?? null,
    uploadCertification: async (userId, kind, file) => {
      validateCertificationFile(file.name, file.type, file.size);
      const url = await readDataUrl(file);
      await modify((s) => {
        if (userId !== s.user.id && !s.user.isAdmin)
          throw Error("Permission denied.");
        if (
          !s.members
            .find((m) => m.id === userId)
            ?.certifications?.some((c) => c.kind === kind)
        )
          throw Error("Save the certification first.");
        (s.certificationFiles ??= []).push({
          id: crypto.randomUUID(),
          userId,
          kind,
          name: file.name,
          type: file.type,
          size: file.size,
          uploadedAt: Date.now(),
          url,
        });
      });
    },
    deleteCertificationFile: (id) =>
      modify((s) => {
        const file = s.certificationFiles?.find((f) => f.id === id);
        if (!file || (file.userId !== s.user.id && !s.user.isAdmin))
          throw Error("Permission denied.");
        s.certificationFiles = s.certificationFiles?.filter((f) => f.id !== id);
      }),
    updateUser: (input) =>
      modify((s) => {
        const previous = s.members.find((m) => m.id === input.id);
        const user = structuredClone({
          ...previous,
          ...input,
          certifications: previous?.certifications,
          licenseNumber: previous?.licenseNumber,
          certificateType: previous?.certificateType,
        });
        if (!s.user.isAdmin) throw Error("Administrator permission required.");
        assertKnownGroups(s.groups, user.groupIds);
        if (user.id === s.user.id && (!user.isAdmin || !user.active))
          throw new Error("Keep the demo administrator active.");
        s.members = s.members.map((m) => (m.id === user.id ? user : m));
        if (user.id === s.user.id) s.user = user;
        audit(s, "user.permissions_changed", user.id);
        if (input.certifications !== undefined)
          recordCertifications(
            s,
            user.id,
            certificationsSchema.parse(input.certifications),
          );
      }),
    auditPage: async (request) => {
      const current = workspace.getState();
      const s =
        (await local.readSnapshot(current.namespace + ":all")) ??
        current.snapshot!;
      const canSee = auditVisible(s);
      const newest = request.entityUuid
        ? s.audit
            .filter((a) => a.entityUuid === request.entityUuid)
            .reduce<AuditEntry | null>(
              (n, a) => (n && n.at >= a.at ? n : a),
              null,
            )
        : null;
      if (!canPageAuditFilter(canSee, request, newest))
        throw new Error(HISTORY_NOT_FOUND);
      return pageAuditEntries(s.audit.filter(canSee), request);
    },
    // The demo log is small, so the whole period is always covered.
    auditSummary: async (period) => {
      const current = workspace.getState();
      const s =
        (await local.readSnapshot(current.namespace + ":all")) ??
        current.snapshot!;
      if (!programPermission(s, "admin"))
        throw new Error("Flight Program administrator required.");
      const canSee = auditVisible(s);
      return {
        summary: summarizeAudit(s.audit.filter(canSee), period),
        truncated: false,
        accountWide: readsAccountWideAudit(s),
      };
    },
    groupAccessReview: async () => {
      const current = workspace.getState();
      if (!current.snapshot?.user.isAdmin)
        throw new Error("Administrator permission required.");
      return groupAccessReports(
        (await local.readSnapshot(current.namespace + ":all")) ??
          current.snapshot,
      );
    },
    previewGroupDeletion: async (id) => {
      const current = workspace.getState();
      const s =
        (await local.readSnapshot(current.namespace + ":all")) ??
        current.snapshot!;
      return groupDeletionPlan(s, id);
    },
    deleteGroup: (id, expected) =>
      modify((s) => {
        const before = s.groups.find((g) => g.id === id);
        deletePermissionGroup(s, id, expected);
        auditProgramRow(s, "group.deleted", id, before?.programUuid, {
          before,
        });
      }),
    saveGroup: ({ allAircraft, ...group }) =>
      modify((s) => {
        if (
          !s.user.isAdmin &&
          (activeProgram(s) !== group.programUuid ||
            !programPermission(s, "admin"))
        )
          throw Error("Flight Program administrator required.");
        const before = s.groups.find((g) => g.id === group.id);
        const fields = normalizeGroup({ ...group, allAircraft }, before);
        if (
          fields.aircraftIds.some(
            (id) =>
              !s.aircraft.some(
                (a) => a.uuid === id && a.programUuid === fields.programUuid,
              ),
          )
        )
          throw Error("Group aircraft must belong to its Flight Program.");
        const next = { ...fields, id: group.id ?? crypto.randomUUID() };
        s.groups = s.groups.some((g) => g.id === next.id)
          ? s.groups.map((g) => (g.id === next.id ? next : g))
          : [...s.groups, next];
        // As convex/admin.ts records it, with the aircraft-access choice.
        auditProgramRow(s, "group.saved", next.id, next.programUuid, {
          before,
          after: allAircraft === undefined ? next : { ...next, allAircraft },
        });
      }),
    resetPassword: async () => {
      throw new Error(
        "The local demo has no real accounts or passwords. Configure Convex to manage credentials.",
      );
    },
    // Demo users cannot sign in, so none has a linked Google or Microsoft account.
    linkedIdentities: async () => [],
    removeIdentity: async () => {
      throw new Error("The local demo has no linked sign-in accounts.");
    },
    alertReads: async (programUuid) =>
      (await local.readFavorites(demoAlertReadsKey(workspace, programUuid))) ??
      [],
    markAlertsRead: async (programUuid, keys, all) => {
      const key = demoAlertReadsKey(workspace, programUuid);
      const before = all ? [] : ((await local.readFavorites(key)) ?? []);
      await local.saveFavorites(key, [...new Set([...before, ...keys])]);
    },
    forgetAlertReads: async (programUuid, keys) => {
      const key = demoAlertReadsKey(workspace, programUuid);
      const before = (await local.readFavorites(key)) ?? [];
      await local.saveFavorites(
        key,
        before.filter((k) => !keys.includes(k)),
      );
    },
    setUrgentAlertEmails: (urgentAlertEmails) =>
      modify((s) => {
        s.user = { ...s.user, urgentAlertEmails };
        s.members = s.members.map((m) =>
          m.id === s.user.id ? { ...m, urgentAlertEmails } : m,
        );
      }),
    expiringDate: (command) =>
      modify((s) => {
        if (
          command.requestUuid &&
          s.audit.some((a) => a.uuid === command.requestUuid)
        )
          return;
        applyExpiringCommand(s, command);
      }),
    // The demo runs in the browser alone, so no push service can reach it.
    pushPublicKey: async () => "",
    subscribePush: async () => undefined,
    unsubscribePush: async () => undefined,
    pushDeviceHeld: async () => false,
    // The demo shows the alert email switches a deployment with email shows;
    // like everything else in the demo, it sends nothing.
    alertEmailEnabled: async () => true,
    signInProviders: async () => [],
    setAlertEmails: (emailAlerts) =>
      modify((s) => {
        s.user = { ...s.user, emailAlerts };
        s.members = s.members.map((m) =>
          m.id === s.user.id ? { ...m, emailAlerts } : m,
        );
      }),
  };
}
// Stands in for the server's per-user, per-program alertReads table.
const ENGINE_TREND_ACTIONS = {
  import: "engineTrend.imported",
  remove: "engineTrend.removed",
  limits: "engineTrend.limits",
} as const;

// An aircraft's engine trends and limits, as the server's query returns them.
function engineTrendData(s: Snapshot, aircraftUuid: string) {
  const limits = s.engineTrendLimits?.find(
    (l) => l.aircraftUuid === aircraftUuid,
  );
  return {
    trends: (s.engineTrends ?? []).filter(
      (t) => t.aircraftUuid === aircraftUuid,
    ),
    limits: limits
      ? {
          chtMaxF: limits.chtMaxF,
          oilPressureMinPsi: limits.oilPressureMinPsi,
        }
      : defaultEngineLimits,
  };
}

function demoAlertReadsKey(
  workspace: DemoWorkspace,
  programUuid: string | undefined,
) {
  const { namespace, snapshot } = workspace.getState();
  return `${namespace}:demo-alert-reads:${snapshot?.user.id}:${programUuid ?? ""}`;
}

// The server's attachment cap, over the demo's copy of one record's files.
function assertRoomAmong<T>(
  files: readonly T[] | undefined,
  onRecord: (file: T) => boolean,
) {
  assertAttachmentRoom((files ?? []).filter(onRecord).length);
}

// The manual the user may maintain, as the server loads it before a change.
function maintainedManual(s: Snapshot, uuid: string) {
  const manual = s.manuals?.find((m) => m.uuid === uuid);
  assertManualMaintainer(s, manual);
  return manual;
}

// What a saved-address save is checked against, from the demo's snapshot of
// every program, as the server reads it by index.
function storedAddresses(
  s: Snapshot,
  programUuid: string,
  input: { uuid: string; name: string },
): StoredAddresses {
  const kept = (s.savedAddresses ?? []).filter(
    (a) => a.programUuid === programUuid,
  );
  const nameKey = savedAddressNameKey(input.name);
  return {
    previous: s.savedAddresses?.find((a) => a.uuid === input.uuid) ?? null,
    sameName: kept.find((a) => savedAddressNameKey(a.name) === nameKey) ?? null,
    count: kept.length,
  };
}

// The deferral appliers return a changed copy and leave the snapshot's report
// as it was, as the server's persist step expects.
function replaceReport(s: Snapshot, next: Discrepancy) {
  s.discrepancies = s.discrepancies.map((d) =>
    d.uuid === next.uuid ? next : d,
  );
}
