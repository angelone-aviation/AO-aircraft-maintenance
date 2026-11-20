/**
 * Responsibility: Pins members' certifications and license copies: who may
 *   read and change them, approval before a certificate counts, the derived
 *   license fields, uploads tied to a saved certification, refusals and
 *   audit entries with before and after.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/certifications, convex/admin, convex/operations
 *   (snapshot), src/data/demo.
 */
import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import type { Id } from "./_generated/dataModel";
import { openFile } from "../tests/fixtures/fileLinks";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
// The fixture's administrator works in the first program by default.
const PROGRAM = demoSnapshot().programs![0].uuid;
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
  const licenseNumber = async () =>
    (await t.run((ctx) => ctx.db.get(users.owner.id)))!.licenseNumber;
  // Filed by an administrator, it still waits for an approval.
  expect(await licenseNumber()).toBe("");
  await admin.mutation(api.certifications.approve, {
    userId: users.owner.id,
    programUuid: PROGRAM,
    certificate: JSON.stringify(certifications[0]),
  });
  expect(await licenseNumber()).toBe("M-123");
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
  // Another member's copy reads as missing, so its id confirms nothing (T4);
  // its link is refused the same way as a deleted one.
  const copy = { kind: "certificationFile" as const, id: files[0].id };
  expect(await openFile(other, copy)).toBeNull();
  await expect(
    other.mutation(api.certifications.remove, { id: files[0].id }),
  ).rejects.toThrow("License copy not found.");
  expect(await openFile(admin, copy)).not.toBeNull();
  expect(await openFile(owner, copy)).not.toBeNull();
  await expect(
    owner.action(api.certifications.upload, {
      userId: users.owner.id,
      kind: "ia",
      name: "license.jpg",
      type: "image/jpeg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
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

const mechanic = [
  { kind: "mechanic", number: "M-1", issuedOn: "2020-01-01", expiresOn: "" },
];
const pdf = {
  kind: "mechanic",
  name: "license.pdf",
  type: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.4").buffer,
};

it("audits each change against the member, by whoever made it, and deletes removed files", async () => {
  const { t, users, admin } = await fixture();
  const userId = users.owner.id;
  await admin.mutation(api.certifications.save, {
    userId,
    payload: JSON.stringify(mechanic),
  });
  expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({
    licenseNumber: "",
  });
  const id = await admin.action(api.certifications.upload, { userId, ...pdf });
  await admin.mutation(api.certifications.remove, {
    id: id as Id<"certificationFiles">,
  });
  expect(
    await t.run((ctx) => ctx.db.system.query("_storage").collect()),
  ).toEqual([]);
  const rows = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(rows.map((r) => [r.action, r.entityUuid, r.actorId])).toEqual(
    [
      "user.certification_filed",
      "user.license_copy_uploaded",
      "user.license_copy_deleted",
    ].map((action) => [action, userId, users.admin.id]),
  );
});

it("refuses a missing member or license copy", async () => {
  const { t, users, admin, owner } = await fixture();
  await t.run((ctx) => ctx.db.delete(users.other.id));
  await expect(
    admin.query(api.certifications.list, { userId: users.other.id }),
  ).rejects.toThrow("User not found.");
  const userId = users.owner.id;
  await owner.mutation(api.certifications.save, {
    userId,
    payload: JSON.stringify(mechanic),
  });
  const id = (await owner.action(api.certifications.upload, {
    userId,
    ...pdf,
  })) as Id<"certificationFiles">;
  await owner.mutation(api.certifications.remove, { id });
  expect(await openFile(owner, { kind: "certificationFile", id })).toBeNull();
  await expect(
    owner.mutation(api.certifications.remove, { id }),
  ).rejects.toThrow("License copy not found.");
});

it("refuses to file a copy once its certification is unselected", async () => {
  const { t, users, owner } = await fixture();
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
  await expect(
    owner.mutation(internal.certifications.finishUpload, {
      userId: users.owner.id,
      kind: "mechanic",
      storageId,
      name: "license.pdf",
      type: "application/pdf",
      size: 1,
    }),
  ).rejects.toThrow("Certification is no longer selected.");
});

it("opens a copy whose file is gone as null, and checks a file before access", async () => {
  const { t, users, owner, other } = await fixture();
  const userId = users.owner.id;
  await owner.mutation(api.certifications.save, {
    userId,
    payload: JSON.stringify(mechanic),
  });
  const id = (await owner.action(api.certifications.upload, {
    userId,
    ...pdf,
  })) as Id<"certificationFiles">;
  await t.run(async (ctx) =>
    ctx.storage.delete((await ctx.db.get(id))!.storageId),
  );
  expect(await openFile(owner, { kind: "certificationFile", id })).toBeNull();
  await expect(
    other.action(api.certifications.upload, { userId, ...pdf, name: "" }),
  ).rejects.toThrow(
    "Upload a PDF, JPEG, PNG, WebP, HEIC or HEIF license copy.",
  );
});

it("refuses a copy whose first bytes are not its declared type, before access and storing nothing, and keeps a real HEIC", async () => {
  const { t, users, owner, other } = await fixture();
  const userId = users.owner.id;
  await owner.mutation(api.certifications.save, {
    userId,
    payload: JSON.stringify(mechanic),
  });
  const text = (body: string) => new TextEncoder().encode(body).buffer;
  const heic = new Uint8Array([
    0,
    0,
    0,
    24,
    ...new TextEncoder().encode("ftypheicmif1"),
  ]).buffer;
  for (const [client, file] of [
    [owner, { ...pdf, bytes: text("<html><body>license</body></html>") }],
    [other, { ...pdf, bytes: text("<html><body>license</body></html>") }],
    [
      owner,
      { ...pdf, name: "license.heic", type: "image/heic", bytes: pdf.bytes },
    ],
  ] as const)
    await expect(
      client.action(api.certifications.upload, { userId, ...file }),
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: "This file's contents do not match its type. Choose a PDF, JPEG, PNG, WebP, HEIC or HEIF file.",
    });
  await t.run(async (ctx) => {
    expect(await ctx.db.query("certificationFiles").collect()).toEqual([]);
    expect(await ctx.db.system.query("_storage").collect()).toEqual([]);
  });
  await owner.action(api.certifications.upload, {
    userId,
    ...pdf,
    name: "license.heic",
    type: "image/heic",
    bytes: heic,
  });
  expect(await owner.query(api.certifications.list, { userId })).toMatchObject([
    { name: "license.heic" },
  ]);
});

it("deletes the stored copy when its certification is unselected during the upload, keeping earlier copies", async () => {
  const { t, users, owner } = await fixture();
  const userId = users.owner.id;
  await owner.mutation(api.certifications.save, {
    userId,
    payload: JSON.stringify(mechanic),
  });
  const earlier = (await owner.action(api.certifications.upload, {
    userId,
    ...pdf,
  })) as Id<"certificationFiles">;
  // Unselects the certification as the upload builds its blob: after the
  // check, before filing.
  let unselected: Promise<unknown> | undefined;
  vi.stubGlobal(
    "Blob",
    class extends Blob {
      constructor(...args: ConstructorParameters<typeof Blob>) {
        super(...args);
        unselected ??= owner.mutation(api.certifications.save, {
          userId,
          payload: "[]",
        });
      }
    },
  );
  try {
    await expect(
      owner.action(api.certifications.upload, { userId, ...pdf }),
    ).rejects.toMatchObject({ data: "Certification is no longer selected." });
  } finally {
    vi.unstubAllGlobals();
  }
  await unselected;
  const { storageId } = (await t.run((ctx) => ctx.db.get(earlier)))!;
  expect(
    (await t.run((ctx) => ctx.db.system.query("_storage").collect())).map(
      (blob) => blob._id,
    ),
  ).toEqual([storageId]);
});

const APPROVER_ONLY =
  /Only a system administrator, or a Flight Program administrator of the member's program, may approve their certificates, and nobody their own\./;
const filed = { kind: "mechanic", number: "M-1", issuedOn: "2020-01-01" };
const stored = (t: Awaited<ReturnType<typeof fixture>>["t"], id: Id<"users">) =>
  t.run(async (ctx) => (await ctx.db.get(id))!);
const changeLog = (t: Awaited<ReturnType<typeof fixture>>["t"]) =>
  t.run(async (ctx) =>
    (await ctx.db.query("audit").collect())
      .filter((r) => r.action.startsWith("user.certification_"))
      .map((r) => ({
        action: r.action,
        before: r.before && JSON.parse(r.before),
        after: r.after && JSON.parse(r.after),
      })),
  );

it("keeps a member's own certificate pending until another administrator approves it, logging every change", async () => {
  const { t, users, admin, owner, other } = await fixture();
  const userId = users.owner.id;
  const save = (certifications: object[]) =>
    owner.mutation(api.certifications.save, {
      userId,
      payload: JSON.stringify(certifications),
    });
  const approve = (client: typeof admin, certificate: object) =>
    client.mutation(api.certifications.approve, {
      userId,
      programUuid: PROGRAM,
      certificate: JSON.stringify(certificate),
    });
  await save([{ ...filed, pending: false }]);
  expect(await stored(t, userId)).toMatchObject({
    certifications: [{ ...filed, pending: true }],
    licenseNumber: "",
  });
  await expect(approve(owner, filed)).rejects.toThrow();
  await expect(approve(other, filed)).rejects.toThrow();
  await expect(approve(admin, { ...filed, number: "M-9" })).rejects.toThrow(
    "This certificate changed since you opened it. Review it again.",
  );
  await approve(admin, filed);
  expect(await stored(t, userId)).toMatchObject({
    certifications: [filed],
    licenseNumber: "M-1",
  });
  await expect(approve(admin, filed)).rejects.toThrow(
    "This certificate is not waiting for approval.",
  );
  await save([{ ...filed, number: "M-2" }]);
  expect((await stored(t, userId)).licenseNumber).toBe("");
  await save([]);
  const edited = { ...filed, number: "M-2", pending: true };
  expect(await changeLog(t)).toEqual([
    {
      action: "user.certification_filed",
      before: null,
      after: { ...filed, pending: true },
    },
    {
      action: "user.certification_approved",
      before: { ...filed, pending: true },
      after: filed,
    },
    { action: "user.certification_edited", before: filed, after: edited },
    { action: "user.certification_removed", before: edited, after: null },
  ]);
});

it("refuses a system administrator approving their own certificate", async () => {
  const { t, users, admin } = await fixture();
  await admin.mutation(api.certifications.save, {
    userId: users.admin.id,
    payload: JSON.stringify([filed]),
  });
  await expect(
    admin.mutation(api.certifications.approve, {
      userId: users.admin.id,
      programUuid: PROGRAM,
      certificate: JSON.stringify(filed),
    }),
  ).rejects.toThrow(APPROVER_ONLY);
  expect(
    await admin.query(api.certifications.awaitingApproval, {
      programUuid: PROGRAM,
    }),
  ).toEqual([]);
  expect((await stored(t, users.admin.id)).certifications).toEqual([
    { ...filed, pending: true },
  ]);
});

it("lets a Flight Program administrator review and approve their own program's members only", async () => {
  const { t, users, owner, other } = await fixture();
  const program = PROGRAM;
  await t.run(async (ctx) => {
    const group = (name: string, programUuid: string, programAdmin: boolean) =>
      ctx.db.insert("groups", {
        programUuid,
        name,
        programAdmin,
        aircraftIds: [],
        permissions: ["read"],
      });
    const managers = await group("Managers", program, true);
    const crew = await group("Crew", program, false);
    const peru = await group("Peru crew", "peru", false);
    await ctx.db.patch(users.other.id, {
      groupIds: [managers],
      activeProgramUuid: program,
    });
    await ctx.db.patch(users.owner.id, { groupIds: [crew] });
    await ctx.db.patch(users.admin.id, { groupIds: [peru], isAdmin: false });
  });
  await t.mutation(internal.memberships.backfill, {});
  for (const id of [users.owner.id, users.admin.id])
    await t.run((ctx) =>
      ctx.db.patch(id, { certifications: [{ ...filed, pending: true }] }),
    );
  expect(
    await other.query(api.certifications.awaitingApproval, {
      programUuid: program,
    }),
  ).toEqual([{ userId: users.owner.id, name: "owner", certificate: filed }]);
  const approve = (userId: Id<"users">) =>
    other.mutation(api.certifications.approve, {
      userId,
      programUuid: program,
      certificate: JSON.stringify(filed),
    });
  await expect(approve(users.admin.id)).rejects.toThrow(APPROVER_ONLY);
  await approve(users.owner.id);
  expect((await stored(t, users.owner.id)).certifications).toEqual([filed]);
  await expect(
    owner.query(api.certifications.awaitingApproval, { programUuid: program }),
  ).resolves.toEqual([]);
});
