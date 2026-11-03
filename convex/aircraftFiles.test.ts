import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
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
it("keeps Form 337 copies on the aircraft for readers, with maintenance uploads and deletes audited", async () => {
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
  const file = seen.aircraftFiles![0];
  const stored = await t.run(async (ctx) =>
    (await ctx.db.query("aircraftFiles").collect()).find(
      (f) => f.aircraftUuid === upload.aircraftUuid,
    )!,
  );
  await expect(
    reader.mutation(api.aircraftFiles.remove, {
      id: stored._id,
      programUuid: "demo-program",
    }),
  ).rejects.toThrow(/maintenance permission/);
  await expect(
    tech.mutation(api.aircraftFiles.remove, {
      id: stored._id,
      programUuid: "foreign",
    }),
  ).rejects.toThrow();
  await tech.mutation(api.aircraftFiles.remove, {
    id: stored._id,
    programUuid: "demo-program",
  });
  expect(await t.run((ctx) => ctx.storage.get(stored.storageId))).toBeNull();
  const after = (await tech.query(api.operations.snapshot, {}))!;
  expect(after.aircraftFiles).toEqual([]);
  const audit = after.audit.filter((a) => a.entityUuid === file.aircraftUuid);
  expect(audit.map((a) => a.action).sort()).toEqual([
    "aircraft.file_removed",
    "aircraft.file_uploaded",
  ]);
  expect(
    JSON.parse(
      audit.find((a) => a.action === "aircraft.file_removed")!.before!,
    ),
  ).toMatchObject({ name: file.name, category: "form-337" });
});
