/**
 * Responsibility: Pins work orders on the server: saving, close-out,
 *   revisions, component corrections, job-card copies and archiving, the
 *   attachments of an open order, and the refusals users see.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/workOrders.ts, convex/admin.ts, convex/taskCards.ts,
 *   convex/schema.ts, src/domain/workOrders.ts, src/data/demo.ts,
 *   tests/fixtures (workOrders, taskCards).
 */
import { convexTest } from "convex-test";
import { it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { MAX_ATTACHMENTS } from "./attachments";
import {
  workOrderComponent,
  workOrderCommand,
} from "../tests/fixtures/workOrders";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const HOUR_SECONDS = 3600;
const DAY_MS = 86_400_000;
const PDF = new TextEncoder().encode("%PDF-1.4 test").buffer;

afterEach(() => vi.useRealTimers());

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Seeds the demo fleet, program and inspections, with a technician (read and
 * maintenance) and a reader, each in a group for the first aircraft only.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const identities = await t.run(async (ctx) => {
    const s = demoSnapshot();
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    for (const i of s.inspections) await ctx.db.insert("inspections", i);
    const makeUser = async (permissions: ("read" | "maintenance")[]) => {
      const group = await ctx.db.insert("groups", {
        programUuid: PROGRAM,
        name: permissions.join(","),
        aircraftIds: [s.aircraft[0].uuid],
        permissions,
      });
      const user = await ctx.db.insert("users", {
        name: "Tech",
        active: true,
        isAdmin: false,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + DAY_MS,
      });
      return { subject: `${user}|${session}` };
    };
    return {
      tech: await makeUser(["read", "maintenance"]),
      reader: await makeUser(["read"]),
    };
  });
  return {
    t,
    tech: t.withIdentity(identities.tech),
    reader: t.withIdentity(identities.reader),
  };
}
it("persists work orders and audit entries; rejects unauthorized, stale and cross-aircraft writes", async () => {
  const { t, tech, reader } = await fixture();
  const command = workOrderCommand();
  const args = {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  };
  await expect(reader.mutation(api.workOrders.save, args)).rejects.toThrow();
  await expect(t.mutation(api.workOrders.save, args)).rejects.toThrow();
  await tech.mutation(api.workOrders.save, args);
  const snapshot = await tech.query(api.operations.snapshot, {});
  expect(snapshot?.workOrders).toHaveLength(1);
  expect(snapshot?.workOrders?.[0].aircraft.registration).toBe(
    demoSnapshot().aircraft[0].registration,
  );
  expect(snapshot?.audit.some((a) => a.action === "workOrder.save")).toBe(true);
  await expect(tech.mutation(api.workOrders.save, args)).rejects.toThrow(
    "changed",
  );
  await expect(
    tech.mutation(api.workOrders.save, {
      ...args,
      payload: JSON.stringify({
        ...command,
        version: 1,
        fields: {
          ...command.fields,
          aircraftUuid: demoSnapshot().aircraft[1].uuid,
        },
      }),
    }),
  ).rejects.toThrow();
  await expect(
    tech.mutation(api.workOrders.save, { ...args, programUuid: "wrong" }),
  ).rejects.toThrow("Program changed");
});
it("uploads authorized maintenance attachments and prevents uploads after closing", async () => {
  const { tech, reader } = await fixture();
  const command = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });
  const file = {
    programUuid: PROGRAM,
    workOrderUuid: command.uuid,
    name: "maintenance.pdf",
    type: "application/pdf",
    bytes: PDF,
  };
  await expect(reader.action(api.workOrders.upload, file)).rejects.toThrow();
  await tech.action(api.workOrders.upload, file);
  const snapshot = await tech.query(api.operations.snapshot, {});
  expect(snapshot?.workOrderAttachments).toMatchObject([
    { name: "maintenance.pdf", workOrderUuid: command.uuid },
  ]);
  expect(snapshot?.workOrderAttachments?.[0].url).toBeTruthy();
  await tech.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify({
      ...command,
      version: 1,
      fields: { ...command.fields, status: "cancelled" },
    }),
  });
  await expect(tech.action(api.workOrders.upload, file)).rejects.toThrow(
    "closed",
  );
});

it("prepares independent source template copies for each work order and prevents premature item completion", async () => {
  vi.useFakeTimers();
  const { t, tech } = await fixture();
  const { taskCardCommand } = await import("../tests/fixtures/taskCards");
  const task = taskCardCommand();
  task.fields.inspectionUuid = "demo-insp-1";
  await tech.mutation(api.taskCards.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(task),
  });
  const { newWorkTask } = await import("../src/domain/workOrders");
  const first = workOrderCommand();
  first.tasks = [
    newWorkTask({ kind: "inspection", uuid: "demo-insp-1" }, "Inspection"),
  ];
  const args = (command: unknown) => ({
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });
  await tech.mutation(api.workOrders.save, args(first));
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  let snapshot = (await tech.query(api.operations.snapshot))!;
  expect(snapshot.taskCards).toHaveLength(2);
  const copy = snapshot.taskCards!.find((c) => c.workOrderUuid === first.uuid)!;
  expect(copy).toMatchObject({
    sourceTaskCardUuid: task.uuid,
    status: "draft",
    technicianSignoff: null,
  });
  const before = snapshot.workOrders![0];
  await expect(
    tech.mutation(
      api.workOrders.save,
      args({
        ...first,
        version: before.version,
        tasks: before.tasks.map((t) => ({ ...t, status: "completed" })),
      }),
    ),
  ).rejects.toThrow("sign off every");
  const second = workOrderCommand();
  second.tasks = [
    newWorkTask({ kind: "inspection", uuid: "demo-insp-1" }, "Inspection"),
  ];
  await tech.mutation(api.workOrders.save, args(second));
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  snapshot = (await tech.query(api.operations.snapshot))!;
  expect(snapshot.taskCards).toHaveLength(3);
  expect(
    snapshot
      .taskCards!.filter((c) => c.workOrderUuid)
      .every((c) => c.uuid !== task.uuid),
  ).toBe(true);
  expect(
    snapshot.audit.some((a) => a.action === "taskCard.created_from_template"),
  ).toBe(true);
  expect(
    snapshot.workOrders!.find((w) => w.uuid === first.uuid)!.tasks[0].status,
  ).toBe("requested");
});

it("closes an order with atomic compliance persistence and a frozen logbook snapshot using the user's license", async () => {
  const { t, tech, reader } = await fixture();
  const command = workOrderCommand();
  const inspectionId = demoSnapshot().inspections[0].uuid;
  await t.run(async (ctx) => {
    const doc = await ctx.db
      .query("inspections")
      .withIndex("uuid", (q) => q.eq("uuid", inspectionId))
      .unique();
    await ctx.db.patch(doc!._id, {
      intervalSeconds: 100 * HOUR_SECONDS,
      intervalMonths: 12,
      lastDate: "2025-01-01",
    });
  });
  await tech.mutation(api.admin.saveLicense, {
    licenseNumber: "CERT-42",
    certificateType: "A&P",
  });
  const { newWorkTask, workOrderFieldsSchema } =
    await import("../src/domain/workOrders");
  command.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: inspectionId },
      "Routine inspection",
    ),
  ];
  await tech.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });
  const before = (await tech.query(api.operations.snapshot, {}))!;
  const order = before.workOrders![0];
  const completion = {
    ...command,
    version: order.version,
    fields: {
      ...workOrderFieldsSchema.parse(order),
      status: "completed",
      completionDate: today(),
      releaseOutcome: "Recorded disposition",
      finalReview: "Reviewed",
    },
    tasks: order.tasks.map((item) => ({ ...item, status: "completed" })),
  };
  await expect(
    reader.mutation(api.workOrders.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify(completion),
    }),
  ).rejects.toThrow();
  await tech.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(completion),
  });
  const after = (await tech.query(api.operations.snapshot, {}))!;
  const closed = after.workOrders![0];
  expect(closed.closeout!.completedBy).toMatchObject({
    licenseNumber: "CERT-42",
    certificateType: "A&P",
  });
  const inspection = after.inspections.find((i) => i.uuid === inspectionId)!;
  expect(inspection.lastDate).toBe(completion.fields.completionDate);
  expect(inspection.dueSeconds).toBe(
    closed.closeout!.aircraft.totalSeconds + 100 * HOUR_SECONDS,
  );
  expect(
    after.audit.some(
      (a) =>
        a.action === "inspection.complete" && a.entityUuid === inspectionId,
    ),
  ).toBe(true);
  await expect(
    tech.mutation(api.workOrders.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify({ ...completion, version: closed.version }),
    }),
  ).rejects.toThrow("closed");
  expect((await tech.query(api.operations.snapshot, {}))!.inspections).toEqual(
    after.inspections,
  );
});

it("persists personal logbook phrases and rejects invalid or unauthenticated updates", async () => {
  const { t, tech, reader } = await fixture();
  await tech.mutation(api.admin.saveLogbookPhrases, {
    phrases: [" Inspected ", "Operationally checked"],
  });
  expect(
    (await tech.query(api.operations.snapshot, {}))?.user.logbookPhrases,
  ).toEqual(["Inspected", "Operationally checked"]);
  expect(
    (await reader.query(api.operations.snapshot, {}))?.user.logbookPhrases,
  ).toBeUndefined();
  await expect(
    t.mutation(api.admin.saveLogbookPhrases, { phrases: ["Repaired"] }),
  ).rejects.toThrow();
  await expect(
    tech.mutation(api.admin.saveLogbookPhrases, {
      phrases: ["Repaired", "repaired"],
    }),
  ).rejects.toThrow();
  expect(
    (await tech.query(api.operations.snapshot, {}))?.user.logbookPhrases,
  ).toEqual(["Inspected", "Operationally checked"]);
});

it("saves personal release statements and rejects invalid or unauthenticated changes", async () => {
  const { t, tech, reader } = await fixture();
  const statements = [{ label: " Maintenance ", text: " Work reviewed. " }];
  await tech.mutation(api.admin.saveReleaseStatements, { statements });
  expect(
    (await tech.query(api.operations.snapshot, {}))?.user.releaseStatements,
  ).toEqual([{ label: "Maintenance", text: "Work reviewed." }]);
  expect(
    (await reader.query(api.operations.snapshot, {}))?.user.releaseStatements,
  ).toBeUndefined();
  await expect(
    t.mutation(api.admin.saveReleaseStatements, { statements }),
  ).rejects.toThrow();
  await expect(
    tech.mutation(api.admin.saveReleaseStatements, {
      statements: [{ label: "Empty", text: " " }],
    }),
  ).rejects.toThrow();
  await tech.mutation(api.admin.saveReleaseStatements, {
    statements: [
      { label: "Edited", text: "Edited statement." },
      { label: "New", text: "New statement." },
    ],
  });
  expect(
    (await tech.query(api.operations.snapshot, {}))?.user.releaseStatements,
  ).toHaveLength(2);
});

it("commits component resets and movement history with closeout and rejects repeat closure", async () => {
  const { t, tech } = await fixture();
  const component = { ...workOrderComponent(), programUuid: PROGRAM };
  await t.run(async (ctx) => {
    await ctx.db.insert("management", {
      uuid: component.uuid,
      kind: component.kind,
      aircraftUuid: component.aircraftUuid,
      programUuid: component.programUuid,
      payload: JSON.stringify(component),
    });
  });
  const cmd = workOrderCommand();
  cmd.componentUuids = [component.uuid];
  await tech.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(cmd),
  });
  const completion = {
    ...cmd,
    version: 1,
    fields: {
      ...cmd.fields,
      status: "completed",
      completionDate: today(),
      releaseOutcome: "Reviewed",
      finalReview: "Reviewed",
    },
    componentWork: [
      {
        componentUuid: component.uuid,
        version: component.version,
        action: "both",
        description: "Repair and overhaul completed",
        reference: "AMM 72",
      },
    ],
  };
  const args = {
    programUuid: PROGRAM,
    payload: JSON.stringify(completion),
  };
  await tech.mutation(api.workOrders.save, args);
  const after = await tech.query(api.operations.snapshot, {});
  const c = after!.management!.find((r) => r.uuid === component.uuid);
  expect(c).toMatchObject({
    timeSinceOverhaul: 0,
    timeSinceRepair: 0,
    version: component.version + 1,
  });
  expect(
    after!.management!.filter((r) => r.kind === "componentMovement"),
  ).toHaveLength(2);
  expect(after!.workOrders![0].closeout!.componentWork![0]).toMatchObject({
    action: "both",
    reference: "AMM 72",
  });
  await expect(
    tech.mutation(api.workOrders.save, {
      ...args,
      payload: JSON.stringify({ ...completion, version: 2 }),
    }),
  ).rejects.toThrow("closed");
  expect((await tech.query(api.operations.snapshot, {}))!.management).toEqual(
    after!.management,
  );
});

it("persists closed-order revisions and their reasons without changing inspections", async () => {
  const { t, tech, reader } = await fixture();
  const command = workOrderCommand();
  const send = (payload: unknown) =>
    tech.mutation(api.workOrders.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify(payload),
    });
  await send(command);
  await send({
    ...command,
    version: 1,
    fields: {
      ...command.fields,
      status: "completed",
      completionDate: today(),
      releaseOutcome: "Original",
      finalReview: "Reviewed",
    },
  });
  const original = await tech.query(api.operations.snapshot, {});
  const revision = {
    action: "revise",
    uuid: command.uuid,
    version: 2,
    reason: "Typo correction",
    fields: {
      supervisor: "Tech",
      scope: "Corrected scope",
      releaseOutcome: "Corrected release",
      finalReview: "Reviewed correction",
      workPerformed: "Corrected wording",
    },
  };
  await expect(
    reader.mutation(api.workOrders.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify(revision),
    }),
  ).rejects.toThrow();
  await send(revision);
  const result = await tech.query(api.operations.snapshot, {});
  expect(result?.workOrders?.[0].revisions?.[0].reason).toBe("Typo correction");
  expect(result?.workOrders?.[0].closeout).toEqual(
    original?.workOrders?.[0].closeout,
  );
  expect(result?.inspections).toEqual(original?.inspections);
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.find((a) => a.action === "workOrder.revise")?.reason).toBe(
    "Typo correction",
  );
  await expect(send(revision)).rejects.toThrow("changed");
});

it("atomically corrects component tracking, retains original movements and audits the correction", async () => {
  const { t, tech, reader } = await fixture();
  const component = { ...workOrderComponent(), programUuid: PROGRAM };
  await t.run((ctx) =>
    ctx.db.insert("management", {
      uuid: component.uuid,
      programUuid: PROGRAM,
      aircraftUuid: component.aircraftUuid,
      kind: "component",
      payload: JSON.stringify(component),
    }),
  );
  const cmd = workOrderCommand();
  cmd.componentUuids = [component.uuid];
  const send = (payload: unknown) =>
    tech.mutation(api.workOrders.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify(payload),
    });
  await send(cmd);
  await send({
    ...cmd,
    version: 1,
    fields: {
      ...cmd.fields,
      status: "completed",
      completionDate: today(),
      releaseOutcome: "Reviewed",
      finalReview: "Reviewed",
    },
    componentWork: [
      {
        componentUuid: component.uuid,
        version: component.version,
        action: "overhaul",
        description: "Bench work",
        reference: "",
      },
    ],
  });
  const before = (await tech.query(api.operations.snapshot, {}))!;
  const order = before.workOrders![0];
  const current = before.management!.find((r) => r.uuid === component.uuid)!;
  const correction = {
    action: "correctComponent",
    uuid: order.uuid,
    version: order.version,
    aircraftVersion: before.aircraft.find(
      (a) => a.uuid === component.aircraftUuid,
    )!.version,
    reason: "Repair was performed, not overhaul",
    choice: {
      componentUuid: component.uuid,
      version: current.version,
      action: "repair",
      description: "Bench repair",
      reference: "",
    },
  };
  await expect(
    reader.mutation(api.workOrders.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify(correction),
    }),
  ).rejects.toThrow();
  await send(correction);
  const after = (await tech.query(api.operations.snapshot, {}))!;
  expect(after.workOrders![0].closeout).toEqual(order.closeout);
  expect(after.workOrders![0].componentCorrections).toHaveLength(1);
  expect(
    after.management!.find((r) => r.uuid === component.uuid),
  ).toMatchObject({
    timeSinceRepair: 0,
    timeSinceOverhaul:
      order.closeout!.componentWork![0].before.timeSinceOverhaul,
  });
  expect(
    after.management!.find(
      (r) => r.kind === "componentMovement" && r.action === "OVERHAUL",
    ),
  ).toHaveProperty("supersededByCorrection");
  expect(
    after.audit.find((a) => a.action === "workOrder.correctComponent")?.reason,
  ).toBe(correction.reason);
  await expect(send(correction)).rejects.toThrow("changed");
  expect((await tech.query(api.operations.snapshot, {}))!.management).toEqual(
    after.management,
  );
});

it("archives a signed task copy without signer approval, preserving signatures, evidence, and audit history", async () => {
  vi.useFakeTimers();
  const { t, tech, reader } = await fixture();
  const { taskCardCommand } = await import("../tests/fixtures/taskCards");
  const { newWorkTask } = await import("../src/domain/workOrders");
  const source = {
    kind: "inspection" as const,
    uuid: demoSnapshot().inspections[0].uuid,
  };
  const template = taskCardCommand();
  template.fields.inspectionUuid = source.uuid;
  await tech.mutation(api.taskCards.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(template),
  });
  const command = workOrderCommand();
  command.tasks = [newWorkTask(source, "Inspection")];
  await tech.mutation(api.workOrders.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const before = (await tech.query(api.operations.snapshot, {}))!;
  const order = before.workOrders!.find((item) => item.uuid === command.uuid)!;
  const copy = before.taskCards!.find(
    (card) => card.workOrderUuid === order.uuid,
  )!;
  // Seed an already-signed record from another signer, with an attachment.
  const signature = {
    userId: "original-signer",
    name: "Original signer",
    at: Date.now(),
  };
  copy.status = "completed";
  copy.completionDate = today();
  copy.technicianSignoff = signature;
  copy.inspectionSignoff = {
    ...signature,
    userId: "inspector",
    name: "Inspector",
  };
  copy.actualWork = "Completed inspection";
  const attachment = await t.run(async (ctx) => {
    const doc = await ctx.db
      .query("taskCards")
      .withIndex("uuid", (q) => q.eq("uuid", copy.uuid))
      .unique();
    await ctx.db.patch(doc!._id, { payload: JSON.stringify(copy) });
    const storageId = await ctx.storage.store(
      new Blob(["evidence"], { type: "text/plain" }),
    );
    const id = await ctx.db.insert("taskEvidence", {
      taskCardUuid: copy.uuid,
      storageId,
      name: "record.txt",
      size: 8,
      uploadedAt: Date.now(),
      category: "supporting-document",
    });
    return { id, storageId };
  });
  const args = {
    programUuid: PROGRAM,
    payload: JSON.stringify({ ...command, version: order.version, tasks: [] }),
  };
  await expect(reader.mutation(api.workOrders.save, args)).rejects.toThrow();
  await tech.mutation(api.workOrders.save, args);
  const after = (await tech.query(api.operations.snapshot, {}))!;
  expect(
    after.workOrders!.find((item) => item.uuid === order.uuid)!.tasks,
  ).toHaveLength(0);
  expect(after.taskCards!.some((card) => card.uuid === copy.uuid)).toBe(false);
  expect(
    after.archivedTaskCards!.find((card) => card.uuid === copy.uuid),
  ).toEqual(copy);
  expect(
    after.workOrders!.find((item) => item.uuid === order.uuid)!
      .archivedTasks![0].task,
  ).toEqual(order.tasks[0]);
  expect(
    after.taskEvidence!.some(
      (file) => file.taskCardUuid === copy.uuid && !!file.url,
    ),
  ).toBe(true);
  await t.run(async (ctx) => {
    expect(await ctx.db.get(attachment.id)).not.toBeNull();
    expect(await ctx.storage.get(attachment.storageId)).not.toBeNull();
  });
  await expect(
    tech.mutation(api.taskCards.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify({
        action: "sign",
        uuid: copy.uuid,
        version: copy.version,
        kind: "technician",
      }),
    }),
  ).rejects.toThrow("read-only");

  expect(after.taskCards!.some((card) => card.uuid === template.uuid)).toBe(
    true,
  );
  expect(
    after.audit.some((entry) => entry.action === "taskCard.archived_with_task"),
  ).toBe(true);
  await expect(tech.mutation(api.workOrders.save, args)).rejects.toThrow(
    "changed",
  );
});

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

async function openOrderWithAttachment() {
  const f = await fixture();
  const command = workOrderCommand();
  const save = (payload: unknown) =>
    f.tech.mutation(api.workOrders.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify(payload),
    });
  await save(command);
  const file = {
    programUuid: PROGRAM,
    workOrderUuid: command.uuid,
    name: "maintenance.pdf",
    type: "application/pdf",
    bytes: PDF,
  };
  await f.tech.action(api.workOrders.upload, file);
  const attachment = await f.t.run(
    async (ctx) => (await ctx.db.query("workOrderFiles").first())!,
  );
  return { ...f, command, save, file, attachment };
}

it("shows the work order's own refusals to the user as ConvexErrors", async () => {
  const { t, tech, command, save, file, attachment } =
    await openOrderWithAttachment();
  const missing = crypto.randomUUID();
  const revise = {
    action: "revise",
    uuid: missing,
    version: 0,
    reason: "Typo correction",
    fields: {
      supervisor: "Tech",
      scope: "Corrected scope",
      releaseOutcome: "",
      finalReview: "",
      workPerformed: "",
    },
  };
  const shown: [string, () => Promise<unknown>][] = [
    ["Work order not found.", () => save(revise)],
    [
      "Work order not found.",
      () =>
        tech.action(api.workOrders.upload, { ...file, workOrderUuid: missing }),
    ],
  ];
  for (const [message, run] of shown)
    expect(await refusal(run()), message).toMatchObject({
      name: "ConvexError",
      data: message,
    });
  await save({
    ...command,
    version: 1,
    fields: { ...command.fields, status: "cancelled" },
  });
  const closed = "This work order is closed.";
  for (const run of [
    () => tech.action(api.workOrders.upload, file),
    () =>
      tech.mutation(internal.workOrders.finishUpload, {
        programUuid: PROGRAM,
        workOrderUuid: command.uuid,
        storageId: attachment.storageId,
        name: "late.pdf",
        size: 1,
      }),
    () =>
      tech.mutation(api.workOrders.removeFile, {
        id: attachment._id,
        programUuid: PROGRAM,
      }),
  ])
    expect(await refusal(run())).toMatchObject({
      name: "ConvexError",
      data: closed,
    });
  await t.run((ctx) => ctx.db.delete(attachment._id));
  expect(
    await refusal(
      tech.mutation(api.workOrders.removeFile, {
        id: attachment._id,
        programUuid: PROGRAM,
      }),
    ),
  ).toMatchObject({ name: "ConvexError", data: "Attachment not found." });
  await expect(
    tech.action(api.workOrders.upload, { ...file, type: "text/plain" }),
  ).rejects.toThrow("Choose a PDF, JPEG or PNG file up to 7 MB.");
});

it("removes an attachment from an open work order with its unused file, audited", async () => {
  const { t, tech, reader, command, attachment } =
    await openOrderWithAttachment();
  const remove = { id: attachment._id, programUuid: PROGRAM };
  await expect(
    reader.mutation(api.workOrders.removeFile, remove),
  ).rejects.toThrow();
  await tech.mutation(api.workOrders.removeFile, remove);
  await t.run(async (ctx) => {
    expect(await ctx.db.query("workOrderFiles").collect()).toEqual([]);
    expect(await ctx.storage.get(attachment.storageId)).toBeNull();
    const audit = await ctx.db.query("audit").collect();
    expect(
      audit.find((a) => a.action === "workOrder.attachment_removed"),
    ).toMatchObject({
      entityUuid: command.uuid,
      before: JSON.stringify({ name: "maintenance.pdf" }),
    });
  });
});

it("deletes the stored file when filing it is refused", async () => {
  const { t, tech, file, attachment } = await openOrderWithAttachment();
  await t.run(async (ctx) => {
    for (let i = 1; i < MAX_ATTACHMENTS; i++)
      await ctx.db.insert("workOrderFiles", {
        workOrderUuid: file.workOrderUuid,
        storageId: attachment.storageId,
        name: `copy-${i}.pdf`,
        size: 1,
        uploadedAt: 0,
      });
  });
  const stored = () =>
    t.run(
      async (ctx) => (await ctx.db.system.query("_storage").collect()).length,
    );
  const before = await stored();
  await expect(tech.action(api.workOrders.upload, file)).rejects.toThrow(
    `maximum of ${MAX_ATTACHMENTS} attachments`,
  );
  expect(await stored()).toBe(before);
});
