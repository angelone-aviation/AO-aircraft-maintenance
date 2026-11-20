/**
 * Responsibility: Pins manual uploads and edits: the ticket handshake, which
 *   blobs a ticket may claim or the sweep may delete, access, rate limits, and
 *   that the storage-reference list covers the schema.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/manuals, convex/storageReferences, convex/schema,
 *   src/data/demo, tests/fixtures/taskCards.
 */
import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { taskCardCommand } from "../tests/fixtures/taskCards";
import { MANUAL_UPLOADS_PER_HOUR } from "./manuals";
import { STORAGE_REFERENCES } from "./storageReferences";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { openFile } from "../tests/fixtures/fileLinks";
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
    const makeUser = async (permissions: ("read" | "maintenance")[]) => {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
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
        expirationTime: Date.now() + 86400000,
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
const pdf = new Blob(["%PDF-1.4\nmanual test"], { type: "application/pdf" });
// convex-test's storeBlob omits contentType, which real signed PDF uploads
// include; the system table's type does not allow patching it, hence the cast.
async function storePdf(ctx: MutationCtx, blob: Blob): Promise<Id<"_storage">> {
  const id = await ctx.storage.store(blob);
  const patchSystem = ctx.db.patch.bind(ctx.db) as unknown as (
    id: Id<"_storage">,
    value: { contentType: string },
  ) => Promise<void>;
  await patchSystem(id, { contentType: "application/pdf" });
  return id;
}
// Same base64 SHA-256 Convex records in `_storage.sha256`.
async function sha256(blob: Blob) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  return btoa(String.fromCharCode(...hash));
}
const input = {
  aircraftUuid: demoSnapshot().aircraft[0].uuid,
  title: "Cessna 441 Maintenance Manual",
  documentNumber: "D2518-15-13",
  revision: "15 + TR 5-2",
  revisionDate: "2004-02-02",
  filename: "Cessna_441.pdf",
  size: pdf.size,
  pageCount: 2937,
};
it("stores immutable manual revisions, scopes access and binds upload completion to the uploader", async () => {
  const { t, tech, reader } = await fixture();
  const args = {
    payload: JSON.stringify(input),
    sha256: await sha256(pdf),
    programUuid: "demo-program",
  };
  await expect(reader.mutation(api.manuals.beginUpload, args)).rejects.toThrow(
    "Maintenance",
  );
  await expect(
    tech.mutation(api.manuals.beginUpload, { ...args, programUuid: "wrong" }),
  ).rejects.toThrow("Program changed");
  const { ticket } = await tech.mutation(api.manuals.beginUpload, args);
  const storageId = await t.run((ctx) => storePdf(ctx, pdf));
  await expect(
    reader.action(api.manuals.finishUpload, {
      ticket,
      storageId,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("expired");
  const uuid = await tech.action(api.manuals.finishUpload, {
    ticket,
    storageId,
    programUuid: "demo-program",
  });
  await expect(
    tech.action(api.manuals.finishUpload, {
      ticket,
      storageId,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("expired");
  expect(await openFile(reader, { kind: "manual", id: uuid })).not.toBeNull();
  const snapshot = await reader.query(api.operations.snapshot);
  expect(snapshot?.manuals).toMatchObject([{ ...input, uuid }]);
  expect(snapshot?.manuals?.[0]).not.toHaveProperty("storageId");
  await t.run(async (ctx) => {
    await ctx.db.insert("manuals", {
      ...input,
      aircraftUuid: demoSnapshot().aircraft[1].uuid,
      uuid: "hidden",
      storageId,
      uploadedBy: "other",
      uploadedAt: Date.now(),
    });
  });
  expect((await reader.query(api.operations.snapshot))?.manuals).toHaveLength(
    1,
  );
  expect(await openFile(reader, { kind: "manual", id: "hidden" })).toBeNull();
});
it("rejects mismatched uploads and invalid reference pages, and persists linked task references", async () => {
  const { t, tech } = await fixture();
  const { ticket } = await tech.mutation(api.manuals.beginUpload, {
    payload: JSON.stringify(input),
    sha256: await sha256(pdf),
    programUuid: "demo-program",
  });
  const invalid = await t.run((ctx) =>
    ctx.storage.store(new Blob(["wrong"], { type: "text/plain" })),
  );
  await expect(
    tech.action(api.manuals.finishUpload, {
      ticket,
      storageId: invalid,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("does not match");
  const storageId = await t.run((ctx) => storePdf(ctx, pdf));
  const manualUuid = await tech.action(api.manuals.finishUpload, {
    ticket,
    storageId,
    programUuid: "demo-program",
  });
  const command = taskCardCommand();
  command.fields.manualReference = {
    manualUuid,
    section: "5-12-02",
    printedPage: "1",
    pdfPage: 2938,
  };
  await expect(
    tech.mutation(api.taskCards.save, {
      payload: JSON.stringify(command),
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("between 1 and 2937");
  command.fields.manualReference.pdfPage = 79;
  await tech.mutation(api.taskCards.save, {
    payload: JSON.stringify(command),
    programUuid: "demo-program",
  });
  expect(
    (await tech.query(api.operations.snapshot))?.taskCards?.[0].manualReference,
  ).toEqual(command.fields.manualReference);
});

it("edits model associations only with maintenance access and validates the model", async () => {
  const { t, tech, reader } = await fixture();
  const uuid = crypto.randomUUID();
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(pdf);
    await ctx.db.insert("manuals", {
      ...input,
      uuid,
      storageId,
      uploadedAt: Date.now(),
      uploadedBy: "test",
    });
  });
  const applicability = {
    kind: "component",
    manufacturer: "Test maker",
    model: "TEST-1",
    partNumber: "P1",
  };
  const args = {
    uuid,
    payload: JSON.stringify(applicability),
    programUuid: "demo-program",
  };
  await expect(
    reader.mutation(api.manuals.setApplicability, args),
  ).rejects.toThrow("Maintenance");
  await expect(
    tech.mutation(api.manuals.setApplicability, {
      ...args,
      programUuid: "wrong",
    }),
  ).rejects.toThrow("Program changed");
  await expect(
    tech.mutation(api.manuals.setApplicability, {
      ...args,
      payload: JSON.stringify({ ...applicability, model: "" }),
    }),
  ).rejects.toThrow();
  await tech.mutation(api.manuals.setApplicability, args);
  const saved = await t.run((ctx) =>
    ctx.db
      .query("manuals")
      .withIndex("uuid", (q) => q.eq("uuid", uuid))
      .unique(),
  );
  expect(saved?.applicability).toEqual(applicability);
  expect(saved?.revision).toBe(input.revision);
});

it("renames a manual without changing its PDF or references and requires maintenance access", async () => {
  const { t, tech, reader } = await fixture();
  const uuid = crypto.randomUUID();
  const before = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(pdf);
    const id = await ctx.db.insert("manuals", {
      ...input,
      uuid,
      storageId,
      uploadedAt: 1,
      uploadedBy: "original",
    });
    return (await ctx.db.get(id))!;
  });
  const args = {
    uuid,
    title: "  Renamed maintenance manual  ",
    programUuid: "demo-program",
  };
  await expect(reader.mutation(api.manuals.rename, args)).rejects.toThrow(
    "Maintenance",
  );
  await expect(
    tech.mutation(api.manuals.rename, { ...args, programUuid: "wrong" }),
  ).rejects.toThrow("Program changed");
  await expect(
    tech.mutation(api.manuals.rename, { ...args, title: "  " }),
  ).rejects.toThrow();
  await tech.mutation(api.manuals.rename, args);
  const after = await t.run((ctx) => ctx.db.get(before._id));
  expect(after).toEqual({ ...before, title: "Renamed maintenance manual" });
});

it("edits reference metadata while preserving file identity and validates access and fields", async () => {
  const { t, tech, reader } = await fixture();
  const uuid = crypto.randomUUID();
  const before = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(pdf);
    const id = await ctx.db.insert("manuals", {
      ...input,
      uuid,
      storageId,
      uploadedAt: 1,
      uploadedBy: "original",
    });
    return (await ctx.db.get(id))!;
  });
  const details = {
    aircraftUuid: input.aircraftUuid,
    title: "Corrected title",
    documentNumber: "DOC-2",
    revision: "Rev 16",
    revisionDate: "2026-01-01",
    applicability: {
      kind: "component",
      manufacturer: "Maker",
      model: "Model",
      partNumber: "PN",
    },
  };
  const args = {
    uuid,
    payload: JSON.stringify(details),
    programUuid: "demo-program",
  };
  await expect(reader.mutation(api.manuals.edit, args)).rejects.toThrow(
    "Maintenance",
  );
  await expect(
    tech.mutation(api.manuals.edit, {
      ...args,
      payload: JSON.stringify({ ...details, aircraftUuid: "missing" }),
    }),
  ).rejects.toThrow("same Flight Program");
  await expect(
    tech.mutation(api.manuals.edit, {
      ...args,
      payload: JSON.stringify({ ...details, pageCount: 1 }),
    }),
  ).rejects.toThrow();
  await tech.mutation(api.manuals.edit, args);
  expect(await t.run((ctx) => ctx.db.get(before._id))).toEqual({
    ...before,
    ...details,
  });
  const { applicability: _applicability, ...cleared } = details;
  await tech.mutation(api.manuals.edit, {
    ...args,
    payload: JSON.stringify(cleared),
  });
  expect(
    (await t.run((ctx) => ctx.db.get(before._id)))?.applicability,
  ).toBeUndefined();
});
it("claims only the blob uploaded for its own ticket and never deletes blobs it did not create", async () => {
  const { t, tech } = await fixture();
  const store = (blob: Blob) => t.run((ctx) => storePdf(ctx, blob));
  const exists = (id: Id<"_storage">) =>
    t.run(async (ctx) => !!(await ctx.storage.getUrl(id)));
  const finish = (ticket: Id<"manualUploads">, storageId: Id<"_storage">) =>
    tech.action(api.manuals.finishUpload, {
      ticket,
      storageId,
      programUuid: "demo-program",
    });
  const begin = async (blob: Blob) =>
    (
      await tech.mutation(api.manuals.beginUpload, {
        payload: JSON.stringify(input),
        sha256: await sha256(blob),
        programUuid: "demo-program",
      })
    ).ticket;
  // Another record's identical PDF, stored before the ticket was issued.
  const earlier = await store(pdf);
  const ticket = await begin(pdf);
  await expect(finish(ticket, earlier)).rejects.toThrow("does not match");
  // Someone else's newer PDF of the same size is not this ticket's upload.
  const foreign = await store(
    new Blob(["%PDF-1.4\nOTHER-file!"], { type: "application/pdf" }),
  );
  await expect(finish(ticket, foreign)).rejects.toThrow("does not match");
  // A newer identical blob already referenced by another record is never claimed.
  const attached = await store(pdf);
  await t.run((ctx) =>
    ctx.db.insert("workOrderFiles", {
      workOrderUuid: "wo",
      storageId: attached,
      name: "evidence.pdf",
      size: pdf.size,
      uploadedAt: 1,
    }),
  );
  await expect(finish(ticket, attached)).rejects.toThrow("does not match");
  for (const id of [earlier, foreign, attached])
    expect(await exists(id)).toBe(true);
  const own = await store(pdf);
  await finish(ticket, own);

  // Declared bytes that are not a PDF: rejected but left for the sweep.
  const disguisedBlob = new Blob(["NOT-A-PDF-" + "x".repeat(pdf.size - 10)]);
  const disguisedTicket = await begin(disguisedBlob);
  const disguised = await store(disguisedBlob);
  await expect(finish(disguisedTicket, disguised)).rejects.toThrow("not a PDF");
  expect(await exists(disguised)).toBe(true);
  // An upload whose browser never called finishUpload.
  const abandonedTicket = await begin(pdf);
  const abandoned = await store(pdf);
  const unrelated = await store(
    new Blob(["%PDF-1.4\nunrelated"], { type: "application/pdf" }),
  );

  // Tickets younger than a day survive the sweep.
  await t.mutation(internal.manuals.cleanupUploads, {});
  expect(await t.run((ctx) => ctx.db.get(abandonedTicket))).not.toBeNull();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 25 * 3600000);
    await t.mutation(internal.manuals.cleanupUploads, {});
  } finally {
    vi.useRealTimers();
  }
  expect(await exists(disguised)).toBe(false);
  expect(await exists(abandoned)).toBe(false);
  expect(await t.run((ctx) => ctx.db.get(abandonedTicket))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get(disguisedTicket))).toBeNull();
  // Saved, attached, earlier and unrelated blobs are untouched.
  for (const id of [own, attached, earlier, foreign, unrelated])
    expect(await exists(id)).toBe(true);
});
it("keeps a matching blob that another record refers to when sweeping its ticket", async () => {
  const { t, tech } = await fixture();
  const { ticket } = await tech.mutation(api.manuals.beginUpload, {
    payload: JSON.stringify(input),
    sha256: await sha256(pdf),
    programUuid: "demo-program",
  });
  const attached = await t.run(async (ctx) => {
    const id = await storePdf(ctx, pdf);
    await ctx.db.insert("workOrderFiles", {
      workOrderUuid: "wo",
      storageId: id,
      name: "evidence.pdf",
      size: pdf.size,
      uploadedAt: 1,
    });
    return id;
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 25 * 3600000);
    await t.mutation(internal.manuals.cleanupUploads, {});
  } finally {
    vi.useRealTimers();
  }
  expect(await t.run((ctx) => ctx.db.get(ticket))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.getUrl(attached))).toBeTruthy();
});
it("sweeps at most 50 expired tickets a run", async () => {
  const { t } = await fixture();
  await t.run(async (ctx) => {
    for (let i = 0; i < 51; i++)
      await ctx.db.insert("manualUploads", {
        payload: JSON.stringify(input),
        userId: "user",
        createdAt: 1,
      });
  });
  await t.mutation(internal.manuals.cleanupUploads, {});
  expect(
    await t.run((ctx) => ctx.db.query("manualUploads").collect()),
  ).toHaveLength(1);
});
it("rate-limits upload tickets per user", async () => {
  const { tech } = await fixture();
  const args = {
    payload: JSON.stringify(input),
    sha256: await sha256(pdf),
    programUuid: "demo-program",
  };
  for (let i = 0; i < MANUAL_UPLOADS_PER_HOUR; i++)
    await tech.mutation(api.manuals.beginUpload, args);
  await expect(tech.mutation(api.manuals.beginUpload, args)).rejects.toThrow(
    /Too many manual uploads/,
  );
});
it("checks every storage reference in the schema before deleting a blob", () => {
  const fields = Object.entries(schema.tables).flatMap(([table, def]) =>
    Object.entries(
      (
        def as unknown as {
          validator: { fields: Record<string, { tableName?: string }> };
        }
      ).validator.fields,
    )
      .filter(([, f]) => f.tableName === "_storage")
      .map(([field]) => `${table}.${field}`),
  );
  expect(fields.sort()).toEqual(
    STORAGE_REFERENCES.map((r) => `${r.table}.${r.field}`).sort(),
  );
});

it("audits each manual change with what it changed, and refuses as ConvexError, access before the payload", async () => {
  const { t, tech, reader } = await fixture();
  const uuid = crypto.randomUUID();
  const applicability = {
    kind: "aircraft" as const,
    manufacturer: "Cessna",
    model: "441",
    partNumber: "",
  };
  await t.run(async (ctx) => {
    await ctx.db.insert("manuals", {
      ...input,
      applicability,
      uuid,
      storageId: await ctx.storage.store(pdf),
      uploadedAt: 1,
      uploadedBy: "original",
    });
  });
  const program = { uuid, programUuid: "demo-program" };
  const access = {
    name: "ConvexError",
    data: "Maintenance access is required.",
  };
  for (const run of [
    () => reader.mutation(api.manuals.edit, { ...program, payload: "{" }),
    () => reader.mutation(api.manuals.rename, { ...program, title: " " }),
    () =>
      reader.mutation(api.manuals.setApplicability, {
        ...program,
        payload: "{",
      }),
    () =>
      tech.mutation(api.manuals.rename, {
        ...program,
        uuid: "missing",
        title: "A",
      }),
  ])
    await expect(run()).rejects.toMatchObject(access);
  // In the schema's key order, which the stored change-log text keeps.
  const details = {
    title: "Corrected title",
    documentNumber: "DOC-2",
    revision: "Rev 16",
    revisionDate: "2026-01-01",
    aircraftUuid: input.aircraftUuid,
  };
  const elsewhere = demoSnapshot().aircraft[1].uuid;
  await expect(
    tech.mutation(api.manuals.edit, {
      ...program,
      payload: JSON.stringify({ ...details, aircraftUuid: elsewhere }),
    }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Choose an aircraft in the same Flight Program with maintenance access.",
  });
  await tech.mutation(api.manuals.edit, {
    ...program,
    payload: JSON.stringify(details),
  });
  await tech.mutation(api.manuals.rename, { ...program, title: " Renamed " });
  const component = {
    ...applicability,
    kind: "component" as const,
    partNumber: "PN",
  };
  await tech.mutation(api.manuals.setApplicability, {
    ...program,
    payload: JSON.stringify(component),
  });
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(
    rows.map(({ action, entityUuid, aircraftUuid, before, after }) => ({
      action,
      entityUuid,
      aircraftUuid,
      before,
      after,
    })),
  ).toEqual([
    {
      action: "manual.edit",
      entityUuid: uuid,
      aircraftUuid: input.aircraftUuid,
      before: JSON.stringify({
        title: input.title,
        documentNumber: input.documentNumber,
        revision: input.revision,
        revisionDate: input.revisionDate,
        aircraftUuid: input.aircraftUuid,
        applicability,
      }),
      after: JSON.stringify(details),
    },
    {
      action: "manual.rename",
      entityUuid: uuid,
      aircraftUuid: input.aircraftUuid,
      before: JSON.stringify({ title: "Corrected title" }),
      after: JSON.stringify({ title: "Renamed" }),
    },
    {
      action: "manual.applicability",
      entityUuid: uuid,
      aircraftUuid: input.aircraftUuid,
      before: undefined,
      after: JSON.stringify(component),
    },
  ]);
});
