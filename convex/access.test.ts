/**
 * Responsibility: Pins who counts as signed in, the class and message of each
 *   access refusal, and the shape of a new change-log row.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/access.ts, convex/schema.ts, src/data/demo.ts (fixture).
 *
 * convex-test does not redact errors as production does, so the refusals are
 * checked by class: only a ConvexError keeps its message in production.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  activeIdentity,
  admin,
  aircraftByUuid,
  auditRow,
  authorized,
  member,
} from "./access";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY = 86400000;

async function fixture() {
  const t = convexTest(schema, modules);
  const aircraft = demoSnapshot().aircraft[0];
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("aircraft", aircraft);
    const user = (active: boolean) =>
      ctx.db.insert("users", {
        name: "Mechanic",
        active,
        isAdmin: false,
        activeProgramUuid: "demo-program",
        groupIds: [],
      });
    const session = (userId: Id<"users">, expiresIn = DAY) =>
      ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + expiresIn,
      });
    const mechanic = await user(true);
    const inactive = await user(false);
    return {
      mechanic,
      current: await session(mechanic),
      expired: await session(mechanic, -1),
      inactive,
      inactiveSession: await session(inactive),
    };
  });
  const as = (userId: Id<"users">, sessionId: Id<"authSessions">) =>
    t.withIdentity({ subject: `${userId}|${sessionId}` });
  return { t, aircraft, ids, as };
}

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

it("counts only an active account with its own unexpired session as signed in", async () => {
  const { t, ids, as } = await fixture();
  const signedIn = async (ctx: MutationCtx) =>
    (await activeIdentity(ctx))?.user._id ?? null;
  expect(await as(ids.mechanic, ids.current).run(signedIn)).toBe(ids.mechanic);
  expect(await as(ids.mechanic, ids.expired).run(signedIn)).toBeNull();
  expect(await as(ids.inactive, ids.inactiveSession).run(signedIn)).toBeNull();
  expect(await as(ids.mechanic, ids.inactiveSession).run(signedIn)).toBeNull();
  expect(await t.run(signedIn)).toBeNull();
});

it("refuses a lapsed session with a plain Error and access with a ConvexError", async () => {
  const { t, ids, as, aircraft } = await fixture();
  const lapsed = await refusal(t.run((ctx) => admin(ctx)));
  expect(lapsed).toMatchObject({
    message: "An active account and session are required.",
  });
  expect(lapsed).not.toBeInstanceOf(ConvexError);
  const mechanic = as(ids.mechanic, ids.current);
  expect(await refusal(mechanic.run((ctx) => admin(ctx)))).toMatchObject({
    name: "ConvexError",
    data: "Administrator permission required.",
  });
  expect(
    await refusal(
      mechanic.run((ctx) => authorized(ctx, aircraft.uuid, "maintenance")),
    ),
  ).toMatchObject({
    name: "ConvexError",
    data: "You do not have permission for this aircraft.",
  });
});

it("finds an aircraft by uuid or refuses with a ConvexError", async () => {
  const { t, aircraft } = await fixture();
  expect(
    await t.run(async (ctx) => (await aircraftByUuid(ctx, aircraft.uuid)).uuid),
  ).toBe(aircraft.uuid);
  expect(
    await refusal(t.run((ctx) => aircraftByUuid(ctx, "unknown"))),
  ).toMatchObject({ name: "ConvexError", data: "Aircraft not found." });
});

it("fills a member's unset name, email and flags", () => {
  const stored: Doc<"users"> = {
    _id: "user-1" as Id<"users">,
    _creationTime: 0,
    isAdmin: false,
  };
  expect(member(stored)).toMatchObject({
    id: "user-1",
    name: "Unnamed user",
    email: "",
    active: false,
    isAdmin: false,
    groupIds: [],
  });
});

it("stamps a new change-log row with a fresh uuid and JSON values", () => {
  const first = auditRow("actor", "plan.saved", "plan-1", {
    before: { found: 0 },
  });
  expect(first).toMatchObject({
    actorId: "actor",
    action: "plan.saved",
    entityUuid: "plan-1",
    before: '{"found":0}',
    after: undefined,
  });
  expect(auditRow("actor", "plan.saved", "plan-1").uuid).not.toBe(first.uuid);
});
