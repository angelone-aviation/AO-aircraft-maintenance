import {
  groupDeletionPlan,
  deletePermissionGroup,
} from "../domain/groupDeletion";
import {
  ADD_EXISTING_RESULT,
  EMAIL_UNAVAILABLE,
} from "../domain/accountRules";
import { validateAircraftPhoto } from "../domain/aircraftPhotos";
import { demoAircraftFiles } from "./demoAircraftFiles";
import { missingDefaultGroups } from "../domain/defaultPermissionGroups";
import {
  certificationsSchema,
  memberLicense,
  validateCertificationFile,
} from "../domain/certifications";
import { generateRecurringRequests } from "../domain/recurringParts";
import { prepareSavedAddress } from "../domain/savedAddresses";
import { applyRequestCommand } from "../domain/partsRequests";
import {
  saveComponentTemplate,
  applyComponentTemplate,
} from "../domain/componentTemplates";
import {
  applyPOCommand,
  poAttachmentRemovable,
} from "../domain/purchaseOrders";
import { applyCostCommand } from "../domain/costs";
import { emptyMonitor, faaCommandSchema } from "../domain/faa";
import {
  adAuditRecord,
  adCommandReason,
  applyADCommand,
} from "../domain/airworthiness";
import { deleteInspectionTemplates } from "../domain/deleteInspectionTemplates";
import {
  oilInventoryDeductions,
  oilUsageAudit,
  preserveOilInventory,
} from "../domain/oilInventory";
import {
  validateChecklistFlight,
  preserveChecklistLink,
} from "../domain/flightChecklistLink";
import { saveChecklist, checklistCounts } from "../domain/checklists";
import {
  inventoryAttachmentAccess,
  validateInventoryFile,
} from "../domain/inventoryAttachments";
import { releaseStatementsSchema } from "../domain/releaseStatements";
import { logbookPhrasesSchema } from "../domain/logbookWording";
import { saveDiscrepancyParts } from "../domain/requiredParts";
import { licenseSchema } from "../domain/logbook";
import { importTaskCsv } from "../domain/taskCsv";
import { activateTemplate } from "../domain/activateTemplate";
import { saveInspectionTemplates } from "../domain/inspectionTemplates";
import {
  manualInputSchema,
  manualEditSchema,
  manualApplicabilitySchema,
  validateManualFile,
} from "../domain/manuals";
import {
  saveTaskCard,
  taskWritable,
  evidenceRemovable,
} from "../domain/taskCards";
import {
  saveWorkOrder,
  validateWorkOrderFile,
  isOpenWorkOrder,
} from "../domain/workOrders";
import { saveFlightPlan, validatePlanFlight } from "../domain/flightPlans";
import { transferProgram } from "../domain/programTransfers";
import {
  activeProgram,
  scopedSnapshot,
  auditVisible,
  programIds,
  programPermission,
} from "../domain/programs";
import { applyFleet } from "../domain/fleet";
import {
  canPageAuditFilter,
  HISTORY_NOT_FOUND,
  pageAuditEntries,
} from "../domain/auditHistory";
import {
  applyEngineTrendCommand,
  defaultEngineLimits,
} from "../domain/engineTrends";
import {
  applyManagement,
  validateMaintenanceTotals,
} from "../domain/management";
import { create } from "zustand";
import { ConvexError } from "convex/values";
import type {
  Aircraft,
  AuditEntry,
  Flight,
  Operation,
  QueuedOperation,
  Snapshot,
} from "../domain/model";
import { can, localDate, offlineValid } from "../domain/model";
import { dispatchGate } from "../domain/aircraftStatus";
import { deferDiscrepancy } from "../domain/deferrals";
import {
  applyFlight,
  conflictReason,
  rebuildFlights,
  resequencedFlights,
  resequenceReason,
  validateFlight,
} from "../domain/flights";
import * as local from "./local";
import { demoSnapshot, withDemoUser } from "./demo";
import { validateOwnerGroup } from "../domain/ownerView";
import {
  assertGroupAircraftChoice,
  assertGroupProgramChange,
} from "../domain/groupAircraft";
import { groupAccessReports } from "../domain/groupAccessReview";
import type { Backend } from "./backend";
interface Workspace {
  ready: boolean;
  snapshot: Snapshot | null;
  queue: QueuedOperation[];
  namespace: string;
  demo: boolean;
  online: boolean;
  connected: boolean;
  syncing: boolean;
  blocked: boolean;
  error: string;
  notice: string;
  favorites: string[];
  backend: Backend | null;
  initialize(namespace: string, demo: boolean): Promise<void>;
  receive(snapshot: Snapshot | null): Promise<void>;
  setConnection(online: boolean, connected: boolean): void;
  enqueue(operation: Operation): Promise<void>;
  flush(retry?: boolean): Promise<void>;
  discard(uuid: string): Promise<void>;
  toggleFavorite(uuid: string): Promise<void>;
  signOutLocal(): Promise<void>;
}
// Server rejections (ConvexError, or any failure reported by the Convex
// backend as "[CONVEX M(...)] ...") will not succeed on resend; anything else
// (dropped connection, timeout, client-side failure) is retried automatically.
export function permanentSyncError(error: unknown) {
  return (
    error instanceof ConvexError ||
    (error instanceof Error && error.message.startsWith("[CONVEX "))
  );
}
function canFlush(state: Workspace) {
  return (
    state.online &&
    state.connected &&
    !!state.backend &&
    state.snapshot !== null &&
    !state.blocked &&
    offlineValid(state.snapshot)
  );
}
// Set when flush is called during a running flush so the running loop makes
// another pass instead of dropping the request.
let flushRequested = false;
let retryRequested = false;
// Drops snapshot completions that finish after a newer receive() started.
let receiveSequence = 0;
// Device-local drafts keyed by namespace; cleared on sign-out.
const draftPrefixes = [
  "angel-one-guided:",
  "angel-one-flight-sessions:",
  "angel-one-checks:",
];
function clearDeviceDrafts(namespace: string) {
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return; // Storage is unavailable, so no drafts were written.
  }
  for (const key of keys)
    if (
      draftPrefixes.some((prefix) => key.startsWith(prefix + namespace + ":"))
    )
      localStorage.removeItem(key);
}
export const useWorkspace = create<Workspace>((set, get) => ({
  ready: false,
  snapshot: null,
  queue: [],
  namespace: "",
  demo: false,
  online: navigator.onLine,
  connected: false,
  syncing: false,
  blocked: false,
  error: "",
  notice: "",
  favorites: [],
  backend: null,
  async initialize(namespace, demo) {
    set({
      ready: false,
      snapshot: null,
      queue: [],
      namespace,
      demo,
      blocked: false,
      error: "",
      notice: "",
    });
    try {
      const [cached, queue] = await Promise.all([
        local.readSnapshot(namespace),
        local.readQueue(namespace),
      ]);
      const full = demo
        ? ((await local.readSnapshot(namespace + ":all")) ??
          cached ??
          demoSnapshot())
        : cached;
      if (demo && full && cached?.user.id === full.user.id)
        full.authenticatedAt = cached.authenticatedAt;
      const snapshot = full
        ? demo
          ? scopedSnapshot(full)
          : full.programScopeVersion === 1
            ? full
            : null
        : null;
      if (demo && full) await local.saveSnapshot(namespace + ":all", full);
      const favorites = snapshot
        ? ((await local.readFavorites(namespace + ":" + snapshot.user.id)) ??
          [])
        : [];
      set({
        namespace,
        demo,
        snapshot,
        queue,
        favorites,
        ready: true,
        connected: demo && navigator.onLine,
        backend: demo ? demoBackend() : get().backend,
      });
      if (snapshot && demo) await local.saveSnapshot(namespace, snapshot);
    } catch {
      set({
        ready: true,
        error:
          "Persistent storage is unavailable. Enable browser storage before adding offline entries.",
      });
    }
  },
  async receive(snapshot) {
    const { namespace } = get();
    if (!namespace) return;
    const sequence = ++receiveSequence;
    if (snapshot) {
      const favorites =
        (await local.readFavorites(namespace + ":" + snapshot.user.id)) ?? [];
      // Check before writing too: IndexedDB applies writes in issue order, so a
      // newer receive() always persists after this one.
      if (sequence !== receiveSequence) return;
      await local.saveSnapshot(namespace, snapshot);
      if (sequence !== receiveSequence) return;
      set({ snapshot, favorites, blocked: false });
      void get().flush();
    } else {
      await local.clearSnapshot(namespace);
      if (sequence !== receiveSequence) return;
      set({ snapshot: null, blocked: true });
    }
  },
  setConnection(online, connected) {
    set({ online, connected });
    if (online && connected) void get().flush();
  },
  async enqueue(operation) {
    const { snapshot, namespace } = get();
    if (!snapshot || get().blocked || !offlineValid(snapshot))
      throw new Error(
        "Your offline access expired. Reconnect and sign in; pending entries are preserved.",
      );
    if (operation.authorId !== snapshot.user.id)
      throw new Error("Account does not match this entry.");
    const aircraftUuid =
      operation.kind === "flight"
        ? operation.input.aircraftUuid
        : operation.aircraftUuid;
    if (
      !can(
        snapshot,
        aircraftUuid,
        operation.kind === "flight" ? "flight" : "discrepancy",
      )
    )
      throw new Error("You cannot add entries for this aircraft.");
    if (operation.kind === "flight")
      validateFlight(
        snapshot.aircraft.find((a) => a.uuid === aircraftUuid)!,
        operation.input,
      );
    if (operation.kind === "flight") {
      validateChecklistFlight(snapshot, operation.input);
      dispatchGate(
        snapshot,
        aircraftUuid,
        operation.dispatchOverrideReason,
        localDate(),
      );
    }
    if (operation.kind === "flight" && operation.input.flightPlanUuid) {
      validatePlanFlight(snapshot, operation.input);
      const planUuid = operation.input.flightPlanUuid;
      const pending = get().queue.find(
        (q) =>
          q.operation.kind === "flight" &&
          q.operation.input.flightPlanUuid === planUuid,
      );
      // A failed entry still blocks: it can be retried, and letting a second
      // flight queue beside it risks logging the plan twice.
      if (pending?.error)
        throw new Error(
          "This plan has a failed flight entry. Discard it in the Sync center before logging the flight again.",
        );
      if (pending)
        throw new Error(
          "This plan already has a flight pending synchronization.",
        );
    }
    operation = { ...operation, programUuid: snapshot.activeProgramUuid };
    const entry = { operation, queuedAt: Date.now() };
    await local.persistOperation(namespace, entry);
    set({
      queue: await local.readQueue(namespace),
      notice: "Entry saved on this device. It will sync when connected.",
    });
    void get().flush();
  },
  async flush(retry = false) {
    const state = get();
    if (state.syncing) {
      flushRequested = true;
      retryRequested ||= retry;
      return;
    }
    if (!canFlush(state)) return;
    set({ syncing: true });
    try {
      // Each extra pass needs a new flush request made during the previous
      // pass (an enqueue or a received snapshot), never a failure, so a
      // persistently failing entry cannot spin this loop.
      do {
        flushRequested = false;
        await flushPass(state.namespace, state.backend!, retry);
        retry = retryRequested;
        retryRequested = false;
      } while (flushRequested && canFlush(get()));
      set({ queue: await local.readQueue(state.namespace) });
    } finally {
      set({ syncing: false });
    }
  },
  async discard(uuid) {
    const { namespace } = get();
    await local.removeOperation(namespace, uuid);
    set({ queue: await local.readQueue(namespace) });
  },
  async toggleFavorite(uuid) {
    const { snapshot, namespace, favorites } = get();
    if (!snapshot) return;
    const next = favorites.includes(uuid)
      ? favorites.filter((id) => id !== uuid)
      : [...favorites, uuid];
    await local.saveFavorites(namespace + ":" + snapshot.user.id, next);
    set({ favorites: next });
  },
  async signOutLocal() {
    const { namespace } = get();
    await local.clearSnapshot(namespace);
    // The outbox stays (entries are tied to their author and sync after the
    // same user signs in again); unsent form drafts do not.
    clearDeviceDrafts(namespace);
    set({ snapshot: null, blocked: true, favorites: [] });
  },
}));
async function flushPass(namespace: string, backend: Backend, retry: boolean) {
  const { getState: get, setState: set } = useWorkspace;
  for (const entry of await local.readQueue(namespace)) {
    if (
      !get().online ||
      !get().connected ||
      get().snapshot?.user.id !== entry.operation.authorId ||
      entry.operation.programUuid !== get().snapshot?.activeProgramUuid
    )
      continue;
    if (entry.error && !retry) continue;
    try {
      const result = await backend.submit(entry.operation);
      await local.removeOperation(namespace, entry.operation.uuid);
      set({
        notice:
          result.status === "review"
            ? "Entry synced and held for administrator review. Aircraft totals are unchanged."
            : "Entry synchronized successfully.",
      });
    } catch (error) {
      if (!permanentSyncError(error)) continue;
      await local.persistOperation(namespace, {
        ...entry,
        error:
          error instanceof ConvexError && typeof error.data === "string"
            ? error.data
            : error instanceof Error
              ? error.message
              : "Sync failed. Your entry is preserved.",
      });
    }
  }
}
/** Local demo only: preview the read-only owner portal as a sample owner. */
export async function previewDemoOwner(owner: boolean) {
  const current = useWorkspace.getState();
  if (!current.demo) throw new Error("Owner preview is available in the demo.");
  const all =
    (await local.readSnapshot(current.namespace + ":all")) ?? current.snapshot!;
  const next = withDemoUser(all, owner);
  await local.saveSnapshot(current.namespace + ":all", next);
  await current.receive(scopedSnapshot(next));
}
/** Local demo only: restart the offline window. Demo changes rebuild the
 * workspace from the full snapshot, so renew that one too. */
export async function renewDemoAccess() {
  const current = useWorkspace.getState();
  if (!current.demo) throw new Error("Renewal is available in the demo.");
  const all =
    (await local.readSnapshot(current.namespace + ":all")) ?? current.snapshot!;
  const next = { ...all, authenticatedAt: Date.now() };
  await local.saveSnapshot(current.namespace + ":all", next);
  await current.receive(scopedSnapshot(next));
}
function demoBackend(): Backend {
  // Serialize read-modify-write so concurrent demo commands cannot overwrite
  // each other's changes.
  let tail: Promise<unknown> = Promise.resolve();
  function modify(fn: (s: Snapshot) => void) {
    const run = tail.then(async () => {
      const current = useWorkspace.getState();
      if (!current.online) throw new Error("Reconnect to make this change.");
      const s = structuredClone(
        (await local.readSnapshot(current.namespace + ":all")) ??
          current.snapshot!,
      );
      fn(s);
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
  return {
    importTaskCsv: (input) =>
      modify((s) => {
        importTaskCsv(s, input);
      }),
    deleteInspectionTemplates: (input) =>
      modify((s) => {
        const result = deleteInspectionTemplates(s, input);
        for (const task of result.taskCards)
          audit(
            s,
            "taskCard.deletedWithTemplate",
            task.uuid,
            task.aircraftUuid,
            "Deleted with its inspection template.",
            task,
            undefined,
          );
        for (const template of result.templates)
          audit(
            s,
            "inspectionTemplate.deleted",
            template.uuid,
            undefined,
            "Deleted template and associated reusable job cards.",
            template,
            undefined,
          );
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
        const m = s.manuals?.find((m) => m.uuid === uuid);
        if (!m || !can(s, m.aircraftUuid, "maintenance"))
          throw new Error("Maintenance access is required.");
        const input = manualEditSchema.parse(raw);
        const source = s.aircraft.find((a) => a.uuid === m.aircraftUuid);
        const target = s.aircraft.find((a) => a.uuid === input.aircraftUuid);
        if (
          !target ||
          !source ||
          source.programUuid !== target.programUuid ||
          !can(s, target.uuid, "maintenance")
        )
          throw new Error(
            "Choose an aircraft in the same Flight Program with maintenance access.",
          );
        audit(
          s,
          "manual.edit",
          uuid,
          m.aircraftUuid,
          undefined,
          { ...m },
          input,
        );
        Object.assign(m, input, { applicability: input.applicability });
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
        const m = s.manuals?.find((m) => m.uuid === uuid);
        if (!m || !can(s, m.aircraftUuid, "maintenance"))
          throw new Error("Maintenance access is required.");
        const title = manualInputSchema.shape.title.parse(raw);
        audit(
          s,
          "manual.rename",
          uuid,
          m.aircraftUuid,
          undefined,
          { title: m.title },
          { title },
        );
        m.title = title;
      }),
    setManualApplicability: (uuid, raw) =>
      modify((s) => {
        const m = s.manuals?.find((m) => m.uuid === uuid);
        if (!m || !can(s, m.aircraftUuid, "maintenance"))
          throw new Error("Maintenance access is required.");
        const applicability = manualApplicabilitySchema.parse(raw);
        audit(
          s,
          "manual.applicability",
          uuid,
          m.aircraftUuid,
          undefined,
          m.applicability,
          applicability,
        );
        m.applicability = applicability;
      }),
    uploadManual: async (raw, file) => {
      const input = manualInputSchema.parse(raw);
      validateManualFile(file);
      if (file.size !== input.size) throw new Error("File size changed.");
      const uuid = crypto.randomUUID();
      const current = useWorkspace.getState();
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
      const current = useWorkspace.getState();
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
        const before = s.taskCards?.find((t) => t.uuid === command.uuid);
        const after = saveTaskCard(s, command);
        audit(
          s,
          "taskCard." + command.action,
          after.uuid,
          after.aircraftUuid,
          undefined,
          before,
          after,
        );
      }),
    attachTaskEvidence: async (taskCardUuid, category, file) => {
      validateWorkOrderFile(file.name, file.type, file.size);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const url = `data:${file.type};base64,${btoa(binary)}`;
      await modify((s) => {
        const t = s.taskCards?.find((t) => t.uuid === taskCardUuid);
        if (!t || !taskWritable(s, t))
          throw new Error(
            "An open job card and maintenance access are required.",
          );
        s.taskEvidence = [
          ...(s.taskEvidence ?? []),
          {
            uuid: crypto.randomUUID(),
            taskCardUuid,
            category,
            name: file.name,
            size: file.size,
            uploadedAt: Date.now(),
            url,
          },
        ];
        // New evidence is part of the record being signed.
        t.technicianSignoff = null;
        t.inspectionSignoff = null;
        t.stepSignoffs = {};
        t.version++;
        t.updatedAt = Date.now();
        audit(
          s,
          "taskCard.evidence",
          t.uuid,
          t.aircraftUuid,
          undefined,
          undefined,
          { name: file.name, category },
        );
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
        audit(
          s,
          "workOrder." + command.action,
          after.uuid,
          after.aircraftUuid,
          command.action === "revise" || command.action === "correctComponent"
            ? command.reason
            : undefined,
          before,
          after,
        );
      }),
    attachInventoryFile: async (stockUuid, file) => {
      validateInventoryFile(file.name, file.type, file.size);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const url = `data:${file.type};base64,${btoa(binary)}`;
      await modify((s) => {
        inventoryAttachmentAccess(s, stockUuid);
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
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const url = `data:${file.type};base64,${btoa(binary)}`;
      await modify((s) => {
        const w = s.workOrders?.find((w) => w.uuid === workOrderUuid);
        if (!w || !can(s, w.aircraftUuid, "maintenance") || !isOpenWorkOrder(w))
          throw new Error(
            "An open work order and maintenance access are required.",
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
        if (!can(s, cmd.aircraftUuid, "maintenance"))
          throw Error("Permission denied.");
        const m =
          s.faaMonitors?.find((x) => x.aircraftUuid === cmd.aircraftUuid) ??
          emptyMonitor(cmd.aircraftUuid);
        if (cmd.kind === "check")
          throw Error(
            "Live FAA checks require a connected backend; demo mode cannot check the FAA.",
          );
        if (cmd.kind === "configure") {
          m.enabled = cmd.enabled;
          m.terms = cmd.terms;
        } else {
          const c = m.candidates.find((c) => c.id === cmd.id);
          if (c) {
            c.reviewReason = cmd.reason;
            c.reviewedAt = Date.now();
          }
        }
        s.faaMonitors = [
          ...(s.faaMonitors ?? []).filter(
            (x) => x.aircraftUuid !== m.aircraftUuid,
          ),
          m,
        ];
      }),
    saveAD: (command) =>
      modify((s) => {
        const prior = s.airworthiness ?? [];
        for (const r of applyADCommand(s, command)) {
          const old = prior.find((x) => x.uuid === r.uuid);
          audit(
            s,
            "ad." + command.kind,
            r.uuid,
            r.aircraftUuid,
            adCommandReason(command),
            old && adAuditRecord(old),
            adAuditRecord(r),
          );
        }
      }),
    partsRequest: (command) =>
      modify((s) => {
        const r = applyRequestCommand(s, command);
        if (r.recurring && !r.cancelled)
          for (const order of s.workOrders ?? []) {
            if (order.aircraftUuid === r.aircraftUuid)
              generateRecurringRequests(s, order);
          }
      }),
    engineTrends: async (aircraftUuid) => {
      const s = useWorkspace.getState().snapshot!;
      if (!can(s, aircraftUuid, "read"))
        throw Error("Aircraft read permission required.");
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
    },
    engineTrend: (aircraftUuid, command) =>
      modify((s) => {
        if (!can(s, aircraftUuid, "maintenance"))
          throw Error("Aircraft maintenance permission required.");
        const stored = s.engineTrendLimits?.find(
          (l) => l.aircraftUuid === aircraftUuid,
        );
        const data = {
          trends: (s.engineTrends ?? []).filter(
            (t) => t.aircraftUuid === aircraftUuid,
          ),
          limits: stored
            ? {
                chtMaxF: stored.chtMaxF,
                oilPressureMinPsi: stored.oilPressureMinPsi,
              }
            : defaultEngineLimits,
        };
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
          `engineTrend.${command.action === "import" ? "imported" : command.action === "remove" ? "removed" : "limits"}`,
          command.action === "limits" ? aircraftUuid : command.uuid,
          aircraftUuid,
        );
      }),
    addressChoices: async (programUuid) => {
      const s = useWorkspace.getState().snapshot!;
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
      const parsed = prepareSavedAddress(input);
      const saved = { ...parsed, version: parsed.version + 1, programUuid };
      await modify((s) => {
        if (
          s.user.activeProgramUuid !== programUuid &&
          s.activeProgramUuid !== programUuid
        )
          throw Error("Flight Program changed.");
        const old = s.savedAddresses?.find((a) => a.uuid === input.uuid);
        if (old && old.programUuid !== programUuid)
          throw Error("Address not found.");
        if ((old?.version ?? 0) !== input.version)
          throw Error("Address changed.");
        if (
          s.savedAddresses?.some(
            (a) =>
              a.uuid !== input.uuid &&
              a.programUuid === programUuid &&
              a.name.toLowerCase() === saved.name.toLowerCase(),
          )
        )
          throw Error("Address name already exists.");
        s.savedAddresses = [
          ...(s.savedAddresses ?? []).filter((a) => a.uuid !== saved.uuid),
          saved,
        ];
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
    setAddressKey: async () => {
      throw Error("Connect to the live app to configure address verification.");
    },
    lookupAddress: async () => {
      throw Error(
        "External address lookups are available in the connected app, not demo mode.",
      );
    },
    poFiles: async (poUuid) =>
      (useWorkspace.getState().snapshot?.purchaseOrderFiles ?? []).filter(
        (f) => f.poUuid === poUuid,
      ),
    attachPOFile: async (poUuid, receiptUuid, file) => {
      validateInventoryFile(file.name, file.type, file.size);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await modify((s) => {
        const po = s.purchaseOrders?.find((p) => p.uuid === poUuid);
        if (
          !po ||
          !programPermission(s, "admin") ||
          po.programUuid !== activeProgram(s)
        )
          throw Error("PO access denied.");
        const receipt = po.receipts.find((r) => r.uuid === receiptUuid);
        if (receiptUuid && !receipt) throw Error("Receipt not found.");
        const f = {
          uuid: crypto.randomUUID(),
          poUuid,
          receiptUuid,
          name: file.name,
          type: file.type,
          size: file.size,
          url: `data:${file.type};base64,${btoa(binary)}`,
          uploadedAt: Date.now(),
        };
        s.purchaseOrderFiles = [...(s.purchaseOrderFiles ?? []), f];
        for (const stockUuid of new Set(
          receipt?.lines.flatMap((l) => l.itemUuids) ?? [],
        ))
          s.inventoryAttachments = [
            ...(s.inventoryAttachments ?? []),
            { ...f, uuid: crypto.randomUUID(), stockUuid },
          ];
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
        const next = saveChecklist(s, command);
        audit(
          s,
          "checklist.saved",
          next.uuid,
          next.aircraftUuid || undefined,
          undefined,
          undefined,
          {
            version: next.version,
            name: next.document.payload.metadata.name,
            ...checklistCounts(next.document),
          },
        );
      }),
    savePlan: (command) =>
      modify((s) => {
        const before = s.flightPlans?.find((p) => p.uuid === command.plan.uuid);
        const after = saveFlightPlan(s, command);
        audit(
          s,
          after.status === "cancelled" ? "plan.cancelled" : "plan.saved",
          after.uuid,
          after.aircraftUuid,
          undefined,
          before,
          after,
        );
      }),
    transferProgram: (input) => modify((s) => transferProgram(s, input)),
    selectProgram: (programUuid) =>
      modify((s) => {
        if (
          programUuid
            ? !s.programs?.some((p) => p.uuid === programUuid) ||
              (!s.user.isAdmin &&
                !programIds(s.user, s.groups).includes(programUuid))
            : !s.user.isAdmin
        )
          throw new Error("Flight Program access denied.");
        s.user.activeProgramUuid = programUuid;
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
          if (op.kind === "flight") {
            const existing = s.flights.find((f) => f.uuid === op.uuid);
            if (existing) {
              status = existing.status;
              return;
            }
            validatePlanFlight(s, op.input);
            validateChecklistFlight(s, op.input);
            const aircraft = s.aircraft.find(
              (a) => a.uuid === op.input.aircraftUuid,
            )!;
            validateFlight(aircraft, op.input);
            const dispatchOverride = dispatchGate(
              s,
              aircraft.uuid,
              op.dispatchOverrideReason,
              localDate(),
            );
            const reason = conflictReason(aircraft, op.input, op.baseVersion);
            const f: Flight = {
              ...op.input,
              dispatchOverride,
              uuid: op.uuid,
              authorId: op.authorId,
              submittedAt: Date.now(),
              status: reason ? "review" : "accepted",
              reviewReason: reason,
              hobbsOff: aircraft.currentHobbs,
              tachOff: aircraft.currentTach,
              cyclicHobbsOff: aircraft.currentCyclicHobbs,
              flightTimeLogOff: aircraft.currentFlightTimeLog,
            };
            const changes = oilInventoryDeductions(s, op.input);
            for (const change of changes) {
              s.management = s.management?.map((r) =>
                r.uuid === change.before.uuid ? change.after : r,
              );
              const entry = oilUsageAudit(change);
              audit(
                s,
                "stock.oil_used",
                change.before.uuid,
                aircraft.uuid,
                `Oil added for flight ${op.uuid}`,
                entry.before,
                entry.after,
              );
            }
            s.flights.push(f);
            status = f.status;
            if (!reason)
              s.aircraft = s.aircraft.map((a) =>
                a.uuid === aircraft.uuid ? applyFlight(a, op.input) : a,
              );
            if (op.input.discrepancy.trim())
              s.discrepancies.push({
                uuid: op.uuid + "-discrepancy",
                aircraftUuid: aircraft.uuid,
                flightUuid: op.uuid,
                authorId: op.authorId,
                description: op.input.discrepancy,
                status: "open",
                createdAt: Date.now(),
              });
            audit(
              s,
              reason ? "flight.held" : "flight.created",
              op.uuid,
              aircraft.uuid,
              reason,
              undefined,
              f,
            );
            if (dispatchOverride)
              audit(
                s,
                "flight.dispatch_override",
                op.uuid,
                aircraft.uuid,
                dispatchOverride.reason,
                undefined,
                dispatchOverride,
              );
          } else {
            if (s.discrepancies.some((d) => d.uuid === op.uuid)) return;
            const report = {
              uuid: op.uuid,
              aircraftUuid: op.aircraftUuid,
              flightUuid: op.flightUuid,
              authorId: op.authorId,
              description: op.description,
              grounding: op.grounding,
              status: "open" as const,
              createdAt: Date.now(),
            };
            s.discrepancies.push(report);
            audit(
              s,
              "discrepancy.created",
              op.uuid,
              op.aircraftUuid,
              undefined,
              undefined,
              report,
            );
          }
        }),
      );
      return { status };
    },
    saveDiscrepancyParts: (uuid, version, parts) =>
      modify((s) => {
        const before = structuredClone(
          s.discrepancies.find((d) => d.uuid === uuid),
        );
        const d = saveDiscrepancyParts(s, uuid, version, parts);
        audit(
          s,
          "discrepancy.parts",
          uuid,
          d.aircraftUuid,
          "Required parts updated",
          before,
          d,
        );
      }),
    deferDiscrepancy: (command) =>
      modify((s) => {
        const next = deferDiscrepancy(s, command);
        const before = s.discrepancies.find((d) => d.uuid === next.uuid);
        s.discrepancies = s.discrepancies.map((d) =>
          d.uuid === next.uuid ? next : d,
        );
        audit(
          s,
          "discrepancy.deferred",
          next.uuid,
          next.aircraftUuid,
          next.deferral!.placard,
          before,
          next.deferral,
        );
      }),
    resolve: (uuid, resolution) =>
      modify((s) => {
        if (!resolution.trim()) throw new Error("Describe the repair.");
        const d = s.discrepancies.find((d) => d.uuid === uuid)!;
        if (d.status === "resolved") throw new Error("Already resolved.");
        const before = { ...d };
        Object.assign(d, {
          status: "resolved",
          resolution,
          resolvedAt: Date.now(),
          resolvedBy: s.user.id,
        });
        audit(
          s,
          "discrepancy.resolved",
          uuid,
          d.aircraftUuid,
          resolution,
          before,
          d,
        );
      }),
    review: (uuid, decision, reason, input) =>
      modify((s) => {
        if (reason.trim().length < 5)
          throw new Error("Provide a meaningful explanation.");
        const f = s.flights.find((f) => f.uuid === uuid)!;
        const before = { ...f };
        preserveChecklistLink(f, input);
        preserveOilInventory(f, input);
        if (input.flightPlanUuid !== f.flightPlanUuid)
          throw new Error("A review cannot change the linked flight plan.");
        if (decision === "accept" && f.status === "rejected")
          validatePlanFlight(s, input);
        Object.assign(f, input, {
          status: decision === "accept" ? "accepted" : "rejected",
          reviewReason: reason,
        });
        const a = s.aircraft.find((a) => a.uuid === f.aircraftUuid)!;
        const stored = s.flights
          .filter((x) => x.aircraftUuid === a.uuid)
          .map((x) => (x === f ? before : x));
        const rebuilt = rebuildFlights(
          a,
          s.flights.filter((f) => f.aircraftUuid === a.uuid),
          stored,
        );
        validateMaintenanceTotals(
          rebuilt.aircraft,
          s.management ?? [],
          s.inspections,
        );
        s.aircraft = s.aircraft.map((a) =>
          a.uuid === rebuilt.aircraft.uuid ? rebuilt.aircraft : a,
        );
        s.flights = s.flights.map(
          (f) => rebuilt.flights.find((r) => r.uuid === f.uuid) ?? f,
        );
        const after = s.flights.find((x) => x.uuid === uuid);
        audit(s, "flight.reviewed", uuid, a.uuid, reason, before, after);
        for (const change of resequencedFlights(stored, rebuilt.flights, uuid))
          audit(
            s,
            "flight.resequenced",
            change.flight.uuid,
            a.uuid,
            resequenceReason(before, f),
            change.before,
            change.after,
          );
      }),
    updateProgramAccess: (userId, programUuid, groupIds, remove) =>
      modify((s) => {
        if (
          activeProgram(s) !== programUuid ||
          !programPermission(s, "admin", programUuid)
        )
          throw Error("Flight Program administrator required.");
        if (
          groupIds.some(
            (id) =>
              !s.groups.some(
                (g) => g.id === id && g.programUuid === programUuid,
              ),
          )
        )
          throw Error("Select groups within this Flight Program.");
        const user = s.members.find((m) => m.id === userId);
        const local = (id: string) =>
          s.groups.some((g) => g.id === id && g.programUuid === programUuid);
        if (!user || !user.groupIds.some(local))
          throw Error("User is not a member of this Flight Program.");
        if (
          !remove &&
          !s.groups.some(
            (g) => groupIds.includes(g.id) && g.permissions.includes("read"),
          )
        )
          throw Error("Select at least one group with read access.");
        user.groupIds = [
          ...user.groupIds.filter((id) => !local(id)),
          ...(remove ? [] : [...new Set(groupIds)]),
        ];
        if (user.id === s.user.id)
          s.user = { ...s.user, groupIds: user.groupIds };
        audit(s, "user.program_access_changed", user.id);
      }),
    addExistingProgramUser: async (email, programUuid, groupIds) => {
      await modify((s) => {
        if (
          activeProgram(s) !== programUuid ||
          !programPermission(s, "admin", programUuid)
        )
          throw Error("Flight Program administrator required.");
        if (
          groupIds.some(
            (id) =>
              !s.groups.some(
                (g) => g.id === id && g.programUuid === programUuid,
              ),
          )
        )
          throw Error("Select groups within this Flight Program.");
        if (
          !s.groups.some(
            (g) => groupIds.includes(g.id) && g.permissions.includes("read"),
          )
        )
          throw Error("Select at least one group with read access.");
        const user = s.members.find(
          (m) =>
            m.active && m.email.toLowerCase() === email.trim().toLowerCase(),
        );
        // Same answer whether or not the account exists, as on the server.
        if (!user) return;
        user.groupIds = [...new Set([...user.groupIds, ...groupIds])];
        if (user.id === s.user.id)
          s.user = { ...s.user, groupIds: user.groupIds };
        audit(s, "user.program_access_added", user.id);
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
      await modify((s) => {
        if (
          activeProgram(s) !== programUuid ||
          !programPermission(s, "admin", programUuid)
        )
          throw Error("Flight Program administrator permission required.");
        if (
          requestedGroups.some(
            (id) =>
              !s.groups.some(
                (g) => g.id === id && g.programUuid === programUuid,
              ),
          )
        )
          throw Error(
            "Users can only be assigned groups in this Flight Program.",
          );
        email = email.trim().toLowerCase();
        name = name.trim();
        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          !name ||
          name.length > 150
        )
          throw Error("A valid email and name are required.");
        if (password.length < 12 || password.length > 128)
          throw Error("Use a password between 12 and 128 characters.");
        if (s.members.some((m) => m.email.toLowerCase() === email))
          throw Error(EMAIL_UNAVAILABLE);
        const groupIds = [...new Set(requestedGroups)];
        if (
          !s.groups.some(
            (g) => groupIds.includes(g.id) && g.permissions.includes("read"),
          )
        ) {
          const read = s.groups.find(
            (g) =>
              g.programUuid === programUuid &&
              g.name === "Observers" &&
              !g.programAdmin &&
              !g.aircraftIds.length &&
              g.permissions.length === 1 &&
              g.permissions[0] === "read",
          );
          if (!read)
            throw Error(
              "Select a permission group; Observers read-only access is unavailable.",
            );
          groupIds.push(read.id);
        }
        s.members.push({
          id,
          email,
          name,
          active: true,
          isAdmin: false,
          activeProgramUuid: programUuid,
          groupIds,
        });
        audit(s, "user.created", id);
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
    uploadAircraftFile: (aircraftUuid, category, file) =>
      demoAircraftFiles.upload(modify, audit, aircraftUuid, category, file),
    archiveAircraftFile: (id, reason) =>
      demoAircraftFiles.archive(modify, audit, id, reason),
    createUser: async (email, name, password) => {
      const id = crypto.randomUUID();
      await modify((s) => {
        if (password.length < 12)
          throw new Error("Use at least 12 characters.");
        if (
          s.members.some(
            (m) => m.email.toLowerCase() === email.trim().toLowerCase(),
          )
        )
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
    saveLicense: (licenseNumber, certificateType) =>
      modify((s) => {
        const fields = licenseSchema.parse({ licenseNumber, certificateType });
        s.user = { ...s.user, ...fields };
        s.members = s.members.map((m) =>
          m.id === s.user.id ? { ...m, ...fields } : m,
        );
        audit(
          s,
          "user.license_updated",
          s.user.id,
          undefined,
          undefined,
          undefined,
          fields,
        );
      }),
    saveCertifications: (userId, rows) =>
      modify((s) => {
        if (userId !== s.user.id && !s.user.isAdmin)
          throw Error("Permission denied.");
        const certifications = certificationsSchema.parse(rows),
          fields = { certifications, ...memberLicense({ certifications }) };
        s.members = s.members.map((m) =>
          m.id === userId ? { ...m, ...fields } : m,
        );
        if (s.user.id === userId) s.user = { ...s.user, ...fields };
        audit(s, "user.certifications_updated", userId);
      }),
    certificationFiles: async (userId) =>
      (useWorkspace.getState().snapshot?.certificationFiles ?? []).filter(
        (f) => f.userId === userId,
      ),
    certificationFileUrl: async (id) =>
      useWorkspace
        .getState()
        .snapshot?.certificationFiles?.find((f) => f.id === id)?.url ?? null,
    uploadCertification: async (userId, kind, file) => {
      validateCertificationFile(file.name, file.type, file.size);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const url = `data:${file.type};base64,${btoa(binary)}`;
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
        if (input.certifications !== undefined) {
          user.certifications = certificationsSchema.parse(
            input.certifications,
          );
          Object.assign(user, memberLicense(user));
        }
        if (user.id === s.user.id && (!user.isAdmin || !user.active))
          throw new Error("Keep the demo administrator active.");
        s.members = s.members.map((m) => (m.id === user.id ? user : m));
        if (user.id === s.user.id) s.user = user;
        audit(s, "user.permissions_changed", user.id);
      }),
    auditPage: async (request) => {
      const current = useWorkspace.getState();
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
    groupAccessReview: async () => {
      const current = useWorkspace.getState();
      if (!current.snapshot?.user.isAdmin)
        throw new Error("Administrator permission required.");
      return groupAccessReports(
        (await local.readSnapshot(current.namespace + ":all")) ??
          current.snapshot,
      );
    },
    previewGroupDeletion: async (id) => {
      const current = useWorkspace.getState();
      const s =
        (await local.readSnapshot(current.namespace + ":all")) ??
        current.snapshot!;
      return groupDeletionPlan(s, id);
    },
    deleteGroup: (id, expected) =>
      modify((s) => {
        const before = s.groups.find((g) => g.id === id);
        deletePermissionGroup(s, id, expected);
        audit(s, "group.deleted", id, undefined, undefined, before);
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
        const assigned = assertGroupProgramChange(
          before,
          group,
          s.user.isAdmin,
        );
        if (
          group.aircraftIds.some(
            (id) =>
              !s.aircraft.some(
                (a) => a.uuid === id && a.programUuid === group.programUuid,
              ),
          )
        )
          throw Error("Group aircraft must belong to its Flight Program.");
        if (!group.name.trim()) throw new Error("Group name is required.");
        validateOwnerGroup(group);
        assertGroupAircraftChoice(before, { ...group, allAircraft });
        const next = { ...group, id: group.id ?? crypto.randomUUID() };
        s.groups = s.groups.some((g) => g.id === next.id)
          ? s.groups.map((g) => (g.id === next.id ? next : g))
          : [...s.groups, next];
        // As convex/admin.ts records it, with the aircraft-access choice.
        audit(
          s,
          "group.saved",
          next.id,
          undefined,
          undefined,
          before,
          allAircraft === undefined ? next : { ...next, allAircraft },
        );
        if (assigned)
          audit(
            s,
            "group.program_assigned",
            next.id,
            undefined,
            undefined,
            { programUuid: null },
            { programUuid: group.programUuid },
          );
      }),
    createAircraft: (aircraft: Aircraft) =>
      modify((s) => {
        if (
          !programPermission(s, "admin") ||
          aircraft.programUuid !== activeProgram(s)
        )
          throw Error("Flight Program administrator required.");
        if (s.aircraft.some((a) => a.registration === aircraft.registration))
          throw new Error("Registration already exists.");
        s.aircraft.push(aircraft);
        audit(s, "aircraft.created", aircraft.uuid, aircraft.uuid);
      }),
    resetPassword: async () => {
      throw new Error(
        "The local demo has no real accounts or passwords. Configure Convex to manage credentials.",
      );
    },
    alertReads: async (programUuid) =>
      (await local.readFavorites(demoAlertReadsKey(programUuid))) ?? [],
    markAlertsRead: async (programUuid, keys, all) => {
      const key = demoAlertReadsKey(programUuid);
      const before = all ? [] : ((await local.readFavorites(key)) ?? []);
      await local.saveFavorites(key, [...new Set([...before, ...keys])]);
    },
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
function demoAlertReadsKey(programUuid: string | undefined) {
  const { namespace, snapshot } = useWorkspace.getState();
  return `${namespace}:demo-alert-reads:${snapshot?.user.id}:${programUuid ?? ""}`;
}
