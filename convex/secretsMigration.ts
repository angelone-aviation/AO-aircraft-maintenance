import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  activeKeyId,
  isSealed,
  needsReseal,
  openSecret,
  sealSecret,
  type SecretContext,
} from "./secrets";
// Re-seals every saved credential (plaintext, v1, or v2 under another key) as
// v2 under the active key. Run after deploying v2 and after each key rotation:
//   npx convex run secretsMigration:reseal
// See docs/runbooks/credentials-key.md.
const MIGRATION = "credentials-v2";
// Plaintext values saved before encryption keep working, with a warning, until
// the migration has completed once; afterwards they are refused.
export const legacyPlaintextAccepted = internalQuery({
  args: {},
  handler: async (ctx) =>
    !(await ctx.db
      .query("credentialMigrations")
      .withIndex("name", (q) => q.eq("name", MIGRATION))
      .first()),
});
export async function openStoredSecret(
  ctx: Pick<ActionCtx, "runQuery">,
  stored: string,
  context: SecretContext,
) {
  if (isSealed(stored)) return openSecret(stored, context);
  const legacyPlaintext = await ctx.runQuery(
    internal.secretsMigration.legacyPlaintextAccepted,
    {},
  );
  return openSecret(stored, context, { legacyPlaintext });
}
const SPRUCE_FIELDS = ["userid", "password", "apikey"] as const;
const target = v.union(
  v.object({
    table: v.literal("faaCredentials"),
    id: v.id("faaCredentials"),
    field: v.literal("key"),
  }),
  v.object({
    table: v.literal("addressVerificationSettings"),
    id: v.id("addressVerificationSettings"),
    field: v.literal("key"),
  }),
  v.object({
    table: v.literal("spruceAccounts"),
    id: v.id("spruceAccounts"),
    field: v.union(
      v.literal("userid"),
      v.literal("password"),
      v.literal("apikey"),
    ),
  }),
);
export const stored = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = [];
    for (const r of await ctx.db.query("faaCredentials").collect())
      if (r.key)
        rows.push({
          target: {
            table: "faaCredentials" as const,
            id: r._id,
            field: "key" as const,
          },
          programUuid: "",
          value: r.key,
        });
    for (const r of await ctx.db.query("addressVerificationSettings").collect())
      if (r.key)
        rows.push({
          target: {
            table: "addressVerificationSettings" as const,
            id: r._id,
            field: "key" as const,
          },
          programUuid: "",
          value: r.key,
        });
    for (const r of await ctx.db.query("spruceAccounts").collect())
      for (const field of SPRUCE_FIELDS)
        if (r.credentials)
          rows.push({
            target: { table: "spruceAccounts" as const, id: r._id, field },
            programUuid: r.programUuid,
            value: r.credentials[field],
          });
    return rows;
  },
});
// Compare-and-swap: a credential saved since it was read is left alone.
export const replace = internalMutation({
  args: { target, from: v.string(), to: v.string() },
  handler: async (ctx, { target, from, to }) => {
    if (target.table === "spruceAccounts") {
      const row = await ctx.db.get(target.id);
      if (row?.credentials?.[target.field] !== from) return false;
      await ctx.db.patch(row._id, {
        credentials: { ...row.credentials, [target.field]: to },
      });
      return true;
    }
    const row = await ctx.db.get(target.id);
    if (row?.key !== from) return false;
    await ctx.db.patch(row._id, { key: to });
    return true;
  },
});
export const complete = internalMutation({
  args: { keyId: v.string() },
  handler: async (ctx, args) => {
    const done = await ctx.db
      .query("credentialMigrations")
      .withIndex("name", (q) => q.eq("name", MIGRATION))
      .first();
    if (done)
      await ctx.db.patch(done._id, {
        keyId: args.keyId,
        completedAt: Date.now(),
      });
    else
      await ctx.db.insert("credentialMigrations", {
        name: MIGRATION,
        keyId: args.keyId,
        completedAt: Date.now(),
      });
  },
});
export const reseal = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ resealed: number; remaining: number; complete: boolean }> => {
    const keyId = activeKeyId();
    let resealed = 0;
    for (const row of await ctx.runQuery(
      internal.secretsMigration.stored,
      {},
    )) {
      if (!needsReseal(row.value)) continue;
      const context = {
        table: row.target.table,
        programUuid: row.programUuid,
        field: row.target.field,
      };
      const plain = await openSecret(row.value, context, {
        legacyPlaintext: true,
      });
      const to = await sealSecret(plain, context);
      if (
        await ctx.runMutation(internal.secretsMigration.replace, {
          target: row.target,
          from: row.value,
          to,
        })
      )
        resealed++;
    }
    const remaining = (
      await ctx.runQuery(internal.secretsMigration.stored, {})
    ).filter((row) => needsReseal(row.value)).length;
    if (!remaining)
      await ctx.runMutation(internal.secretsMigration.complete, { keyId });
    return { resealed, remaining, complete: !remaining };
  },
});
