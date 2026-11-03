import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { demoSnapshot } from "../src/data/demo";
import { taskCardCommand } from "../tests/fixtures/taskCards";
import { taskCardFieldsSchema } from "../src/domain/taskCards";
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
  const { tech, reader } = await fixture(),
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
