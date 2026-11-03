import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { MAX_AIRCRAFT_FILES } from "../src/domain/aircraftFiles";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function fixture() {
  const t = convexTest(schema, modules),
    demo = demoSnapshot();
  const identities = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    await ctx.db.insert("aircraft", demo.aircraft[0]);
    await ctx.db.insert("aircraft", {
      ...demo.aircraft[0],
      uuid: "foreign-aircraft",
      registration: "FOREIGN",
      programUuid: "foreign",
    });
    const makeUser = async (permissions: ("read" | "maintenance")[]) => {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: permissions.join(","),
        aircraftIds: [demo.aircraft[0].uuid],
        permissions,
      });
      const user = await ctx.db.insert("users", {
        name: permissions.join(","),
        active: true,
        isAdmin: false,
        groupIds: [group],
        activeProgramUuid: "demo-program",
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
const pdf = new TextEncoder().encode("%PDF-1.4 Form 337").buffer;
const upload = {
  aircraftUuid: demoSnapshot().aircraft[0].uuid,
  programUuid: "demo-program",
  category: "form-337" as const,
  name: "337-2019-alteration.pdf",
  type: "application/pdf",
  bytes: pdf,
};
it("keeps Form 337 copies on the aircraft for readers, with maintenance uploads and archiving audited", async () => {
  const { t, tech, reader } = await fixture();
  await expect(reader.action(api.aircraftFiles.upload, upload)).rejects.toThrow(
    /maintenance permission/,
  );
  await expect(
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      aircraftUuid: "foreign-aircraft",
    }),
  ).rejects.toThrow(/permission/);
  await expect(
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      name: "337.html",
      type: "text/html",
    }),
  ).rejects.toThrow("PDF, JPEG, PNG or WebP");
  await expect(
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      bytes: new Uint8Array(7 * 1024 * 1024 + 1).buffer,
    }),
  ).rejects.toThrow("7 MB");
  await tech.action(api.aircraftFiles.upload, upload);
  // A foreign program's copy never reaches this program's readers.
  await t.run(async (ctx) =>
    ctx.db.insert("aircraftFiles", {
      aircraftUuid: "foreign-aircraft",
      category: "form-337",
      storageId: await ctx.storage.store(new Blob(["foreign"])),
      name: "foreign-337.pdf",
      type: "application/pdf",
      size: 7,
      uploadedAt: 1,
    }),
  );
  const seen = (await reader.query(api.operations.snapshot, {}))!;
  expect(seen.aircraftFiles).toMatchObject([
    {
      aircraftUuid: upload.aircraftUuid,
      category: "form-337",
      name: "337-2019-alteration.pdf",
      type: "application/pdf",
      size: pdf.byteLength,
    },
  ]);
  expect(seen.aircraftFiles![0].url).toBeTruthy();
  expect(seen.aircraftFiles![0].archivedAt).toBeUndefined();
  const file = seen.aircraftFiles![0];
  const stored = await t.run(async (ctx) =>
    (await ctx.db.query("aircraftFiles").collect()).find(
      (f) => f.aircraftUuid === upload.aircraftUuid,
    )!,
  );
  const archive = (reason: string, programUuid = "demo-program") => ({
    id: stored._id,
    reason,
    programUuid,
  });
  await expect(
    reader.mutation(api.aircraftFiles.archive, archive("Superseded")),
  ).rejects.toThrow(/maintenance permission/);
  await expect(
    tech.mutation(api.aircraftFiles.archive, archive("Superseded", "foreign")),
  ).rejects.toThrow();
  await expect(
    tech.mutation(api.aircraftFiles.archive, archive("   ")),
  ).rejects.toThrow("Enter a reason for archiving this copy.");
  await tech.mutation(
    api.aircraftFiles.archive,
    archive(" Superseded by the corrected 337 "),
  );
  await expect(
    tech.mutation(api.aircraftFiles.archive, archive("Again")),
  ).rejects.toThrow("already archived");
  // Status records are never deleted: the row and its stored file remain.
  const row = await t.run((ctx) => ctx.db.get(stored._id));
  expect(row).toMatchObject({
    storageId: stored.storageId,
    archiveReason: "Superseded by the corrected 337",
    archivedBy: { name: "read,maintenance" },
  });
  expect(row!.archivedAt).toEqual(expect.any(Number));
  expect(
    await t.run(async (ctx) =>
      (await ctx.storage.get(stored.storageId))?.text(),
    ),
  ).toBe("%PDF-1.4 Form 337");
  // Readers still receive the archived copy, flagged, with an openable URL.
  const after = (await reader.query(api.operations.snapshot, {}))!;
  expect(after.aircraftFiles).toMatchObject([
    {
      uuid: file.uuid,
      archiveReason: "Superseded by the corrected 337",
      archivedBy: { name: "read,maintenance" },
    },
  ]);
  expect(after.aircraftFiles![0].url).toBeTruthy();
  const audit = (await tech.query(api.operations.snapshot, {}))!.audit.filter(
    (a) => a.entityUuid === file.aircraftUuid,
  );
  expect(audit.map((a) => a.action).sort()).toEqual([
    "aircraft.file_archived",
    "aircraft.file_uploaded",
  ]);
  const entry = audit.find((a) => a.action === "aircraft.file_archived")!;
  expect(entry.reason).toBe("Superseded by the corrected 337");
  expect(JSON.parse(entry.before!)).toMatchObject({
    name: file.name,
    category: "form-337",
  });
  expect(JSON.parse(entry.after!)).toMatchObject({
    archiveReason: "Superseded by the corrected 337",
  });
});
it("limits an aircraft to 200 current copies; archived copies do not count", async () => {
  const { t, tech } = await fixture();
  const fill = (count: number, archived: boolean) =>
    t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["337"]));
      for (let i = 0; i < count; i++)
        await ctx.db.insert("aircraftFiles", {
          aircraftUuid: upload.aircraftUuid,
          category: "form-337",
          storageId,
          name: `337-${i}.pdf`,
          type: "application/pdf",
          size: 3,
          uploadedAt: i,
          ...(archived
            ? {
                archivedAt: 1,
                archivedBy: { userId: "u", name: "Archivist" },
                archiveReason: "Superseded",
              }
            : {}),
        });
    });
  await fill(MAX_AIRCRAFT_FILES, true);
  await tech.action(api.aircraftFiles.upload, upload);
  await fill(MAX_AIRCRAFT_FILES - 2, false);
  await tech.action(api.aircraftFiles.upload, upload);
  await expect(tech.action(api.aircraftFiles.upload, upload)).rejects.toThrow(
    "maximum of 200 current documents",
  );
});
