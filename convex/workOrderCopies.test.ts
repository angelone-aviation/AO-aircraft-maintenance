/**
 * Responsibility: Pins template copying onto work orders: bounded batches,
 *   captured contents, refusals, failure and resume without duplicates.
 * Layer: Test. convex-test suite with fake timers; never shipped in the build.
 * Dependencies: convex/workOrderCopies, convex/workOrders, convex/schema,
 *   src/domain (taskCards, workOrders), src/data/demo and tests/fixtures.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { workOrderCommand } from "../tests/fixtures/workOrders";
import { taskCardCommand } from "../tests/fixtures/taskCards";
import { saveTaskCard } from "../src/domain/taskCards";
import { newWorkTask, workOrderSchema } from "../src/domain/workOrders";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function setup(count = 25) {
  const t = convexTest(schema, modules);
  const s = demoSnapshot();
  const templateCommand = taskCardCommand();
  templateCommand.fields.inspectionUuid = s.inspections[0].uuid;
  const original = saveTaskCard(s, templateCommand);
  const subject = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    for (const inspection of s.inspections)
      await ctx.db.insert("inspections", inspection);
    const userId = await ctx.db.insert("users", {
      name: "Maintainer",
      active: true,
      isAdmin: true,
    });
    const session = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86400000,
    });
    for (let i = 0; i < count; i++) {
      const card = {
        ...original,
        uuid: crypto.randomUUID(),
        title: `Template ${i}`,
        cardNumber: `TEST-${i}`,
      };
      await ctx.db.insert("taskCards", {
        uuid: card.uuid,
        aircraftUuid: card.aircraftUuid,
        payload: JSON.stringify(card),
      });
    }
    return `${userId}|${session}`;
  });
  const user = t.withIdentity({ subject });
  const command = workOrderCommand();
  await user.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(command),
  });
  const add = {
    action: "add",
    uuid: command.uuid,
    version: 1,
    source: { kind: "inspection", uuid: s.inspections[0].uuid },
  };
  const start = () =>
    user.mutation(api.workOrders.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(add),
    });
  const read = () =>
    t.run(async (ctx) => ({
      jobs: await ctx.db.query("workOrderCopyJobs").collect(),
      cards: (await ctx.db.query("taskCards").collect()).map((d) =>
        JSON.parse(d.payload),
      ),
      order: workOrderSchema.parse(
        JSON.parse(
          (await ctx.db
            .query("workOrders")
            .withIndex("uuid", (q) => q.eq("uuid", command.uuid))
            .unique())!.payload,
        ),
      ),
      audits: await ctx.db.query("audit").collect(),
    }));
  return { t, user, original, command, add, start, read };
}
it("queues 450 templates, uses bounded batches, and ignores duplicate deliveries", async () => {
  const { t, start, read } = await setup(450);
  await start();
  let state = await read();
  expect(state.order.templateCopy).toMatchObject({
    status: "running",
    total: 450,
    completed: 0,
  });
  expect(state.cards.filter((c) => c.workOrderUuid)).toHaveLength(0);
  const jobId = state.jobs[0]._id;
  await t.mutation(internal.workOrderCopies.processBatch, { jobId, batch: 0 });
  await t.mutation(internal.workOrderCopies.processBatch, { jobId, batch: 0 });
  state = await read();
  expect(state.cards.filter((c) => c.workOrderUuid)).toHaveLength(10);
  expect(state.order.templateCopy?.completed).toBe(10);
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  state = await read();
  const copies = state.cards.filter((c) => c.workOrderUuid);
  expect(copies).toHaveLength(450);
  expect(new Set(copies.map((c) => c.sourceTaskCardUuid)).size).toBe(450);
  expect(new Set(copies.map((c) => c.cardNumber)).size).toBe(450);
  expect(
    state.audits.filter((a) => a.action === "taskCard.created_from_template"),
  ).toHaveLength(450);
  expect(state.order.templateCopy).toMatchObject({
    status: "completed",
    completed: 450,
  });
  expect(
    await t.run((ctx) => ctx.db.query("workOrderCopyBatches").collect()),
  ).toHaveLength(0);
}, 20000);
it("retains captured template contents and versions when templates change or disappear", async () => {
  const { t, start, read } = await setup(2);
  await start();
  const originals = (await read()).cards;
  await t.run(async (ctx) => {
    const docs = await ctx.db.query("taskCards").collect();
    await ctx.db.patch(docs[0]._id, {
      payload: JSON.stringify({
        ...JSON.parse(docs[0].payload),
        version: 50,
        title: "Edited after request",
      }),
    });
    await ctx.db.delete(docs[1]._id);
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const copies = (await read()).cards.filter((c) => c.workOrderUuid);
  expect(copies).toHaveLength(2);
  for (const copy of copies) {
    const original = originals.find((o) => o.uuid === copy.sourceTaskCardUuid);
    expect(copy.title).toBe(original.title);
    expect(copy.sourceTaskCardVersion).toBe(original.version);
    expect(copy.technicianSignoff).toBeNull();
    expect(copy.steps[0].uuid).not.toBe(original.steps[0].uuid);
    expect(copy.steps[0].result).toBe("");
    // Legacy template steps stay readable but are not signoff points.
    expect(original.steps[0].signoffRequired).toBe(true);
    expect(copy.steps[0]).toMatchObject({
      instruction: original.steps[0].instruction,
      signoffRequired: false,
    });
  }
});
it("blocks edits and closeout while incomplete, then resumes a failed batch without duplicating cards", async () => {
  const { t, user, command, start, read } = await setup();
  await start();
  const jobId = (await read()).jobs[0]._id;
  await t.mutation(internal.workOrderCopies.processBatch, { jobId, batch: 0 });
  // Damage a stored batch to exercise the actual action failure/rollback path.
  const damaged = await t.run(async (ctx) => {
    const doc = await ctx.db
      .query("workOrderCopyBatches")
      .withIndex("jobBatch", (q) => q.eq("jobId", jobId).eq("batch", 1))
      .unique();
    const cards = doc!.cards.map((c, i) =>
      i === 2 ? { ...c, payload: "{}" } : c,
    );
    await ctx.db.patch(doc!._id, { cards });
    return doc!;
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  let state = await read();
  expect(state.order.templateCopy).toMatchObject({
    status: "failed",
    completed: 10,
    error:
      "Job card preparation stopped. Resume to retry the remaining cards. If it fails again, contact support.",
  });
  expect(state.cards.filter((c) => c.workOrderUuid)).toHaveLength(10);
  for (const status of ["open", "cancelled", "completed"]) {
    await expect(
      user.mutation(api.workOrders.save, {
        programUuid: "demo-program",
        payload: JSON.stringify({
          ...command,
          version: state.order.version,
          fields: { ...command.fields, status },
          tasks: state.order.tasks,
        }),
      }),
    ).rejects.toThrow("prepared");
  }
  await expect(
    t.mutation(api.workOrderCopies.resume, {
      programUuid: "demo-program",
      workOrderUuid: command.uuid,
    }),
  ).rejects.toThrow();
  await t.run((ctx) => ctx.db.patch(damaged._id, { cards: damaged.cards }));
  await user.mutation(api.workOrderCopies.resume, {
    programUuid: "demo-program",
    workOrderUuid: command.uuid,
  });
  await user.mutation(api.workOrderCopies.resume, {
    programUuid: "demo-program",
    workOrderUuid: command.uuid,
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  state = await read();
  expect(state.cards.filter((c) => c.workOrderUuid)).toHaveLength(25);
  expect(state.order.templateCopy).toMatchObject({
    status: "completed",
    completed: 25,
  });
});
it("rejects duplicate requests, wrong programs and unauthenticated requests; recopy skips existing copies", async () => {
  const { t, user, add, command, start, read } = await setup(2);
  await expect(
    t.mutation(api.workOrders.save, {
      payload: JSON.stringify(add),
      programUuid: "demo-program",
    }),
  ).rejects.toThrow();
  await expect(
    user.mutation(api.workOrders.save, {
      payload: JSON.stringify(add),
      programUuid: "wrong",
    }),
  ).rejects.toThrow("Program changed");
  await start();
  await expect(start()).rejects.toThrow("prepared");
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  let state = await read();
  await user.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "copyTemplates",
      uuid: command.uuid,
      version: state.order.version,
    }),
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  state = await read();
  expect(state.jobs).toHaveLength(1);
  expect(state.cards.filter((c) => c.workOrderUuid)).toHaveLength(2);
});

it("adds inspections with no templates immediately and rejects cross-aircraft inspection links", async () => {
  const { t, user, add, start, read } = await setup(0);
  await t.run(async (ctx) => {
    const other = demoSnapshot().inspections[0];
    await ctx.db.insert("inspections", {
      ...other,
      uuid: "other-aircraft-inspection",
      aircraftUuid: demoSnapshot().aircraft[1].uuid,
    });
  });
  await expect(
    user.mutation(api.workOrders.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...add,
        source: { kind: "inspection", uuid: "other-aircraft-inspection" },
      }),
    }),
  ).rejects.toThrow("unavailable");
  await start();
  const state = await read();
  expect(state.order.tasks).toHaveLength(1);
  expect(state.order.templateCopy).toBeUndefined();
  expect(state.jobs).toHaveLength(0);
  await expect(start()).rejects.toThrow(
    "Work order changed. Reopen it before saving.",
  );
  await expect(
    user.mutation(api.workOrders.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ ...add, version: state.order.version }),
    }),
  ).rejects.toThrow("This item is already on the work order.");
});

it("refuses to close a work order that adds items with templates to copy", async () => {
  const { user, command, add, read } = await setup(2);
  await expect(
    user.mutation(api.workOrders.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        ...command,
        version: 1,
        fields: { ...command.fields, status: "cancelled" },
        tasks: [
          newWorkTask({ kind: "inspection", uuid: add.source.uuid }, "Annual"),
        ],
      }),
    }),
  ).rejects.toThrow(
    "Add and prepare job cards before closing this work order.",
  );
  expect((await read()).jobs).toHaveLength(0);
});

it("caps each stored batch's template text, giving a larger template a batch of its own", async () => {
  const { t, original, start, read } = await setup(0);
  const longStep = { ...original.steps[0], instruction: "x".repeat(10_000) };
  await t.run(async (ctx) => {
    for (const [i, steps] of [15, 15, 45, 15].entries()) {
      const card = {
        ...original,
        uuid: crypto.randomUUID(),
        cardNumber: `LARGE-${i}`,
        steps: Array.from({ length: steps }, () => ({
          ...longStep,
          uuid: crypto.randomUUID(),
        })),
      };
      await ctx.db.insert("taskCards", {
        uuid: card.uuid,
        aircraftUuid: card.aircraftUuid,
        payload: JSON.stringify(card),
      });
    }
  });
  await start();
  const batches = await t.run((ctx) =>
    ctx.db.query("workOrderCopyBatches").collect(),
  );
  expect(
    batches.sort((a, b) => a.batch - b.batch).map((b) => b.cards.length),
  ).toEqual([2, 1, 1]);
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect((await read()).cards.filter((c) => c.workOrderUuid)).toHaveLength(4);
});
it("allows a maintainer to recover a canceled scheduled worker, and ignores a resume while it is queued or after it finishes", async () => {
  const { t, user, command, start, read } = await setup(12);
  await start();
  const job = (await read()).jobs[0];
  await t.run((ctx) => ctx.scheduler.cancel(job.scheduledId!));
  const resume = () =>
    user.mutation(api.workOrderCopies.resume, {
      programUuid: "demo-program",
      workOrderUuid: command.uuid,
    });
  await resume();
  await resume();
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  await resume();
  const state = await read();
  expect(
    state.audits.filter((a) => a.action === "workOrder.resumeTemplates"),
  ).toHaveLength(1);
  expect(state.order.templateCopy).toMatchObject({
    status: "completed",
    completed: 12,
  });
  expect(state.cards.filter((c) => c.workOrderUuid)).toHaveLength(12);
});
