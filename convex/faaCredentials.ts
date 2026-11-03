import {
  action,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { sealSecret, type SecretContext } from "./secrets";
import { openStoredSecret } from "./secretsMigration";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { admin, audit } from "./access";
import { faaCredentialInput } from "../src/domain/faaCredential";
export const authorize = internalQuery({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return null;
  },
});
export const secret = internalQuery({
  args: {},
  handler: async (ctx) => {
    const saved = await ctx.db.query("faaCredentials").unique();
    return { stored: saved?.key || "", expiresOn: saved?.expiresOn || "" };
  },
});
export const FAA_SECRET: SecretContext = {
  table: "faaCredentials",
  programUuid: "",
  field: "key",
};
// Decrypts only inside actions that call the FAA. The environment key is the
// fallback until an administrator saves one.
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
// `key` arrives sealed; replace validated the plaintext before sealing.
export const commit = internalMutation({
  args: { key: v.string(), expiresOn: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    const user = await admin(ctx);
    const input = faaCredentialInput.omit({ key: true }).parse(args);
    if (input.expiresOn <= new Date().toISOString().slice(0, 10))
      throw Error("The renewal date must be in the future.");
    const saved = await ctx.db.query("faaCredentials").unique();
    if ((saved?.version ?? 0) !== input.version)
      throw Error("FAA key settings changed. Reload before saving.");
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
export const replace = action({
  args: { key: v.string(), expiresOn: v.string(), version: v.number() },
  handler: async (ctx, args): Promise<null> => {
    await ctx.runQuery(internal.faaCredentials.authorize, {});
    const input = faaCredentialInput.parse(args);
    if (input.expiresOn <= new Date().toISOString().slice(0, 10))
      throw Error("The renewal date must be in the future.");
    const sealed = await sealSecret(input.key, FAA_SECRET);
    // Verify the replacement before discarding a working key. Never log headers or key values.
    const response = await fetch(
      "https://drs.faa.gov/api/drs/data-pull/ADFRAWD/filtered",
      {
        method: "POST",
        headers: { "x-api-key": input.key, "Content-Type": "application/json" },
        redirect: "error",
        body: JSON.stringify({
          offset: 0,
          documentFilters: { Keyword: ["441"] },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw Error(
        `FAA could not verify the new key (${response.status}). The previous key is unchanged.`,
      );
    const body = await response.json();
    if (!body?.summary || !Array.isArray(body.documents) || body.errorMessage)
      throw Error(
        "FAA returned an unexpected response. The previous key is unchanged.",
      );
    await ctx.runMutation(internal.faaCredentials.commit, {
      ...input,
      key: sealed,
    });
    return null;
  },
});
// One-time initialization of existing environment credentials; does not return or change the secret.
export const initializeExpiry = internalMutation({
  args: { expiresOn: v.string() },
  handler: async (ctx, args) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.expiresOn))
      throw Error("Invalid date.");
    if (await ctx.db.query("faaCredentials").unique()) return;
    await ctx.db.insert("faaCredentials", {
      expiresOn: args.expiresOn,
      version: 1,
      updatedAt: Date.now(),
    });
  },
});
