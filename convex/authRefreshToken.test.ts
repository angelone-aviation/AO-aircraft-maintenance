import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
// GHSA-579h-4cfp-fh53: @convex-dev/auth <= 0.0.95 deleted whatever document the
// session half of a forged refresh token named, without signing in.
it("a forged refresh token cannot delete an arbitrary document", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      active: true,
      isAdmin: true,
      groupIds: [],
      email: "admin@example.com",
    }),
  );
  for (const refreshToken of [`${userId}|${userId}`, `x|${userId}`])
    await t.action(api.auth.signIn, { refreshToken }).catch(() => undefined);
  expect(await t.run((ctx) => ctx.db.get(userId))).not.toBeNull();
});
