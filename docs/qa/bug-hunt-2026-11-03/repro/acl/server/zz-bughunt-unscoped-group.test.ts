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

// docs/flight-program-access.md step 5: "Assign existing unscoped permission
// groups to a program before expecting them to grant access."
it("lets a system administrator assign an unscoped legacy group to a program", async () => {
  const { t, ids, as } = await setup();
  const legacy = await t.run((ctx) =>
    ctx.db.insert("groups", {
      name: "Legacy maintenance",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["read", "maintenance"],
    }),
  );
  await t.run((ctx) =>
    ctx.db.patch(ids.users.pilot, { groupIds: [ids.groups.pilotsA, legacy] }),
  );
  await as("system").mutation(api.admin.saveGroup, {
    id: legacy,
    programUuid: "A",
    name: "Legacy maintenance",
    programAdmin: false,
    aircraftIds: [],
    permissions: ["read", "maintenance"],
  });
  expect(await t.run((ctx) => ctx.db.get(legacy))).toMatchObject({
    programUuid: "A",
  });
});

