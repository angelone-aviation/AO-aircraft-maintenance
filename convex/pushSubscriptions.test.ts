/**
 * Responsibility: Pins device subscriptions: the public key only when the
 *   deployment can send, a device moving to whoever signs in on it, own rows
 *   only, malformed keys and hosts other than push services refused, the
 *   device limit, and whether the caller's account holds this device.
 * Layer: Test. convex-test suite; never shipped.
 * Dependencies: convex/pushSubscriptions.ts, convex/schema.ts,
 *   src/domain/pushSubscription.ts, tests/fixtures/alertProgram.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { MAX_PUSH_DEVICES } from "../src/domain/pushSubscription";
import {
  DEMO_PROGRAM,
  seedAlertProgram,
  type AlertWorld,
} from "../tests/fixtures/alertProgram";

const inProgram = { programUuid: DEMO_PROGRAM };
const device = (n: number) => ({
  ...inProgram,
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
  userAgent: "Test browser",
});
const rows = (t: AlertWorld["t"]) =>
  t.run((ctx) => ctx.db.query("pushSubscriptions").collect());

afterEach(() => vi.unstubAllEnvs());

it("publishes the key only once every VAPID variable is set", async () => {
  const { a } = await seedAlertProgram();
  expect(await a.query(api.pushSubscriptions.publicKey, {})).toBe("");
  vi.stubEnv("VAPID_PUBLIC_KEY", "B".repeat(87));
  vi.stubEnv("VAPID_PRIVATE_KEY", "k".repeat(43));
  expect(await a.query(api.pushSubscriptions.publicKey, {})).toBe("");
  vi.stubEnv("VAPID_SUBJECT", "mailto:alerts@example.test");
  expect(await a.query(api.pushSubscriptions.publicKey, {})).toBe(
    "B".repeat(87),
  );
});

it("records the caller's device, moves it to whoever signs in next, and forgets only own rows", async () => {
  const { t, ids, a, reader } = await seedAlertProgram();
  await a.mutation(api.pushSubscriptions.subscribe, device(1));
  await a.mutation(api.pushSubscriptions.subscribe, device(1));
  let stored = await rows(t);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    userId: ids.a.userId,
    programUuid: DEMO_PROGRAM,
    endpoint: device(1).endpoint,
    userAgent: "Test browser",
  });
  await reader.mutation(api.pushSubscriptions.subscribe, device(1));
  stored = await rows(t);
  expect(stored).toHaveLength(1);
  expect(stored[0].userId).toBe(ids.reader.userId);
  await a.mutation(api.pushSubscriptions.unsubscribe, {
    ...inProgram,
    endpoint: device(1).endpoint,
  });
  expect(await rows(t)).toHaveLength(1);
  await reader.mutation(api.pushSubscriptions.unsubscribe, {
    ...inProgram,
    endpoint: device(1).endpoint,
  });
  expect(await rows(t)).toEqual([]);
});

it("refuses malformed subscriptions, a stale program and too many devices", async () => {
  const { t, a } = await seedAlertProgram();
  await expect(
    a.mutation(api.pushSubscriptions.subscribe, {
      ...device(1),
      endpoint: "http://fcm.googleapis.com/fcm/send/plain",
    }),
  ).rejects.toThrow();
  // Only the browsers' push services: the server must not POST elsewhere.
  for (const endpoint of [
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1:8443/admin",
    "https://user:secret@fcm.googleapis.com/fcm/send/x",
    "https://push.example.test/send/1",
  ])
    await expect(
      a.mutation(api.pushSubscriptions.subscribe, { ...device(1), endpoint }),
      endpoint,
    ).rejects.toMatchObject({
      name: "ConvexError",
      data: "This browser's alert service is not supported. Use Chrome, Edge, Firefox or Safari.",
    });
  await expect(
    a.mutation(api.pushSubscriptions.subscribe, {
      ...device(1),
      keys: { p256dh: "short", auth: "a".repeat(22) },
    }),
  ).rejects.toThrow();
  await expect(
    a.mutation(api.pushSubscriptions.subscribe, {
      ...device(1),
      programUuid: "other-program",
    }),
  ).rejects.toMatchObject({ name: "ConvexError" });
  expect(await rows(t)).toEqual([]);
  for (let n = 0; n < MAX_PUSH_DEVICES; n++)
    await a.mutation(api.pushSubscriptions.subscribe, device(n));
  await expect(
    a.mutation(api.pushSubscriptions.subscribe, device(MAX_PUSH_DEVICES)),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Too many devices receive alerts. Turn alerts off on another device first.",
  });
  expect(await rows(t)).toHaveLength(MAX_PUSH_DEVICES);
});

it("answers whether the caller's account holds a device, never another's", async () => {
  const { t, a, reader } = await seedAlertProgram();
  const endpoint = device(1).endpoint;
  expect(await a.query(api.pushSubscriptions.held, { endpoint })).toBe(false);
  await a.mutation(api.pushSubscriptions.subscribe, device(1));
  expect(await a.query(api.pushSubscriptions.held, { endpoint })).toBe(true);
  // Signed in as someone else on the same device: the switch reads off
  // until they switch it on, which moves the device to them.
  expect(await reader.query(api.pushSubscriptions.held, { endpoint })).toBe(
    false,
  );
  await reader.mutation(api.pushSubscriptions.subscribe, device(1));
  expect(await a.query(api.pushSubscriptions.held, { endpoint })).toBe(false);
  await expect(
    t.query(api.pushSubscriptions.held, { endpoint }),
  ).rejects.toThrow();
});
