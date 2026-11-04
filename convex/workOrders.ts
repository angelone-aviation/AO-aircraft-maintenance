/**
 * Responsibility: Work order commands, in one transaction, and the
 *   attachments filed on an open work order.
 * Layer: Server. One runCommand mutation, the rules being the domain's; the
 *   attachment functions check access themselves. Every change is audited.
 * Dependencies: convex (runCommand, programContext, access, attachments,
 *   recurringParts, workOrderCopies, userErrors), src/domain (workOrders,
 *   model, management).
 */
import { prepareRecurringParts } from "./recurringParts";
import { ConvexError, v } from "convex/values";
import { can, type Snapshot } from "../src/domain/model";
import { startCopy, queueTemplateCopies } from "./workOrderCopies";
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
  type ProgramContext,
  type Transaction,
} from "./runCommand";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  MAX_ATTACHMENTS,
} from "./attachments";
import { inspectionSchema } from "../src/domain/management";
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
type ManagementRecord = NonNullable<Snapshot["management"]>[number];

/**
 * Runs one work order command (save, revise, add work, copy templates or
 * correct a component) and persists what it changed: job cards, inspections,
 * component records, recurring parts requests and the order itself. Template
 * copies run as scheduled batches (workOrderCopies.ts).
 *
 * @param payload - JSON, as `workOrderCommandSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @returns The work order's uuid.
 * @throws {ConvexError} As `runCommand`, `saveWorkOrder` and `startCopy`;
 *   "Work order maintenance access denied."; "Job cards are still being
 *   prepared. …"; "Work order not found."
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => workOrderCommandSchema.parse(JSON.parse(args.payload)),
      delegate: (state, command) =>
        command.action === "copyTemplates" ||
        (command.action === "add" && command.source.kind === "inspection")
          ? startCopy(ctx, state, command)
          : undefined,
      load: loadWorkOrder,
      apply: ({ working }, command) => ({
        next: saveWorkOrder(working, command, Date.now(), {
          deferTemplateCopies: true,
        }),
      }),
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
 * @throws As `validateWorkOrderFile`, a Rejection as a ConvexError, before any
 *   permission check; as {@link finishUpload}.
 */
export const upload = action({
  args: { ...fileArgs, name: v.string(), type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() =>
      validateWorkOrderFile(args.name, args.type, args.bytes.byteLength),
    );
    await ctx.runQuery(internal.workOrders.checkUpload, {
      workOrderUuid: args.workOrderUuid,
      programUuid: args.programUuid,
    });
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.workOrders.finishUpload, {
        workOrderUuid: args.workOrderUuid,
        programUuid: args.programUuid,
        storageId,
        name: args.name,
        size: args.bytes.byteLength,
      });
    } catch (e) {
      // A file that was not filed must not stay in storage.
      await ctx.storage.delete(storageId);
      throw e;
    }
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
  const working = await loadWorking(ctx, state, orders.snapshot.workOrders);
  return {
    working,
    existing,
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
  workOrders: Snapshot["workOrders"],
): Promise<Snapshot> {
  const { snapshot } = await hydrate(ctx, state, [
    "management",
    "airworthiness",
    "taskCards",
    "inspections",
    "discrepancies",
  ]);
  return {
    ...snapshot,
    workOrders,
    archivedTaskCards: [],
    // Work order rules never read evidence; it stays out of the transaction.
    taskEvidence: [],
  };
}

function assertEditable(state: ProgramContext, previous: WorkOrder) {
  if (!can(state, previous.aircraftUuid, "maintenance"))
    throw new ConvexError("Work order maintenance access denied.");
  if (previous.templateCopy && previous.templateCopy.status !== "completed")
    throw new ConvexError(
      "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.",
    );
}

async function persistWorkOrder(
  { ctx, state, log }: Transaction,
  loaded: LoadedWorkOrder,
  result: { next: WorkOrder },
) {
  const { working } = loaded;
  // Scheduling that must run between apply and persist.
  log.record(await prepareRecurringParts(ctx, working, result.next));
  result.next = await queueTemplateCopies(
    ctx,
    result.next,
    loaded.previous,
    state,
  );
  await persistTaskCards(ctx, working, loaded.previousCards);
  await persistInspections(ctx, working, loaded.previousInspections);
  for (const record of working.management ?? [])
    if (record.version !== loaded.previousManagement.get(record.uuid))
      await persistManagementRecord(ctx, record);
  const next = result.next;
  const fields = {
    uuid: next.uuid,
    aircraftUuid: next.aircraftUuid,
    payload: JSON.stringify(next),
  };
  if (loaded.existing) await ctx.db.replace(loaded.existing._id, fields);
  else await ctx.db.insert("workOrders", fields);
}

async function persistTaskCards(
  ctx: MutationCtx,
  working: Snapshot,
  previousCards: Set<string>,
) {
  for (const card of working.archivedTaskCards ?? [])
    await ctx.db.insert("archivedTaskCards", {
      uuid: card.uuid,
      aircraftUuid: card.aircraftUuid,
      payload: JSON.stringify(card),
    });
  const remainingCards = new Set(working.taskCards?.map((card) => card.uuid));
  for (const id of previousCards) {
    if (remainingCards.has(id)) continue;
    const doc = await ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", id))
      .unique();
    if (doc) await ctx.db.delete(doc._id);
  }
  for (const card of working.taskCards ?? [])
    if (!previousCards.has(card.uuid))
      await ctx.db.insert("taskCards", {
        uuid: card.uuid,
        aircraftUuid: card.aircraftUuid,
        payload: JSON.stringify(card),
      });
}

async function persistInspections(
  ctx: MutationCtx,
  working: Snapshot,
  previousVersions: Map<string, number | undefined>,
) {
  for (const inspection of working.inspections) {
    if (inspection.version === previousVersions.get(inspection.uuid)) continue;
    const doc = await ctx.db
      .query("inspections")
      .withIndex("uuid", (q) => q.eq("uuid", inspection.uuid))
      .unique();
    if (!doc) throw new Error("Inspection not found during closeout.");
    await ctx.db.replace(
      doc._id,
      inspectionSchema.parse({
        ...inspection,
        materials: inspection.materials ?? "",
        archived: inspection.archived ?? false,
      }),
    );
  }
}

async function persistManagementRecord(
  ctx: MutationCtx,
  record: ManagementRecord,
) {
  const doc = await ctx.db
    .query("management")
    .withIndex("uuid", (q) => q.eq("uuid", record.uuid))
    .unique();
  if (doc) {
    await ctx.db.patch(doc._id, {
      aircraftUuid: "aircraftUuid" in record ? record.aircraftUuid : undefined,
      payload: JSON.stringify(record),
    });
    return;
  }
  // A work order adds component movements; every other record it changes
  // already exists.
  if (record.kind !== "componentMovement")
    throw new Error("Service requirement not found during closeout.");
  await ctx.db.insert("management", {
    uuid: record.uuid,
    programUuid: record.programUuid,
    aircraftUuid: record.aircraftUuid,
    kind: record.kind,
    payload: JSON.stringify(record),
  });
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
