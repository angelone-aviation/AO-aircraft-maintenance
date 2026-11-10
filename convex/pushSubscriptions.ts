/**
 * Responsibility: The devices members asked to be alerted on: the deployment's
 *   public push key, and each member's own subscriptions.
 * Layer: Server. Public functions for the signed-in member, plus the
 *   internal reads and the clean-up the push sender needs.
 * Dependencies: convex/values, ./_generated, ./access, ./programContext,
 *   src/domain/pushSubscription.
 *
 * A subscription belongs to the account, not to one Flight Program: the
 * program recorded with it is the one the device was subscribed from. Writes
 * no change-log rows, like the alert-email choice.
 */
import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { currentUser } from "./access";
import { checkContext } from "./programContext";
import {
  isPushServiceEndpoint,
  MAX_PUSH_DEVICES,
  pushSubscriptionInputSchema,
  UNSUPPORTED_PUSH_SERVICE,
} from "../src/domain/pushSubscription";

const subscriptionArgs = {
  programUuid: v.optional(v.string()),
  endpoint: v.string(),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
  userAgent: v.optional(v.string()),
};

/**
 * The public key devices subscribe with.
 *
 * @returns VAPID_PUBLIC_KEY, or "" while any of the three VAPID variables is
 *   unset, so devices never subscribe to a deployment that cannot send.
 */
export const publicKey = query({
  args: {},
  handler: async () =>
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
      ? process.env.VAPID_PUBLIC_KEY
      : "",
});

/**
 * Records the caller's device subscription, replacing an earlier row for the
 * same endpoint (another account's included: a device alerts whoever is
 * signed in on it).
 *
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} As `checkContext`; "This browser's alert service is
 *   not supported. Use Chrome, Edge, Firefox or Safari." for an endpoint
 *   outside the browsers' push services; "Too many devices receive alerts.
 *   Turn alerts off on another device first." past 10 devices.
 * @throws {z.ZodError} For a malformed subscription.
 */
export const subscribe = mutation({
  args: subscriptionArgs,
  handler: async (ctx, { programUuid, ...raw }) => {
    const state = await checkContext(ctx, programUuid);
    if (!isPushServiceEndpoint(raw.endpoint))
      throw new ConvexError(UNSUPPORTED_PUSH_SERVICE);
    const input = pushSubscriptionInputSchema.parse(raw);
    const userId = state.user.id as Id<"users">;
    const existing = await byEndpoint(ctx, input.endpoint);
    if (existing) await ctx.db.delete(existing._id);
    await assertDeviceRoom(ctx, userId);
    await ctx.db.insert("pushSubscriptions", {
      userId,
      programUuid,
      ...input,
      createdAt: existing?.userId === userId ? existing.createdAt : Date.now(),
      lastSeenAt: Date.now(),
    });
    return null;
  },
});

/**
 * Whether the caller's own account receives alerts on a device, so the
 * device's switch shows the account's state, not just the browser's: after
 * someone else signs in on a shared device, it reads off until they switch
 * it on.
 *
 * @param endpoint - This device's push endpoint.
 * @returns True only for a subscription stored for the caller.
 * @throws As `currentUser`.
 */
export const held = query({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const user = await currentUser(ctx);
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    return existing?.userId === user._id;
  },
});

/**
 * Forgets the caller's subscription for an endpoint; nothing happens for an
 * unknown one or another account's.
 *
 * @throws {ConvexError} As `checkContext`.
 */
export const unsubscribe = mutation({
  args: { programUuid: v.optional(v.string()), endpoint: v.string() },
  handler: async (ctx, { programUuid, endpoint }) => {
    const state = await checkContext(ctx, programUuid);
    const existing = await byEndpoint(ctx, endpoint);
    if (existing && existing.userId === state.user.id)
      await ctx.db.delete(existing._id);
    return null;
  },
});

/**
 * One member's subscriptions, for the push sender.
 *
 * @returns The rows, in no particular order.
 */
export const ofUser = internalQuery({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) =>
    ctx.db
      .query("pushSubscriptions")
      .withIndex("user", (q) => q.eq("userId", userId))
      .collect(),
});

/**
 * How many refusals for good (401 or 403) in a row remove a subscription. A
 * VAPID key rotation makes every refusal permanent, but so does a VAPID
 * misconfiguration until it is fixed; three checks keep the devices through
 * a brief mistake, and the device's switch then reads off.
 */
export const MAX_PUSH_REFUSALS = 3;

/**
 * Counts a refusal for good of a send to a device, and removes the
 * subscription at {@link MAX_PUSH_REFUSALS} in a row.
 *
 * @returns Whether the subscription was removed.
 */
export const recordRefusal = internalMutation({
  args: { id: v.id("pushSubscriptions") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return true;
    const refusals = (row.refusals ?? 0) + 1;
    if (refusals < MAX_PUSH_REFUSALS) {
      await ctx.db.patch(id, { refusals });
      return false;
    }
    await ctx.db.delete(id);
    return true;
  },
});

/**
 * Starts a device's refusal count again after a send it accepted.
 */
export const recordAccepted = internalMutation({
  args: { id: v.id("pushSubscriptions") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row?.refusals) await ctx.db.patch(id, { refusals: 0 });
  },
});

/**
 * Forgets every device an account is alerted on, when its sessions end
 * (disabled, password reset), so a lost or shared device stops showing the
 * member's alerts (ADR-0012).
 *
 * @returns How many subscriptions were removed.
 */
export async function forgetDevices(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<number> {
  const rows = await ctx.db
    .query("pushSubscriptions")
    .withIndex("user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/**
 * Drops a subscription the push service reported gone (404 or 410), or one
 * whose endpoint is not a push service.
 */
export const remove = internalMutation({
  args: { id: v.id("pushSubscriptions") },
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id);
  },
});

function byEndpoint(ctx: MutationCtx, endpoint: string) {
  return ctx.db
    .query("pushSubscriptions")
    .withIndex("endpoint", (q) => q.eq("endpoint", endpoint))
    .unique();
}

async function assertDeviceRoom(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("pushSubscriptions")
    .withIndex("user", (q) => q.eq("userId", userId))
    .collect();
  if (rows.length >= MAX_PUSH_DEVICES)
    throw new ConvexError(
      "Too many devices receive alerts. Turn alerts off on another device first.",
    );
}
