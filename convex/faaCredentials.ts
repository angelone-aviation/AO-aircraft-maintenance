/**
 * Responsibility: The FAA DRS API key: replacing it once the FAA accepts it,
 *   recording its renewal date, and opening it for actions that call the FAA.
 * Layer: Server. One public action and internal functions; the key is stored
 *   sealed and never returned.
 * Dependencies: convex/secrets, convex/secretsMigration, convex/access,
 *   src/domain/faaCredential, convex/values.
 */
import {
  action,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { sealSecret, type SecretContext } from "./secrets";
import { openStoredSecret } from "./secretsMigration";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { admin, audit } from "./access";
import { faaCredentialInput } from "../src/domain/faaCredential";

const VERIFY_TIMEOUT_MS = 30_000;

type DrsResponse = {
  summary?: unknown;
  documents?: unknown;
  errorMessage?: unknown;
} | null;

/**
 * Refuses anyone but a system administrator, for actions to call first.
 *
 * @throws {ConvexError} "Administrator permission required."
 */
export const authorize = internalQuery({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return null;
  },
});

/**
 * Reads the saved key as stored, for {@link faaSecret}. Checks no access.
 *
 * @returns The sealed key and the renewal date, each "" when not saved.
 */
export const secret = internalQuery({
  args: {},
  handler: async (ctx) => {
    const saved = await ctx.db.query("faaCredentials").unique();
    return { stored: saved?.key || "", expiresOn: saved?.expiresOn || "" };
  },
});

/** Where the FAA key is sealed: the one faaCredentials row, for no program. */
export const FAA_SECRET: SecretContext = {
  table: "faaCredentials",
  programUuid: "",
  field: "key",
};

/**
 * Opens the FAA key for an action about to call the FAA. Until an
 * administrator saves one, the deployment's FAA_DRS_API_KEY is used.
 *
 * @param ctx - Action context.
 * @returns The plaintext key ("" when neither is set) and the renewal date.
 * @throws {ConvexError} As `openStoredSecret`, for a saved key it cannot open.
 */
export async function faaSecret(
  ctx: ActionCtx,
): Promise<{ key: string; expiresOn: string }> {
  const saved = await ctx.runQuery(internal.faaCredentials.secret, {});
  return {
    expiresOn: saved.expiresOn,
    key: saved.stored
      ? await openStoredSecret(ctx, saved.stored, FAA_SECRET)
      : process.env.FAA_DRS_API_KEY || "",
  };
}

/**
 * Saves a key {@link replace} has verified and sealed, with its renewal date.
 *
 * @param key - The sealed key; its plaintext was validated before sealing.
 * @param expiresOn - The renewal date (YYYY-MM-DD).
 * @param version - The settings version the form was loaded with.
 * @returns null. Bumps the version and audits `faa.key.updated` with the
 *   renewal date and version, never the key.
 * @throws {ConvexError} "Administrator permission required."; "The renewal
 *   date must be in the future."; "FAA key settings changed. Reload before
 *   saving."
 * @throws {z.ZodError} For a malformed date or version.
 */
export const commit = internalMutation({
  args: { key: v.string(), expiresOn: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    const user = await admin(ctx);
    const input = faaCredentialInput.omit({ key: true }).parse(args);
    assertRenewalInFuture(input.expiresOn);
    const saved = await ctx.db.query("faaCredentials").unique();
    if ((saved?.version ?? 0) !== input.version)
      throw new ConvexError("FAA key settings changed. Reload before saving.");
    const value = {
      key: args.key,
      expiresOn: input.expiresOn,
      version: input.version + 1,
      updatedAt: Date.now(),
    };
    if (saved) await ctx.db.replace(saved._id, value);
    else await ctx.db.insert("faaCredentials", value);
    await audit(ctx, user._id, "faa.key.updated", "faa-key", {
      after: { expiresOn: value.expiresOn, version: value.version },
    });
    return null;
  },
});

/**
 * Replaces the FAA key, after a test search proves the FAA accepts it, so a
 * working key is never discarded for a bad one.
 *
 * @param key - The new key, as `faaCredentialInput` accepts it.
 * @param expiresOn - Its renewal date (YYYY-MM-DD), after today (UTC).
 * @param version - The settings version the form was loaded with.
 * @returns null. Saves as {@link commit} does.
 * @throws {ConvexError} From sealing, before the FAA sees the key; "FAA could
 *   not verify the new key (<status>). …" or "FAA returned an unexpected
 *   response. …", each ending "The previous key is unchanged."; the
 *   {@link commit} refusals.
 */
export const replace = action({
  args: { key: v.string(), expiresOn: v.string(), version: v.number() },
  handler: async (ctx, args): Promise<null> => {
    await ctx.runQuery(internal.faaCredentials.authorize, {});
    const input = faaCredentialInput.parse(args);
    assertRenewalInFuture(input.expiresOn);
    const sealed = await sealSecret(input.key, FAA_SECRET);
    await verifyWithFaa(input.key);
    await ctx.runMutation(internal.faaCredentials.commit, {
      ...input,
      key: sealed,
    });
    return null;
  },
});

/**
 * Records the renewal date of a key that lives only in FAA_DRS_API_KEY,
 * without reading or changing the key. Run once by hand; it does nothing once
 * key settings exist.
 *
 * @param expiresOn - The renewal date (YYYY-MM-DD).
 * @throws {Error} "Invalid date." when not in YYYY-MM-DD form.
 */
export const initializeExpiry = internalMutation({
  args: { expiresOn: v.string() },
  handler: async (ctx, args) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.expiresOn))
      throw new Error("Invalid date.");
    if (await ctx.db.query("faaCredentials").unique()) return;
    await ctx.db.insert("faaCredentials", {
      expiresOn: args.expiresOn,
      version: 1,
      updatedAt: Date.now(),
    });
  },
});

// ISO dates compare as text; "today" is the UTC date.
function assertRenewalInFuture(expiresOn: string): void {
  if (expiresOn <= new Date().toISOString().slice(0, 10))
    throw new ConvexError("The renewal date must be in the future.");
}

// Never log the request headers or the key.
async function verifyWithFaa(key: string): Promise<void> {
  const response = await fetch(
    "https://drs.faa.gov/api/drs/data-pull/ADFRAWD/filtered",
    {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      redirect: "error",
      body: JSON.stringify({
        offset: 0,
        documentFilters: { Keyword: ["441"] },
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new ConvexError(
      `FAA could not verify the new key (${response.status}). The previous key is unchanged.`,
    );
  const body = (await response.json()) as DrsResponse;
  if (!body?.summary || !Array.isArray(body.documents) || body.errorMessage)
    throw new ConvexError(
      "FAA returned an unexpected response. The previous key is unchanged.",
    );
}
