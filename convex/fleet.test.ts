/**
 * Responsibility: Pins the fleet mutation's stored rows: an aircraft save
 *   that moves installed component baselines, and the refusals for an
 *   aircraft uuid or registration held elsewhere.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/fleet, convex/collections, src/data/demo,
 *   src/domain/fleet, tests/fixtures/workOrders.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { aircraftInputSchema } from "../src/domain/fleet";
import { decode } from "./collections";
import { workOrderComponent } from "../tests/fixtures/workOrders";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const ADJUSTMENT_SECONDS = 360000;

// The demo program and an administrator, with an engine installed on the
// first aircraft and a foreign aircraft holding another registration.
async function fixture() {
  const t = convexTest(schema, modules);
  const s = demoSnapshot();
  const engine = { ...workOrderComponent(), programUuid: PROGRAM };
  const subject = await t.run(async (ctx) => {
    await ctx.db.insert("programs", s.programs![0]);
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("aircraft", {
      ...s.aircraft[1],
      uuid: "foreign-plane",
      registration: "N999OT",
      programUuid: "other",
    });
    await ctx.db.insert("management", {
      programUuid: PROGRAM,
      uuid: engine.uuid,
      kind: engine.kind,
      aircraftUuid: engine.aircraftUuid,
      payload: JSON.stringify(engine),
    });
    const id = await ctx.db.insert("users", {
      name: "Administrator",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: id,
      expirationTime: Date.now() + 86400000,
    });
    return `${id}|${session}`;
  });
  const admin = t.withIdentity({ subject });
  const save = (aircraft: unknown) =>
    admin.mutation(api.fleet.save, {
      programUuid: PROGRAM,
      payload: JSON.stringify({
        requestUuid: crypto.randomUUID(),
        reason: "Verified aircraft records",
        action: "aircraft.save",
        aircraft,
      }),
    });
  return { t, aircraft: s.aircraft[0], engine, save };
}

it("moves an installed component's baseline with the aircraft's readings", async () => {
  const { t, aircraft, engine, save } = await fixture();
  await save({
    ...aircraftInputSchema.parse(aircraft),
    adjustmentSeconds: aircraft.adjustmentSeconds + ADJUSTMENT_SECONDS,
  });
  const row = await t.run((ctx) =>
    ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", engine.uuid))
      .unique(),
  );
  const { _id, _creationTime, ...stored } = row!;
  expect(stored).toEqual({
    programUuid: PROGRAM,
    uuid: engine.uuid,
    kind: engine.kind,
    aircraftUuid: engine.aircraftUuid,
    payload: JSON.stringify({
      ...decode("management", [{ payload: JSON.stringify(engine) }])[0],
      installedSeconds: engine.installedSeconds + ADJUSTMENT_SECONDS,
      installedCycles: engine.installedCycles,
      version: engine.version + 1,
    }),
  });
});

it("refuses an aircraft uuid or registration held elsewhere, as a ConvexError", async () => {
  const { aircraft, save } = await fixture();
  const input = aircraftInputSchema.parse(aircraft);
  await expect(
    save({ ...input, uuid: "foreign-plane", registration: "N1NEW" }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Aircraft belongs to another Flight Program.",
  });
  await expect(
    save({ ...input, registration: "N999OT" }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "This registration cannot be used.",
  });
});
