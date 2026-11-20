/**
 * Responsibility: Pins the snapshot query and the problem-report, flight
 *   submission and review mutations: authorization, idempotent retries, held
 *   flights, resolution and deferral with their change-log rows, flight
 *   plans, profiles, checklists and oil.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/operations.ts, convex/schema.ts, convex/values, zod,
 *   src/domain (model, management), src/data/demo.ts (fixture).
 */
import type { ManagedRecord } from "../src/domain/management";
import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import { ConvexError } from "convex/values";
import { ZodError } from "zod";
import { api } from "./_generated/api";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import { localDate, type FlightInput } from "../src/domain/model";
import {
  MAX_OPEN_REPORTS_PER_MEMBER,
  REPORT_LIMIT_REFUSAL,
} from "../src/domain/reportBacklog";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const DAY_MS = 86_400_000;
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
      email: "pilot@example.test",
      active: true,
      isAdmin: false,
      groupIds: [group],
    });
    const admin = await ctx.db.insert("users", {
      name: "Admin",
      email: "admin@example.test",
      active: true,
      isAdmin: true,
      groupIds: [],
    });
    const outsider = await ctx.db.insert("users", {
      name: "Other",
      active: true,
      isAdmin: false,
      groupIds: [],
    });
    const session = await ctx.db.insert("authSessions", {
      userId: user,
      expirationTime: Date.now() + 86400000,
    });
    await ctx.db.insert("aircraft", a);
    await ctx.db.insert("aircraft", {
      ...a,
      uuid: "secret-aircraft",
      registration: "SECRET",
    });
    const adminSession = await ctx.db.insert("authSessions", {
      userId: admin,
      expirationTime: Date.now() + 86400000,
    });
    const outsiderSession = await ctx.db.insert("authSessions", {
      userId: outsider,
      expirationTime: Date.now() + 86400000,
    });
    return {
      user,
      admin,
      outsider,
      group,
      session,
      adminSession,
      outsiderSession,
    };
  });
  const pilot = t.withIdentity({ subject: ids.user + "|" + ids.session });
  const admin = t.withIdentity({ subject: ids.admin + "|" + ids.adminSession });
  const outsider = t.withIdentity({
    subject: ids.outsider + "|" + ids.outsiderSession,
  });
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
  const op = () => ({
    programUuid: "demo-program",
    kind: "flight" as const,
    uuid: crypto.randomUUID(),
    authorId: ids.user,
    baseVersion: 0,
    input,
  });
  return { t, pilot, admin, outsider, ids, a, input, op };
}
describe("the per-member open-report limit (D2)", () => {
  it("refuses a synced report or a flight's report past it, never a resend, and frees room on a resolution", async () => {
    const { t, pilot, admin, ids, a, op } = await fixture();
    await t.run(async (ctx) => {
      // Half on an aircraft the pilot cannot see: the limit is the
      // program's whole workspace, not the pilot's view of it.
      for (let i = 0; i < MAX_OPEN_REPORTS_PER_MEMBER; i++)
        await ctx.db.insert("discrepancies", {
          uuid: `open-${i}`,
          aircraftUuid: i % 2 ? a.uuid : "secret-aircraft",
          description: "Short",
          status: "open",
          authorId: ids.user,
          createdAt: 0,
        });
    });
    const report = {
      programUuid: "demo-program",
      kind: "discrepancy" as const,
      uuid: crypto.randomUUID(),
      authorId: ids.user,
      aircraftUuid: a.uuid,
      description: "One more",
    };
    const submit = (operation: unknown) =>
      pilot.mutation(api.operations.submit, { operation } as never);
    const reports = () =>
      t.run(
        async (ctx) => (await ctx.db.query("discrepancies").collect()).length,
      );
    // A ConvexError, so the Sync center keeps the entry with this message.
    await expect(submit(report)).rejects.toMatchObject({
      name: "ConvexError",
      data: REPORT_LIMIT_REFUSAL,
    });
    expect(await reports()).toBe(MAX_OPEN_REPORTS_PER_MEMBER);
    await admin.mutation(api.operations.resolveDiscrepancy, {
      programUuid: "demo-program",
      uuid: "open-1",
      resolution: "Fixed",
    });
    expect(await submit(report)).toEqual({ status: "accepted" });
    expect(await submit(report)).toEqual({ status: "accepted" });
    const flight = op();
    await expect(
      submit({
        ...flight,
        input: { ...flight.input, discrepancy: "Brake soft" },
      }),
    ).rejects.toMatchObject({ data: REPORT_LIMIT_REFUSAL });
    expect(await submit(flight)).toEqual({ status: "accepted" });
  });
});

describe("server authorization", () => {
  it("rejects anonymous writes and aircraft access outside the user group", async () => {
    const { t, pilot, outsider, op } = await fixture();
    await expect(
      t.mutation(api.operations.submit, { operation: op() }),
    ).rejects.toThrow("active");
    await expect(
      outsider.mutation(api.operations.submit, { operation: op() }),
    ).rejects.toThrow("permission");
    await expect(
      pilot.mutation(api.operations.submit, {
        operation: {
          ...op(),
          input: { ...op().input, aircraftUuid: "secret-aircraft" },
        },
      }),
    ).rejects.toThrow("permission");
  });
  it("filters cached snapshots by aircraft access and hides other user emails", async () => {
    const { pilot, ids } = await fixture();
    const s = await pilot.query(api.operations.snapshot, {});
    expect(s!.aircraft.map((a) => a.uuid)).toEqual(["demo-206"]);
    expect(s!.members.find((m) => m.id === ids.admin)).toBeUndefined();
    expect(s!.authenticatedAt).toBeGreaterThan(0);
  });
  it("rechecks revoked permissions when offline entries reconnect", async () => {
    const { t, pilot, ids, op } = await fixture();
    await t.run(async (ctx) => ctx.db.patch(ids.user, { groupIds: [] }));
    await expect(
      pilot.mutation(api.operations.submit, { operation: op() }),
    ).rejects.toThrow("permission");
    expect(
      (await pilot.query(api.operations.snapshot, {}))!.aircraft,
    ).toHaveLength(0);
  });
  it("rejects author spoofing and inactive users", async () => {
    const { t, pilot, ids, op } = await fixture();
    await expect(
      pilot.mutation(api.operations.submit, {
        operation: { ...op(), authorId: ids.admin },
      }),
    ).rejects.toThrow("different user");
    await t.run(async (ctx) => ctx.db.patch(ids.user, { active: false }));
    expect(await pilot.query(api.operations.snapshot, {})).toBeNull();
    await expect(
      pilot.mutation(api.operations.submit, { operation: op() }),
    ).rejects.toThrow("active");
  });
  it("does not allow pilots to grant themselves admin or group access", async () => {
    const { pilot, ids } = await fixture();
    await expect(
      pilot.mutation(api.admin.updateUser, {
        id: ids.user,
        active: true,
        isAdmin: true,
        groupIds: [],
      }),
    ).rejects.toThrow(/[Aa]dministrator/);
    await expect(
      pilot.mutation(api.admin.saveGroup, {
        name: "Elevated",
        aircraftIds: ["secret-aircraft"],
        permissions: ["read", "resolve"],
      }),
    ).rejects.toThrow(/[Aa]dministrator/);
  });
  it("keeps at least one active administrator", async () => {
    const { admin, ids } = await fixture();
    await expect(
      admin.mutation(api.admin.updateUser, {
        id: ids.admin,
        active: false,
        isAdmin: false,
        groupIds: [],
      }),
    ).rejects.toThrow("at least one");
  });
  it("blocks the public password signup flow at the server", async () => {
    const { t } = await fixture();
    await expect(
      t.action(api.auth.signIn, {
        provider: "password",
        params: {
          flow: "signUp",
          email: "intruder@example.test",
          password: "a-long-enough-password",
        },
      }),
    ).rejects.toThrow("managed by your administrator");
  });
});
describe("flight submissions and reviews", () => {
  it("deduplicates retries including the linked discrepancy and increments totals once", async () => {
    const { t, pilot, op, a } = await fixture();
    const operation = op();
    operation.input = {
      ...operation.input,
      discrepancy: "Landing light failed",
    };
    await pilot.mutation(api.operations.submit, { operation });
    await pilot.mutation(api.operations.submit, { operation });
    const state = await t.run(async (ctx) => ({
      a: await ctx.db
        .query("aircraft")
        .withIndex("uuid", (q) => q.eq("uuid", a.uuid))
        .unique(),
      flights: await ctx.db.query("flights").collect(),
      reports: await ctx.db.query("discrepancies").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));
    expect(state.a!.cycles).toBe(a.cycles + 1);
    expect(state.flights).toHaveLength(1);
    expect(state.reports).toHaveLength(1);
    // The flight and the report it filed each have one creation row.
    expect(state.audit.map((row) => [row.action, row.entityUuid])).toEqual([
      ["flight.created", operation.uuid],
      ["discrepancy.created", `${operation.uuid}-discrepancy`],
    ]);
  });
  it("refuses a resent entry id with other readings, so the device keeps it", async () => {
    const { t, pilot, op, a } = await fixture();
    const first = op();
    await pilot.mutation(api.operations.submit, { operation: first });
    const stored = () =>
      t.run(async (ctx) => ({
        flights: await ctx.db.query("flights").collect(),
        audit: await ctx.db.query("audit").collect(),
      }));
    const before = await stored();
    // A retry of the same entry after a lost reply is answered as before.
    expect(
      await pilot.mutation(api.operations.submit, { operation: first }),
    ).toEqual({ status: "accepted" });
    const changed = {
      ...first,
      input: { ...first.input, hobbsOn: a.currentHobbs + 7200, landings: 3 },
    };
    await expect(
      pilot.mutation(api.operations.submit, { operation: changed }),
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: expect.stringMatching(
        /^This entry was already received with different readings/,
      ),
    });
    expect(await stored()).toEqual(before);
  });
  it("holds stale submissions without changing totals and preserves both records", async () => {
    const { pilot, op, a } = await fixture();
    await pilot.mutation(api.operations.submit, { operation: op() });
    const second = op();
    second.input = {
      ...second.input,
      startTime: "2026-01-02T00:00:00Z",
      hobbsOn: a.currentHobbs + 7200,
    };
    expect(
      await pilot.mutation(api.operations.submit, { operation: second }),
    ).toEqual({ status: "review" });
    const s = await pilot.query(api.operations.snapshot, {});
    expect(s!.flights).toHaveLength(2);
    expect(s!.aircraft[0].cycles).toBe(a.cycles + 1);
    expect(s!.flights.find((f) => f.uuid === second.uuid)?.status).toBe(
      "review",
    );
  });
  it("holds a flight longer than 24 hours (a decimal comma read as 23425) until an administrator accepts it", async () => {
    const { pilot, admin, op, a } = await fixture();
    const slip = op();
    // 2341.2 h then "2342,5" typed: the browser keeps 23425.
    slip.input = { ...slip.input, hobbsOn: 23425 * 3600 };
    expect(
      await pilot.mutation(api.operations.submit, { operation: slip }),
    ).toEqual({ status: "review" });
    let s = await pilot.query(api.operations.snapshot, {});
    expect(s!.aircraft[0].currentHobbs).toBe(a.currentHobbs);
    expect(s!.flights[0].reviewReason).toMatch(
      /^Hobbs reading is 21,083.8 hours past the current counter/,
    );
    // Nothing is lost: the administrator can still accept it as logged.
    await admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid: slip.uuid,
      decision: "accept",
      reason: "Ferry flight over several days, readings verified",
      input: slip.input,
    });
    s = await pilot.query(api.operations.snapshot, {});
    expect(s!.aircraft[0].currentHobbs).toBe(23425 * 3600);
    expect(s!.flights[0].status).toBe("accepted");
  });
  it("admin review accepts a valid backdated flight and rebuilds subsequent starting counters", async () => {
    const { pilot, admin, op, a } = await fixture();
    const later = op();
    later.input = {
      ...later.input,
      startTime: "2026-01-03T00:00:00Z",
      hobbsOn: a.currentHobbs + 7200,
    };
    await pilot.mutation(api.operations.submit, { operation: later });
    const earlier = op();
    earlier.baseVersion = 1;
    await pilot.mutation(api.operations.submit, { operation: earlier });
    await expect(
      pilot.mutation(api.operations.reviewFlight, {
        programUuid: "demo-program",
        uuid: earlier.uuid,
        decision: "accept",
        reason: "Verified the paper log",
        input: earlier.input,
      }),
    ).rejects.toThrow(/[Aa]dministrator/);
    await admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid: earlier.uuid,
      decision: "accept",
      reason: "Verified the paper log",
      input: earlier.input,
    });
    const s = await pilot.query(api.operations.snapshot, {});
    expect(s!.aircraft[0].currentHobbs).toBe(a.currentHobbs + 7200);
    expect(s!.aircraft[0].cycles).toBe(a.cycles + 2);
    expect(s!.flights.find((f) => f.uuid === later.uuid)?.hobbsOff).toBe(
      earlier.input.hobbsOn,
    );
    expect(
      s!.audit.some(
        (e) =>
          e.action === "flight.reviewed" && e.before && e.after && e.reason,
      ),
    ).toBe(true);
  });
  it("logs every submission and review row under the aircraft's program", async () => {
    const { t, pilot, admin, op, a, ids } = await fixture();
    const later = op();
    later.input = {
      ...later.input,
      startTime: "2026-01-03T00:00:00Z",
      hobbsOn: a.currentHobbs + 7200,
    };
    await pilot.mutation(api.operations.submit, { operation: later });
    const earlier = op();
    earlier.baseVersion = 1;
    await pilot.mutation(api.operations.submit, { operation: earlier });
    await pilot.mutation(api.operations.submit, {
      operation: {
        programUuid: "demo-program",
        kind: "discrepancy",
        uuid: crypto.randomUUID(),
        authorId: ids.user,
        aircraftUuid: a.uuid,
        description: "Landing light out",
      },
    });
    await admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid: earlier.uuid,
      decision: "accept",
      reason: "Verified the paper log",
      input: earlier.input,
    });
    const rows = await t.run((ctx) => ctx.db.query("audit").collect());
    // None of these rows named a program before T12's final round.
    expect(rows.map((r) => [r.action, r.programUuid])).toEqual([
      ["flight.created", "demo-program"],
      ["flight.held", "demo-program"],
      ["discrepancy.created", "demo-program"],
      ["flight.reviewed", "demo-program"],
      ["flight.resequenced", "demo-program"],
    ]);
  });
  it("rejects a correction that would invalidate a later flight atomically", async () => {
    const { pilot, admin, op, a } = await fixture();
    const first = op();
    await pilot.mutation(api.operations.submit, { operation: first });
    const second = {
      ...op(),
      baseVersion: 1,
      input: {
        ...op().input,
        startTime: "2026-01-03T00:00:00Z",
        hobbsOn: a.currentHobbs + 7200,
      },
    };
    await pilot.mutation(api.operations.submit, { operation: second });
    await expect(
      admin.mutation(api.operations.reviewFlight, {
        programUuid: "demo-program",
        uuid: first.uuid,
        decision: "accept",
        reason: "Attempt correction",
        input: { ...first.input, hobbsOn: a.currentHobbs + 10800 },
      }),
    ).rejects.toThrow("lower");
    const s = await pilot.query(api.operations.snapshot, {});
    expect(s!.flights.find((f) => f.uuid === first.uuid)?.hobbsOn).toBe(
      first.input.hobbsOn,
    );
  });

  // The outbox decides hold or retry by class (outboxRefusals.test.ts), so
  // showing zod refusals elsewhere (Batch 422) must not reach this path.
  it("characterizes current behaviour: refuses an entry its schema refuses with zod's own error", async () => {
    const { pilot, op } = await fixture();
    const invalid = op();
    invalid.input.fuel = { unit: "L", start: 10, added: 0, end: 20 };
    const error = await pilot
      .mutation(api.operations.submit, { operation: invalid })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZodError);
    expect(error).not.toBeInstanceOf(ConvexError);
  });
});
describe("flight review on runCommand", () => {
  it("shows review refusals as ConvexError, in order, and writes nothing", async () => {
    const { t, pilot, admin, op, a } = await fixture();
    const held = op();
    held.baseVersion = 1;
    await pilot.mutation(api.operations.submit, { operation: held });
    const stored = () =>
      t.run(async (ctx) => ({
        flights: await ctx.db.query("flights").collect(),
        aircraft: await ctx.db.query("aircraft").collect(),
        audit: await ctx.db.query("audit").collect(),
      }));
    const before = await stored();
    const review = (
      changes: Partial<FlightInput> = {},
      reason = "Checked",
      uuid: string = held.uuid,
    ) => ({
      programUuid: "demo-program",
      uuid,
      decision: "accept" as const,
      reason,
      input: { ...held.input, ...changes },
    });
    const run = { checklistRun: checklistRun(held.input.startTime, a) };
    // Batch 299: each was a plain error, which production shows as "Server
    // Error"; Batch 92's checklist Rejection was one too, thrown outside
    // runCommand.
    const refusals: [typeof admin, ReturnType<typeof review>, string][] = [
      [pilot, review(), "Flight Program administrator required."],
      [admin, review({}, "ok"), "Provide a meaningful review explanation."],
      [admin, review({}, "Checked", "missing"), "Flight not found."],
      [
        admin,
        review(run),
        "A review cannot change the recorded checklist run.",
      ],
      [
        admin,
        review({ aircraftUuid: "secret-aircraft" }),
        "A correction cannot change aircraft.",
      ],
      [admin, review({ pilotId: "ghost" }), "Pilot not found."],
      [
        admin,
        review({ hobbsOn: undefined }),
        "The hobbs reading is required for this aircraft.",
      ],
    ];
    for (const [caller, args, data] of refusals)
      await expect(
        caller.mutation(api.operations.reviewFlight, args),
      ).rejects.toMatchObject({ name: "ConvexError", data });
    expect(await stored()).toEqual(before);
  });

  it("answers another Flight Program's flight as missing, whatever the review says about its links", async () => {
    const { t, pilot, op, a } = await fixture();
    const held = op();
    held.baseVersion = 1;
    await pilot.mutation(api.operations.submit, { operation: held });
    const ids = await t.run(async (ctx) => {
      await ctx.db.insert("programs", {
        ...demoSnapshot().programs![0],
        uuid: "other-program",
        name: "Other program",
      });
      await ctx.db.insert("aircraft", {
        ...a,
        uuid: "other-aircraft",
        registration: "OTHER",
        programUuid: "other-program",
      });
      const group = await ctx.db.insert("groups", {
        programUuid: "other-program",
        name: "Managers",
        programAdmin: true,
        aircraftIds: [],
        permissions: ["read", "flight", "maintenance"],
      });
      const user = await ctx.db.insert("users", {
        name: "Other manager",
        active: true,
        isAdmin: false,
        groupIds: [group],
        activeProgramUuid: "other-program",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + 86400000,
      });
      return { user, session };
    });
    const manager = t.withIdentity({ subject: `${ids.user}|${ids.session}` });
    const flights = () => t.run((ctx) => ctx.db.query("flights").collect());
    const before = await flights();
    // Before the fix the answer named the first link that differed from the
    // stored flight, so it told an outsider what that flight links to.
    for (const changes of [{}, { flightPlanUuid: crypto.randomUUID() }])
      await expect(
        manager.mutation(api.operations.reviewFlight, {
          programUuid: "other-program",
          uuid: held.uuid,
          decision: "reject",
          reason: "Checked",
          input: { ...held.input, aircraftUuid: "other-aircraft", ...changes },
        }),
      ).rejects.toMatchObject({
        name: "ConvexError",
        data: "Flight not found.",
      });
    expect(await flights()).toEqual(before);
  });

  it("characterizes current behaviour: a malformed correction stays a plain error", async () => {
    const { pilot, admin, op, a } = await fixture();
    const held = op();
    held.baseVersion = 1;
    await pilot.mutation(api.operations.submit, { operation: held });
    const error = await admin
      .mutation(api.operations.reviewFlight, {
        programUuid: "demo-program",
        uuid: held.uuid,
        decision: "accept",
        reason: "Checked",
        input: { ...held.input, hobbsOn: a.currentHobbs + 1800 + 180 },
      })
      .catch((e: Error) => e);
    expect(error).toMatchObject({ message: /tenths of an hour/ });
    expect(error).not.toMatchObject({ name: "ConvexError" });
  });

  it("stores the reviewed flight over its row and logs it with its system fields", async () => {
    const { t, pilot, admin, op, ids } = await fixture();
    const held = op();
    held.baseVersion = 1;
    await pilot.mutation(api.operations.submit, { operation: held });
    const row = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("flights")
          .withIndex("uuid", (q) => q.eq("uuid", held.uuid))
          .unique(),
      );
    const original = (await row())!;
    const input = { ...held.input, remarks: "Paper log" };
    await admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid: held.uuid,
      decision: "accept",
      reason: "Checked",
      input,
    });
    const reviewed = (await row())!;
    expect(reviewed).toEqual({
      ...original,
      ...input,
      status: "accepted",
      reviewReason: "Checked",
      hobbsOff: original.hobbsOff,
      tachOff: original.tachOff,
    });
    const log = await t.run(async (ctx) =>
      (await ctx.db.query("audit").collect()).find(
        (r) => r.action === "flight.reviewed",
      ),
    );
    // The row names the aircraft's program (none before T12's final round).
    expect(log).toMatchObject({
      actorId: ids.admin,
      reason: "Checked",
      programUuid: "demo-program",
    });
    expect(JSON.parse(log!.before!)).toEqual(original);
    expect(JSON.parse(log!.after!)).toEqual(reviewed);
  });

  it("reviews once per request id: a replay returns nothing and writes nothing", async () => {
    const { t, pilot, admin, op } = await fixture();
    const held = op();
    held.baseVersion = 1;
    await pilot.mutation(api.operations.submit, { operation: held });
    const requestUuid = crypto.randomUUID();
    const review = (reason: string) =>
      admin.mutation(api.operations.reviewFlight, {
        programUuid: "demo-program",
        requestUuid,
        uuid: held.uuid,
        decision: "accept",
        reason,
        input: held.input,
      });
    const stored = () =>
      t.run(async (ctx) => ({
        flights: await ctx.db.query("flights").collect(),
        aircraft: await ctx.db.query("aircraft").collect(),
        audit: await ctx.db.query("audit").collect(),
        commandRequests: await ctx.db.query("commandRequests").collect(),
      }));
    await review("Checked");
    const saved = await stored();
    expect(saved.commandRequests).toMatchObject([{ uuid: requestUuid }]);
    expect(JSON.parse(saved.commandRequests[0].payload)).toEqual({
      uuid: held.uuid,
      decision: "accept",
      reason: "Checked",
      input: held.input,
    });
    // ADR-0003: a replay succeeds with no payload.
    await expect(review("Checked")).resolves.toBeNull();
    expect(await stored()).toEqual(saved);
    await expect(review("Checked again")).rejects.toMatchObject({
      data: "Request identifier already used.",
    });
    expect(await stored()).toEqual(saved);
  });

  it("clears the copilot and a reading the review leaves blank, as the demo does", async () => {
    const { t, pilot, admin, op, ids, a } = await fixture();
    const held = op();
    held.baseVersion = 1;
    held.input = {
      ...held.input,
      copilotId: ids.admin,
      tachOn: a.currentTach + 3600,
    };
    await pilot.mutation(api.operations.submit, { operation: held });
    // FlightForm sends a cleared field as undefined, which Convex drops.
    await admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid: held.uuid,
      decision: "accept",
      reason: "No copilot aboard",
      input: { ...held.input, copilotId: undefined, tachOn: undefined },
    });
    const stored = await t.run(async (ctx) => ({
      flight: (await ctx.db.query("flights").first())!,
      aircraft: await ctx.db
        .query("aircraft")
        .withIndex("uuid", (q) => q.eq("uuid", a.uuid))
        .unique(),
      log: (await ctx.db.query("audit").collect()).find(
        (r) => r.action === "flight.reviewed",
      )!,
    }));
    expect(stored.flight).not.toHaveProperty("copilotId");
    expect(stored.flight).not.toHaveProperty("tachOn");
    expect(stored.aircraft!.currentTach).toBe(a.currentTach);
    expect(JSON.parse(stored.log.before!)).toMatchObject({
      copilotId: ids.admin,
      tachOn: a.currentTach + 3600,
    });
    expect(JSON.parse(stored.log.after!)).toEqual(stored.flight);
  });
});

describe("discrepancy resolution", () => {
  it("restricts resolution and retains the explanation and actor", async () => {
    const { pilot, admin, ids, a } = await fixture();
    const operation = {
      programUuid: "demo-program",
      kind: "discrepancy" as const,
      uuid: crypto.randomUUID(),
      authorId: ids.user,
      aircraftUuid: a.uuid,
      description: "Oil leak",
    };
    await pilot.mutation(api.operations.submit, { operation });
    await expect(
      pilot.mutation(api.operations.resolveDiscrepancy, {
        programUuid: "demo-program",
        uuid: operation.uuid,
        resolution: "Fixed",
      }),
    ).rejects.toThrow("permission");
    await expect(
      admin.mutation(api.operations.resolveDiscrepancy, {
        programUuid: "demo-program",
        uuid: operation.uuid,
        resolution: " ",
      }),
    ).rejects.toThrow("repair");
    await admin.mutation(api.operations.resolveDiscrepancy, {
      programUuid: "demo-program",
      uuid: operation.uuid,
      resolution: "Replaced damaged seal",
    });
    const s = await pilot.query(api.operations.snapshot, {});
    expect(s!.discrepancies[0]).toMatchObject({
      status: "resolved",
      resolvedBy: ids.admin,
      resolution: "Replaced damaged seal",
    });
  });
  it("shows the domain's refusals as ConvexError, and stores the report and its change-log row as before", async () => {
    const { t, pilot, admin, ids, a } = await fixture();
    const uuid = crypto.randomUUID();
    await pilot.mutation(api.operations.submit, {
      operation: {
        programUuid: "demo-program",
        kind: "discrepancy",
        uuid,
        authorId: ids.user,
        aircraftUuid: a.uuid,
        description: "Oil leak",
      },
    });
    const resolve = (resolution: string, report: string = uuid) =>
      admin.mutation(api.operations.resolveDiscrepancy, {
        programUuid: "demo-program",
        uuid: report,
        resolution,
      });
    // Batch 268: these were plain errors, which production shows as "Server
    // Error"; through runCommand the domain's Rejection reaches the user.
    const length = "Describe the repair in 1–5000 characters.";
    for (const text of [" ", "x".repeat(5001)])
      await expect(resolve(text)).rejects.toMatchObject({
        name: "ConvexError",
        data: length,
      });
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("discrepancies")
        .withIndex("uuid", (q) => q.eq("uuid", uuid))
        .unique(),
    );
    await resolve("  Replaced damaged seal ");
    await expect(resolve("Again")).rejects.toMatchObject({
      name: "ConvexError",
      data: "This report is already resolved.",
    });
    // Characterizes current behaviour: a missing report stays a plain Error.
    const missing = await resolve("Fixed", "nope").catch((e: Error) => e);
    expect(missing).toMatchObject({ message: "Report not found." });
    expect(missing).not.toMatchObject({ name: "ConvexError" });
    const [report, row] = await t.run(async (ctx) => [
      await ctx.db.get(stored!._id),
      (await ctx.db.query("audit").collect()).find(
        (r) => r.action === "discrepancy.resolved",
      )!,
    ]);
    expect(report).toMatchObject({
      status: "resolved",
      resolution: "Replaced damaged seal",
      resolvedBy: ids.admin,
    });
    expect(row).toMatchObject({
      actorId: ids.admin,
      entityUuid: uuid,
      aircraftUuid: a.uuid,
      reason: "  Replaced damaged seal ",
    });
    // The row names the aircraft's program (none before Batch 296).
    expect(row.programUuid).toBe(a.programUuid);
    // The report as the demo logs it, without Convex's system fields.
    expect(row.before).toBe(JSON.stringify(recordOf(stored!)));
    expect(row.after).toBe(
      JSON.stringify({
        status: "resolved",
        resolution: "Replaced damaged seal",
        resolvedBy: ids.admin,
        resolvedAt: (report as { resolvedAt: number }).resolvedAt,
      }),
    );
  });
  it("stores a deferral and its change-log row: the report before, the client's program", async () => {
    const { t, pilot, admin, ids, a } = await fixture();
    const uuid = crypto.randomUUID();
    await pilot.mutation(api.operations.submit, {
      operation: {
        programUuid: "demo-program",
        kind: "discrepancy",
        uuid,
        authorId: ids.user,
        aircraftUuid: a.uuid,
        description: "Alternator inoperative",
      },
    });
    const report = () =>
      t.run((ctx) =>
        ctx.db
          .query("discrepancies")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .unique(),
      );
    const stored = await report();
    // MX-3: the repair interval counts from the day the defect was found.
    const foundOn = localDate(Date.now() - 2 * DAY_MS);
    await admin.mutation(api.operations.deferDiscrepancy, {
      programUuid: "demo-program",
      payload: JSON.stringify({
        uuid,
        foundOn,
        deferredOn: localDate(),
        deferral: {
          type: "mel",
          melItem: "24-1",
          category: "B",
          placard: " ALT INOP ",
        },
      }),
    });
    const deferred = await report();
    expect(deferred!.deferral).toMatchObject({
      foundOn,
      expiresOn: localDate(Date.parse(foundOn + "T12:00:00") + 3 * DAY_MS),
    });
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("audit").collect()).filter(
        (r) => r.action === "discrepancy.deferred",
      ),
    );
    expect(rows).toEqual([
      {
        _id: expect.any(String),
        _creationTime: expect.any(Number),
        uuid: expect.any(String),
        at: expect.any(Number),
        programUuid: "demo-program",
        actorId: ids.admin,
        action: "discrepancy.deferred",
        entityUuid: uuid,
        aircraftUuid: a.uuid,
        reason: "ALT INOP",
        before: JSON.stringify(recordOf(stored!)),
        after: JSON.stringify({
          type: "mel",
          melItem: "24-1",
          category: "B",
          placard: "ALT INOP",
          foundOn,
          deferredOn: localDate(),
          deferredAt: deferred!.deferral!.deferredAt,
          deferredBy: ids.admin,
          deferredByName: "Admin",
          expiresOn: deferred!.deferral!.expiresOn,
        }),
      },
    ]);
  });
  it("resolves once per request id: a replay returns nothing and writes nothing", async () => {
    const { t, pilot, admin, ids, a } = await fixture();
    const uuid = crypto.randomUUID();
    await pilot.mutation(api.operations.submit, {
      operation: {
        programUuid: "demo-program",
        kind: "discrepancy",
        uuid,
        authorId: ids.user,
        aircraftUuid: a.uuid,
        description: "Alternator inoperative",
      },
    });
    const requestUuid = crypto.randomUUID();
    const resolve = (resolution: string) =>
      admin.mutation(api.operations.resolveDiscrepancy, {
        programUuid: "demo-program",
        uuid,
        resolution,
        requestUuid,
      });
    const stored = () =>
      t.run(async (ctx) => ({
        discrepancies: await ctx.db.query("discrepancies").collect(),
        audit: await ctx.db.query("audit").collect(),
        commandRequests: await ctx.db.query("commandRequests").collect(),
      }));
    await resolve("Replaced the alternator");
    const saved = await stored();
    expect(saved.commandRequests).toMatchObject([
      {
        uuid: requestUuid,
        payload: JSON.stringify({
          uuid,
          resolution: "Replaced the alternator",
        }),
      },
    ]);
    // ADR-0003: a replay succeeds with no payload, where a second resolution
    // is refused.
    await expect(resolve("Replaced the alternator")).resolves.toBeNull();
    expect(await stored()).toEqual(saved);
    await expect(resolve("Reseated the plug")).rejects.toMatchObject({
      data: "Request identifier already used.",
    });
    expect(await stored()).toEqual(saved);
  });
  it("defers once per request id: a replay returns nothing and writes nothing", async () => {
    const { t, pilot, admin, ids, a } = await fixture();
    const uuid = crypto.randomUUID();
    await pilot.mutation(api.operations.submit, {
      operation: {
        programUuid: "demo-program",
        kind: "discrepancy",
        uuid,
        authorId: ids.user,
        aircraftUuid: a.uuid,
        description: "Alternator inoperative",
      },
    });
    const requestUuid = crypto.randomUUID();
    const command = (placard: string) => ({
      uuid,
      foundOn: localDate(),
      deferredOn: localDate(),
      deferral: { type: "91.213d", placard, notHazard: true },
      requestUuid,
    });
    const defer = (placard: string) =>
      admin.mutation(api.operations.deferDiscrepancy, {
        programUuid: "demo-program",
        payload: JSON.stringify(command(placard)),
      });
    const stored = () =>
      t.run(async (ctx) => ({
        discrepancies: await ctx.db.query("discrepancies").collect(),
        audit: await ctx.db.query("audit").collect(),
        commandRequests: await ctx.db.query("commandRequests").collect(),
      }));
    await defer("ALT INOP");
    const saved = await stored();
    expect(saved.commandRequests).toMatchObject([
      { uuid: requestUuid, payload: JSON.stringify(command("ALT INOP")) },
    ]);
    // ADR-0003: a replay succeeds with no payload.
    await expect(defer("ALT INOP")).resolves.toBeNull();
    expect(await stored()).toEqual(saved);
    await expect(
      admin.mutation(api.operations.deferDiscrepancy, {
        programUuid: "demo-program",
        payload: JSON.stringify({
          ...command("ALT INOP"),
          requestUuid: undefined,
        }),
      }),
    ).rejects.toMatchObject({ data: "This discrepancy is already deferred." });
    await expect(defer("GEN INOP")).rejects.toMatchObject({
      data: "Request identifier already used.",
    });
    expect(await stored()).toEqual(saved);
  });
});

it("names the signed-in account to a current session only", async () => {
  const { t, pilot, ids } = await fixture();
  expect(await pilot.query(api.operations.signedInUser, {})).toBe(ids.user);
  expect(await t.query(api.operations.signedInUser, {})).toBeNull();
  await t.run(async (ctx) => ctx.db.delete(ids.session));
  expect(await pilot.query(api.operations.signedInUser, {})).toBeNull();
});

it("rejects a revoked session even while its access JWT remains unexpired", async () => {
  const { t, pilot, ids, op } = await fixture();
  await t.run(async (ctx) => ctx.db.delete(ids.session));
  expect(await pilot.query(api.operations.snapshot, {})).toBeNull();
  await expect(
    pilot.mutation(api.operations.submit, { operation: op() }),
  ).rejects.toThrow("session");
});

it("scopes PDF plans, rejects duplicate imports and logs a plan only once", async () => {
  const { t, pilot, outsider, a, op } = await fixture();
  const plan = {
    uuid: crypto.randomUUID(),
    version: 0,
    aircraftUuid: a.uuid,
    registration: a.registration,
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
  const save = {
    programUuid: "demo-program",
    payload: JSON.stringify({ plan, baseVersion: 0 }),
  };
  await expect(outsider.mutation(api.flightPlans.save, save)).rejects.toThrow();
  await pilot.mutation(api.flightPlans.save, save);
  expect(
    (await pilot.query(api.operations.snapshot))?.flightPlans,
  ).toHaveLength(1);
  await expect(
    pilot.mutation(api.flightPlans.save, {
      ...save,
      payload: JSON.stringify({
        plan: { ...plan, uuid: crypto.randomUUID() },
        baseVersion: 0,
      }),
    }),
  ).rejects.toThrow("already been imported");
  const flight = op();
  flight.input = { ...flight.input, flightPlanUuid: plan.uuid };
  await pilot.mutation(api.operations.submit, { operation: flight });
  await pilot.mutation(api.operations.submit, { operation: flight }); // replay is idempotent
  await expect(
    pilot.mutation(api.operations.submit, {
      operation: { ...flight, uuid: crypto.randomUUID() },
    }),
  ).rejects.toThrow("already has a logged flight");
  await expect(
    pilot.mutation(api.flightPlans.save, {
      ...save,
      payload: JSON.stringify({
        plan: { ...plan, status: "cancelled", version: 1 },
        baseVersion: 1,
      }),
    }),
  ).rejects.toThrow("already has a logged flight");
  expect(
    await t.run(
      async (ctx) =>
        (await ctx.db.query("flights").collect()).filter(
          (f) => f.flightPlanUuid === plan.uuid,
        ).length,
    ),
  ).toBe(1);
});

it("persists turbine start readings and amphibious landing surfaces through submit and correction", async () => {
  const { pilot, admin, op } = await fixture();
  const operation = op();
  operation.input = {
    ...operation.input,
    engineStarts: [
      { engine: "left", durationSeconds: 12.5, maxEgtC: 670 },
      { engine: "right", durationSeconds: 14, maxEgtC: 690 },
    ],
    landingSurface: "sea",
  };
  await pilot.mutation(api.operations.submit, { operation });
  let saved = (await pilot.query(api.operations.snapshot, {}))!.flights.find(
    (f) => f.uuid === operation.uuid,
  )!;
  expect(saved.engineStarts).toEqual(operation.input.engineStarts);
  expect(saved.landingSurface).toBe("sea");
  await admin.mutation(api.operations.reviewFlight, {
    uuid: operation.uuid,
    programUuid: "demo-program",
    decision: "accept",
    reason: "Corrected engine start readings",
    input: {
      ...operation.input,
      engineStarts: [
        { engine: "left", durationSeconds: 13, maxEgtC: 675 },
        { engine: "right" },
      ],
      landingSurface: "land",
    },
  });
  saved = (await pilot.query(api.operations.snapshot, {}))!.flights.find(
    (f) => f.uuid === operation.uuid,
  )!;
  expect(saved.engineStarts).toEqual([
    { engine: "left", durationSeconds: 13, maxEgtC: 675 },
    { engine: "right" },
  ]);
  expect(saved.landingSurface).toBe("land");
  await admin.mutation(api.operations.reviewFlight, {
    uuid: operation.uuid,
    programUuid: "demo-program",
    decision: "accept",
    reason: "Surface was not recorded",
    input: { ...operation.input, landingSurface: null },
  });
  expect(
    (await pilot.query(api.operations.snapshot, {}))!.flights.find(
      (f) => f.uuid === operation.uuid,
    )!.landingSurface,
  ).toBeNull();
});

it("saves helicopter profiles and cyclic readings through live flight submission", async () => {
  const { pilot, admin, a, input, op } = await fixture();
  const { aircraftInputSchema } = await import("../src/domain/fleet");
  const { totalSeconds } = await import("../src/domain/model");
  await admin.mutation(api.fleet.save, {
    programUuid: "demo-program",
    payload: JSON.stringify({
      action: "aircraft.save",
      requestUuid: crypto.randomUUID(),
      reason: "Configure helicopter meter",
      aircraft: {
        ...aircraftInputSchema.parse(a),
        helicopter: true,
        meter: "cyclic",
        currentCyclicHobbs: 100 * 3600,
        adjustmentSeconds: totalSeconds(a) - 100 * 3600,
      },
    }),
  });
  const configured = (await pilot.query(api.operations.snapshot, {}))!
    .aircraft[0];
  expect(configured).toMatchObject({
    helicopter: true,
    meter: "cyclic",
    currentCyclicHobbs: 360000,
  });
  expect(totalSeconds(configured)).toBe(totalSeconds(a));
  const request = {
    ...op(),
    baseVersion: configured.version,
    input: {
      ...input,
      startTime: new Date(Date.now() + 1000).toISOString(),
      hobbsOn: undefined,
      cyclicHobbsOn: 101 * 3600,
    },
  };
  await pilot.mutation(api.operations.submit, { operation: request });
  const saved = (await pilot.query(api.operations.snapshot, {}))!;
  expect(saved.aircraft[0].currentCyclicHobbs).toBe(101 * 3600);
  expect(totalSeconds(saved.aircraft[0])).toBe(totalSeconds(a) + 3600);
  expect(saved.flights[0]).toMatchObject({
    cyclicHobbsOff: 100 * 3600,
    cyclicHobbsOn: 101 * 3600,
    status: "accepted",
  });
  await admin.mutation(api.operations.reviewFlight, {
    uuid: request.uuid,
    programUuid: "demo-program",
    decision: "accept",
    reason: "Correct ending reading",
    input: { ...request.input, cyclicHobbsOn: 101.5 * 3600 },
  });
  const corrected = (await pilot.query(api.operations.snapshot, {}))!;
  expect(corrected.aircraft[0].currentCyclicHobbs).toBe(101.5 * 3600);
  expect(corrected.flights[0].cyclicHobbsOff).toBe(100 * 3600);
  expect(totalSeconds(corrected.aircraft[0])).toBe(totalSeconds(a) + 5400);
});

it("stores guided checklist and fluid readings, deduplicates and preserves provenance through review", async () => {
  const { t, pilot, admin, a, op } = await fixture();
  const { emptyChecklist } = await import("../src/domain/checklists");
  const record = {
    uuid: crypto.randomUUID(),
    version: 1,
    programUuid: "demo-program",
    aircraftUuid: a.uuid,
    document: emptyChecklist(),
    sourceName: "test.fmd",
    updatedAt: 0,
    updatedBy: "test",
  };
  await t.run((ctx) =>
    ctx.db.insert("checklists", {
      uuid: record.uuid,
      programUuid: record.programUuid,
      aircraftUuid: a.uuid,
      payload: JSON.stringify(record),
    }),
  );
  const operation = op();
  operation.input = {
    ...operation.input,
    fuel: { unit: "US gal", start: 30, added: 10, end: 25 },
    oil: [{ engine: "single", unit: "US qt", start: 6, added: 0, end: 5.5 }],
    checklistRun: {
      sessionUuid: operation.uuid,
      checklistUuid: record.uuid,
      checklistVersion: 1,
      checklistName: "Test checklist",
      startedAt: operation.input.startTime,
      metersVerifiedAt: operation.input.startTime,
      preflight: { hobbs: a.currentHobbs, tach: a.currentTach },
      checked: [],
      skipped: [],
      totalChecks: 0,
    },
  };
  expect(await pilot.mutation(api.operations.submit, { operation })).toEqual({
    status: "accepted",
  });
  await pilot.mutation(api.operations.submit, { operation });
  let snapshot = await pilot.query(api.operations.snapshot);
  expect(snapshot!.flights).toHaveLength(1);
  expect(snapshot!.flights[0]).toMatchObject({
    fuel: operation.input.fuel,
    oil: operation.input.oil,
    checklistRun: operation.input.checklistRun,
  });
  await expect(
    admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid: operation.uuid,
      decision: "accept",
      reason: "Correct fluid reading",
      input: { ...operation.input, checklistRun: undefined },
    }),
  ).rejects.toThrow("cannot change");
  await admin.mutation(api.operations.reviewFlight, {
    programUuid: "demo-program",
    uuid: operation.uuid,
    decision: "accept",
    reason: "Correct fluid reading",
    input: { ...operation.input, fuel: { ...operation.input.fuel!, end: 24 } },
  });
  snapshot = await pilot.query(api.operations.snapshot);
  expect(snapshot!.flights[0].fuel?.end).toBe(24);
  const invalid = op();
  invalid.input = {
    ...operation.input,
    fuel: { unit: "L", start: 10, added: 0, end: 20 },
  };
  await expect(
    pilot.mutation(api.operations.submit, { operation: invalid }),
  ).rejects.toThrow("Shutdown");
});

it("persists range oil levels and their separate added quantity through submission and correction", async () => {
  const { pilot, admin, op } = await fixture();
  const operation = op();
  operation.input.oil = [
    {
      engine: "single",
      unit: "range",
      start: 0,
      added: 1,
      addedUnit: "US qt",
      end: 100,
    },
  ];
  await pilot.mutation(api.operations.submit, { operation });
  expect((await pilot.query(api.operations.snapshot))!.flights[0].oil).toEqual(
    operation.input.oil,
  );
  const corrected = {
    ...operation.input,
    oil: [{ ...operation.input.oil[0], end: 75 }],
  };
  await admin.mutation(api.operations.reviewFlight, {
    programUuid: "demo-program",
    uuid: operation.uuid,
    decision: "accept",
    reason: "Correct shutdown range",
    input: corrected,
  });
  expect((await pilot.query(api.operations.snapshot))!.flights[0].oil).toEqual(
    corrected.oil,
  );
});

async function oilStockFixture(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  quantity = 3,
  expirationDate?: string,
) {
  const records: ManagedRecord[] = [
    {
      kind: "location",
      uuid: "oil-store",
      version: 0,
      programUuid: "demo-program",
      name: "Oil store",
      address: "",
      contact: "",
    },
    {
      kind: "stock",
      uuid: "oil-part",
      version: 0,
      programUuid: "demo-program",
      locationUuid: "oil-store",
      partNumber: "OIL-1",
      description: "Oil bottle",
      category: "supply",
      condition: "new",
      alternates: "",
      quantity,
      minimum: 0,
      oil: true,
      vendor: "Secret Vendor",
      invoiceNumber: "INV-9",
      poRef: "PO-9",
      cost: 12.5,
      expirationDate,
    },
    {
      kind: "stock",
      uuid: "tire-part",
      version: 0,
      programUuid: "demo-program",
      locationUuid: "oil-store",
      partNumber: "TIRE-1",
      description: "Main tire",
      category: "part",
      condition: "new",
      alternates: "",
      quantity: 4,
      minimum: 0,
    },
  ];
  await t.run(async (ctx) => {
    for (const r of records)
      await ctx.db.insert("management", {
        uuid: r.uuid,
        kind: r.kind,
        programUuid: r.programUuid,
        payload: JSON.stringify(r),
      });
  });
}
it("issues oil once for a held flight, aggregates engines, and keeps physical usage on rejection", async () => {
  const { t, pilot, admin, op } = await fixture();
  await oilStockFixture(t);
  const operation = op();
  operation.baseVersion = 999;
  operation.input.oil = [
    {
      engine: "left",
      unit: "US qt",
      start: 6,
      added: 1,
      inventory: {
        locationUuid: "oil-store",
        stockUuid: "oil-part",
        quantity: 1,
      },
    },
    {
      engine: "right",
      unit: "range",
      start: 50,
      added: 1,
      addedUnit: "US qt",
      inventory: {
        locationUuid: "oil-store",
        stockUuid: "oil-part",
        quantity: 1,
      },
    },
  ];
  expect(
    (await pilot.mutation(api.operations.submit, { operation })).status,
  ).toBe("review");
  await pilot.mutation(api.operations.submit, { operation });
  const stock = () =>
    t.run(async (ctx) =>
      JSON.parse(
        (await ctx.db
          .query("management")
          .withIndex("uuid", (q) => q.eq("uuid", "oil-part"))
          .unique())!.payload,
      ),
    );
  expect(await stock()).toMatchObject({ quantity: 1, version: 1 });
  await expect(
    admin.mutation(api.operations.reviewFlight, {
      programUuid: "demo-program",
      uuid: operation.uuid,
      decision: "reject",
      reason: "Reject meter entry",
      input: { ...operation.input, oil: undefined },
    }),
  ).rejects.toThrow("posted oil inventory");
  await admin.mutation(api.operations.reviewFlight, {
    programUuid: "demo-program",
    uuid: operation.uuid,
    decision: "reject",
    reason: "Reject meter entry",
    input: operation.input,
  });
  expect((await stock()).quantity).toBe(1);
  const audit = await t.run((ctx) => ctx.db.query("audit").collect());
  expect(audit.filter((a) => a.action === "stock.oil_used")).toHaveLength(1);
});
it("records oil usage without admin-only stock details and hides stock rows from flight users", async () => {
  const { t, pilot, admin, op } = await fixture();
  await oilStockFixture(t);
  const operation = op();
  operation.input.oil = [
    {
      engine: "single",
      unit: "US qt",
      start: 6,
      added: 1,
      inventory: {
        locationUuid: "oil-store",
        stockUuid: "oil-part",
        quantity: 1,
      },
    },
  ];
  await pilot.mutation(api.operations.submit, { operation });
  const [row] = await t.run((ctx) =>
    ctx.db
      .query("audit")
      .filter((q) => q.eq(q.field("action"), "stock.oil_used"))
      .collect(),
  );
  expect(JSON.parse(row.before!)).toEqual({
    stockUuid: "oil-part",
    quantity: 3,
  });
  expect(JSON.parse(row.after!)).toEqual({
    stockUuid: "oil-part",
    quantity: 2,
  });
  expect(row.aircraftUuid).toBe(operation.input.aircraftUuid);
  // A historic row written before the fix with the full stock record.
  await t.run((ctx) =>
    ctx.db.insert("audit", {
      ...(({ _id: _i, _creationTime: _c, ...rest }) => rest)(row),
      uuid: "historic",
      before: JSON.stringify({
        uuid: "oil-part",
        vendor: "Secret Vendor",
        cost: 12.5,
      }),
    }),
  );
  const history = (client: typeof pilot) =>
    client.query(api.auditHistory.page, {
      programUuid: "demo-program",
      cursor: null,
      numItems: 40,
    });
  const pilotRows = (await history(pilot)).page;
  expect(pilotRows.some((a) => a.entityUuid === "oil-part")).toBe(false);
  expect(pilotRows.some((a) => a.action === "flight.created")).toBe(true);
  expect(
    (await pilot.query(api.operations.snapshot))!.audit.some(
      (a) => a.entityUuid === "oil-part",
    ),
  ).toBe(false);
  const adminRows = (await history(admin)).page.filter(
    (a) => a.entityUuid === "oil-part",
  );
  expect(adminRows).toHaveLength(2);
  expect(adminRows.some((a) => a.before?.includes("Secret Vendor"))).toBe(true);
});
it("refuses flight-line deduction of stock that is not oil", async () => {
  const { t, pilot, op } = await fixture();
  await oilStockFixture(t);
  const operation = op();
  operation.input.oil = [
    {
      engine: "single",
      unit: "US qt",
      start: 6,
      added: 1,
      inventory: {
        locationUuid: "oil-store",
        stockUuid: "tire-part",
        quantity: 1,
      },
    },
  ];
  await expect(
    pilot.mutation(api.operations.submit, { operation }),
  ).rejects.toThrow("not marked as oil");
  const tire = await t.run(async (ctx) =>
    JSON.parse(
      (await ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", "tire-part"))
        .unique())!.payload,
    ),
  );
  expect(tire.quantity).toBe(4);
});
it("refuses flight-line deduction of an expired oil lot and saves nothing (#47)", async () => {
  const { t, pilot, op } = await fixture();
  const expired = new Date(Date.now() - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  await oilStockFixture(t, 3, expired);
  const operation = op();
  operation.input.oil = [
    {
      engine: "single",
      unit: "US qt",
      start: 6,
      added: 1,
      inventory: {
        locationUuid: "oil-store",
        stockUuid: "oil-part",
        quantity: 1,
      },
    },
  ];
  await expect(
    pilot.mutation(api.operations.submit, { operation }),
  ).rejects.toThrow(
    `OIL-1 expired on ${expired}. Expired stock cannot be issued or reserved.`,
  );
  const { oil, flights, audit } = await t.run(async (ctx) => ({
    oil: JSON.parse(
      (await ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", "oil-part"))
        .unique())!.payload,
    ),
    flights: await ctx.db.query("flights").collect(),
    audit: await ctx.db.query("audit").collect(),
  }));
  expect(oil).toMatchObject({ quantity: 3, version: 0 });
  expect(flights).toHaveLength(0);
  expect(audit.some((a) => a.action === "stock.oil_used")).toBe(false);
});
it("rejects insufficient or foreign oil stock atomically and retries after replenishment", async () => {
  const { t, pilot, op, a } = await fixture();
  await oilStockFixture(t, 1);
  const operation = op();
  operation.input.oil = [
    {
      engine: "single",
      unit: "US qt",
      start: 6,
      added: 2,
      inventory: {
        locationUuid: "oil-store",
        stockUuid: "oil-part",
        quantity: 2,
      },
    },
  ];
  await expect(
    pilot.mutation(api.operations.submit, { operation }),
  ).rejects.toThrow("Insufficient stock");
  expect((await pilot.query(api.operations.snapshot))!.flights).toHaveLength(0);
  expect(
    (await pilot.query(api.operations.snapshot))!.aircraft.find(
      (x) => x.uuid === a.uuid,
    )!.version,
  ).toBe(0);
  await t.run(async (ctx) => {
    const doc = (await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", "oil-part"))
      .unique())!;
    await ctx.db.patch(doc._id, {
      payload: JSON.stringify({
        ...JSON.parse(doc.payload),
        quantity: 3,
        programUuid: "foreign",
      }),
    });
  });
  await expect(
    pilot.mutation(api.operations.submit, { operation }),
  ).rejects.toThrow("Flight Program");
  await t.run(async (ctx) => {
    const doc = (await ctx.db
      .query("management")
      .withIndex("uuid", (q) => q.eq("uuid", "oil-part"))
      .unique())!;
    await ctx.db.patch(doc._id, {
      payload: JSON.stringify({
        ...JSON.parse(doc.payload),
        programUuid: "demo-program",
      }),
    });
  });
  await pilot.mutation(api.operations.submit, { operation });
  const result = await t.run(async (ctx) =>
    JSON.parse(
      (await ctx.db
        .query("management")
        .withIndex("uuid", (q) => q.eq("uuid", "oil-part"))
        .unique())!.payload,
    ),
  );
  expect(result.quantity).toBe(1);
});

// A valid checklist run the flight was not logged with.
function checklistRun(
  startedAt: string,
  a: { currentHobbs: number; currentTach: number },
) {
  return {
    sessionUuid: crypto.randomUUID(),
    checklistUuid: crypto.randomUUID(),
    checklistVersion: 1,
    checklistName: "Preflight",
    startedAt,
    metersVerifiedAt: startedAt,
    preflight: { hobbs: a.currentHobbs, tach: a.currentTach },
    checked: [],
    skipped: [],
    totalChecks: 0,
  };
}

// A stored row without Convex's system fields, as the domain holds a record.
function recordOf<T extends { _id: string; _creationTime: number }>({
  _id,
  _creationTime,
  ...record
}: T) {
  return record;
}
