/**
 * Responsibility: Pins the Aircraft Spruce actions' own checks: the search
 *   bounds, link's one-day test export, sync's order checks, and refresh's
 *   clean-up of a catalog file it could not commit.
 * Layer: Test. convex-test suite with a stubbed fetch; never shipped.
 * Dependencies: convex/aircraftSpruceActions, convex/aircraftSpruce,
 *   convex/secrets, convex/schema, src/domain/aircraftSpruce, src/data/demo.
 */
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { orderFields } from "../src/domain/aircraftSpruce";
import { poDraftSchema, poSchema } from "../src/domain/purchaseOrders";
import { sealSecret } from "./secrets";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const PROGRAM = "demo-program";
const PO_NUMBER = "PO-2026-0001";
const credentials = {
  userid: "user",
  password: "password",
  apikey: "key",
  currency: "USD",
};
const exportLink = () =>
  Response.json({ url: "https://www.aircraftspruce.com/downloads/export.csv" });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function setup() {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", ENCRYPTION_KEY);
  const t = convexTest(schema, modules);
  const subjects = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("purchaseOrders", {
      uuid: "po",
      programUuid: PROGRAM,
      payload: JSON.stringify(purchaseOrder()),
    });
    async function subject(isAdmin: boolean) {
      const userId = await ctx.db.insert("users", {
        active: true,
        isAdmin,
        activeProgramUuid: PROGRAM,
        groupIds: [],
      });
      const session = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 86400000,
      });
      return `${userId}|${session}`;
    }
    return { admin: await subject(true), other: await subject(false) };
  });
  return {
    t,
    admin: t.withIdentity({ subject: subjects.admin }),
    other: t.withIdentity({ subject: subjects.other }),
  };
}

function purchaseOrder() {
  return poSchema.parse({
    ...poDraftSchema.parse({
      uuid: "po",
      version: 1,
      vendor: "Aircraft Spruce",
      vendorContact: "",
      shipTo: "Hangar",
      expectedDate: "",
      currency: "USD",
      shippingCents: 0,
      notes: "",
      lines: [
        {
          uuid: "line",
          locationUuid: "store",
          partNumber: "AN3",
          description: "Bolt",
          quantity: 1,
          unitCents: 100,
          kind: "part",
        },
      ],
    }),
    programUuid: PROGRAM,
    number: PO_NUMBER,
    phase: "issued",
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    shipments: [],
    receipts: [],
    history: [],
  });
}

async function linkAccount(admin: Awaited<ReturnType<typeof setup>>["admin"]) {
  const seal = (field: "userid" | "password" | "apikey") =>
    sealSecret(credentials[field], {
      table: "spruceAccounts",
      programUuid: PROGRAM,
      field,
    });
  await admin.mutation(internal.aircraftSpruce.commitAccount, {
    programUuid: PROGRAM,
    version: 0,
    credentials: {
      userid: await seal("userid"),
      password: await seal("password"),
      apikey: await seal("apikey"),
      currency: "USD",
    },
  });
}

function stubFetch(...responses: Response[]) {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function requestBody(fetcher: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetcher.mock.calls[0][1].body as string);
}

it("checks the search length before access, counting 2 after trimming", async () => {
  const { other } = await setup();
  for (const search of [" a ", "a".repeat(201)])
    await expect(
      other.action(api.aircraftSpruceActions.search, {
        programUuid: PROGRAM,
        search,
      }),
    ).rejects.toMatchObject({ data: "Enter 2–200 characters." });
  await expect(
    other.action(api.aircraftSpruceActions.search, {
      programUuid: PROGRAM,
      search: "ab",
    }),
  ).rejects.toThrow(/permission denied/);
});

it("links after downloading one UTC day of order numbers", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
  // Ahead of UTC, so local dates would already read January 1.
  vi.stubEnv("TZ", "Pacific/Auckland");
  const { admin } = await setup();
  const fetcher = stubFetch(exportLink(), new Response("ORN\n"));
  await admin.action(api.aircraftSpruceActions.link, {
    programUuid: PROGRAM,
    version: 0,
    ...credentials,
  });
  expect(requestBody(fetcher)).toMatchObject({
    order_from: "12/31/2026",
    order_to: "01/01/2027",
    fields: ["ORN"],
  });
  await expect(
    admin.action(api.aircraftSpruceActions.link, {
      programUuid: PROGRAM,
      version: 0,
      ...credentials,
    }),
  ).rejects.toMatchObject({ data: "Account changed. Reload before saving." });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("refuses an order number with wildcards or over 100 characters", async () => {
  const { admin } = await setup();
  await linkAccount(admin);
  const fetcher = stubFetch();
  for (const order of ["12%", "1_2", "1".repeat(101)])
    await expect(
      admin.action(api.aircraftSpruceActions.sync, {
        programUuid: PROGRAM,
        poUuid: "po",
        order,
      }),
    ).rejects.toMatchObject({ data: "Enter an exact order number." });
  expect(fetcher).not.toHaveBeenCalled();
});

it("syncs by trimmed order number, or by PO number when it is blank", async () => {
  const { admin } = await setup();
  await linkAccount(admin);
  const header = orderFields.join(",");
  const line = (orn: string, pono: string) =>
    orderFields.map((f) => ({ ORN: orn, PONO: pono })[f] ?? "").join(",");
  let fetcher = stubFetch(
    exportLink(),
    new Response(`${header}\n${line("77", "")}\n${line("78", "")}\n`),
  );
  expect(
    await admin.action(api.aircraftSpruceActions.sync, {
      programUuid: PROGRAM,
      poUuid: "po",
      order: " 77 ",
    }),
  ).toBe(1);
  expect(requestBody(fetcher)).toMatchObject({ order: "77" });
  fetcher = stubFetch(exportLink(), new Response(`${header}\n`));
  await expect(
    admin.action(api.aircraftSpruceActions.sync, {
      programUuid: PROGRAM,
      poUuid: "po",
      order: "",
    }),
  ).rejects.toMatchObject({
    data: "No matching orders found. Existing sync retained. Check the PO number or enter the Aircraft Spruce order number.",
  });
  expect(requestBody(fetcher)).toMatchObject({ po: PO_NUMBER });
  expect(requestBody(fetcher)).not.toHaveProperty("order");
});

it("refuses order lines too large to store", async () => {
  const { admin } = await setup();
  await linkAccount(admin);
  const header = orderFields.join(",");
  const big = orderFields
    .map((f) => (f === "ORN" ? "77" : "x".repeat(400)))
    .join(",");
  stubFetch(exportLink(), new Response(`${header}\n${`${big}\n`.repeat(100)}`));
  await expect(
    admin.action(api.aircraftSpruceActions.sync, {
      programUuid: PROGRAM,
      poUuid: "po",
      order: "77",
    }),
  ).rejects.toMatchObject({
    data: "Order export is too large. Select an individual order.",
  });
});

it("shows an export of over 1,000 order lines as a ConvexError", async () => {
  const { admin } = await setup();
  await linkAccount(admin);
  const line = orderFields.map((f) => (f === "ORN" ? "77" : "")).join(",");
  const rows = `${line}\n`.repeat(1001);
  stubFetch(exportLink(), new Response(`${orderFields.join(",")}\n${rows}`));
  await expect(
    admin.action(api.aircraftSpruceActions.sync, {
      programUuid: PROGRAM,
      poUuid: "po",
      order: "77",
    }),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "Too many order lines. Select an individual order.",
  });
});

it("deletes a refreshed catalog file the commit refuses", async () => {
  const { t, admin } = await setup();
  await linkAccount(admin);
  await t.run(async (ctx) => {
    const account = await ctx.db.query("spruceAccounts").unique();
    await ctx.db.patch(account!._id, { catalogAt: Date.now() + 86400000 });
  });
  stubFetch(
    exportLink(),
    new Response("PN,DESCRIPTION,NETPRICE,UOM\nA,B,1,EA\n"),
  );
  await expect(
    admin.action(api.aircraftSpruceActions.refresh, { programUuid: PROGRAM }),
  ).rejects.toThrow(/newer catalog/);
  expect(
    await t.run((ctx) => ctx.db.system.query("_storage").collect()),
  ).toEqual([]);
});

it("refuses a catalog with an empty part number", async () => {
  const { admin } = await setup();
  await linkAccount(admin);
  stubFetch(
    exportLink(),
    new Response("PN,DESCRIPTION,NETPRICE,UOM\n,B,1,EA\n"),
  );
  await expect(
    admin.action(api.aircraftSpruceActions.refresh, { programUuid: PROGRAM }),
  ).rejects.toMatchObject({ data: "Catalog contains an empty part number." });
});
