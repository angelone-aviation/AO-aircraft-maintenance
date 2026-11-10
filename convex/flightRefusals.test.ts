/**
 * Responsibility: Pins that each refusal a queued flight can meet on the
 *   server reaches the Sync center with its reason (a ConvexError), not as
 *   production's generic "Server Error".
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/operations.ts (submit), convex/schema.ts,
 *   src/data/demo.ts, src/domain/model.ts (types).
 */
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import type { FlightInput } from "../src/domain/model";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

async function fixture() {
  const t = convexTest(schema, modules);
  const a = demoSnapshot().aircraft[0];
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    const group = await ctx.db.insert("groups", {
      programUuid: "demo-program",
      name: "Pilots",
      aircraftIds: [a.uuid],
      permissions: ["read", "flight", "discrepancy"],
    });
    const user = await ctx.db.insert("users", {
      name: "Pilot",
      active: true,
      isAdmin: false,
      activeProgramUuid: "demo-program",
      groupIds: [group],
    });
    const removed = await ctx.db.insert("users", {
      name: "Removed copilot",
      active: true,
      isAdmin: false,
      groupIds: [],
    });
    const inactive = await ctx.db.insert("users", {
      name: "Inactive copilot",
      active: false,
      isAdmin: false,
      groupIds: [group],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + 86400000,
    });
    await ctx.db.insert("aircraft", a);
    return { user, removed, inactive, session };
  });
  const pilot = t.withIdentity({ subject: ids.user + "|" + ids.session });
  const input: FlightInput = {
    aircraftUuid: a.uuid,
    pilotId: ids.user,
    startTime: "2026-01-01T10:00:00Z",
    hobbsOn: a.currentHobbs + 3600,
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
  const refusal = (change: Partial<FlightInput>) =>
    pilot
      .mutation(api.operations.submit, {
        operation: {
          programUuid: "demo-program",
          kind: "flight" as const,
          uuid: crypto.randomUUID(),
          authorId: ids.user,
          baseVersion: a.version,
          input: { ...input, ...change },
        },
      })
      .then(
        () => {
          throw new Error("Expected a refusal.");
        },
        (error: unknown) => error,
      );
  return { ids, refusal };
}

// Production shows a user only a ConvexError's data; any other server error
// reaches the device as "[CONVEX M(operations:submit)] ... Server Error" and
// the Sync center prints the generic "Something went wrong" text for it.
describe("a refused flight reaches the Sync center with its reason", () => {
  it("a copilot no longer in the program (docs/offline.md's own example)", async () => {
    const { ids, refusal } = await fixture();
    expect(await refusal({ copilotId: ids.removed })).toMatchObject({
      name: "ConvexError",
      data: "Pilot must belong to this Flight Program.",
    });
  });
  it("a copilot deactivated while the entry waited", async () => {
    const { ids, refusal } = await fixture();
    expect(await refusal({ copilotId: ids.inactive })).toMatchObject({
      name: "ConvexError",
      data: "Select an active copilot.",
    });
  });
  it("a device clock more than five minutes ahead of the server", async () => {
    const { refusal } = await fixture();
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(await refusal({ startTime: ahead })).toMatchObject({
      name: "ConvexError",
      data: "Flight time cannot be in the future.",
    });
  });
  it("a reading the aircraft's meter now requires", async () => {
    const { refusal } = await fixture();
    expect(await refusal({ hobbsOn: undefined })).toMatchObject({
      name: "ConvexError",
      data: "The hobbs reading is required for this aircraft.",
    });
  });
  it("a guided flight whose checklist was removed while the entry waited", async () => {
    const { refusal } = await fixture();
    const at = "2026-01-01T09:30:00.000Z";
    const checklistRun = {
      sessionUuid: crypto.randomUUID(),
      checklistUuid: crypto.randomUUID(),
      checklistVersion: 1,
      checklistName: "Normal procedures",
      startedAt: at,
      metersVerifiedAt: at,
      preflight: { hobbs: 0, tach: 0 },
      checked: [],
      skipped: [],
      totalChecks: 0,
    };
    expect(await refusal({ checklistRun })).toMatchObject({
      name: "ConvexError",
      data: "Checklist is unavailable for this aircraft or Flight Program.",
    });
  });
});
