/**
 * Responsibility: Pins the job-card evidence refusals the main suite leaves
 *   out: a finished upload for a card the user can no longer write (checked
 *   again after the bytes are stored) and removing evidence already gone.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/taskCards.ts, convex/schema.ts, src/data/demo.ts,
 *   tests/fixtures/taskCards.ts.
 */
import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { taskCardCommand } from "../tests/fixtures/taskCards";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const NO_OPEN_CARD = "An open job card and maintenance access are required.";

it("refuses to file evidence on a card the user may no longer write, filing nothing", async () => {
  const { t, tech, reader } = await world();
  const command = taskCardCommand();
  await tech.mutation(api.taskCards.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF"])));
  const finish = {
    programUuid: PROGRAM,
    taskCardUuid: command.uuid,
    storageId,
    name: "photo.jpg",
    size: 4,
    category: "photo" as const,
  };
  await expect(
    reader.mutation(internal.taskCards.finishUpload, finish),
  ).rejects.toMatchObject({ name: "ConvexError", data: NO_OPEN_CARD });
  await expect(
    tech.mutation(internal.taskCards.finishUpload, {
      ...finish,
      taskCardUuid: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ data: NO_OPEN_CARD });
  expect(await t.run((ctx) => ctx.db.query("taskEvidence").collect())).toEqual(
    [],
  );
});

it("says evidence removed meanwhile is not found", async () => {
  const { t, tech } = await world();
  const command = taskCardCommand();
  await tech.mutation(api.taskCards.save, {
    programUuid: PROGRAM,
    payload: JSON.stringify(command),
  });
  const id = await t.run(async (ctx) => {
    const row = await ctx.db.insert("taskEvidence", {
      taskCardUuid: command.uuid,
      storageId: await ctx.storage.store(new Blob(["x"])),
      name: "gone.jpg",
      size: 1,
      uploadedAt: 0,
      category: "photo",
    });
    await ctx.db.delete(row);
    return row;
  });
  await expect(
    tech.mutation(api.taskCards.removeEvidence, { id, programUuid: PROGRAM }),
  ).rejects.toMatchObject({ name: "ConvexError", data: "Evidence not found." });
});

// The demo program and aircraft, a technician with maintenance permission on
// the first aircraft and a reader without it.
async function world() {
  const t = convexTest(schema, modules);
  const s = demoSnapshot();
  const ids = await t.run(async (ctx) => {
    for (const a of s.aircraft) await ctx.db.insert("aircraft", a);
    await ctx.db.insert("programs", s.programs![0]);
    const member = async (permissions: ("read" | "maintenance")[]) => {
      const group = await ctx.db.insert("groups", {
        programUuid: PROGRAM,
        name: permissions.join(","),
        aircraftIds: [s.aircraft[0].uuid],
        permissions,
      });
      const user = await ctx.db.insert("users", {
        name: permissions.join(" "),
        active: true,
        isAdmin: false,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + 86_400_000,
      });
      return { subject: `${user}|${session}` };
    };
    return {
      tech: await member(["read", "maintenance"]),
      reader: await member(["read"]),
    };
  });
  return {
    t,
    tech: t.withIdentity(ids.tech),
    reader: t.withIdentity(ids.reader),
  };
}
