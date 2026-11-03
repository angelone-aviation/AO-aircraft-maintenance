/**
 * Responsibility: Re-seals every saved credential (plaintext, v1, or v2 under
 *   another key) as v2 under the active key, and gates legacy plaintext on it.
 * Layer: Server. Internal functions; run by hand after deploying and after
 *   each key rotation: `npx convex run secretsMigration:reseal`.
 * Dependencies: convex/secrets.ts, convex/values, convex/_generated.
 *
 * Plaintext values saved before encryption keep working, with a warning, until
 * the migration has completed once; afterwards they are refused. Keys and
 * rotation: docs/runbooks/credentials-key.md.
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  activeKeyId,
  isSealed,
  needsReseal,
  openSecret,
  sealSecret,
  type SecretContext,
} from "./secrets";

// Name of the completion row. Renaming it would accept plaintext again until
// the next complete run.
const MIGRATION = "credentials-v2";
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

type StoredCredential = {
  target: Infer<typeof target>;
  programUuid: string;
  value: string;
};

/**
 * Tells whether legacy plaintext credentials are still accepted.
 *
 * @returns True until the migration has completed once.
 */
export const legacyPlaintextAccepted = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> =>
    !(await ctx.db
      .query("credentialMigrations")
      .withIndex("name", (q) => q.eq("name", MIGRATION))
      .first()),
});

/**
 * Opens a stored credential for a provider call, accepting legacy plaintext
 * only while {@link legacyPlaintextAccepted} says so.
 *
 * @param ctx - Action context, for the plaintext check.
 * @param stored - The value as stored.
 * @param context - The row and field it was read from.
 * @returns The plaintext credential.
 * @throws {ConvexError} As {@link openSecret}, including "A saved credential is
 *   not encrypted. …" for plaintext once the migration has completed.
 */
export async function openStoredSecret(
  ctx: Pick<ActionCtx, "runQuery">,
  stored: string,
  context: SecretContext,
): Promise<string> {
  if (isSealed(stored)) return openSecret(stored, context);
  const legacyPlaintext = await ctx.runQuery(
    internal.secretsMigration.legacyPlaintextAccepted,
    {},
  );
  return openSecret(stored, context, { legacyPlaintext });
}

/**
 * Lists every saved credential with the row and field it is stored in.
 *
 * @returns FAA keys, Geoapify keys, then each Aircraft Spruce account's userid,
 *   password and apikey; unset keys and accounts without credentials skipped.
 */
export const stored = internalQuery({
  args: {},
  handler: async (ctx): Promise<StoredCredential[]> => {
    const rows: StoredCredential[] = [];
    for (const r of await ctx.db.query("faaCredentials").collect())
      if (r.key)
        rows.push({
          target: { table: "faaCredentials", id: r._id, field: "key" },
          programUuid: "",
          value: r.key,
        });
    for (const r of await ctx.db.query("addressVerificationSettings").collect())
      if (r.key)
        rows.push({
          target: {
            table: "addressVerificationSettings",
            id: r._id,
            field: "key",
          },
          programUuid: "",
          value: r.key,
        });
    for (const r of await ctx.db.query("spruceAccounts").collect())
      rows.push(...listSpruceCredentials(r));
    return rows;
  },
});

/**
 * Swaps one stored credential for its re-sealed value, unless it changed since
 * it was read (compare-and-swap), so a credential saved meanwhile is kept.
 *
 * @param target - The row and field.
 * @param from - The value as read.
 * @param to - The re-sealed value.
 * @returns True when the value was replaced.
 */
export const replace = internalMutation({
  args: { target, from: v.string(), to: v.string() },
  handler: async (ctx, { target, from, to }): Promise<boolean> => {
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

/**
 * Records that every credential is sealed under `keyId`, which ends the
 * acceptance of legacy plaintext. Upserts the one completion row.
 *
 * @param keyId - The key the run sealed with.
 */
export const complete = internalMutation({
  args: { keyId: v.string() },
  handler: async (ctx, args): Promise<void> => {
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

/**
 * Re-seals every credential that is not v2 under the active key, one
 * compare-and-swap at a time, and marks the migration complete when none is
 * left. Idempotent; run again until it reports `complete: true`.
 *
 * @returns How many values this run replaced, how many still need it, and
 *   whether none does.
 * @throws {ConvexError} From the key configuration, or when a value cannot be
 *   opened; values replaced before the throw stay replaced.
 */
export const reseal = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ resealed: number; remaining: number; complete: boolean }> => {
    const keyId = activeKeyId();
    let resealed = 0;
    for (const row of await ctx.runQuery(internal.secretsMigration.stored, {}))
      if (needsReseal(row.value) && (await resealCredential(ctx, row)))
        resealed++;
    const remaining = (
      await ctx.runQuery(internal.secretsMigration.stored, {})
    ).filter((row) => needsReseal(row.value)).length;
    if (!remaining)
      await ctx.runMutation(internal.secretsMigration.complete, { keyId });
    return { resealed, remaining, complete: !remaining };
  },
});

function listSpruceCredentials(
  account: Doc<"spruceAccounts">,
): StoredCredential[] {
  const { credentials } = account;
  if (!credentials) return [];
  return SPRUCE_FIELDS.map((field) => ({
    target: { table: "spruceAccounts", id: account._id, field },
    programUuid: account.programUuid,
    value: credentials[field],
  }));
}

async function resealCredential(
  ctx: ActionCtx,
  row: StoredCredential,
): Promise<boolean> {
  const context = {
    table: row.target.table,
    programUuid: row.programUuid,
    field: row.target.field,
  };
  const plain = await openSecret(row.value, context, {
    legacyPlaintext: true,
  });
  const to = await sealSecret(plain, context);
  return ctx.runMutation(internal.secretsMigration.replace, {
    target: row.target,
    from: row.value,
    to,
  });
}
