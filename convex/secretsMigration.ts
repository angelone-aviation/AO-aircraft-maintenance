/**
 * Responsibility: Re-seals every saved credential under the active key after a
 *   key rotation, and opens a stored credential for a provider call.
 * Layer: Server. Internal functions, run by hand after each key rotation:
 *   `npx convex run secretsMigration:reseal`.
 * Dependencies: convex/secrets.ts, convex/values, convex/_generated.
 *
 * Rotation: docs/runbooks/credentials-key.md.
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
  needsReseal,
  openSecret,
  sealSecret,
  type SecretContext,
} from "./secrets";

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
 * Opens a stored credential for a provider call.
 *
 * @param _ctx - Unused since plaintext is refused outright; kept so the three
 *   callers need not change (docs/architecture/t21-inventory.md).
 * @param stored - The value as stored.
 * @param context - The row and field it was read from.
 * @returns The plaintext credential.
 * @throws {ConvexError} As {@link openSecret}: "A saved credential is not
 *   encrypted. …" for plaintext or v1.
 */
export function openStoredSecret(
  _ctx: Pick<ActionCtx, "runQuery">,
  stored: string,
  context: SecretContext,
): Promise<string> {
  return openSecret(stored, context);
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
 * Re-seals every credential that is not v2 under the active key, one
 * compare-and-swap at a time. Idempotent; run again until it reports
 * `complete: true`.
 *
 * @returns How many values this run replaced, how many still need it, and
 *   whether none does.
 * @throws {ConvexError} From the key configuration, or when a value cannot be
 *   opened (plaintext and v1 included); values replaced before the throw stay
 *   replaced.
 */
export const reseal = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ resealed: number; remaining: number; complete: boolean }> => {
    let resealed = 0;
    for (const row of await ctx.runQuery(internal.secretsMigration.stored, {}))
      if (needsReseal(row.value) && (await resealCredential(ctx, row)))
        resealed++;
    const remaining = (
      await ctx.runQuery(internal.secretsMigration.stored, {})
    ).filter((row) => needsReseal(row.value)).length;
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
  const plain = await openSecret(row.value, context);
  const to = await sealSecret(plain, context);
  return ctx.runMutation(internal.secretsMigration.replace, {
    target: row.target,
    from: row.value,
    to,
  });
}
