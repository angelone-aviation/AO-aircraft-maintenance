/**
 * Responsibility: Job-card saves, through the task-card domain applier, and
 *   job-card evidence: upload, its checks, and removal.
 * Layer: Server. Convex mutations, an action and internal functions; the
 *   rules live in src/domain (taskCards, attachments).
 * Dependencies: convex/values, ./_generated, ./programContext, ./access,
 *   ./runCommand, ./collections, ./attachments, ./userErrors, src/domain
 *   (taskCards, workOrders, attachments, model).
 */
import { v, ConvexError } from "convex/values";
import {
  mutation,
  action,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  checkContext,
  managementDocs,
  inspectionDocs,
  taskCardDocs,
  workOrderDocs,
  discrepancyDocs,
} from "./programContext";
import { authorized, audit } from "./access";
import {
  runCommand,
  hydrate,
  requestOf,
  writeChanged,
  type ProgramContext,
} from "./runCommand";
import { decode } from "./collections";
import {
  assertAttachmentRoom,
  deleteBlobIfUnused,
  storeThenFinish,
  MAX_ATTACHMENTS,
} from "./attachments";
import { exposeRejections } from "./userErrors";
import { validateWorkOrderFile } from "../src/domain/workOrders";
import { withNewEvidence } from "../src/domain/attachments";
import { can } from "../src/domain/model";
import {
  applyTaskCardCommand,
  taskCardCommandSchema,
  taskWritable,
  evidenceRemovable,
  type TaskCardCommand,
} from "../src/domain/taskCards";

const NO_OPEN_CARD = "An open job card and maintenance access are required.";
const NO_EVIDENCE = "Evidence not found.";

/**
 * Saves a job card in the active Flight Program and writes the
 * "taskCard.<action>" row applyTaskCardCommand records. A replayed request id
 * changes nothing.
 *
 * @param payload - The job-card command, as JSON, with its request id.
 * @returns The card's uuid; nothing for a replay.
 * @throws {ConvexError} "Archived job cards are read-only."; "Record belongs
 *   to another Flight Program." for a card uuid outside the program; a
 *   domain Rejection; runCommand's program refusals.
 */
export const save = mutation({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: (ctx, args) =>
    runCommand(ctx, {
      programUuid: args.programUuid,
      parse: () => taskCardCommandSchema.parse(JSON.parse(args.payload)),
      request: (command) => requestOf(command.requestUuid, args.payload),
      load: ({ ctx, state }, command) => loadCard(ctx, state, command),
      apply: ({ snapshot }, command) => applyTaskCardCommand(snapshot, command),
      persist: ({ ctx }, { docs }, next) =>
        writeChanged(ctx, "taskCards", docs, [next]),
      audit: (log, { snapshot }) => log.replay(snapshot.audit),
      returns: (next) => next.uuid,
    }),
});

const fileArgs = {
  taskCardUuid: v.string(),
  programUuid: v.optional(v.string()),
};
const category = v.union(
  v.literal("photo"),
  v.literal("supporting-document"),
  v.literal("parts-traceability"),
);
/**
 * Checks, before an upload is stored, that the caller may add evidence to
 * the job card.
 *
 * @returns The caller's user id.
 * @throws {ConvexError} "An open job card and maintenance access are
 *   required."; the refusals of checkContext and authorized.
 */
export const checkUpload = internalQuery({
  args: fileArgs,
  handler: async (ctx, args) => {
    const s = await taskState(ctx, args.programUuid);
    const t = s.taskCards.find((t) => t.uuid === args.taskCardUuid);
    if (!t || !taskWritable(s, t)) throw new ConvexError(NO_OPEN_CARD);
    return (await authorized(ctx, t.aircraftUuid, "maintenance", s))._id;
  },
});
/**
 * Records a stored upload as job-card evidence. New evidence clears the
 * card's signoffs, so the card is saved with a new version and a
 * "taskCard.evidence" change-log row.
 *
 * @throws {ConvexError} "An open job card and maintenance access are
 *   required."; the attachment limit; checkContext's refusals.
 */
export const finishUpload = internalMutation({
  args: {
    ...fileArgs,
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    category,
  },
  handler: async (ctx, args) => {
    const s = await taskState(ctx, args.programUuid);
    const t = s.taskCards.find((t) => t.uuid === args.taskCardUuid);
    if (!t || !taskWritable(s, t)) throw new ConvexError(NO_OPEN_CARD);
    assertAttachmentRoom(
      await ctx.db
        .query("taskEvidence")
        .withIndex("taskCard", (q) => q.eq("taskCardUuid", t.uuid))
        .take(MAX_ATTACHMENTS),
    );
    const { programUuid: _program, ...fields } = args;
    const now = Date.now();
    await ctx.db.insert("taskEvidence", {
      ...fields,
      aircraftUuid: t.aircraftUuid,
      uploadedAt: now,
    });
    const next = withNewEvidence(t, now);
    const doc = await ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", t.uuid))
      .unique();
    await ctx.db.patch(doc!._id, { payload: JSON.stringify(next) });
    await audit(ctx, s.user.id, "taskCard.evidence", t.uuid, {
      aircraftUuid: t.aircraftUuid,
      before: t,
      after: { ...next, evidenceName: args.name, category: args.category },
    });
  },
});
/**
 * Uploads one evidence file to a job card. The file is stored first and
 * deleted again if the card refuses it.
 *
 * @throws {ConvexError} "Choose a PDF, JPEG or PNG file up to 7 MB.", before
 *   any permission check; the refusals of checkUpload and finishUpload.
 */
export const upload = action({
  args: {
    ...fileArgs,
    name: v.string(),
    type: v.string(),
    bytes: v.bytes(),
    category,
  },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() =>
      validateWorkOrderFile(args.name, args.type, args.bytes.byteLength),
    );
    const card = {
      taskCardUuid: args.taskCardUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.taskCards.checkUpload, card);
    await storeThenFinish(ctx, args, (storageId) =>
      ctx.runMutation(internal.taskCards.finishUpload, {
        ...card,
        storageId,
        name: args.name,
        size: args.bytes.byteLength,
        category: args.category,
      }),
    );
  },
});
/**
 * Deletes one evidence file from an open, unsigned job card, and its stored
 * file once nothing else uses it. Writes a "taskCard.evidence_removed"
 * change-log row.
 *
 * @throws {ConvexError} The refusals of checkContext, first; "Evidence not
 *   found.", also for evidence the caller cannot read; as authorized;
 *   "Evidence can be deleted only from an open, unsigned job card."
 */
export const removeEvidence = mutation({
  args: { id: v.id("taskEvidence"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await taskState(ctx, args.programUuid);
    const file = await ctx.db.get(args.id);
    const t = file && s.taskCards.find((t) => t.uuid === file.taskCardUuid);
    // One refusal for evidence that is gone or out of the caller's sight, so
    // an id never tells that another program's evidence exists (review T4).
    if (!file || !t || !can(s, t.aircraftUuid, "read"))
      throw new ConvexError(NO_EVIDENCE);
    await authorized(ctx, t.aircraftUuid, "maintenance", s);
    if (!evidenceRemovable(s, t))
      throw new ConvexError(
        "Evidence can be deleted only from an open, unsigned job card.",
      );
    await ctx.db.delete(file._id);
    await deleteBlobIfUnused(ctx, file.storageId);
    await audit(ctx, s.user.id, "taskCard.evidence_removed", t.uuid, {
      aircraftUuid: t.aircraftUuid,
      before: { name: file.name, category: file.category },
    });
  },
});

// Archived cards are read-only; a card is saved only within the program.
async function loadCard(
  ctx: MutationCtx,
  state: ProgramContext,
  command: TaskCardCommand,
) {
  const { snapshot, docs } = await hydrate(ctx, state, [
    "taskCards",
    "workOrders",
    "inspections",
    "discrepancies",
    "management",
  ]);
  const archived = await ctx.db
    .query("archivedTaskCards")
    .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
    .unique();
  if (archived) throw new ConvexError("Archived job cards are read-only.");
  return { snapshot, docs: docs.taskCards };
}

// The caller's program with its job cards, work orders, inspections, problem
// reports and records, for the evidence functions.
async function taskState(ctx: QueryCtx | MutationCtx, programUuid?: string) {
  const state = await checkContext(ctx, programUuid);
  const management = await managementDocs(ctx, programUuid);
  return {
    ...state,
    taskCards: decode("taskCards", await taskCardDocs(ctx, state.aircraft)),
    workOrders: decode("workOrders", await workOrderDocs(ctx, state.aircraft)),
    inspections: await inspectionDocs(ctx, state.aircraft, management),
    discrepancies: await discrepancyDocs(ctx, state.aircraft),
    management: decode("management", management),
  };
}
