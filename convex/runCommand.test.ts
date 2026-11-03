import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import type { AuditEntry } from "../src/domain/model";
import { runCommand, hydrate, plainErrors, type Command } from "./runCommand";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
async function fixture() {
  const t = convexTest(schema, modules);
  const s = demoSnapshot();
  const ids = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    await ctx.db.insert("programs", {
      ...s.programs![0],
      uuid: "other",
      name: "Other operations",
    });
    const user = async (programUuid: string) => {
      const group = await ctx.db.insert("groups", {
        programUuid,
        name: "Maintenance",
        aircraftIds: [],
        permissions: ["read", "maintenance"],
      });
      const id = await ctx.db.insert("users", {
        name: "Mechanic",
        active: true,
        isAdmin: false,
        activeProgramUuid: programUuid,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      return { id, identity: { subject: `${id}|${session}` } };
    };
    return { mechanic: await user(PROGRAM), outsider: await user("other") };
  });
  const as =
    (identity: { subject: string }) =>
    <C, W, R, Out>(command: Command<C, W, R, Out>) =>
      t
        .withIdentity(identity)
        .run(async (ctx) => (await runCommand(ctx, command)) ?? null);
  const rows = () => t.run((ctx) => ctx.db.query("audit").collect());
  const requests = () =>
    t.run((ctx) => ctx.db.query("managementRequests").collect());
  const flightPlans = () =>
    t.run((ctx) => ctx.db.query("flightPlans").collect());
  return {
    t,
    aircraft: s.aircraft[0].uuid,
    mechanic: { ...ids.mechanic, run: as(ids.mechanic.identity) },
    outsider: { ...ids.outsider, run: as(ids.outsider.identity) },
    rows,
    requests,
    flightPlans,
  };
}
// A command that saves one flight plan document and audits it.
function planCommand(
  aircraftUuid: string,
  overrides: Partial<Command<string, { found: number }, string, string>> = {},
): Command<string, { found: number }, string, string> {
  return {
    programUuid: PROGRAM,
    parse: () => "plan-1",
    load: async ({ ctx }) => ({
      found: (await ctx.db.query("flightPlans").collect()).length,
    }),
    apply: (_, uuid) => uuid,
    persist: async ({ ctx }, _, uuid) => {
      await ctx.db.insert("flightPlans", {
        uuid,
        aircraftUuid,
        payload: "{}",
      });
    },
    audit: (log, { found }, uuid) =>
      log.entry("plan.saved", uuid, {
        programUuid: PROGRAM,
        aircraftUuid,
        reason: "Planned",
        before: { found },
        after: { uuid },
      }),
    returns: (uuid) => uuid,
    ...overrides,
  };
}

it("checks the caller's Flight Program before reading the command", async () => {
  const f = await fixture();
  const parse = vi.fn(() => "plan-1");
  const load = vi.fn();
  await expect(
    f.outsider.run(planCommand(f.aircraft, { parse, load })),
  ).rejects.toThrow(
    "Flight Program changed. Reopen the form in the correct program.",
  );
  await expect(
    f.t.run((ctx) => runCommand(ctx, planCommand(f.aircraft, { parse }))),
  ).rejects.toThrow("An active account and session are required.");
  expect(parse).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(await f.flightPlans()).toEqual([]);
  expect(await f.rows()).toEqual([]);
});

it("refuses record-level access in load and writes nothing", async () => {
  const f = await fixture();
  const apply = vi.fn();
  await expect(
    f.mechanic.run(
      planCommand(f.aircraft, {
        load: async () => {
          throw new Error("You do not have permission for this aircraft.");
        },
        apply,
      }),
    ),
  ).rejects.toThrow("You do not have permission for this aircraft.");
  expect(apply).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual([]);
});

it("writes the command's audit entry exactly once, after its documents", async () => {
  const f = await fixture();
  expect(await f.mechanic.run(planCommand(f.aircraft))).toBe("plan-1");
  expect(await f.flightPlans()).toHaveLength(1);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    action: "plan.saved",
    entityUuid: "plan-1",
    actorId: f.mechanic.id,
    programUuid: PROGRAM,
    aircraftUuid: f.aircraft,
    reason: "Planned",
  });
  expect(JSON.parse(rows[0].before!)).toEqual({ found: 0 });
  expect(JSON.parse(rows[0].after!)).toEqual({ uuid: "plan-1" });
});

it("replays the applier's entries, re-stamped or exactly as recorded", async () => {
  const f = await fixture();
  const domain: AuditEntry = {
    uuid: "domain-entry",
    at: 1,
    actorId: "domain-actor",
    action: "stock.issue",
    entityUuid: "stock-1",
    aircraftUuid: f.aircraft,
    reason: "Issued",
    before: JSON.stringify({ quantity: 2 }),
    after: JSON.stringify({ quantity: 1 }),
  };
  await f.mechanic.run({
    programUuid: PROGRAM,
    parse: () => null,
    load: ({ ctx, state }) => hydrate(ctx, state, ["management"]),
    apply: ({ snapshot }) => {
      snapshot.audit.unshift(domain);
    },
    persist: async () => {},
    audit: (log, { snapshot }) => {
      log.replay(snapshot.audit, { programUuid: PROGRAM });
      log.record(snapshot.audit, { programUuid: PROGRAM });
    },
  });
  const [replayed, recorded] = await f.rows();
  expect(replayed).toMatchObject({
    action: "stock.issue",
    entityUuid: "stock-1",
    actorId: f.mechanic.id,
    programUuid: PROGRAM,
    aircraftUuid: f.aircraft,
    reason: "Issued",
    before: domain.before,
    after: domain.after,
  });
  expect(replayed.uuid).not.toBe("domain-entry");
  expect(recorded).toMatchObject({ ...domain, programUuid: PROGRAM });
});

it("rolls back and exposes only expected rejections when the domain refuses", async () => {
  const f = await fixture();
  const persist = vi.fn();
  // An expected rejection keeps its message through production redaction.
  const refused = f.mechanic.run(
    planCommand(f.aircraft, {
      load: async ({ ctx }) => {
        await ctx.db.insert("flightPlans", {
          uuid: "written-before-the-refusal",
          aircraftUuid: f.aircraft,
          payload: "{}",
        });
        return { found: 0 };
      },
      apply: () => {
        throw new Error("Plan overlaps another flight.");
      },
      expose: plainErrors,
      persist,
    }),
  );
  await expect(refused).rejects.toThrow(ConvexError);
  await expect(refused).rejects.toThrow("Plan overlaps another flight.");
  // Anything else is rethrown unchanged.
  const failure = new TypeError("Cannot read properties of undefined");
  await expect(
    f.mechanic.run(
      planCommand(f.aircraft, {
        apply: () => {
          throw failure;
        },
        expose: plainErrors,
      }),
    ),
  ).rejects.toThrow(TypeError);
  // A refusal while persisting undoes the documents already written.
  await expect(
    f.mechanic.run(
      planCommand(f.aircraft, {
        persist: async ({ ctx }, _, uuid) => {
          await ctx.db.insert("flightPlans", {
            uuid,
            aircraftUuid: f.aircraft,
            payload: "{}",
          });
          throw new Error("Record belongs to another Flight Program.");
        },
      }),
    ),
  ).rejects.toThrow("Record belongs to another Flight Program.");
  expect(persist).not.toHaveBeenCalled();
  expect(await f.flightPlans()).toEqual([]);
  expect(await f.rows()).toEqual([]);
});

it("applies a request id once and refuses its reuse for another payload", async () => {
  const f = await fixture();
  const command = (payload: string) =>
    planCommand(f.aircraft, {
      request: () => ({ uuid: "request-1", payload }),
    });
  expect(await f.mechanic.run(command("first"))).toBe("plan-1");
  // A replay of the same request succeeds without writing again.
  expect(await f.mechanic.run(command("first"))).toBeNull();
  expect(await f.flightPlans()).toHaveLength(1);
  expect(await f.rows()).toHaveLength(1);
  expect(await f.requests()).toMatchObject([
    { uuid: "request-1", actorId: f.mechanic.id, payload: "first" },
  ]);
  await expect(f.mechanic.run(command("second"))).rejects.toThrow(
    "Request identifier already used.",
  );
  // Nothing is recorded for a request whose command was refused.
  await expect(
    f.mechanic.run(
      planCommand(f.aircraft, {
        request: () => ({ uuid: "request-2", payload: "x" }),
        apply: () => {
          throw new Error("Refused.");
        },
      }),
    ),
  ).rejects.toThrow("Refused.");
  expect(await f.requests()).toHaveLength(1);
});

it("hands delegated commands to their own transaction", async () => {
  const f = await fixture();
  const load = vi.fn();
  expect(
    await f.mechanic.run(
      planCommand(f.aircraft, {
        delegate: async () => "queued",
        load,
      }),
    ),
  ).toBe("queued");
  expect(load).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual([]);
});
