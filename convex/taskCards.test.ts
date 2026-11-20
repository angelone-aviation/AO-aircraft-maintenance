/**
 * Responsibility: Pins job cards: saving and access, signer identity and
 *   signoff rules, template unlinking, evidence, archived cards, a card uuid
 *   outside the Flight Program, and replayed request ids.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/taskCards, convex/operations, convex/attachments,
 *   src/data/demo, src/domain/taskCards, tests/fixtures/taskCards.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { demoSnapshot } from "../src/data/demo";
import { taskCardCommand } from "../tests/fixtures/taskCards";
import { taskCardFieldsSchema } from "../src/domain/taskCards";
import { MAX_ATTACHMENTS } from "./attachments";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function fixture() {
  const t = convexTest(schema, modules);
  const identities = await t.run(async (ctx) => {
    const s = demoSnapshot();
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    for (const i of s.inspections) await ctx.db.insert("inspections", i);
    const makeUser = async (
      permissions: ("read" | "maintenance")[],
      name = "Tech",
    ) => {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: permissions.join(","),
        aircraftIds: [s.aircraft[0].uuid],
        permissions,
      });
      const user = await ctx.db.insert("users", {
        name,
        active: true,
        isAdmin: false,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${user}|${session}` };
    };
    return {
      tech: await makeUser(["read", "maintenance"]),
      reader: await makeUser(["read"]),
      inspector: await makeUser(["read", "maintenance"], "Inspector"),
    };
  });
  return {
    t,
    tech: t.withIdentity(identities.tech),
    reader: t.withIdentity(identities.reader),
    inspector: t.withIdentity(identities.inspector),
    inspectorId: identities.inspector.subject.split("|")[0] as Id<"users">,
  };
}
it("persists cards, enforces access and prevents forged signoffs", async () => {
  const { t, tech, reader } = await fixture(),
    command = taskCardCommand();
  command.fields.inspectionUuid = demoSnapshot().inspections[0].uuid;
  const args = {
    programUuid: "demo-program",
    payload: JSON.stringify({
      ...command,
      technicianSignoff: { userId: "forged", name: "Forged", at: 1 },
    }),
  };
  await expect(t.mutation(api.taskCards.save, args)).rejects.toThrow();
  await expect(reader.mutation(api.taskCards.save, args)).rejects.toThrow();
  await tech.mutation(api.taskCards.save, args);
  const s = await tech.query(api.operations.snapshot, {});
  expect(s?.taskCards?.[0].technicianSignoff).toBeNull();
  expect(s?.audit.some((a) => a.action === "taskCard.save")).toBe(true);
  // The row names the aircraft's program (ADR-0003; none before Batch 296).
  const [row] = await t.run(async (ctx) =>
    (await ctx.db.query("audit").collect()).filter(
      (r) => r.action === "taskCard.save",
    ),
  );
  expect(row).toMatchObject({
    entityUuid: command.uuid,
    aircraftUuid: command.fields.aircraftUuid,
  });
  expect(JSON.parse(row.after!)).toEqual(s!.taskCards![0]);
  expect(row.programUuid).toBe("demo-program");
  expect(row).not.toHaveProperty("before");
  await expect(tech.mutation(api.taskCards.save, args)).rejects.toThrow(
    "changed",
  );
  await expect(
    tech.mutation(api.taskCards.save, { ...args, programUuid: "wrong" }),
  ).rejects.toThrow("Program changed");
  const alien = taskCardCommand();
  alien.fields.aircraftUuid = demoSnapshot().aircraft[1].uuid;
  await expect(
    tech.mutation(api.taskCards.save, {
      ...args,
      payload: JSON.stringify(alien),
    }),
  ).rejects.toThrow("access denied");
});
it("records real signer identity, invalidates signatures on evidence upload, and freezes completed cards", async () => {
  const { t, tech, reader } = await fixture(),
    command = taskCardCommand();
  command.fields.steps = [];
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(command),
  });
  const getCard = async () =>
    (await tech.query(api.operations.snapshot, {}))!.taskCards![0];
  let card = await getCard();
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "save",
      uuid: card.uuid,
      version: card.version,
      fields: {
        ...taskCardFieldsSchema.parse(card),
        status: "ready",
        actualWork: "Verified",
        completionDate: new Date().toISOString().slice(0, 10),
      },
    }),
  });
  card = await getCard();
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "sign",
      uuid: card.uuid,
      version: card.version,
      kind: "technician",
    }),
  });
  card = await getCard();
  expect(card.technicianSignoff?.name).toBe("Tech");
  const file = {
    programUuid: "demo-program",
    taskCardUuid: card.uuid,
    category: "parts-traceability" as const,
    name: "certificate.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.4 test").buffer,
  };
  await expect(reader.action(api.taskCards.upload, file)).rejects.toThrow();
  await tech.action(api.taskCards.upload, file);
  card = await getCard();
  expect(card.technicianSignoff).toBeNull();
  // Filed under the card's aircraft, which the snapshot reads evidence by.
  expect(
    await t.run(async (ctx) => (await ctx.db.query("taskEvidence").first())!),
  ).toMatchObject({ taskCardUuid: card.uuid, aircraftUuid: card.aircraftUuid });
  expect(
    (await tech.query(api.operations.snapshot, {}))?.taskEvidence,
  ).toMatchObject([
    { name: "certificate.pdf", category: "parts-traceability" },
  ]);
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "sign",
      uuid: card.uuid,
      version: card.version,
      kind: "technician",
    }),
  });
  card = await getCard();
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "save",
      uuid: card.uuid,
      version: card.version,
      fields: { ...taskCardFieldsSchema.parse(card), status: "completed" },
    }),
  });
  await expect(tech.action(api.taskCards.upload, file)).rejects.toThrow(
    "open job card",
  );
});
it("shows a refused evidence file to the user, and keeps no file the card refuses", async () => {
  const { t, tech, reader } = await fixture(),
    command = taskCardCommand();
  command.fields.steps = [];
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(command),
  });
  const file = {
    programUuid: "demo-program",
    taskCardUuid: command.uuid,
    category: "photo" as const,
    name: "notes.txt",
    type: "text/plain",
    bytes: new TextEncoder().encode("notes").buffer,
  };
  // The file check runs before any permission check.
  for (const client of [tech, reader])
    await expect(
      client.action(api.taskCards.upload, file),
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: "Choose a PDF, JPEG or PNG file up to 7 MB.",
    });
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["photo"]));
    for (let i = 0; i < MAX_ATTACHMENTS; i++)
      await ctx.db.insert("taskEvidence", {
        taskCardUuid: command.uuid,
        storageId,
        name: `photo-${i}.jpg`,
        size: 5,
        uploadedAt: 1,
        category: "photo",
      });
  });
  const stored = () =>
    t.run(
      async (ctx) => (await ctx.db.system.query("_storage").collect()).length,
    );
  const before = await stored();
  await expect(
    tech.action(api.taskCards.upload, {
      ...file,
      name: "photo.jpg",
      type: "image/jpeg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
    }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: `This record already has the maximum of ${MAX_ATTACHMENTS} attachments.`,
  });
  expect(await stored()).toBe(before);
});
it("refuses evidence whose first bytes are not its declared type, storing nothing", async () => {
  const { t, tech, reader } = await fixture(),
    command = taskCardCommand();
  command.fields.steps = [];
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(command),
  });
  const renamed = {
    programUuid: "demo-program",
    taskCardUuid: command.uuid,
    category: "photo" as const,
    name: "IMG_0001.jpg",
    type: "image/jpeg",
    bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
      .buffer,
  };
  for (const client of [tech, reader])
    await expect(
      client.action(api.taskCards.upload, renamed),
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: "This file's contents do not match its type. Choose a PDF, JPEG or PNG file.",
    });
  await t.run(async (ctx) => {
    expect(await ctx.db.query("taskEvidence").collect()).toEqual([]);
    expect(await ctx.db.system.query("_storage").collect()).toEqual([]);
  });
});
it("rejects an inspection signoff until the inspector has a certificate on file", async () => {
  const { tech, inspector, inspectorId } = await fixture(),
    command = taskCardCommand();
  command.fields.steps = [];
  const save = (client: typeof tech, payload: unknown) =>
    client.mutation(api.taskCards.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(payload),
    });
  const getCard = async () =>
    (await tech.query(api.operations.snapshot, {}))!.taskCards![0];
  await save(tech, command);
  let card = await getCard();
  await save(tech, {
    action: "save",
    uuid: card.uuid,
    version: card.version,
    fields: {
      ...taskCardFieldsSchema.parse(card),
      status: "in-progress",
      actualWork: "Replaced seal",
      completionDate: new Date().toISOString().slice(0, 10),
      inspectionSignoffRequired: true,
    },
  });
  card = await getCard();
  // The technician has no certificate on file and may still sign the work.
  await save(tech, {
    action: "sign",
    uuid: card.uuid,
    version: card.version,
    kind: "technician",
  });
  card = await getCard();
  expect(card.technicianSignoff?.name).toBe("Tech");
  const inspect = () =>
    save(inspector, {
      action: "sign",
      uuid: card.uuid,
      version: card.version,
      kind: "inspection",
    });
  await expect(inspect()).rejects.toThrow(
    "Add your certificate type and number under My certifications to sign as inspector.",
  );
  card = await getCard();
  expect(card.inspectionSignoff).toBeNull();
  // A selected certification without a number is still not enough.
  await inspector.mutation(api.certifications.save, {
    userId: inspectorId,
    payload: JSON.stringify([
      { kind: "mechanic", number: "", issuedOn: "", airframe: true },
    ]),
  });
  await expect(inspect()).rejects.toThrow("My certifications");
  // A pilot certificate is not a maintenance certificate.
  await inspector.mutation(api.certifications.save, {
    userId: inspectorId,
    payload: JSON.stringify([
      { kind: "pilot", number: "P-98765", issuedOn: "" },
    ]),
  });
  await expect(inspect()).rejects.toThrow(
    "Add a mechanic, repairman or inspection authorization certificate under My certifications to sign as inspector.",
  );
  card = await getCard();
  expect(card.inspectionSignoff).toBeNull();
  await inspector.mutation(api.certifications.save, {
    userId: inspectorId,
    payload: JSON.stringify([
      {
        kind: "mechanic",
        number: "3456789",
        issuedOn: "",
        airframe: true,
        powerplant: true,
      },
    ]),
  });
  await inspect();
  card = await getCard();
  expect(card.inspectionSignoff?.name).toBe("Inspector");
  const audit = (await tech.query(api.operations.snapshot, {}))!.audit;
  expect(audit.filter((a) => a.action === "taskCard.sign")).toHaveLength(2);
});

it("unlinks templates with maintenance access, preserves the card, and audits the change", async () => {
  const { tech, reader } = await fixture();
  const command = taskCardCommand();
  command.fields.inspectionUuid = demoSnapshot().inspections[0].uuid;
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(command),
  });
  const before = await tech.query(api.operations.snapshot, {});
  const card = before!.taskCards!.find((card) => card.uuid === command.uuid)!;
  const args = {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "unlink",
      uuid: card.uuid,
      version: card.version,
      link: { kind: "inspection", uuid: card.inspectionUuid },
    }),
  };
  await expect(reader.mutation(api.taskCards.save, args)).rejects.toThrow();
  await tech.mutation(api.taskCards.save, args);
  const after = await tech.query(api.operations.snapshot, {});
  expect(
    after!.taskCards!.find((item) => item.uuid === card.uuid)?.inspectionUuid,
  ).toBe("");
  expect(after!.audit.some((entry) => entry.action === "taskCard.unlink")).toBe(
    true,
  );
  await expect(tech.mutation(api.taskCards.save, args)).rejects.toThrow(
    "changed",
  );
});
it("deletes evidence only from open unsigned cards with maintenance access, keeping shared blobs", async () => {
  const { t, tech, reader } = await fixture(),
    command = taskCardCommand();
  command.fields.steps = [];
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(command),
  });
  const ids = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["photo"]));
    const shared = await ctx.storage.store(new Blob(["shared"]));
    const row = (id: typeof storageId) =>
      ctx.db.insert("taskEvidence", {
        taskCardUuid: command.uuid,
        storageId: id,
        name: "photo.jpg",
        size: 5,
        uploadedAt: 1,
        category: "photo",
      });
    // A sample document reused by a work-order attachment.
    await ctx.db.insert("workOrderFiles", {
      workOrderUuid: "other",
      storageId: shared,
      name: "shared.pdf",
      size: 6,
      uploadedAt: 1,
    });
    return {
      storageId,
      shared,
      own: await row(storageId),
      reused: await row(shared),
    };
  });
  const args = { id: ids.own, programUuid: "demo-program" };
  await expect(
    reader.mutation(api.taskCards.removeEvidence, args),
  ).rejects.toThrow("permission");
  await expect(
    tech.mutation(api.taskCards.removeEvidence, { ...args, programUuid: "x" }),
  ).rejects.toThrow("Program changed");
  await tech.mutation(api.taskCards.removeEvidence, args);
  await tech.mutation(api.taskCards.removeEvidence, {
    id: ids.reused,
    programUuid: "demo-program",
  });
  expect(await t.run((ctx) => ctx.storage.getUrl(ids.storageId))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.getUrl(ids.shared))).not.toBeNull();
  const s = await tech.query(api.operations.snapshot, {});
  expect(s?.taskEvidence).toEqual([]);
  expect(
    s?.audit.filter((a) => a.action === "taskCard.evidence_removed"),
  ).toHaveLength(2);
  // Once signed, evidence is part of the signed record.
  let card = s!.taskCards![0];
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "save",
      uuid: card.uuid,
      version: card.version,
      fields: {
        ...taskCardFieldsSchema.parse(card),
        status: "ready",
        actualWork: "Verified",
        completionDate: new Date().toISOString().slice(0, 10),
      },
    }),
  });
  card = (await tech.query(api.operations.snapshot, {}))!.taskCards![0];
  await tech.mutation(api.taskCards.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "sign",
      uuid: card.uuid,
      version: card.version,
      kind: "technician",
    }),
  });
  const signed = await t.run(async (ctx) =>
    ctx.db.insert("taskEvidence", {
      taskCardUuid: command.uuid,
      storageId: await ctx.storage.store(new Blob(["late"])),
      name: "late.jpg",
      size: 4,
      uploadedAt: 2,
      category: "photo",
    }),
  );
  await expect(
    tech.mutation(api.taskCards.removeEvidence, {
      id: signed,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("unsigned");
});

it("refuses a job card uuid stored outside the Flight Program, and an archived card", async () => {
  const { t, tech } = await fixture();
  const command = taskCardCommand();
  const outside = { uuid: command.uuid, aircraftUuid: "other-aircraft" };
  const archived = taskCardCommand();
  await t.run(async (ctx) => {
    await ctx.db.insert("taskCards", { ...outside, payload: "{}" });
    await ctx.db.insert("archivedTaskCards", {
      uuid: archived.uuid,
      aircraftUuid: archived.fields.aircraftUuid,
      payload: "{}",
    });
  });
  const save = (c: unknown) =>
    tech.mutation(api.taskCards.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  const stored = () => t.run((ctx) => ctx.db.query("taskCards").collect());
  const before = await stored();
  await expect(save(command)).rejects.toMatchObject({
    name: "ConvexError",
    data: "Record belongs to another Flight Program.",
  });
  await expect(save(archived)).rejects.toMatchObject({
    name: "ConvexError",
    data: "Archived job cards are read-only.",
  });
  expect(await stored()).toEqual(before);
});

it("saves a job card once per request id: a replay returns nothing and writes nothing", async () => {
  const { t, tech } = await fixture();
  const requestUuid = crypto.randomUUID();
  const command = { ...taskCardCommand(), requestUuid };
  const save = (c: unknown) =>
    tech.mutation(api.taskCards.save, {
      programUuid: "demo-program",
      payload: JSON.stringify(c),
    });
  const stored = () =>
    t.run(async (ctx) => ({
      taskCards: await ctx.db.query("taskCards").collect(),
      audit: await ctx.db.query("audit").collect(),
      commandRequests: await ctx.db.query("commandRequests").collect(),
    }));
  await expect(save(command)).resolves.toBe(command.uuid);
  const saved = await stored();
  expect(saved.taskCards).toHaveLength(1);
  expect(saved.commandRequests).toMatchObject([
    { uuid: requestUuid, payload: JSON.stringify(command) },
  ]);
  // ADR-0003: a replay succeeds with no payload.
  await expect(save(command)).resolves.toBeNull();
  expect(await stored()).toEqual(saved);
  await expect(
    save({ ...command, requestUuid: undefined }),
  ).rejects.toMatchObject({
    data: "Job card changed. Reopen it before saving.",
  });
  await expect(
    save({ ...command, fields: { ...command.fields, title: "Other" } }),
  ).rejects.toMatchObject({ data: "Request identifier already used." });
  expect(await stored()).toEqual(saved);
});
