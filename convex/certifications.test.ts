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
  const users = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "peru",
      name: "Peru Projects",
    });
    for (const a of demo.aircraft) await ctx.db.insert("aircraft", a);
    const create = async (name: string, isAdmin: boolean) => {
      const id = await ctx.db.insert("users", {
        name,
        email: `${name}@example.test`,
        active: true,
        isAdmin,
        groupIds: [],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { id, identity: { subject: `${id}|${session}` } };
    };
    return {
      admin: await create("admin", true),
      owner: await create("owner", false),
      other: await create("other", false),
    };
  });
  return {
    t,
    users,
    admin: t.withIdentity(users.admin.identity),
    owner: t.withIdentity(users.owner.identity),
    other: t.withIdentity(users.other.identity),
  };
}
it("assigns an existing Observers group and keeps other programs restricted", async () => {
  const { t, users, admin, owner } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("groups", {
      programUuid: "peru",
      name: "Observers",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["read"],
    }),
  );
  const args = {
    id: users.owner.id,
    active: true,
    isAdmin: false,
    groupIds: [],
    programUuids: ["peru"],
  };
  await admin.mutation(api.admin.updateUser, args);
  await admin.mutation(api.admin.updateUser, args);
  const groups = await t.run((ctx) => ctx.db.query("groups").collect());
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    programUuid: "peru",
    permissions: ["read"],
    name: "Observers",
    programAdmin: false,
  });
  const snapshot = await owner.query(api.operations.snapshot, {});
  expect(snapshot!.programs!.map((p) => p.name)).toEqual(["Peru Projects"]);
  expect(snapshot!.aircraft).toEqual([]);
  await expect(
    owner.mutation(api.admin.updateUser, { ...args, isAdmin: true }),
  ).rejects.toThrow(/Administrator/);
  await expect(
    admin.mutation(api.admin.updateUser, {
      ...args,
      programUuids: ["missing"],
    }),
  ).rejects.toThrow(/Flight Program/);
  await admin.mutation(api.admin.updateUser, { ...args, programUuids: [] });
  expect((await t.run((ctx) => ctx.db.get(users.owner.id)))!.groupIds).toEqual(
    [],
  );
});
it("saves independent certifications, protects copies and allows the owner to manage their own documents", async () => {
  const { t, users, admin, owner, other } = await fixture();
  const certifications = [
    {
      kind: "mechanic",
      number: "M-123",
      issuedOn: "2020-01-01",
      expiresOn: "",
    },
    {
      kind: "pilot",
      number: "P-456",
      issuedOn: "2021-01-01",
      expiresOn: "2030-01-01",
    },
  ];
  await admin.mutation(api.admin.updateUser, {
    id: users.owner.id,
    active: true,
    isAdmin: false,
    groupIds: [],
    certificationsPayload: JSON.stringify(certifications),
  });
  expect(
    (await t.run((ctx) => ctx.db.get(users.owner.id)))!.licenseNumber,
  ).toBe("M-123");
  await expect(
    other.mutation(api.certifications.save, {
      userId: users.owner.id,
      payload: "[]",
    }),
  ).rejects.toThrow(/account owner/);
  const id = await owner.action(api.certifications.upload, {
    userId: users.owner.id,
    kind: "mechanic",
    name: "license.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.4\nLicense copy").buffer,
  });
  const files = await owner.query(api.certifications.list, {
    userId: users.owner.id,
  });
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe("license.pdf");
  await expect(
    other.query(api.certifications.list, { userId: users.owner.id }),
  ).rejects.toThrow(/account owner/);
  await expect(
    other.query(api.certifications.fileUrl, { id: files[0].id }),
  ).rejects.toThrow(/account owner/);
  await expect(
    other.mutation(api.certifications.remove, { id: files[0].id }),
  ).rejects.toThrow(/account owner/);
  expect(
    await admin.query(api.certifications.fileUrl, { id: files[0].id }),
  ).toBeTruthy();
  await expect(
    owner.action(api.certifications.upload, {
      userId: users.owner.id,
      kind: "ia",
      name: "license.jpg",
      type: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]).buffer,
    }),
  ).rejects.toThrow(/Save this certification/);
  await owner.mutation(api.certifications.save, {
    userId: users.owner.id,
    payload: JSON.stringify([
      ...certifications,
      {
        kind: "ia",
        number: "M-123",
        issuedOn: "2022-01-01",
        renewalDate: "2026-03-01",
      },
    ]),
  });
  expect(
    (await owner.query(api.certifications.list, { userId: users.owner.id }))[0]
      .id,
  ).toBe(id);
  expect(
    (await t.run((ctx) => ctx.db.get(users.owner.id)))!.certifications?.find(
      (c) => c.kind === "mechanic",
    )?.renewalDate,
  ).toBe("2026-03-01");
  await owner.mutation(api.certifications.remove, { id: files[0].id });
  expect(
    await owner.query(api.certifications.list, { userId: users.owner.id }),
  ).toEqual([]);
});
