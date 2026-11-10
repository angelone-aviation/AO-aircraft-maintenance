/**
 * Responsibility: Delivers urgent alerts to members' devices through their
 *   push services, and drops subscriptions those services report gone.
 * Layer: Server. A Node action scheduled by the urgent-alert sender; the
 *   message and the dedup claim come from elsewhere.
 * Dependencies: convex/values, ./_generated, ./urgentAlerts (job type and
 *   message), ./webPushProtocol, src/domain/pushSubscription.
 *
 * Dormant until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are
 * set (docs/runbooks/monitoring.md). Logs name the user id, never the
 * endpoint or the message.
 */
"use node";
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  pushJobValidator,
  pushPayloadFor,
  RETRY_DELAYS_MS,
  type PushJob,
} from "./urgentAlerts";
import { buildPushRequest, type VapidKeys } from "./webPushProtocol";
import { isPushServiceEndpoint } from "../src/domain/pushSubscription";

const PUSH_TIMEOUT_MS = 15000;
// The push service no longer knows the subscription (RFC 8030 §7.3).
const GONE_STATUSES = [404, 410];

interface Counts {
  sent: number;
  failed: number;
  removed: number;
}

/**
 * Sends each member's push message to every device they subscribed, after
 * claiming the alerts on the push channel so a second run sends nothing
 * twice. A member none of whose devices accepted the message has the claim
 * released, and those members' jobs run again after the next of
 * `RETRY_DELAYS_MS`.
 *
 * @param notifications - One job per member, from `sendImmediate`.
 * @param attempt - How many retries came before this run; 0 by default.
 * @returns How many messages were accepted, how many failed, how many gone
 *   subscriptions were removed; `skipped` while the VAPID variables are
 *   unset.
 */
export const sendUrgent = internalAction({
  args: {
    notifications: v.array(pushJobValidator),
    attempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { notifications, attempt = 0 },
  ): Promise<Counts & { skipped: boolean }> => {
    const vapid = readVapidKeys();
    const counts: Counts = { sent: 0, failed: 0, removed: 0 };
    if (!vapid) return { ...counts, skipped: true };
    const refused: PushJob[] = [];
    for (const job of notifications)
      if (await notifyMember(ctx, vapid, job, counts)) refused.push(job);
    if (refused.length && attempt < RETRY_DELAYS_MS.length)
      await ctx.scheduler.runAfter(
        RETRY_DELAYS_MS[attempt],
        internal.push.sendUrgent,
        { notifications: refused, attempt: attempt + 1 },
      );
    return { ...counts, skipped: false };
  },
});

function readVapidKeys(): VapidKeys | undefined {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return undefined;
  return { publicKey, privateKey, subject };
}

// True when the member's claim was released for a retry: devices exist, but
// none accepted the message for a reason other than being gone.
async function notifyMember(
  ctx: ActionCtx,
  vapid: VapidKeys,
  job: PushJob,
  counts: Counts,
): Promise<boolean> {
  const { userId, programUuid } = job;
  const claim = await ctx.runMutation(internal.urgentAlerts.claimDeliveries, {
    userId,
    programUuid,
    channel: "push",
    keys: job.alerts.map((a) => a.key),
  });
  if (!claim.claimed.length) return false;
  const payload = JSON.stringify(pushPayloadFor(job, claim.claimed));
  const devices = await ctx.runQuery(internal.pushSubscriptions.ofUser, {
    userId,
  });
  const removedBefore = counts.removed;
  let accepted = 0;
  for (const device of devices)
    if (await deliver(ctx, vapid, device, payload, counts)) accepted++;
  if (accepted) return false;
  await ctx.runMutation(internal.urgentAlerts.releaseDeliveries, {
    userId,
    programUuid,
    channel: "push",
    keys: claim.claimed,
  });
  return counts.removed - removedBefore < devices.length;
}

// True once the push service accepted the message for this device. A row
// saved before endpoints were checked is dropped, never fetched.
async function deliver(
  ctx: ActionCtx,
  vapid: VapidKeys,
  device: Doc<"pushSubscriptions">,
  payload: string,
  counts: Counts,
): Promise<boolean> {
  if (!isPushServiceEndpoint(device.endpoint)) {
    await ctx.runMutation(internal.pushSubscriptions.remove, {
      id: device._id,
    });
    counts.removed++;
    return false;
  }
  try {
    const request = await buildPushRequest(device, payload, vapid);
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (response.ok) {
      counts.sent++;
      return true;
    }
    if (GONE_STATUSES.includes(response.status)) {
      await ctx.runMutation(internal.pushSubscriptions.remove, {
        id: device._id,
      });
      counts.removed++;
      return false;
    }
    throw new Error(`Push service rejected the message (${response.status}).`);
  } catch (error) {
    // One device's failure must not stop the others.
    counts.failed++;
    console.error(
      "Push message not sent",
      device.userId,
      error instanceof Error ? error.message : "unknown error",
    );
    return false;
  }
}
