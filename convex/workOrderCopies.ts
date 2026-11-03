import { prepareRecurringParts } from "./recurringParts";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { audit } from "./access";
import { checkContext } from "./programContext";
import { can, type Snapshot } from "../src/domain/model";
import {
  copyTemplateSteps,
  isTaskTemplate,
  taskCardSchema,
  type TaskCard,
} from "../src/domain/taskCards";
import {
  isOpenWorkOrder,
  newWorkTask,
  workOrderSchema,
  type WorkOrder,
  type WorkOrderCommand,
} from "../src/domain/workOrders";
import { taskCardMatchesWorkItem } from "../src/domain/workOrderCards";

const BATCH_SIZE = 10;
const preparing =
  "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.";

async function orderDocument(ctx: MutationCtx, uuid: string) {
  const doc = await ctx.db
    .query("workOrders")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  if (!doc) throw new ConvexError("Work order not found.");
  return doc;
}

// Snapshot selection is linear, aircraft-scoped, and transactional. Only the
// worker validates/copies individual cards; it never loads the card collection.
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
  const selected = cards.flatMap(({ payload, card }) => {
    const item = added.find((t) => taskCardMatchesWorkItem(card, t));
    return item &&
      isTaskTemplate(card) &&
      card.status !== "canceled" &&
      !copied.has(card.uuid)
      ? [{ payload, uuid: crypto.randomUUID(), workTaskUuid: item.uuid }]
      : [];
  });
  if (!selected.length) return { ...order, templateCopy: undefined };
  if (!isOpenWorkOrder(order))
    throw new ConvexError(
      "Add and prepare job cards before closing this work order.",
    );
  const jobId = await ctx.db.insert("workOrderCopyJobs", {
    uuid: crypto.randomUUID(),
    workOrderUuid: order.uuid,
    aircraftUuid: order.aircraftUuid,
    actorId: state.user.id,
    programUuid: state.aircraft.find((a) => a.uuid === order.aircraftUuid)
      ?.programUuid,
    status: "running",
    completed: 0,
    total: selected.length,
    batch: 0,
  });
  // Limit both card count and stored document size, including unusually large templates.
  let batch = 0;
  let pending: typeof selected = [];
  let bytes = 0;
  for (const card of selected) {
    const size = new TextEncoder().encode(card.payload).length;
    if (
      pending.length &&
      (pending.length >= BATCH_SIZE || bytes + size > 400_000)
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
  const scheduledId = await ctx.scheduler.runAfter(
    0,
    internal.workOrderCopies.run,
    { jobId, batch: 0 },
  );
  await ctx.db.patch(jobId, { scheduledId });
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

// Fast path for the inspection dialog and the "missing templates" action.
export async function startCopy(
  ctx: MutationCtx,
  state: Snapshot,
  command: WorkOrderCommand,
) {
  const doc = await orderDocument(ctx, command.uuid);
  const before = workOrderSchema.parse(JSON.parse(doc.payload));
  if (!can(state, before.aircraftUuid, "maintenance"))
    throw new ConvexError("Work order maintenance access denied.");
  if (!isOpenWorkOrder(before))
    throw new ConvexError("This work order is closed.");
  if (before.templateCopy && before.templateCopy.status !== "completed")
    throw new ConvexError(preparing);
  if (before.version !== command.version)
    throw new ConvexError("Work order changed. Reopen it before saving.");
  let next = { ...before, version: before.version + 1 };
  if (command.action === "add" && command.source.kind === "inspection") {
    const inspection = await ctx.db
      .query("inspections")
      .withIndex("uuid", (q) => q.eq("uuid", command.source.uuid))
      .unique();
    if (
      !inspection ||
      inspection.archived ||
      inspection.aircraftUuid !== before.aircraftUuid
    )
      throw new ConvexError("Work item is unavailable for this aircraft.");
    if (
      before.tasks.some(
        (t) =>
          t.source.kind === "inspection" && t.source.uuid === inspection.uuid,
      )
    )
      throw new ConvexError("This item is already on the work order.");
    next.tasks = [
      ...before.tasks,
      newWorkTask(
        command.source,
        `${inspection.reference}: ${inspection.description}`,
      ),
    ];
  } else if (command.action !== "copyTemplates")
    throw new Error("Unsupported copy command.");
  next = workOrderSchema.parse(next);
  next = await queueTemplateCopies(
    ctx,
    next,
    command.action === "copyTemplates" ? undefined : before,
    state,
  );
  await prepareRecurringParts(ctx, state, next);
  await ctx.db.patch(doc._id, { payload: JSON.stringify(next) });
  await audit(ctx, state.user.id, "workOrder." + command.action, next.uuid, {
    aircraftUuid: next.aircraftUuid,
    before,
    after: next,
  });
  return next.uuid;
}

const batchArgs = { jobId: v.id("workOrderCopyJobs"), batch: v.number() };
async function publishProgress(
  ctx: MutationCtx,
  job: Doc<"workOrderCopyJobs">,
) {
  const doc = await orderDocument(ctx, job.workOrderUuid);
  const order = workOrderSchema.parse(JSON.parse(doc.payload));
  if (order.templateCopy?.jobId !== job._id)
    throw new Error("Preparation job no longer matches the work order.");
  await ctx.db.patch(doc._id, {
    payload: JSON.stringify({
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
  });
}

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
    for (const [index, entry] of chunk.cards.entries()) {
      const original = taskCardSchema.parse(JSON.parse(entry.payload));
      const copy = taskCardSchema.parse({
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
      await ctx.db.insert("taskCards", {
        uuid: copy.uuid,
        aircraftUuid: copy.aircraftUuid,
        payload: JSON.stringify(copy),
      });
      await audit(
        ctx,
        job.actorId,
        "taskCard.created_from_template",
        copy.uuid,
        {
          programUuid: job.programUuid,
          aircraftUuid: job.aircraftUuid,
          reason: `Copied ${original.cardNumber} version ${original.version} to ${order.number}.`,
          after: copy,
        },
      );
    }
    const completed = job.completed + chunk.cards.length;
    const status =
      completed === job.total ? ("completed" as const) : ("running" as const);
    const scheduledId =
      status === "running"
        ? await ctx.scheduler.runAfter(0, internal.workOrderCopies.run, {
            jobId,
            batch: batch + 1,
          })
        : undefined;
    const next = {
      ...job,
      completed,
      status,
      batch: batch + 1,
      scheduledId,
      error: undefined,
    };
    await ctx.db.patch(jobId, {
      completed,
      status,
      batch: next.batch,
      scheduledId,
      error: undefined,
    });
    await publishProgress(ctx, next);
    // A committed batch cannot be replayed; discard its stored template payloads.
    await ctx.db.delete(chunk._id);
  },
});

export const fail = internalMutation({
  args: { ...batchArgs, error: v.string() },
  handler: async (ctx, { jobId, batch, error }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.status !== "running" || job.batch !== batch) return;
    await ctx.db.patch(jobId, { status: "failed", error });
    await publishProgress(ctx, { ...job, status: "failed", error });
  },
});

// An action catches mutation failures (including execution timeouts); the failed
// mutation rolls back all cards and progress for that batch before this runs.
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
    if (job.status === "running" && job.scheduledId) {
      const scheduled = await ctx.db.system.get(job.scheduledId);
      if (scheduled && ["pending", "inProgress"].includes(scheduled.state.kind))
        return;
    }
    const scheduledId = await ctx.scheduler.runAfter(
      0,
      internal.workOrderCopies.run,
      { jobId: job._id, batch: job.batch },
    );
    await ctx.db.patch(job._id, {
      status: "running",
      error: undefined,
      scheduledId,
    });
    await publishProgress(ctx, {
      ...job,
      status: "running",
      error: undefined,
      scheduledId,
    });
    await audit(ctx, state.user.id, "workOrder.resumeTemplates", order.uuid, {
      aircraftUuid: order.aircraftUuid,
    });
  },
});
