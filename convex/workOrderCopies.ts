/**
 * Responsibility: Copies an aircraft's job-card templates onto a work order in
 *   scheduled batches, and shows and resumes the copy's progress.
 * Layer: Server. A helper for workOrders.save, internal batch workers and one
 *   public mutation; maintenance permission writes.
 * Dependencies: convex/access, convex/programContext, convex/collections,
 *   src/domain (model, taskCards, workOrders, workOrderCards).
 *
 * A work order can name hundreds of templates, more than one mutation may
 * write, so the request captures them and scheduled batches copy them.
 */
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { audit } from "./access";
import { checkContext } from "./programContext";
import { encode } from "./collections";
import { can, type Snapshot } from "../src/domain/model";
import {
  copyTemplateSteps,
  isTaskTemplate,
  taskCardSchema,
  type TaskCard,
} from "../src/domain/taskCards";
import {
  isOpenWorkOrder,
  workOrderSchema,
  type WorkOrder,
  type WorkTask,
} from "../src/domain/workOrders";
import { taskCardMatchesWorkItem } from "../src/domain/workOrderCards";

// Copies per scheduled mutation, and the template text one stored batch may
// hold, well under Convex's 1 MiB document limit. A larger template still gets
// a batch of its own.
const BATCH_SIZE = 10;
const BATCH_BYTES = 400_000;

type Job = Doc<"workOrderCopyJobs">;
type CardCopy = Doc<"workOrderCopyBatches">["cards"][number];
type CopyTarget = { job: Job; order: WorkOrder; now: number; index: number };

const batchArgs = { jobId: v.id("workOrderCopyJobs"), batch: v.number() };

/**
 * Captures the templates of the work items `order` adds and schedules their
 * copy. Selection reads only this aircraft's cards, in this transaction; the
 * worker parses each card later.
 *
 * @param ctx - Mutation context; stores the job and its batches.
 * @param order - The work order about to be saved.
 * @param previous - The order as stored, or undefined to copy for every item.
 * @param state - The caller's snapshot; its user authors the copies.
 * @returns `order` when no item is added; otherwise `order` with a running
 *   `templateCopy`, or none when no template is left to copy.
 * @throws {ConvexError} "Add and prepare job cards before closing this work
 *   order." for a closed order with templates to copy.
 */
export async function queueTemplateCopies(
  ctx: MutationCtx,
  order: WorkOrder,
  previous: WorkOrder | undefined,
  state: Snapshot,
) {
  const added = order.tasks.filter(
    (t) =>
      t.status !== "cancelled" &&
      !previous?.tasks.some((p) => p.uuid === t.uuid),
  );
  if (!added.length) return order;
  const selected = await selectTemplates(ctx, order, added);
  if (!selected.length) return { ...order, templateCopy: undefined };
  if (!isOpenWorkOrder(order))
    throw new ConvexError(
      "Add and prepare job cards before closing this work order.",
    );
  const jobId = await startJob(ctx, order, state, selected);
  return {
    ...order,
    templateCopy: {
      jobId,
      status: "running" as const,
      completed: 0,
      total: selected.length,
    },
  };
}

/**
 * Copies one stored batch as draft job cards on the work order, audits each
 * `taskCard.created_from_template`, and schedules the next batch. Any throw
 * rolls the whole batch back for {@link run} to report.
 *
 * @param jobId - The copy job.
 * @param batch - The batch; ignored unless it is a running job's next one.
 * @throws {ConvexError} "Work order not found."
 * @throws {Error} "Work order is unavailable for preparation." for a closed
 *   order or one copying for another job; "Template snapshot batch is
 *   missing."; a ZodError for a stored template that no longer parses.
 */
export const processBatch = internalMutation({
  args: batchArgs,
  handler: async (ctx, { jobId, batch }) => {
    const job = await ctx.db.get(jobId);
    // Duplicate deliveries and old workers after a resume are harmless.
    if (!job || job.status !== "running" || job.batch !== batch) return;
    const doc = await orderDocument(ctx, job.workOrderUuid);
    const order = workOrderSchema.parse(JSON.parse(doc.payload));
    if (!isOpenWorkOrder(order) || order.templateCopy?.jobId !== jobId)
      throw new Error("Work order is unavailable for preparation.");
    const chunk = await ctx.db
      .query("workOrderCopyBatches")
      .withIndex("jobBatch", (q) => q.eq("jobId", jobId).eq("batch", batch))
      .unique();
    if (!chunk) throw new Error("Template snapshot batch is missing.");
    const now = Date.now();
    for (const [index, entry] of chunk.cards.entries())
      await insertCopy(ctx, entry, { job, order, now, index });
    await advanceJob(ctx, job, chunk.cards.length);
    // A committed batch cannot be replayed; discard its stored template
    // payloads.
    await ctx.db.delete(chunk._id);
  },
});

/**
 * Marks a copy job failed, with the message its work order shows, unless the
 * job has finished, been resumed or moved past `batch`.
 *
 * @param error - The message for the work order.
 * @throws {ConvexError} "Work order not found."
 * @throws {Error} "Preparation job no longer matches the work order."
 */
export const fail = internalMutation({
  args: { ...batchArgs, error: v.string() },
  handler: async (ctx, { jobId, batch, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running" || job.batch !== batch) return;
    await ctx.db.patch(jobId, { status: "failed", error });
    await publishProgress(ctx, { ...job, status: "failed", error });
  },
});

/**
 * Runs one batch. On any failure, an execution timeout included, it logs the
 * cause and marks the job failed with a message asking the user to resume;
 * the failed batch has rolled back, so resuming repeats it whole.
 *
 * @param jobId - The copy job.
 * @param batch - The batch to run.
 */
export const run = internalAction({
  args: batchArgs,
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.workOrderCopies.processBatch, args);
    } catch (error) {
      console.error("Work order preparation failed", args.jobId, error);
      await ctx.runMutation(internal.workOrderCopies.fail, {
        ...args,
        error:
          "Job card preparation stopped. Resume to retry the remaining cards. If it fails again, contact support.",
      });
    }
  },
});

/**
 * Restarts a work order's unfinished template copy from the batch it stopped
 * at, and audits `workOrder.resumeTemplates`. Does nothing without an
 * unfinished copy, or while its worker is still queued or running.
 *
 * @param workOrderUuid - The work order.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} "Work order not found."; "Work order maintenance access
 *   denied."; "This work order is closed."
 * @throws As `checkContext`, first.
 */
export const resume = mutation({
  args: { workOrderUuid: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = await checkContext(ctx, args.programUuid);
    const doc = await orderDocument(ctx, args.workOrderUuid);
    const order = workOrderSchema.parse(JSON.parse(doc.payload));
    if (!can(state, order.aircraftUuid, "maintenance"))
      throw new ConvexError("Work order maintenance access denied.");
    const jobs = await ctx.db
      .query("workOrderCopyJobs")
      .withIndex("workOrder", (q) => q.eq("workOrderUuid", order.uuid))
      .collect();
    const job = jobs.find((j) => j._id === order.templateCopy?.jobId);
    if (!job || job.status === "completed") return;
    if (!isOpenWorkOrder(order))
      throw new ConvexError("This work order is closed.");
    if (job.status === "running" && (await isWorkerQueued(ctx, job))) return;
    const scheduledId = await ctx.scheduler.runAfter(
      0,
      internal.workOrderCopies.run,
      { jobId: job._id, batch: job.batch },
    );
    const restarted = { status: "running" as const, error: undefined };
    await ctx.db.patch(job._id, { ...restarted, scheduledId });
    await publishProgress(ctx, { ...job, ...restarted, scheduledId });
    await audit(ctx, state.user.id, "workOrder.resumeTemplates", order.uuid, {
      aircraftUuid: order.aircraftUuid,
    });
  },
});

async function orderDocument(ctx: MutationCtx, uuid: string) {
  const doc = await ctx.db
    .query("workOrders")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  if (!doc) throw new ConvexError("Work order not found.");
  return doc;
}

// A template already copied to this order is not copied again.
async function selectTemplates(
  ctx: MutationCtx,
  order: WorkOrder,
  added: WorkTask[],
): Promise<CardCopy[]> {
  const documents = await ctx.db
    .query("taskCards")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", order.aircraftUuid))
    .collect();
  const cards = documents.map((d) => ({
    payload: d.payload,
    card: JSON.parse(d.payload) as TaskCard,
  }));
  const copied = new Set(
    cards
      .filter(({ card }) => card.workOrderUuid === order.uuid)
      .map(({ card }) => card.sourceTaskCardUuid),
  );
  return cards.flatMap(({ payload, card }) => {
    const item = added.find((t) => taskCardMatchesWorkItem(card, t));
    return item &&
      isTaskTemplate(card) &&
      card.status !== "canceled" &&
      !copied.has(card.uuid)
      ? [{ payload, uuid: crypto.randomUUID(), workTaskUuid: item.uuid }]
      : [];
  });
}

async function startJob(
  ctx: MutationCtx,
  order: WorkOrder,
  state: Snapshot,
  cards: CardCopy[],
): Promise<Id<"workOrderCopyJobs">> {
  const jobId = await ctx.db.insert("workOrderCopyJobs", {
    uuid: crypto.randomUUID(),
    workOrderUuid: order.uuid,
    aircraftUuid: order.aircraftUuid,
    actorId: state.user.id,
    programUuid: state.aircraft.find((a) => a.uuid === order.aircraftUuid)
      ?.programUuid,
    status: "running",
    completed: 0,
    total: cards.length,
    batch: 0,
  });
  await storeBatches(ctx, jobId, cards);
  const scheduledId = await ctx.scheduler.runAfter(
    0,
    internal.workOrderCopies.run,
    { jobId, batch: 0 },
  );
  await ctx.db.patch(jobId, { scheduledId });
  return jobId;
}

async function storeBatches(
  ctx: MutationCtx,
  jobId: Id<"workOrderCopyJobs">,
  cards: CardCopy[],
): Promise<void> {
  let batch = 0;
  let pending: CardCopy[] = [];
  let bytes = 0;
  for (const card of cards) {
    const size = new TextEncoder().encode(card.payload).length;
    if (
      pending.length &&
      (pending.length >= BATCH_SIZE || bytes + size > BATCH_BYTES)
    ) {
      await ctx.db.insert("workOrderCopyBatches", {
        jobId,
        batch: batch++,
        cards: pending,
      });
      pending = [];
      bytes = 0;
    }
    pending.push(card);
    bytes += size;
  }
  if (pending.length)
    await ctx.db.insert("workOrderCopyBatches", {
      jobId,
      batch,
      cards: pending,
    });
}

async function insertCopy(
  ctx: MutationCtx,
  entry: CardCopy,
  target: CopyTarget,
): Promise<void> {
  const { job, order } = target;
  const original = taskCardSchema.parse(JSON.parse(entry.payload));
  const copy = draftCopy(original, entry, target);
  await ctx.db.insert("taskCards", encode("taskCards", copy));
  await audit(ctx, job.actorId, "taskCard.created_from_template", copy.uuid, {
    programUuid: job.programUuid,
    aircraftUuid: job.aircraftUuid,
    reason: `Copied ${original.cardNumber} version ${original.version} to ${order.number}.`,
    after: copy,
  });
}

// A copy keeps the template's instructions and drops all of its work: a new
// unsigned draft linked to the order and to the template version it copies.
function draftCopy(
  original: TaskCard,
  entry: CardCopy,
  { job, order, now, index }: CopyTarget,
): TaskCard {
  return taskCardSchema.parse({
    ...original,
    uuid: entry.uuid,
    version: 1,
    cardNumber: `TC-${job.uuid}-${job.completed + index + 1}`,
    workOrderUuid: order.uuid,
    workTaskUuid: entry.workTaskUuid,
    sourceTaskCardUuid: original.uuid,
    sourceTaskCardVersion: original.version,
    status: "draft",
    assignedTechnician: "",
    findings: "",
    actualWork: "",
    measurements: "",
    actualLabor: null,
    completionDate: "",
    partsUsed: [],
    prerequisiteUuids: [],
    functionalTestOutcome: original.functionalTestRequired
      ? "pending"
      : "not-required",
    functionalTestResults: "",
    steps: copyTemplateSteps(original.steps),
    technicianSignoff: null,
    inspectionSignoff: null,
    stepSignoffs: {},
    createdAt: now,
    updatedAt: now,
    createdBy: job.actorId,
  });
}

async function advanceJob(ctx: MutationCtx, job: Job, copied: number) {
  const completed = job.completed + copied;
  const status =
    completed === job.total ? ("completed" as const) : ("running" as const);
  const batch = job.batch + 1;
  const scheduledId =
    status === "running"
      ? await ctx.scheduler.runAfter(0, internal.workOrderCopies.run, {
          jobId: job._id,
          batch,
        })
      : undefined;
  const progress = { completed, status, batch, scheduledId, error: undefined };
  await ctx.db.patch(job._id, progress);
  await publishProgress(ctx, { ...job, ...progress });
}

async function publishProgress(ctx: MutationCtx, job: Job) {
  const doc = await orderDocument(ctx, job.workOrderUuid);
  const order = workOrderSchema.parse(JSON.parse(doc.payload));
  if (order.templateCopy?.jobId !== job._id)
    throw new Error("Preparation job no longer matches the work order.");
  await ctx.db.patch(
    doc._id,
    encode("workOrders", {
      ...order,
      version: order.version + 1,
      templateCopy: {
        jobId: job._id,
        status: job.status,
        completed: job.completed,
        total: job.total,
        error: job.error,
      },
    }),
  );
}

async function isWorkerQueued(ctx: MutationCtx, job: Job): Promise<boolean> {
  if (!job.scheduledId) return false;
  const scheduled = await ctx.db.system.get(job.scheduledId);
  return (
    !!scheduled && ["pending", "inProgress"].includes(scheduled.state.kind)
  );
}
