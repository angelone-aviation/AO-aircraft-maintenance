/**
 * Responsibility: Pins the flight-plan mutation's change-log rows and its
 *   refusal of a plan uuid stored on another aircraft.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/flightPlans, src/data/demo.
 */
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
const DAY_MS = 86_400_000;

// Seeds the demo program's aircraft and a system administrator acting in it.
async function fixture() {
  const t = convexTest(schema, modules),
    s = demoSnapshot();
  const subject = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    const userId = await ctx.db.insert("users", {
      name: "Administrator",
      active: true,
      isAdmin: true,
      groupIds: [],
      activeProgramUuid: "demo-program",
    });
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + DAY_MS,
    });
    return `${userId}|${sessionId}`;
  });
  const admin = t.withIdentity({ subject });
  const save = (plan: object, baseVersion: number) =>
    admin.mutation(api.flightPlans.save, {
      programUuid: "demo-program",
      payload: JSON.stringify({ plan, baseVersion }),
    });
  const stored = () =>
    t.run(async (ctx) => ({
      plans: await ctx.db.query("flightPlans").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
  return { t, plan: proposedPlan(s.aircraft[0]), save, stored };
}

it("writes plan.saved, then plan.cancelled with the plan before and after", async () => {
  const { plan, save, stored } = await fixture();
  expect(await save(plan, 0)).toBe(plan.uuid);
  await save({ ...plan, version: 1, status: "cancelled" }, 1);
  const rows = (await stored()).audit.filter((a) => a.entityUuid === plan.uuid);
  expect(rows.map((a) => a.action)).toEqual(["plan.saved", "plan.cancelled"]);
  expect(rows[0].before).toBeUndefined();
  expect(JSON.parse(rows[1].before!)).toMatchObject({
    status: "proposed",
    version: 1,
  });
  expect(JSON.parse(rows[1].after!)).toMatchObject({
    status: "cancelled",
    version: 2,
  });
});

it("refuses a plan uuid stored on another aircraft, and writes nothing", async () => {
  const { t, plan, save, stored } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("flightPlans", {
      uuid: plan.uuid,
      aircraftUuid: "other-aircraft",
      payload: "{}",
    }),
  );
  const before = await stored();
  await expect(save(plan, 0)).rejects.toMatchObject({
    name: "ConvexError",
    data: "Plan ID already used.",
  });
  expect(await stored()).toEqual(before);
});

// A proposed plan as a PDF import produces it.
function proposedPlan(aircraft: { uuid: string; registration: string }) {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    aircraftUuid: aircraft.uuid,
    registration: aircraft.registration,
    departureAt: "2026-09-30T22:05:00Z",
    origin: "MZBZ",
    destination: "KCHA",
    alternate: "KRZR",
    durationMinutes: 293,
    cycles: 1,
    landings: 1,
    flightRules: "I",
    aircraftType: "C441",
    flightType: "G",
    speed: "N0255",
    level: "F270",
    route: "DCT",
    pilotText: "Demo",
    equipment: "SGR / CB1",
    otherInformation: "",
    sourceName: "test.pdf",
    sourceHash: "a".repeat(64),
    status: "proposed",
    createdAt: Date.now(),
  };
}
