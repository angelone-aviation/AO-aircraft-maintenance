/**
 * Responsibility: Pins what the workspace snapshot returns to each kind of
 *   view at one year of records, before its reads are made cheaper.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/operations.ts, convex/schema.ts,
 *   tests/fixtures/programVolume.ts, tests/fixtures/storedCollections.ts,
 *   src/data/demo.ts, src/domain/model.ts (types).
 *
 * The goldens hold what each role received before the snapshot's reads were
 * made cheaper; that change must leave them byte for byte as they are.
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { seedProgramVolume } from "../tests/fixtures/programVolume";
import {
  PROGRAM,
  seedStoredCollections,
} from "../tests/fixtures/storedCollections";
import { demoSnapshot } from "../src/data/demo";
import type { Snapshot } from "../src/domain/model";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const SEEDED_AT = Date.UTC(2026, 10, 3, 12);
const N206 = demoSnapshot().aircraft[0].uuid;
const SECOND_CARD = "00000000-0000-4000-8000-00000000beef";
const ROLES = ["admin", "pilot", "owner", "board"] as const;
// Seeding about ten thousand rows takes a while on a shared machine.
const VOLUME_TIMEOUT_MS = 120_000;

afterEach(() => vi.useRealTimers());

it(
  "returns every role at one year of records what it returned before",
  async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
    const t = convexTest(schema, modules);
    const { accounts } = await t.run((ctx) =>
      seedProgramVolume(ctx, SEEDED_AT),
    );
    const digests: Record<string, { bytes: number; sha256: string }> = {};
    for (const role of ROLES)
      digests[role] = await digest(
        await t
          .withIdentity({ subject: accounts[role] })
          .query(api.operations.snapshot, {}),
      );
    await expect(JSON.stringify(digests, null, 1)).toMatchFileSnapshot(
      "./__golden__/snapshot.volume.json",
    );
  },
  VOLUME_TIMEOUT_MS,
);

it("returns the owner and board views it returned before", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
  const t = convexTest(schema, modules);
  const subjects = await t.run(async (ctx) => {
    const { admin } = await seedStoredCollections(ctx);
    await ctx.db.insert("taskEvidence", {
      taskCardUuid: (await ctx.db.query("taskCards").first())!.uuid,
      storageId: await ctx.storage.store(new Blob(["%PDF-1.4"])),
      name: "evidence.pdf",
      size: 8,
      uploadedAt: SEEDED_AT,
      category: "photo",
    });
    return {
      admin: admin.subject,
      owner: await reducedAccount(ctx, { owner: true, aircraftIds: [N206] }),
      board: await reducedAccount(ctx, { board: true, aircraftIds: [] }),
    };
  });
  for (const view of ["owner", "board"] as const) {
    const s = await t
      .withIdentity({ subject: subjects[view] })
      .query(api.operations.snapshot, {});
    expect(s!.aircraft.length, view).toBeGreaterThan(0);
    await expect(JSON.stringify(s, null, 1)).toMatchFileSnapshot(
      `./__golden__/snapshot.${view}.json`,
    );
  }
});

it("keeps each job card's evidence together, in job-card order", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: SEEDED_AT });
  const t = convexTest(schema, modules);
  const subject = await t.run(async (ctx) => {
    const { admin } = await seedStoredCollections(ctx);
    const first = (await ctx.db.query("taskCards").first())!;
    await ctx.db.insert("taskCards", {
      uuid: SECOND_CARD,
      aircraftUuid: first.aircraftUuid,
      payload: first.payload.replace(first.uuid, SECOND_CARD),
    });
    const blob = await ctx.storage.store(new Blob(["%PDF-1.4"]));
    for (const [card, name] of [
      [SECOND_CARD, "b1"],
      [first.uuid, "a1"],
      [SECOND_CARD, "b2"],
    ])
      await ctx.db.insert("taskEvidence", {
        taskCardUuid: card,
        storageId: blob,
        name,
        size: 8,
        uploadedAt: SEEDED_AT,
        category: "photo",
      });
    return admin.subject;
  });
  const s = await t
    .withIdentity({ subject })
    .query(api.operations.snapshot, {});
  expect(s!.taskEvidence!.map((e) => e.name)).toEqual(["a1", "b1", "b2"]);
});

async function reducedAccount(
  ctx: Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0],
  group: { owner?: boolean; board?: boolean; aircraftIds: string[] },
) {
  const groupId = await ctx.db.insert("groups", {
    programUuid: PROGRAM,
    name: group.owner ? "Owners" : "Board",
    permissions: ["read"],
    ...group,
  });
  const id = await ctx.db.insert("users", {
    name: group.owner ? "Owner" : "Board member",
    active: true,
    isAdmin: false,
    activeProgramUuid: PROGRAM,
    groupIds: [groupId],
  });
  const session = await ctx.db.insert("authSessions", {
    userId: id,
    expirationTime: Date.now() + 86_400_000,
  });
  return `${id}|${session}`;
}

// syncedAt is the query's clock reading, not a record.
async function digest(s: Snapshot | null) {
  const text = JSON.stringify({ ...s, syncedAt: undefined });
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  const sha256 = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { bytes: text.length, sha256 };
}
