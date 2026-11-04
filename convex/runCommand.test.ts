/**
 * Responsibility: Pins the command transaction: context check, rollback,
 *   change-log rows, request ids, hand-off, the post-apply hook, which errors
 *   reach the user, and the changed-row writer.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/runCommand.ts, convex/collections.ts,
 *   convex/schema.ts, src/domain/model.ts, src/domain/costs.ts,
 *   src/domain/rejection.ts, src/domain/flightSubmission.ts,
 *   src/domain/components.ts, src/data/demo.ts (fixture).
 *
 * convex-test does not redact errors as production does, so these tests
 * check the error class: only a ConvexError keeps its message in production.
 */
import { convexTest } from "convex-test";
import { it, expect, vi } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { demoSnapshot } from "../src/data/demo";
import type { AuditEntry } from "../src/domain/model";
import { Rejection } from "../src/domain/rejection";
import { FlightRejection } from "../src/domain/flightSubmission";
import { ComponentUsageError } from "../src/domain/components";
import type { CostRecord } from "../src/domain/costs";
import { encode } from "./collections";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  runCommand,
  hydrate,
  writeChanged,
  plainErrors,
  errorsOf,
  requestOf,
  type Command,
} from "./runCommand";
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
// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );
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
  const stale =
    "Flight Program changed. Reopen the form in the correct program.";
  expect(
    await refusal(f.outsider.run(planCommand(f.aircraft, { parse, load }))),
  ).toMatchObject({ name: "ConvexError", data: stale });
  // The session refusal stays a plain Error (see convex/access.ts).
  const signedOut = await refusal(
    f.t.run((ctx) => runCommand(ctx, planCommand(f.aircraft, { parse }))),
  );
  expect(signedOut).toMatchObject({
    message: "An active account and session are required.",
  });
  expect(signedOut).not.toBeInstanceOf(ConvexError);
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
  expect(await refusal(f.mechanic.run(command("second")))).toMatchObject({
    name: "ConvexError",
    data: "Request identifier already used.",
  });
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

it("records each request id in commandRequests too, as managementRequests holds it", async () => {
  const f = await fixture();
  const command = planCommand(f.aircraft, {
    request: () => ({ uuid: "request-1", payload: "first" }),
  });
  await f.mechanic.run(command);
  expect(await f.mechanic.run(command)).toBeNull();
  await f.mechanic.run(planCommand(f.aircraft));
  const stored = [
    { uuid: "request-1", actorId: f.mechanic.id, payload: "first" },
  ];
  const fields = <T extends { _id: unknown; _creationTime: number }>({
    _id,
    _creationTime,
    ...row
  }: T) => row;
  const commandRequests = await f.t.run((ctx) =>
    ctx.db.query("commandRequests").collect(),
  );
  expect(commandRequests.map(fields)).toEqual(stored);
  expect((await f.requests()).map(fields)).toEqual(stored);
});

it("still replays a request id recorded only in managementRequests", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    ctx.db.insert("managementRequests", {
      uuid: "request-1",
      actorId: f.mechanic.id,
      payload: "first",
    }),
  );
  const command = planCommand(f.aircraft, {
    request: () => ({ uuid: "request-1", payload: "first" }),
  });
  expect(await f.mechanic.run(command)).toBeNull();
  expect(await f.flightPlans()).toEqual([]);
  expect(
    await f.t.run((ctx) => ctx.db.query("commandRequests").collect()),
  ).toEqual([]);
});

it("runs a command sent without a request id every time, recording none", async () => {
  const f = await fixture();
  expect(requestOf("request-1", "first")).toEqual({
    uuid: "request-1",
    payload: "first",
  });
  const command = planCommand(f.aircraft, {
    request: () => requestOf(undefined, "first"),
  });
  expect(await f.mechanic.run(command)).toBe("plan-1");
  expect(await f.mechanic.run(command)).toBe("plan-1");
  expect(await f.flightPlans()).toHaveLength(2);
  expect(await f.requests()).toEqual([]);
  expect(
    await f.t.run((ctx) => ctx.db.query("commandRequests").collect()),
  ).toEqual([]);
});

it("runs afterApply between apply and persist, and continues with what it returns", async () => {
  const f = await fixture();
  const steps: string[] = [];
  const seen: unknown[] = [];
  const result = await f.mechanic.run(
    planCommand(f.aircraft, {
      apply: (_, uuid) => {
        steps.push("apply");
        return uuid;
      },
      afterApply: async (tx, working, uuid, command) => {
        steps.push("afterApply");
        seen.push(tx.state.user.id, working, uuid, command);
        return `${uuid}-scheduled`;
      },
      persist: async ({ ctx }, _, uuid) => {
        steps.push("persist");
        await ctx.db.insert("flightPlans", {
          uuid,
          aircraftUuid: f.aircraft,
          payload: "{}",
        });
      },
    }),
  );
  expect(steps).toEqual(["apply", "afterApply", "persist"]);
  expect(seen).toEqual([f.mechanic.id, { found: 0 }, "plan-1", "plan-1"]);
  expect(result).toBe("plan-1-scheduled");
  expect((await f.flightPlans()).map((p) => p.uuid)).toEqual([
    "plan-1-scheduled",
  ]);
  expect((await f.rows()).map((r) => r.entityUuid)).toEqual([
    "plan-1-scheduled",
  ]);
});

it("skips afterApply for a replayed request, so nothing is scheduled twice", async () => {
  const f = await fixture();
  const afterApply = vi.fn(
    async (_tx: unknown, _w: unknown, uuid: string) => uuid,
  );
  const command = planCommand(f.aircraft, {
    request: () => ({ uuid: "request-1", payload: "first" }),
    afterApply,
  });
  await f.mechanic.run(command);
  expect(await f.mechanic.run(command)).toBeNull();
  expect(afterApply).toHaveBeenCalledTimes(1);
});

it("shows a Rejection from afterApply as a ConvexError, keeps other errors unchanged, and writes nothing", async () => {
  const f = await fixture();
  const stale = "Work order changed. Reopen it before saving.";
  const scheduling = (error: Error) =>
    planCommand(f.aircraft, {
      afterApply: async ({ ctx }) => {
        await ctx.db.insert("flightPlans", {
          uuid: "scheduled-before-the-refusal",
          aircraftUuid: f.aircraft,
          payload: "{}",
        });
        throw error;
      },
      expose: plainErrors,
    });
  const refused = await refusal(
    f.mechanic.run(scheduling(new Rejection(stale))),
  );
  expect(refused).toBeInstanceOf(ConvexError);
  expect(refused).toMatchObject({ message: stale, data: stale });
  const fault = new Error(stale);
  // A command's `expose` covers apply only, so a plain Error stays hidden.
  expect(await refusal(f.mechanic.run(scheduling(fault)))).toBe(fault);
  expect(await f.flightPlans()).toEqual([]);
  expect(await f.rows()).toEqual([]);
});

it("shows a domain Rejection from apply or load as a ConvexError with its message", async () => {
  const f = await fixture();
  const stale = "Work order changed. Reopen it before saving.";
  const fromApply = await refusal(
    f.mechanic.run(
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
          throw new Rejection(stale);
        },
      }),
    ),
  );
  expect(fromApply).toBeInstanceOf(ConvexError);
  expect(fromApply).toMatchObject({ message: stale, data: stale });
  const apply = vi.fn();
  const cycle = "Component attachment cycle detected.";
  const fromLoad = await refusal(
    f.mechanic.run(
      planCommand(f.aircraft, {
        load: async () => {
          throw new ComponentUsageError(cycle);
        },
        apply,
      }),
    ),
  );
  expect(fromLoad).toBeInstanceOf(ConvexError);
  expect(fromLoad).toMatchObject({ message: cycle, data: cycle });
  expect(apply).not.toHaveBeenCalled();
  expect(await f.flightPlans()).toEqual([]);
  expect(await f.rows()).toEqual([]);
});

it("shows a Rejection from persist as a ConvexError and writes nothing", async () => {
  const f = await fixture();
  const collision = "Record belongs to another Flight Program.";
  const refused = await refusal(
    f.mechanic.run(
      planCommand(f.aircraft, {
        persist: async ({ ctx }, _, uuid) => {
          await ctx.db.insert("flightPlans", {
            uuid,
            aircraftUuid: f.aircraft,
            payload: "{}",
          });
          throw new Rejection(collision);
        },
      }),
    ),
  );
  expect(refused).toBeInstanceOf(ConvexError);
  expect(refused).toMatchObject({ message: collision, data: collision });
  const fault = new Error(collision);
  const hidden = await refusal(
    f.mechanic.run(
      planCommand(f.aircraft, {
        persist: async () => {
          throw fault;
        },
        expose: plainErrors,
      }),
    ),
  );
  // A command's `expose` covers apply only, so a plain Error stays hidden.
  expect(hidden).toBe(fault);
  expect(await f.flightPlans()).toEqual([]);
  expect(await f.rows()).toEqual([]);
});

it("keeps any other error hidden, from load or apply, and unchanged", async () => {
  const f = await fixture();
  const fault = new Error("Cannot read the stored payload.");
  const fromApply = await refusal(
    f.mechanic.run(
      planCommand(f.aircraft, {
        apply: () => {
          throw fault;
        },
      }),
    ),
  );
  expect(fromApply).toBe(fault);
  // Characterizes current behaviour: a command's `expose` covers apply only.
  const fromLoad = await refusal(
    f.mechanic.run(
      planCommand(f.aircraft, {
        load: async () => {
          throw fault;
        },
        expose: plainErrors,
      }),
    ),
  );
  expect(fromLoad).toBe(fault);
  expect(fromLoad).not.toBeInstanceOf(ConvexError);
});

it("shows a Rejection even when the command's expose names another class", async () => {
  const f = await fixture();
  class OtherRefusal extends Error {}
  const refused = await refusal(
    f.mechanic.run(
      planCommand(f.aircraft, {
        apply: () => {
          throw new FlightRejection("Flight dispatch rejected.");
        },
        expose: errorsOf(OtherRefusal),
      }),
    ),
  );
  expect(refused).toBeInstanceOf(ConvexError);
  expect(refused).toMatchObject({ data: "Flight dispatch rejected." });
});

// Cost records: one the command changes, one it leaves as stored, one it
// does not pass, and one stored in another Flight Program.
function costRecords(aircraftUuid: string) {
  const budget = (uuid: string, programUuid = PROGRAM): CostRecord => ({
    uuid,
    version: 1,
    programUuid,
    kind: "budget",
    aircraftUuid: programUuid === PROGRAM ? aircraftUuid : "other-aircraft",
    year: 2026,
    amountCents: 100,
  });
  return {
    changed: budget("changed"),
    unchanged: budget("unchanged"),
    unpassed: budget("unpassed"),
    elsewhere: budget("elsewhere", "other"),
  };
}

// Runs writeChanged on the costs `records` gives, recording each write.
function writeCosts(
  records: (stored: CostRecord[]) => CostRecord[],
  writes: string[],
): Command<null, { stored: CostRecord[]; docs: Doc<"costs">[] }, CostRecord[]> {
  return {
    programUuid: PROGRAM,
    parse: () => null,
    load: async ({ ctx, state }) => {
      const { snapshot, docs } = await hydrate(ctx, state, ["costs"]);
      return { stored: snapshot.costs!, docs: docs.costs };
    },
    apply: ({ stored }) => records(stored),
    persist: ({ ctx }, { docs }, next) =>
      writeChanged(
        tracedWrites(ctx, writes),
        "costs",
        docs,
        next,
        "Cost record belongs to another Flight Program.",
      ),
    audit: () => undefined,
  };
}

// The mutation context with each insert and replace recorded by uuid.
function tracedWrites(ctx: MutationCtx, writes: string[]): MutationCtx {
  const db = new Proxy(ctx.db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "insert" && key !== "replace")
        return typeof value === "function" ? value.bind(target) : value;
      return (...args: [unknown, { uuid: string }]) => {
        writes.push(`${key} ${args[1].uuid}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { ...ctx, db };
}

it("writes changed records as the codec encodes them, skips unchanged ones and never deletes", async () => {
  const f = await fixture();
  const costs = costRecords(f.aircraft);
  await f.t.run(async (ctx) => {
    for (const r of [costs.changed, costs.unchanged, costs.unpassed])
      await ctx.db.insert("costs", encode("costs", r));
  });
  const added = { ...costs.changed, uuid: "added" };
  const changed = { ...costs.changed, version: 2, amountCents: 200 };
  const writes: string[] = [];
  await f.mechanic.run(
    writeCosts(() => [changed, costs.unchanged, added], writes),
  );
  expect(writes).toEqual(["replace changed", "insert added"]);
  const stored = await f.t.run(async (ctx) =>
    (await ctx.db.query("costs").collect()).map(
      ({ _id, _creationTime, ...row }) => row,
    ),
  );
  expect(stored).toEqual(
    [changed, costs.unchanged, costs.unpassed, added].map((r) =>
      encode("costs", r),
    ),
  );
});

it("refuses a uuid stored outside the loaded rows with the caller's message, and writes nothing", async () => {
  const f = await fixture();
  const costs = costRecords(f.aircraft);
  await f.t.run((ctx) =>
    ctx.db.insert("costs", encode("costs", costs.elsewhere)),
  );
  const writes: string[] = [];
  const refused = await refusal(
    f.mechanic.run(
      writeCosts(
        () => [costs.changed, { ...costs.elsewhere, amountCents: 1 }],
        writes,
      ),
    ),
  );
  expect(refused).toBeInstanceOf(ConvexError);
  expect(refused).toMatchObject({
    data: "Cost record belongs to another Flight Program.",
  });
  expect(writes).toEqual(["insert changed"]);
  const stored = await f.t.run((ctx) => ctx.db.query("costs").collect());
  expect(stored.map((d) => d.payload)).toEqual([
    encode("costs", costs.elsewhere).payload,
  ]);
});
