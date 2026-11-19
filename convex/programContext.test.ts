/**
 * Responsibility: Pins the Flight Program context check and what the scoped
 *   loaders add beyond their index: legacy, removed-component and settings
 *   rows, and the History list's limit and order.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/programContext.ts, convex/schema.ts, src/data/demo.ts
 *   (fixture).
 *
 * convex-test does not redact errors as production does, so the refusals are
 * checked by class: only a ConvexError keeps its message in production.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import {
  AUDIT_LIMIT,
  auditDocs,
  checkContext,
  costDocs,
  inspectionDocs,
  managementDocs,
} from "./programContext";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const STALE = "Flight Program changed. Reopen the form in the correct program.";

async function fixture() {
  const t = convexTest(schema, modules);
  const s = demoSnapshot();
  const identities = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    const group = (owner: boolean) =>
      ctx.db.insert("groups", {
        programUuid: PROGRAM,
        name: owner ? "Owners" : "Maintenance",
        owner,
        aircraftIds: [],
        permissions: ["read"],
      });
    const user = async (isAdmin: boolean, groupIds: string[]) => {
      const id = await ctx.db.insert("users", {
        name: "User",
        active: true,
        isAdmin,
        activeProgramUuid: PROGRAM,
        groupIds: groupIds.map((g) => ctx.db.normalizeId("groups", g)!),
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${id}|${session}` };
    };
    return {
      member: await user(false, [await group(false)]),
      owner: await user(false, [await group(true)]),
      unassigned: await user(false, []),
      admin: await user(true, []),
    };
  });
  const check =
    (identity: { subject: string } | undefined) => (expected?: string) => {
      const as = identity ? t.withIdentity(identity) : t;
      return as.run(async (ctx) => {
        await checkContext(ctx, expected);
        return null;
      });
    };
  return {
    t,
    member: check(identities.member),
    owner: check(identities.owner),
    unassigned: check(identities.unassigned),
    admin: check(identities.admin),
    signedOut: check(undefined),
  };
}

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

it("passes a member or administrator acting in their active program", async () => {
  const f = await fixture();
  expect(await f.member(PROGRAM)).toBeNull();
  expect(await f.admin(PROGRAM)).toBeNull();
});

it("refuses as a ConvexError, permission first, then owner access, then a stale program", async () => {
  const f = await fixture();
  // Unassigned has no read permission and no active program: both apply.
  expect(await refusal(f.unassigned(PROGRAM))).toMatchObject({
    name: "ConvexError",
    data: "Flight Program permission denied.",
  });
  expect(await refusal(f.owner("another-program"))).toMatchObject({
    name: "ConvexError",
    data: "Aircraft owner access is read-only.",
  });
  expect(await refusal(f.member("another-program"))).toMatchObject({
    name: "ConvexError",
    data: STALE,
  });
  expect(await refusal(f.admin(undefined))).toMatchObject({ data: STALE });
});

it("refuses a missing session with a plain Error", async () => {
  const f = await fixture();
  const error = await refusal(f.signedOut(PROGRAM));
  expect(error).toMatchObject({
    message: "An active account and session are required.",
  });
  expect(error).not.toBeInstanceOf(ConvexError);
});

it("adds legacy records without a program, and reads only those without one", async () => {
  const f = await fixture();
  const uuids = await f.t.run(async (ctx) => {
    for (const [uuid, programUuid] of [
      ["mine", PROGRAM],
      ["legacy", undefined],
      ["theirs", "another-program"],
    ])
      await ctx.db.insert("management", {
        uuid: uuid!,
        programUuid,
        kind: "vendor",
        payload: "{}",
      });
    const of = async (program?: string) =>
      (await managementDocs(ctx, program)).map((d) => d.uuid);
    return { program: await of(PROGRAM), none: await of(undefined) };
  });
  expect(uuids).toEqual({ program: ["mine", "legacy"], none: ["legacy"] });
});

it("adds each inspection of a removed component once", async () => {
  const f = await fixture();
  const [onAircraft] = demoSnapshot().inspections;
  const uuids = await f.t.run(async (ctx) => {
    const component = (uuid: string, aircraftUuid?: string) =>
      ctx.db.insert("management", {
        uuid,
        programUuid: PROGRAM,
        kind: "component",
        aircraftUuid,
        payload: "{}",
      });
    await component("removed");
    await component("installed", onAircraft.aircraftUuid);
    await ctx.db.insert("inspections", onAircraft);
    await ctx.db.insert("inspections", {
      ...onAircraft,
      uuid: "removed-inspection",
      aircraftUuid: "",
      componentUuid: "removed",
    });
    // On the aircraft and listed under a removed component too.
    await ctx.db.insert("inspections", {
      ...onAircraft,
      uuid: "both",
      componentUuid: "removed",
    });
    const management = await managementDocs(ctx, PROGRAM);
    const aircraft = [{ uuid: onAircraft.aircraftUuid }];
    return (await inspectionDocs(ctx, aircraft, management)).map((d) => d.uuid);
  });
  expect(uuids.sort()).toEqual(
    [onAircraft.uuid, "both", "removed-inspection"].sort(),
  );
});

it("reads the program's cost records by program, whichever aircraft they name (AC-10)", async () => {
  const f = await fixture();
  const uuids = await f.t.run(async (ctx) => {
    for (const [uuid, aircraftUuid, programUuid] of [
      ["cost", "demo-206", PROGRAM],
      ["settings", "", PROGRAM],
      ["departed", "sold-aircraft", PROGRAM],
      ["other-settings", "", "another-program"],
      ["paid-elsewhere", "demo-206", "another-program"],
    ])
      await ctx.db.insert("costs", {
        uuid,
        aircraftUuid,
        programUuid,
        payload: "{}",
      });
    const of = async (program?: string) =>
      (await costDocs(ctx, program)).map((d) => d.uuid);
    return { program: await of(PROGRAM), none: await of(undefined) };
  });
  expect(uuids).toEqual({
    program: ["cost", "departed", "settings"],
    none: [],
  });
});

it("keeps the History list to the newest AUDIT_LIMIT rows, each once", async () => {
  const f = await fixture();
  const at = await f.t.run(async (ctx) => {
    // Each row is both the program's and the aircraft's.
    for (let i = 0; i < AUDIT_LIMIT + 10; i++)
      await ctx.db.insert("audit", {
        uuid: `row-${i}`,
        programUuid: PROGRAM,
        aircraftUuid: "demo-206",
        actorId: "someone",
        at: i,
        action: "test",
        entityUuid: "record",
      });
    return (await auditDocs(ctx, PROGRAM, [{ uuid: "demo-206" }])).map(
      (d) => d.at,
    );
  });
  expect(at).toHaveLength(AUDIT_LIMIT);
  expect(at[0]).toBe(AUDIT_LIMIT + 9);
  expect(new Set(at).size).toBe(AUDIT_LIMIT);
  expect(at).toEqual([...at].sort((a, b) => b - a));
});
