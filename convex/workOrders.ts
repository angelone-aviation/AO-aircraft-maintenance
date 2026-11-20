/**
 * Responsibility: Work order commands, in one transaction, and the
 *   attachments filed on an open work order.
 * Layer: Server. One runCommand mutation, the rules being the domain's; the
 *   attachment functions check access themselves. Every change is audited.
 * Dependencies: convex (runCommand, programContext, access, attachments,
 *   management, recordNumbers, recurringParts, workOrderCopies, urgentAlerts,
 *   userErrors),
 *   src/domain (workOrders, model, changeLog, inventoryAttachments).
 */
import { prepareRecurringParts } from "./recurringParts";
import { dropRecordNumber } from "./recordNumbers";
import { ConvexError, v } from "convex/values";
import { can, type Snapshot } from "../src/domain/model";
import { auditEntry } from "../src/domain/changeLog";
import { queueTemplateCopies } from "./workOrderCopies";
import {
  mutation,
  action,
  internalQuery,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { checkContext } from "./programContext";
import { authorized, audit } from "./access";
import {
  runCommand,
  hydrate,
  requestOf,
  requestUuidIn,
  writeChanged,
  type Hydrated,
  type ProgramContext,
  type Transaction,
} from "./runCommand";
import { writeInspection } from "./management";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  storeThenFinish,
  MAX_ATTACHMENTS,
} from "./attachments";
import {
  saveWorkOrder,
  workOrderSchema,
  workOrderCommandSchema,
  isOpenWorkOrder,
  validateWorkOrderFile,
  WORK_ORDER_FILE_TYPES,
  type WorkOrder,
  type WorkOrderCommand,
} from "../src/domain/workOrders";
import { assertFileContents } from "../src/domain/inventoryAttachments";
import { exposeRejections } from "./userErrors";
import { scheduleUrgentAlerts } from "./urgentAlerts";

type LoadedWorkOrder = Awaited<ReturnType<typeof loadWorkOrder>>;

// The tenant guard's message. Every row a save writes was loaded from the
// program or has a fresh uuid, so data the app wrote never meets it.
const NOT_FOUND = "Work order not found.";

/**
 * Runs one work order command (save, revise, add work, copy templates or
 * correct a component) through `saveWorkOrder`, and persists what it changed:
 * job cards, inspections, component records, recurring parts requests and the
 * order itself. Template copies run as scheduled batches (workOrderCopies.ts).
 * A replayed request id changes nothing.
 *
 * @param payload - JSON, as `workOrderCommandSchema`, with its request id,
 *   which that schema drops.
 * @param programUuid - The caller's active Flight Program.
 * @returns The work order's uuid.
 * @throws {ConvexError} As `runCommand`, and the refusals of `saveWorkOrder`
 *   and `queueTemplateCopies`; "Work order maintenance access denied."; "Job
 *   cards are still being prepared. …"; "Work order not found."
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const uuid = await runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => workOrderCommandSchema.parse(JSON.parse(args.payload)),
      request: () => requestOf(requestUuidIn(args.payload), args.payload),
      load: loadWorkOrder,
      apply: ({ working }, command) => ({
        next: saveWorkOrder(working, command, Date.now(), {
          deferTemplateCopies: true,
        }),
      }),
      afterApply: scheduleJobs,
      persist: persistWorkOrder,
      audit: (log, { working, previous }, { next }, command) =>
        log.replay([
          ...working.audit,
          auditEntry(working, {
            action: "workOrder." + command.action,
            entityUuid: next.uuid,
            aircraftUuid: next.aircraftUuid,
            before: previous,
            after: next,
            reason:
              command.action === "revise" ||
              command.action === "correctComponent"
                ? command.reason
                : undefined,
          }),
        ]),
      returns: ({ next }) => next.uuid,
    });
    // A close-out moves components and freezes readings, which can pass a
    // limit.
    await scheduleUrgentAlerts(ctx, args.programUuid);
    return uuid;
  },
});

const fileArgs = {
  workOrderUuid: v.string(),
  programUuid: v.optional(v.string()),
};

/**
 * Checks, before an attachment is stored, that the caller may add one.
 *
 * @returns The caller's user id.
 * @throws {ConvexError} As `checkContext`; "Work order not found.", also
 *   for one the caller cannot read; as `authorized`; "This work order is
 *   closed."
 */
export const checkUpload = internalQuery({
  args: fileArgs,
  handler: async (ctx, args) =>
    (await openWorkOrder(ctx, args.programUuid, async () => args, NOT_FOUND))
      .user._id,
});

/**
 * Files a stored attachment on the work order, checked again in this
 * transaction; audits "workOrder.attachment".
 *
 * @throws {ConvexError} As {@link checkUpload}; the attachment limit.
 */
export const finishUpload = internalMutation({
  args: {
    ...fileArgs,
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const { doc, user } = await openWorkOrder(
      ctx,
      args.programUuid,
      async () => args,
      NOT_FOUND,
    );
    assertAttachmentRoom(
      await ctx.db
        .query("workOrderFiles")
        .withIndex("workOrder", (q) => q.eq("workOrderUuid", doc.uuid))
        .take(MAX_ATTACHMENTS),
    );
    const { programUuid: _program, ...fields } = args;
    await ctx.db.insert("workOrderFiles", {
      ...fields,
      aircraftUuid: doc.aircraftUuid,
      uploadedAt: Date.now(),
    });
    await audit(ctx, user._id, "workOrder.attachment", doc.uuid, {
      aircraftUuid: doc.aircraftUuid,
      after: { name: args.name },
    });
  },
});

/**
 * Stores a PDF, JPEG or PNG and files it on an open work order. A refused
 * filing deletes the stored file.
 *
 * @param name - The file name shown on the order.
 * @param type - The file's MIME type.
 * @param bytes - The file.
 * @throws {ConvexError} "Choose a PDF, JPEG or PNG file up to 7 MiB.", then
 *   "This file's contents do not match its type. Choose a PDF, JPEG or PNG
 *   file." when the first bytes are not the declared type's, both before
 *   any permission check and storing nothing; as {@link finishUpload}.
 */
export const upload = action({
  args: { ...fileArgs, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() => {
      validateWorkOrderFile(args.name, args.type, args.bytes.byteLength);
      assertFileContents(args.type, args.bytes, WORK_ORDER_FILE_TYPES);
    });
    const order = {
      workOrderUuid: args.workOrderUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.workOrders.checkUpload, order);
    await storeThenFinish(ctx, args, (storageId) =>
      ctx.runMutation(internal.workOrders.finishUpload, {
        ...order,
        storageId,
        name: args.name,
        size: args.bytes.byteLength,
      }),
    );
  },
});

/**
 * Removes an attachment from an open work order, and its stored file once
 * nothing else refers to it; audits "workOrder.attachment_removed".
 *
 * @param id - The attachment.
 * @throws {ConvexError} As `checkContext`; "Attachment not found.", also on
 *   a work order the caller cannot read; as `authorized`; "This work order
 *   is closed."
 */
export const removeFile = mutation({
  args: { id: v.id("workOrderFiles"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { target, doc, user } = await openWorkOrder(
      ctx,
      args.programUuid,
      () => ctx.db.get(args.id),
      "Attachment not found.",
    );
    await ctx.db.delete(target._id);
    await deleteBlobIfUnused(ctx, target.storageId);
    await audit(ctx, user._id, "workOrder.attachment_removed", doc.uuid, {
      aircraftUuid: doc.aircraftUuid,
      before: { name: target.name },
    });
  },
});

async function loadWorkOrder(
  { ctx, state }: Transaction,
  command: WorkOrderCommand,
) {
  const existing = await findWorkOrder(ctx, command.uuid);
  const previous = existing
    ? workOrderSchema.parse(JSON.parse(existing.payload))
    : undefined;
  if (previous) assertEditable(state, previous);
  const orders = await hydrate(ctx, state, ["workOrders"]);
  const aircraftUuid =
    command.action === "save"
      ? command.fields.aircraftUuid
      : orders.snapshot.workOrders!.find((w) => w.uuid === command.uuid)
          ?.aircraftUuid;
  if (!aircraftUuid) throw new ConvexError(NOT_FOUND);
  await authorized(ctx, aircraftUuid, "maintenance", state);
  const { working, docs } = await loadWorking(ctx, state, orders);
  return {
    working,
    docs,
    previous,
    previousInspections: new Map(
      working.inspections.map((i) => [i.uuid, i.version]),
    ),
    previousManagement: new Map(
      working.management?.map((r) => [r.uuid, r.version]),
    ),
    previousCards: new Set(working.taskCards?.map((t) => t.uuid)),
  };
}

async function loadWorking(
  ctx: MutationCtx,
  state: ProgramContext,
  orders: Hydrated<"workOrders">,
) {
  const { snapshot, docs } = await hydrate(ctx, state, [
    "management",
    "airworthiness",
    "taskCards",
    "inspections",
    "discrepancies",
  ]);
  const working: Snapshot = {
    ...snapshot,
    workOrders: orders.snapshot.workOrders,
    archivedTaskCards: [],
    // Work order rules never read evidence; it stays out of the transaction.
    taskEvidence: [],
  };
  return { working, docs: { ...docs, workOrders: orders.docs.workOrders } };
}

function assertEditable(state: ProgramContext, previous: WorkOrder) {
  if (!can(state, previous.aircraftUuid, "maintenance"))
    throw new ConvexError("Work order maintenance access denied.");
  if (previous.templateCopy && previous.templateCopy.status !== "completed")
    throw new ConvexError(
      "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.",
    );
}

// Starts the jobs a save owes: recurring parts requests, then template copies.
// They need the applied order, and the order records its copy job, so they
// run before persist (ADR-0003). Copying templates copies them for every item,
// not only the items it adds.
async function scheduleJobs(
  { ctx, state, log }: Transaction,
  loaded: LoadedWorkOrder,
  { next }: { next: WorkOrder },
  command: WorkOrderCommand,
) {
  log.record(await prepareRecurringParts(ctx, loaded.working, next));
  const previous =
    command.action === "copyTemplates" ? undefined : loaded.previous;
  return { next: await queueTemplateCopies(ctx, next, previous, state) };
}

// Writes only what the command changed, found by membership and version, so a
// record it left alone is never rewritten: archived job cards, the job cards
// it removed or added, inspections, component records, then the order.
async function persistWorkOrder(
  { ctx }: Transaction,
  loaded: LoadedWorkOrder,
  { next }: { next: WorkOrder },
) {
  const { working, docs, previousCards } = loaded;
  const cards = working.taskCards ?? [];
  await writeChanged(
    ctx,
    "archivedTaskCards",
    [],
    working.archivedTaskCards ?? [],
  );
  await deleteRemovedCards(ctx, docs.taskCards, cards);
  const added = cards.filter((card) => !previousCards.has(card.uuid));
  await writeChanged(ctx, "taskCards", docs.taskCards, added);
  for (const inspection of working.inspections)
    if (inspection.version !== loaded.previousInspections.get(inspection.uuid))
      await writeInspection(ctx, docs.inspections, inspection);
  const records = changedRecords(loaded);
  await writeChanged(ctx, "management", docs.management, records);
  await writeChanged(ctx, "workOrders", docs.workOrders, [next]);
}

async function deleteRemovedCards(
  ctx: MutationCtx,
  loaded: readonly Doc<"taskCards">[],
  remaining: readonly { uuid: string }[],
) {
  const kept = new Set(remaining.map((card) => card.uuid));
  for (const doc of loaded) {
    if (kept.has(doc.uuid)) continue;
    await ctx.db.delete(doc._id);
    await dropRecordNumber(ctx, doc.uuid);
  }
}

// A work order adds component movements only; every other record it changes
// was loaded.
function changedRecords({ working, previousManagement }: LoadedWorkOrder) {
  const changed = (working.management ?? []).filter(
    (r) => r.version !== previousManagement.get(r.uuid),
  );
  if (
    changed.some(
      (r) => !previousManagement.has(r.uuid) && r.kind !== "componentMovement",
    )
  )
    throw new Error("Service requirement not found during closeout.");
  return changed;
}

function findWorkOrder(ctx: QueryCtx | MutationCtx, uuid: string) {
  return ctx.db
    .query("workOrders")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
}

// The one access check of the attachment functions, on the order `target`
// (an upload's arguments, or a filed attachment) names: the Flight Program,
// then that the order exists, then maintenance access to its aircraft, then
// that the order is open. The program comes first, so a caller outside it
// learns nothing about the record.
// The session and program come first, and a work order the caller cannot read
// gets the same refusal as a missing one, so an id or uuid never tells that
// another program's work order exists (security review T4).
async function openWorkOrder<T extends { workOrderUuid: string }>(
  ctx: QueryCtx | MutationCtx,
  programUuid: string | undefined,
  find: () => Promise<T | null>,
  missing: string,
) {
  const state = await checkContext(ctx, programUuid);
  const target = await find();
  const doc = target && (await findWorkOrder(ctx, target.workOrderUuid));
  if (!target || !doc || !can(state, doc.aircraftUuid, "read"))
    throw new ConvexError(missing);
  const user = await authorized(ctx, doc.aircraftUuid, "maintenance", state);
  if (!isOpenWorkOrder(workOrderSchema.parse(JSON.parse(doc.payload))))
    throw new ConvexError("This work order is closed.");
  return { target, doc, user };
}
