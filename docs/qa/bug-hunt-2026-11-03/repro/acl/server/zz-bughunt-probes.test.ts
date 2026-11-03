import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    for (const uuid of ["A", "B"]) {
      await ctx.db.insert("programs", {
        ...demoSnapshot().programs![0],
        uuid,
        name: uuid,
        email: `${uuid}@example.test`,
      });
    }
    for (const [uuid, program] of [
      ["plane-A1", "A"],
      ["plane-A2", "A"],
      ["plane-B", "B"],
    ])
      await ctx.db.insert("aircraft", {
        ...demoSnapshot().aircraft[0],
        uuid,
        registration: uuid.toUpperCase(),
        programUuid: program,
        program,
      });
    const g = async (
      name: string,
      programUuid: string,
      fields: Partial<{
        programAdmin: boolean;
        owner: boolean;
        aircraftIds: string[];
        permissions: ("read" | "flight" | "discrepancy" | "resolve" | "maintenance")[];
      }> = {},
    ) =>
      ctx.db.insert("groups", {
        name,
        programUuid,
        programAdmin: false,
        aircraftIds: [],
        permissions: ["read"],
        ...fields,
      });
    const groups = {
      observersA: await g("Observers", "A"),
      adminA: await g("A managers", "A", { programAdmin: true }),
      pilotsA: await g("Pilots", "A", {
        permissions: ["read", "flight", "discrepancy"],
      }),
      ownersA: await g("Owners", "A", {
        owner: true,
        aircraftIds: ["plane-A1"],
      }),
      restrictedA: await g("A1 only", "A", {
        aircraftIds: ["plane-A1"],
        permissions: ["read", "maintenance"],
      }),
      readersB: await g("Observers", "B"),
    };
    const users: Record<string, Id<"users">> = {};
    const sessions: Record<string, Id<"authSessions">> = {};
    const make = async (
      name: string,
      groupIds: Id<"groups">[],
      isAdmin = false,
      active = true,
    ) => {
      const id = await ctx.db.insert("users", {
        name,
        email: `${name}@example.test`,
        active,
        isAdmin,
        groupIds,
        activeProgramUuid: "A",
      });
      users[name] = id;
      sessions[name] = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + 86400000,
      });
      for (const groupId of groupIds) {
        const group = await ctx.db.get(groupId);
        await ctx.db.insert("memberships", {
          userId: id,
          groupId,
          programUuid: group!.programUuid,
        });
      }
    };
    await make("system", [], true);
    await make("disabledAdmin", [], true, false);
    await make("programAdmin", [groups.adminA]);
    await make("pilot", [groups.pilotsA]);
    await make("owner", [groups.ownersA]);
    await make("restricted", [groups.restrictedA]);
    await make("readerB", [groups.readersB]);
    return { users, sessions, groups };
  });
  const as = (name: string) =>
    t.withIdentity({
      subject: `${ids.users[name]}|${ids.sessions[name]}`,
    });
  return { t, ids, as };
}

const programSave = (uuid: string, name: string, version = 1) =>
  JSON.stringify({
    requestUuid: crypto.randomUUID(),
    reason: "probe",
    action: "program.save",
    program: {
      uuid,
      version,
      name,
      address: "",
      email: "",
      contactName: "",
      website: "",
    },
  });

it("probe: pilot and owner cannot reach admin or program-admin functions", async () => {
  const { ids, as } = await setup();
  for (const who of ["pilot", "owner", "restricted", "readerB"]) {
    const c = as(who);
    const results: Record<string, string> = {};
    const attempt = async (label: string, p: Promise<unknown>) => {
      results[label] = await p.then(
        () => "ALLOWED",
        () => "rejected",
      );
    };
    await attempt(
      "updateUser",
      c.mutation(api.admin.updateUser, {
        id: ids.users[who],
        active: true,
        isAdmin: true,
        groupIds: [],
      }),
    );
    await attempt(
      "saveGroup",
      c.mutation(api.admin.saveGroup, {
        programUuid: "A",
        programAdmin: true,
        name: "x",
        aircraftIds: [],
        permissions: ["read"],
      }),
    );
    await attempt(
      "updateAccess",
      c.mutation(api.programUsers.updateAccess, {
        programUuid: "A",
        groupIds: [ids.groups.adminA],
        userId: ids.users[who],
        remove: false,
      }),
    );
    await attempt(
      "laborRate",
      c.mutation(api.costs.execute, {
        programUuid: "A",
        payload: JSON.stringify({
          action: "settings.laborRate",
          laborRateCents: 100,
        }),
      }),
    );
    await attempt(
      "programSave",
      c.mutation(api.fleet.save, {
        programUuid: "A",
        payload: programSave("A", "Renamed"),
      }),
    );
    await attempt(
      "transfer",
      c.mutation(api.programs.transfer, {
        programUuid: "A",
        kind: "aircraft",
        uuid: "plane-A1",
        destination: "B",
        reason: "x",
      }),
    );
    await attempt(
      "initialize",
      c.mutation(api.defaultGroups.initialize, { programUuid: "A" }),
    );
    await attempt(
      "spruceStatus",
      c.query(api.aircraftSpruce.status, { programUuid: "A" }),
    );
    await attempt("addressStatus", c.query(api.addressVerification.status, {}));
    await attempt(
      "deleteGroup",
      c.mutation(api.groupDeletion.remove, {
        id: ids.groups.observersA,
        programUuid: "A",
        expected: "",
      }),
    );
    await attempt(
      "selectUnassigned",
      c.mutation(api.programs.select, { programUuid: "" }),
    );
    expect({ who, results }).toEqual({
      who,
      results: Object.fromEntries(
        Object.keys(results).map((k) => [k, "rejected"]),
      ),
    });
  }
});

it("probe: program admin cannot cross programs or act as system admin", async () => {
  const { ids, as } = await setup();
  const c = as("programAdmin");
  const results: Record<string, string> = {};
  const attempt = async (label: string, p: Promise<unknown>) => {
    results[label] = await p.then(
      () => "ALLOWED",
      (e) => "rejected",
    );
  };
  await attempt(
    "transfer",
    c.mutation(api.programs.transfer, {
      programUuid: "A",
      kind: "aircraft",
      uuid: "plane-A1",
      destination: "B",
      reason: "x",
    }),
  );
  await attempt(
    "updateUser",
    c.mutation(api.admin.updateUser, {
      id: ids.users.pilot,
      active: true,
      isAdmin: true,
      groupIds: [],
    }),
  );
  await attempt(
    "saveGroupB",
    c.mutation(api.admin.saveGroup, {
      programUuid: "B",
      name: "x",
      aircraftIds: [],
      permissions: ["read"],
    }),
  );
  await attempt(
    "saveGroupForeignAircraft",
    c.mutation(api.admin.saveGroup, {
      programUuid: "A",
      name: "x",
      aircraftIds: ["plane-B"],
      permissions: ["read"],
    }),
  );
  await attempt(
    "editGroupB",
    c.mutation(api.admin.saveGroup, {
      id: ids.groups.readersB,
      programUuid: "B",
      name: "Hijacked",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    }),
  );
  await attempt(
    "updateAccessB",
    c.mutation(api.programUsers.updateAccess, {
      programUuid: "B",
      groupIds: [ids.groups.readersB],
      userId: ids.users.readerB,
      remove: true,
    }),
  );
  await attempt(
    "addExistingB",
    c.mutation(api.programUsers.addExisting, {
      programUuid: "A",
      groupIds: [ids.groups.readersB],
      email: "programAdmin@example.test",
    }),
  );
  await attempt(
    "programSaveB",
    c.mutation(api.fleet.save, {
      programUuid: "A",
      payload: programSave("B", "B2"),
    }),
  );
  await attempt(
    "programCreate",
    c.mutation(api.fleet.save, {
      programUuid: "A",
      payload: programSave("C", "C", 0),
    }),
  );
  await attempt(
    "deleteGroupB",
    c.mutation(api.groupDeletion.remove, {
      id: ids.groups.readersB,
      programUuid: "A",
      expected: "",
    }),
  );
  await attempt("faaCommit", c.query(api.addressVerification.status, {}));
  expect(results).toEqual(
    Object.fromEntries(Object.keys(results).map((k) => [k, "rejected"])),
  );
});

it("probe: snapshots by role", async () => {
  const { as } = await setup();
  const owner = (await as("owner").query(api.operations.snapshot, {}))!;
  expect(owner.aircraft.map((a) => a.uuid)).toEqual(["plane-A1"]);
  expect(owner.audit).toEqual([]);
  expect(owner.flights).toEqual([]);
  expect(owner.members.map((m) => m.name)).toEqual(["owner"]);
  const restricted = (await as("restricted").query(
    api.operations.snapshot,
    {},
  ))!;
  expect(restricted.aircraft.map((a) => a.uuid)).toEqual(["plane-A1"]);
  const b = (await as("readerB").query(api.operations.snapshot, {}))!;
  expect(b.aircraft.map((a) => a.uuid)).toEqual(["plane-B"]);
  expect(b.programs!.map((p) => p.uuid)).toEqual(["B"]);
  expect(b.members.map((m) => m.name).sort()).toEqual(["readerB"]);
  const pilot = (await as("pilot").query(api.operations.snapshot, {}))!;
  expect(pilot.members.map((m) => m.name).sort()).toEqual(
    ["owner", "pilot", "programAdmin", "restricted"].sort(),
  );
  expect(pilot.members.every((m) => m.email === "" || m.name === "pilot")).toBe(
    true,
  );
  expect(await as("disabledAdmin").query(api.operations.snapshot, {})).toBe(
    null,
  );
});

it("probe: aircraft transfer visibility for each program", async () => {
  const { t, ids, as } = await setup();
  await t.run(async (ctx) => {
    await ctx.db.insert("discrepancies", {
      uuid: "report-A1",
      aircraftUuid: "plane-A1",
      description: "Oil leak",
      status: "open",
      authorId: ids.users.pilot,
      createdAt: Date.now(),
    });
    await ctx.db.insert("audit", {
      uuid: "audit-1",
      programUuid: "A",
      aircraftUuid: "plane-A1",
      entityUuid: "report-A1",
      actorId: ids.users.pilot,
      action: "discrepancy.reported",
      at: Date.now(),
    });
    await ctx.db.insert("audit", {
      uuid: "audit-2",
      aircraftUuid: "plane-A1",
      entityUuid: "plane-A1",
      actorId: ids.users.system,
      action: "aircraft.created",
      at: Date.now(),
    });
  });
  await as("system").mutation(api.programs.transfer, {
    programUuid: "A",
    kind: "aircraft",
    uuid: "plane-A1",
    destination: "B",
    reason: "Moved to B",
  });
  const b = (await as("readerB").query(api.operations.snapshot, {}))!;
  expect(b.aircraft.map((a) => a.uuid).sort()).toEqual(["plane-A1", "plane-B"]);
  expect(b.discrepancies.map((d) => d.uuid)).toEqual(["report-A1"]);
  expect(b.audit.map((a) => a.uuid).sort()).toEqual(
    expect.arrayContaining(["audit-1", "audit-2"]),
  );
  const page = await as("readerB").query(api.auditHistory.page, {
    programUuid: "B",
    aircraftUuid: "plane-A1",
    cursor: null,
    numItems: 20,
  });
  expect(page.page.map((a) => a.action)).toEqual(
    expect.arrayContaining(["program.transferred", "discrepancy.reported"]),
  );
  for (const who of ["pilot", "programAdmin", "restricted", "owner"]) {
    const s = (await as(who).query(api.operations.snapshot, {}))!;
    expect({ who, a: s.aircraft.map((a) => a.uuid) }).toEqual({
      who,
      a: who === "pilot" || who === "programAdmin" ? ["plane-A2"] : [],
    });
    expect(s.discrepancies).toEqual([]);
    expect(s.audit.filter((a) => a.aircraftUuid === "plane-A1")).toEqual([]);
  }
  await expect(
    as("programAdmin").query(api.auditHistory.page, {
      programUuid: "A",
      aircraftUuid: "plane-A1",
      cursor: null,
      numItems: 20,
    }),
  ).rejects.toThrow(/History not found/);
});
