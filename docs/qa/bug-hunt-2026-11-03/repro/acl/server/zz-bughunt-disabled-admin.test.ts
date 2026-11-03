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

// A disabled administrator must remain editable (rename, change groups or
// demote) while another administrator is active; only removing the LAST
// ACTIVE administrator should be refused.
it("lets the only active administrator edit a disabled administrator", async () => {
  const { t, ids, as } = await setup();
  await as("system").mutation(api.admin.updateUser, {
    id: ids.users.disabledAdmin,
    active: false,
    isAdmin: false,
    groupIds: [],
    name: "Former administrator",
  });
  const user = await t.run((ctx) => ctx.db.get(ids.users.disabledAdmin));
  expect(user).toMatchObject({ isAdmin: false, name: "Former administrator" });
});

