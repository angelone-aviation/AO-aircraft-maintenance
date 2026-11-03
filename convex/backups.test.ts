import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

const hour = 3_600_000;
const copy = (patch: Record<string, unknown> = {}) => ({
  completedAt: Date.now() - hour,
  objectKey: "daily/2026/11/04/angelone-20261104T084112Z.zip.age",
  bytes: 123_456_789,
  sha256: "a".repeat(64),
  envUploaded: true,
  ...patch,
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const groupId = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Program administrators",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    async function user(name: string, isAdmin: boolean, groupIds = [groupId]) {
      const userId = await ctx.db.insert("users", {
        active: true,
        isAdmin,
        name,
        email: name + "@example.test",
        groupIds,
        activeProgramUuid: "demo-program",
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${userId}|${session}` };
    }
    return {
      system: await user("system", true, []),
      programAdmin: await user("program-admin", false),
    };
  });
  return {
    t,
    system: t.withIdentity(ids.system),
    programAdmin: t.withIdentity(ids.programAdmin),
  };
}
const record = (
  t: Awaited<ReturnType<typeof setup>>["t"],
  patch: Record<string, unknown> = {},
) =>
  t.mutation(
    internal.backups.recordOffsiteCopy,
    copy(patch) as ReturnType<typeof copy>,
  );

it("records a copy and shows the newest one, with the newest monthly copy, to system administrators", async () => {
  const { t, system } = await setup();
  expect(await system.query(api.backups.latestOffsiteCopy, {})).toBeNull();

  const monthlyAt = Date.now() - 50 * hour;
  await record(t, {
    completedAt: monthlyAt,
    objectKey: "daily/2026/11/01/angelone-20261101T084000Z.zip.age",
    monthlyKey: "monthly/2026-11/angelone-20261101T084000Z.zip.age",
  });
  expect(await system.query(api.backups.latestOffsiteCopy, {})).toEqual({
    completedAt: monthlyAt,
    bytes: 123_456_789,
    objectKey: "daily/2026/11/01/angelone-20261101T084000Z.zip.age",
    monthlyKey: "monthly/2026-11/angelone-20261101T084000Z.zip.age",
    envUploaded: true,
    monthlyCompletedAt: monthlyAt,
  });

  const latest = copy({ envUploaded: false });
  await record(t, latest);
  // Recorded in any order: the newest by completedAt wins.
  await record(t, {
    completedAt: monthlyAt - 24 * hour,
    objectKey: "daily/2026/10/31/angelone-20261031T084000Z.zip.age",
  });
  expect(await system.query(api.backups.latestOffsiteCopy, {})).toEqual({
    completedAt: latest.completedAt,
    bytes: latest.bytes,
    objectKey: latest.objectKey,
    monthlyKey: undefined,
    envUploaded: false,
    monthlyCompletedAt: monthlyAt,
  });
  const rows = await t.run((ctx) => ctx.db.query("backupRuns").collect());
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.recordedAt >= r.completedAt)).toBe(true);
  // Not a change to a record: no change-log row.
  expect(await t.run((ctx) => ctx.db.query("audit").collect())).toEqual([]);
});

it("treats a retried call for the same copy as one copy", async () => {
  const { t } = await setup();
  const same = copy();
  const first = await record(t, same);
  expect(await record(t, same)).toBe(first);
  await expect(record(t, { ...same, bytes: 1 })).rejects.toThrow(
    "This copy is already recorded with different details.",
  );
  expect(
    await t.run((ctx) => ctx.db.query("backupRuns").collect()),
  ).toHaveLength(1);
});

it("rejects input that breaks the backup job's contract", async () => {
  const { t } = await setup();
  for (const [patch, message] of [
    [
      { objectKey: "monthly/2026-11/x.zip.age" },
      'objectKey must start with "daily/" and end with ".zip.age".',
    ],
    [{ objectKey: "daily/2026/11/04/x.zip" }, 'end with ".zip.age"'],
    [{ objectKey: "daily/.zip.age" }, "objectKey must start"],
    [
      { objectKey: "daily/" + "x".repeat(1024) + ".zip.age" },
      "objectKey must start",
    ],
    [
      { monthlyKey: "daily/2026/11/04/x.zip.age" },
      'monthlyKey must start with "monthly/".',
    ],
    [{ monthlyKey: "" }, "monthlyKey must start"],
    [
      { sha256: "A".repeat(64) },
      "sha256 must be 64 lowercase hexadecimal characters.",
    ],
    [{ sha256: "a".repeat(63) }, "sha256 must be 64"],
    [{ sha256: "g".repeat(64) }, "sha256 must be 64"],
    [{ bytes: 0 }, "bytes must be a positive whole number."],
    [{ bytes: -5 }, "bytes must be a positive whole number."],
    [{ bytes: 1.5 }, "bytes must be a positive whole number."],
    [{ completedAt: 0 }, "completedAt must be a time in epoch milliseconds."],
    [
      { completedAt: Date.now() + 11 * 60_000 },
      "completedAt is more than 10 minutes in the future.",
    ],
  ] as const)
    await expect(record(t, patch)).rejects.toThrow(message);
  await expect(
    t.mutation(internal.backups.recordOffsiteCopy, {
      ...copy(),
      bytes: "12",
    } as never),
  ).rejects.toThrow();
  expect(await t.run((ctx) => ctx.db.query("backupRuns").collect())).toEqual(
    [],
  );
  // Slightly ahead of the server clock is fine (the job's clock may drift).
  await record(t, { completedAt: Date.now() + 5 * 60_000 });
});

it("shows the newest copy only to system administrators", async () => {
  const { t, programAdmin } = await setup();
  await record(t);
  await expect(
    programAdmin.query(api.backups.latestOffsiteCopy, {}),
  ).rejects.toThrow("Administrator permission required.");
  await expect(t.query(api.backups.latestOffsiteCopy, {})).rejects.toThrow(
    "An active account and session are required.",
  );
});
