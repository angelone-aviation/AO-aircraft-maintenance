/**
 * Responsibility: Work order commands, in one transaction, and the
 *   attachments filed on an open work order.
 * Layer: Server. One runCommand mutation, the rules being the domain's; the
 *   attachment functions check access themselves. Every change is audited.
 * Dependencies: convex (runCommand, programContext, access, attachments,
 *   management, recurringParts, workOrderCopies, userErrors), src/domain
 *   (workOrders, model).
 */
import { prepareRecurringParts } from "./recurringParts";
import { ConvexError, v } from "convex/values";
import { can, type Snapshot } from "../src/domain/model";
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
  type WorkOrder,
  type WorkOrderCommand,
} from "../src/domain/workOrders";
import { exposeRejections } from "./userErrors";

type LoadedWorkOrder = Awaited<ReturnType<typeof loadWorkOrder>>;

// The tenant guard's message. Every row a save writes was loaded from the
// program or has a fresh uuid, so data the app wrote never meets it.
const RECORD_TAKEN = "Record belongs to another Flight Program.";

const COPY_REFUSALS = new Set([
  "Work order changed. Reopen it before saving.",
  "This work order is closed.",
  "This item is already on the work order.",
]);

/**
 * Runs one work order command (save, revise, add work, copy templates or
 * correct a component) through `saveWorkOrder`, and persists what it changed:
 * job cards, inspections, component records, recurring parts requests and the
 * order itself. Template copies run as scheduled batches (workOrderCopies.ts).
 *
 * @param payload - JSON, as `workOrderCommandSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @returns The work order's uuid.
 * @throws {ConvexError} As `runCommand`, `saveWorkOrder` and
 *   `queueTemplateCopies`; "Work order maintenance access denied."; "Job cards
 *   are still being prepared. …"; "Work order not found."; for adding an
 *   inspection or copying templates, also "Work order changed. Reopen it
 *   before saving.", "This work order is closed." and "This item is already
 *   on the work order."
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => workOrderCommandSchema.parse(JSON.parse(args.payload)),
      load: loadWorkOrder,
      apply: ({ working }, command) => ({
        next: showCopyRefusals(command, () =>
          saveWorkOrder(working, command, Date.now(), {
            deferTemplateCopies: true,
          }),
        ),
      }),
      afterApply: scheduleJobs,
      persist: persistWorkOrder,
      audit: (log, { working, previous }, { next }, command) => {
        log.replay(working.audit);
        log.entry("workOrder." + command.action, next.uuid, {
          aircraftUuid: next.aircraftUuid,
          before: previous,
          after: next,
          reason:
            command.action === "revise" || command.action === "correctComponent"
              ? command.reason
              : undefined,
        });
      },
      returns: ({ next }) => next.uuid,
    }),
});

const fileArgs = {
  workOrderUuid: v.string(),
  programUuid: v.optional(v.string()),
};

/**
 * Checks, before an attachment is stored, that the caller may add one.
 *
 * @returns The caller's user id.
 * @throws {ConvexError} As `checkContext` and `authorized`; "Work order not
 *   found."; "This work order is closed."
 */
export const checkUpload = internalQuery({
  args: fileArgs,
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const doc = await findWorkOrder(ctx, args.workOrderUuid);
    if (!doc) throw new ConvexError("Work order not found.");
    return (await authorizeOpenOrder(ctx, state, doc))._id;
  },
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
    const state = await checkContext(ctx, args.programUuid);
    const doc = await findWorkOrder(ctx, args.workOrderUuid);
    if (!doc) throw new ConvexError("Work order not found.");
    const user = await authorizeOpenOrder(ctx, state, doc);
    assertAttachmentRoom(
      await ctx.db
        .query("workOrderFiles")
        .withIndex("workOrder", (q) => q.eq("workOrderUuid", doc.uuid))
        .take(MAX_ATTACHMENTS),
    );
    const { programUuid: _program, ...fields } = args;
    await ctx.db.insert("workOrderFiles", {
      ...fields,
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
 * @throws {ConvexError} "Choose a PDF, JPEG or PNG file up to 7 MB.", before
 *   any permission check; as {@link finishUpload}.
 */
export const upload = action({
  args: { ...fileArgs, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() =>
      validateWorkOrderFile(args.name, args.type, args.bytes.byteLength),
    );
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
 * @throws {ConvexError} As `checkContext` and `authorized`; "Attachment not
 *   found."; "This work order is closed."
 */
export const removeFile = mutation({
  args: { id: v.id("workOrderFiles"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const file = await ctx.db.get(args.id);
    const doc = file && (await findWorkOrder(ctx, file.workOrderUuid));
    if (!file || !doc) throw new ConvexError("Attachment not found.");
    const user = await authorizeOpenOrder(ctx, state, doc);
    await ctx.db.delete(file._id);
    await deleteBlobIfUnused(ctx, file.storageId);
    await audit(ctx, user._id, "workOrder.attachment_removed", doc.uuid, {
      aircraftUuid: doc.aircraftUuid,
      before: { name: file.name },
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
  if (!aircraftUuid) throw new ConvexError("Work order not found.");
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

// Production hides a plain Error's message. Adding an inspection and copying
// templates showed these refusals as ConvexError before saveWorkOrder ran
// them, and saveWorkOrder still throws them as plain Error.
function showCopyRefusals(
  command: WorkOrderCommand,
  save: () => WorkOrder,
): WorkOrder {
  try {
    return save();
  } catch (error) {
    if (!isCopyCommand(command) || !isCopyRefusal(error)) throw error;
    throw new ConvexError(error.message);
  }
}

const isCopyCommand = (command: WorkOrderCommand) =>
  command.action === "copyTemplates" ||
  (command.action === "add" && command.source.kind === "inspection");

const isCopyRefusal = (error: unknown): error is Error =>
  error instanceof Error &&
  error.constructor === Error &&
  COPY_REFUSALS.has(error.message);

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
    RECORD_TAKEN,
  );
  await deleteRemovedCards(ctx, docs.taskCards, cards);
  const added = cards.filter((card) => !previousCards.has(card.uuid));
  await writeChanged(ctx, "taskCards", docs.taskCards, added, RECORD_TAKEN);
  for (const inspection of working.inspections)
    if (inspection.version !== loaded.previousInspections.get(inspection.uuid))
      await writeInspection(ctx, docs.inspections, inspection);
  const records = changedRecords(loaded);
  await writeChanged(ctx, "management", docs.management, records, RECORD_TAKEN);
  await writeChanged(ctx, "workOrders", docs.workOrders, [next], RECORD_TAKEN);
}

async function deleteRemovedCards(
  ctx: MutationCtx,
  loaded: readonly Doc<"taskCards">[],
  remaining: readonly { uuid: string }[],
) {
  const kept = new Set(remaining.map((card) => card.uuid));
  for (const doc of loaded)
    if (!kept.has(doc.uuid)) await ctx.db.delete(doc._id);
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

async function authorizeOpenOrder(
  ctx: QueryCtx | MutationCtx,
  state: ProgramContext,
  doc: Doc<"workOrders">,
) {
  const user = await authorized(ctx, doc.aircraftUuid, "maintenance", state);
  if (!isOpenWorkOrder(workOrderSchema.parse(JSON.parse(doc.payload))))
    throw new ConvexError("This work order is closed.");
  return user;
}
