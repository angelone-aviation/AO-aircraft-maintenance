/**
 * Responsibility: Pins the push sender: dormant without VAPID keys, one
 *   encrypted request per subscribed device, the push-channel claim, a gone
 *   subscription removed, a refused send retried later, and an alert that
 *   cleared and returned pushed again.
 * Layer: Test. convex-test suite with a stubbed push service; never shipped.
 * Dependencies: convex/push.ts, convex/urgentAlerts.ts,
 *   convex/pushSubscriptions.ts, convex/webPushProtocol.ts,
 *   tests/fixtures/alertProgram.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { toBase64Url } from "./webPushProtocol";
import {
  DEMO_PROGRAM,
  seedAlertProgram,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";

// RFC 8291's receiver keys: a well-formed subscription.
const SUBSCRIPTION = {
  programUuid: DEMO_PROGRAM,
  endpoint: "https://push.example.test/send/admin-phone",
  keys: {
    p256dh:
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function stubVapid() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  vi.stubEnv("VAPID_PUBLIC_KEY", toBase64Url(raw));
  vi.stubEnv("VAPID_PRIVATE_KEY", jwk.d!);
  vi.stubEnv("VAPID_SUBJECT", "mailto:alerts@example.test");
}

function stubPushService(status = 201) {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", request);
  return request;
}

const deliveries = (t: AlertWorld["t"]) =>
  t.run((ctx) => ctx.db.query("alertDeliveries").collect());
const subscriptions = (t: AlertWorld["t"]) =>
  t.run((ctx) => ctx.db.query("pushSubscriptions").collect());

async function checkProgram(world: AlertWorld) {
  const result = await world.t.action(internal.urgentAlerts.sendImmediate, {
    programUuid: DEMO_PROGRAM,
  });
  await world.t.finishAllScheduledFunctions(vi.runAllTimers);
  return result;
}

it("stays dormant without VAPID keys", async () => {
  const world = await seedAlertProgram();
  await world.a.mutation(api.pushSubscriptions.subscribe, SUBSCRIPTION);
  const request = stubPushService();
  expect(
    await world.t.action(internal.push.sendUrgent, {
      notifications: [
        {
          userId: world.ids.a.userId,
          programUuid: DEMO_PROGRAM,
          alerts: [{ key: "k", title: "Grounded" }],
          programName: "Ops",
        },
      ],
    }),
  ).toEqual({ sent: 0, failed: 0, removed: 0, skipped: true });
  expect(request).not.toHaveBeenCalled();
});

it("pushes each member's new urgent alerts to their devices once, encrypted", async () => {
  const world = await seedAlertProgram();
  const { t, a } = world;
  vi.useFakeTimers();
  await stubVapid();
  await a.mutation(api.pushSubscriptions.subscribe, SUBSCRIPTION);
  const request = stubPushService();
  expect(await checkProgram(world)).toMatchObject({ pushed: 1, sent: 0 });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0];
  expect(url).toBe(SUBSCRIPTION.endpoint);
  const headers = new Headers(init?.headers);
  expect(headers.get("Content-Encoding")).toBe("aes128gcm");
  expect(headers.get("TTL")).toBe("86400");
  expect(headers.get("Authorization")).toMatch(/^vapid t=.+, k=.+$/);
  expect(init?.body).toBeInstanceOf(Uint8Array);
  // The message text never travels in the clear.
  expect(new TextDecoder().decode(init?.body as Uint8Array)).not.toContain(
    "N206MA",
  );
  const rows = await deliveries(t);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.channel === "push")).toBe(true);
  expect(await checkProgram(world)).toMatchObject({ pushed: 0 });
  expect(request).toHaveBeenCalledTimes(1);
});

it("removes a subscription the push service reports gone and keeps the claim", async () => {
  const world = await seedAlertProgram();
  vi.useFakeTimers();
  await stubVapid();
  await world.a.mutation(api.pushSubscriptions.subscribe, SUBSCRIPTION);
  stubPushService(410);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await checkProgram(world);
  expect(await subscriptions(world.t)).toEqual([]);
  // Nothing was accepted, so the alerts stay unclaimed for a new device.
  expect(await deliveries(world.t)).toEqual([]);
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});

it("releases the claim after a refused send, logging the user id only", async () => {
  const world = await seedAlertProgram();
  vi.useFakeTimers();
  await stubVapid();
  await world.a.mutation(api.pushSubscriptions.subscribe, SUBSCRIPTION);
  stubPushService(500);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await checkProgram(world);
  expect(await deliveries(world.t)).toEqual([]);
  expect(await subscriptions(world.t)).toHaveLength(1);
  expect(error).toHaveBeenCalledWith(
    "Push message not sent",
    world.ids.a.userId,
    "Push service rejected the message (500).",
  );
  expect(JSON.stringify(error.mock.calls)).not.toContain("push.example.test");
  error.mockRestore();
  const request = stubPushService(201);
  await checkProgram(world);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await deliveries(world.t)).toHaveLength(2);
});

it("pushes an urgent alert again when it cleared and came back", async () => {
  const world = await seedAlertProgram();
  vi.useFakeTimers();
  await stubVapid();
  await world.a.mutation(api.pushSubscriptions.subscribe, SUBSCRIPTION);
  const request = stubPushService();
  const setDue = (dueDate: string) =>
    world.t.run(async (ctx) => {
      for (const i of await ctx.db.query("inspections").collect())
        await ctx.db.patch(i._id, { dueDate });
    });
  expect(await checkProgram(world)).toMatchObject({ pushed: 1 });
  // A mistaken due date is corrected, then put back: the same keys return.
  await setDue("2999-01-01");
  expect(await checkProgram(world)).toMatchObject({ pushed: 0 });
  expect(await deliveries(world.t)).toEqual([]);
  await setDue("2000-01-01");
  expect(await checkProgram(world)).toMatchObject({ pushed: 1 });
  expect(await checkProgram(world)).toMatchObject({ pushed: 0 });
  expect(request).toHaveBeenCalledTimes(2);
});
