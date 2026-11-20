/**
 * Responsibility: Pins Form 337 copies and logbook page photos on the
 *   aircraft record: who uploads and archives them, the link a photo must
 *   carry, the audit entries, the separate caps on Form 337 copies and
 *   photos, and that a copy and its stored file are never deleted.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/aircraftFiles, convex/operations (snapshot),
 *   convex/workOrders (save), src/domain/aircraftFiles, src/data/demo,
 *   tests/fixtures/workOrders.
 */
import { convexTest } from "convex-test";
import { it, expect, vi, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { MAX_CURRENT_AIRCRAFT_FILES } from "../src/domain/aircraftFiles";
import { AIRCRAFT_FILE_UPLOADS_PER_HOUR } from "./aircraftFiles";
import { workOrderCommand } from "../tests/fixtures/workOrders";
const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
async function fixture() {
  const t = convexTest(schema, modules),
    demo = demoSnapshot();
  const identities = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    await ctx.db.insert("aircraft", demo.aircraft[0]);
    await ctx.db.insert("aircraft", {
      ...demo.aircraft[0],
      uuid: "foreign-aircraft",
      registration: "FOREIGN",
      programUuid: "foreign",
    });
    const flight = {
      aircraftUuid: demo.aircraft[0].uuid,
      authorId: "pilot",
      pilotId: "pilot",
      submittedAt: 1,
      status: "accepted" as const,
      startTime: "2026-03-04T10:00:00Z",
      hobbsOn: 3600,
      landings: 1,
      cycles: 1,
      origin: "AAA",
      destination: "BBB",
      operation: "Mission" as const,
      flightRules: "VFR" as const,
      remarks: "",
      discrepancy: "",
    };
    await ctx.db.insert("flights", { ...flight, uuid: FLIGHT_UUID });
    await ctx.db.insert("flights", {
      ...flight,
      uuid: FOREIGN_FLIGHT_UUID,
      aircraftUuid: "foreign-aircraft",
    });
    const makeUser = async (
      permissions: ("read" | "flight" | "maintenance")[],
    ) => {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: permissions.join(","),
        aircraftIds: [demo.aircraft[0].uuid],
        permissions,
      });
      const user = await ctx.db.insert("users", {
        name: permissions.join(","),
        active: true,
        isAdmin: false,
        groupIds: [group],
        activeProgramUuid: "demo-program",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${user}|${session}` };
    };
    return {
      tech: await makeUser(["read", "maintenance"]),
      pilot: await makeUser(["read", "flight"]),
      reader: await makeUser(["read"]),
    };
  });
  return {
    t,
    tech: t.withIdentity(identities.tech),
    pilot: t.withIdentity(identities.pilot),
    reader: t.withIdentity(identities.reader),
  };
}
afterEach(() => vi.useRealTimers());

const FLIGHT_UUID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_FLIGHT_UUID = "22222222-2222-4222-8222-222222222222";
const pdf = new TextEncoder().encode("%PDF-1.4 Form 337").buffer;
const upload = {
  aircraftUuid: demoSnapshot().aircraft[0].uuid,
  programUuid: "demo-program",
  category: "form-337" as const,
  name: "337-2019-alteration.pdf",
  type: "application/pdf",
  bytes: pdf,
};
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
const photo = {
  aircraftUuid: demoSnapshot().aircraft[0].uuid,
  programUuid: "demo-program",
  category: "logbook-page" as const,
  linkedKind: "flight" as const,
  linkedUuid: FLIGHT_UUID,
  name: "logbook-line.jpg",
  type: "image/jpeg",
  bytes: jpeg,
};
it("keeps Form 337 copies on the aircraft for readers, with maintenance uploads and archiving audited", async () => {
  const { t, tech, reader } = await fixture();
  await expect(reader.action(api.aircraftFiles.upload, upload)).rejects.toThrow(
    /maintenance permission/,
  );
  await expect(
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      aircraftUuid: "foreign-aircraft",
    }),
  ).rejects.toThrow(/permission/);
  await expect(
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      name: "337.html",
      type: "text/html",
    }),
  ).rejects.toThrow("PDF, JPEG, PNG or WebP");
  await expect(
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      bytes: new Uint8Array(7 * 1024 * 1024 + 1).buffer,
    }),
  ).rejects.toThrow("7 MiB");
  await tech.action(api.aircraftFiles.upload, upload);
  // A foreign program's copy never reaches this program's readers.
  await t.run(async (ctx) =>
    ctx.db.insert("aircraftFiles", {
      aircraftUuid: "foreign-aircraft",
      category: "form-337",
      storageId: await ctx.storage.store(new Blob(["foreign"])),
      name: "foreign-337.pdf",
      type: "application/pdf",
      size: 7,
      uploadedAt: 1,
    }),
  );
  const seen = (await reader.query(api.operations.snapshot, {}))!;
  expect(seen.aircraftFiles).toMatchObject([
    {
      aircraftUuid: upload.aircraftUuid,
      category: "form-337",
      name: "337-2019-alteration.pdf",
      type: "application/pdf",
      size: pdf.byteLength,
    },
  ]);
  // Files open through short-lived links (convex/fileLinks.ts); a storage
  // URL in the snapshot would open the file for anyone, for good.
  expect(seen.aircraftFiles![0]).not.toHaveProperty("url");
  expect(seen.aircraftFiles![0].archivedAt).toBeUndefined();
  const file = seen.aircraftFiles![0];
  const stored = await t.run(async (ctx) =>
    (await ctx.db.query("aircraftFiles").collect()).find(
      (f) => f.aircraftUuid === upload.aircraftUuid,
    )!,
  );
  const archive = (reason: string, programUuid = "demo-program") => ({
    id: stored._id,
    reason,
    programUuid,
  });
  await expect(
    reader.mutation(api.aircraftFiles.archive, archive("Superseded")),
  ).rejects.toThrow(/maintenance permission/);
  await expect(
    tech.mutation(api.aircraftFiles.archive, archive("Superseded", "foreign")),
  ).rejects.toThrow();
  await expect(
    tech.mutation(api.aircraftFiles.archive, archive("   ")),
  ).rejects.toThrow("Enter a reason for archiving this copy.");
  await tech.mutation(
    api.aircraftFiles.archive,
    archive(" Superseded by the corrected 337 "),
  );
  await expect(
    tech.mutation(api.aircraftFiles.archive, archive("Again")),
  ).rejects.toThrow("already archived");
  // Status records are never deleted: the row and its stored file remain.
  const row = await t.run((ctx) => ctx.db.get(stored._id));
  expect(row).toMatchObject({
    storageId: stored.storageId,
    archiveReason: "Superseded by the corrected 337",
    archivedBy: { name: "read,maintenance" },
  });
  expect(row!.archivedAt).toEqual(expect.any(Number));
  expect(
    await t.run(async (ctx) =>
      (await ctx.storage.get(stored.storageId))?.text(),
    ),
  ).toBe("%PDF-1.4 Form 337");
  // Readers still receive the archived copy, flagged; it opens through a
  // link like any other (convex/fileLinkRules.test.ts).
  const after = (await reader.query(api.operations.snapshot, {}))!;
  expect(after.aircraftFiles).toMatchObject([
    {
      uuid: file.uuid,
      archiveReason: "Superseded by the corrected 337",
      archivedBy: { name: "read,maintenance" },
    },
  ]);
  const audit = (await tech.query(api.operations.snapshot, {}))!.audit.filter(
    (a) => a.entityUuid === file.aircraftUuid,
  );
  expect(audit.map((a) => a.action).sort()).toEqual([
    "aircraft.file_archived",
    "aircraft.file_uploaded",
  ]);
  const entry = audit.find((a) => a.action === "aircraft.file_archived")!;
  expect(entry.reason).toBe("Superseded by the corrected 337");
  expect(JSON.parse(entry.before!)).toMatchObject({
    name: file.name,
    category: "form-337",
  });
  expect(JSON.parse(entry.after!)).toMatchObject({
    archiveReason: "Superseded by the corrected 337",
  });
});
// Inserts `count` copies of a category on the aircraft, sharing one blob.
function fillAircraft(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  category: "form-337" | "logbook-page",
  count: number,
  archived = false,
) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["copy"]));
    for (let i = 0; i < count; i++)
      await ctx.db.insert("aircraftFiles", {
        aircraftUuid: upload.aircraftUuid,
        category,
        ...(category === "logbook-page"
          ? { linkedKind: "flight" as const, linkedUuid: FLIGHT_UUID }
          : {}),
        storageId,
        name: `${category}-${i}.pdf`,
        type: "application/pdf",
        size: 3,
        uploadedAt: i,
        ...(archived
          ? {
              archivedAt: 1,
              archivedBy: { userId: "u", name: "Archivist" },
              archiveReason: "Superseded",
            }
          : {}),
      });
  });
}

it("limits an aircraft to 200 current Form 337 copies; archived copies do not count", async () => {
  const { t, tech } = await fixture();
  const max = MAX_CURRENT_AIRCRAFT_FILES["form-337"];
  await fillAircraft(t, "form-337", max, true);
  await tech.action(api.aircraftFiles.upload, upload);
  await fillAircraft(t, "form-337", max - 2);
  await tech.action(api.aircraftFiles.upload, upload);
  await expect(
    tech.action(api.aircraftFiles.upload, upload),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "This aircraft already has the maximum of 200 current Form 337 copies.",
  });
});

it("limits an aircraft to 500 current logbook page photos, apart from its Form 337 copies", async () => {
  const { t, tech, pilot } = await fixture();
  await fillAircraft(t, "form-337", MAX_CURRENT_AIRCRAFT_FILES["form-337"]);
  await fillAircraft(
    t,
    "logbook-page",
    MAX_CURRENT_AIRCRAFT_FILES["logbook-page"] - 1,
  );
  await pilot.action(api.aircraftFiles.upload, photo);
  await expect(
    pilot.action(api.aircraftFiles.upload, photo),
  ).rejects.toMatchObject({
    name: "ConvexError",
    data: "This aircraft already has the maximum of 500 current logbook page photos.",
  });
  await expect(
    tech.action(api.aircraftFiles.upload, upload),
  ).rejects.toMatchObject({
    data: "This aircraft already has the maximum of 200 current Form 337 copies.",
  });
});

it("files a Form 337 copy on an aircraft whose 200 current documents are all logbook page photos (NA-7)", async () => {
  const { t, tech } = await fixture();
  await fillAircraft(t, "logbook-page", 200);
  await tech.action(api.aircraftFiles.upload, upload);
  const files = await t.run((ctx) => ctx.db.query("aircraftFiles").collect());
  expect(files.filter((f) => f.category === "form-337")).toHaveLength(1);
});

// A member with flight and maintenance permission, who may file both kinds.
async function addCrew(t: Awaited<ReturnType<typeof fixture>>["t"]) {
  return t.withIdentity(
    await t.run(async (ctx) => {
      const group = await ctx.db.insert("groups", {
        programUuid: "demo-program",
        name: "crew",
        aircraftIds: [upload.aircraftUuid],
        permissions: ["read", "flight", "maintenance"],
      });
      const user = await ctx.db.insert("users", {
        name: "Crew",
        active: true,
        isAdmin: false,
        groupIds: [group],
        activeProgramUuid: "demo-program",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: user,
        expirationTime: Date.now() + 86400000,
      });
      return { subject: `${user}|${session}` };
    }),
  );
}

const TOO_MANY_UPLOADS = {
  name: "ConvexError",
  data: "Too many aircraft document uploads. Wait an hour and try again.",
};

// Mid-hour, so the hourly window cannot turn over during a test.
function pinClockMidHour() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 19, 10, 20));
}

it("allows each user 30 document uploads an hour, photos and Form 337 copies together (D12)", async () => {
  pinClockMidHour();
  const { t, pilot } = await fixture();
  const crew = await addCrew(t);
  expect(AIRCRAFT_FILE_UPLOADS_PER_HOUR).toBe(30);
  for (let i = 0; i < AIRCRAFT_FILE_UPLOADS_PER_HOUR; i++)
    await crew.action(api.aircraftFiles.upload, i % 2 ? upload : photo);
  for (const file of [upload, photo])
    await expect(
      crew.action(api.aircraftFiles.upload, file),
    ).rejects.toMatchObject(TOO_MANY_UPLOADS);
  await t.run(async (ctx) => {
    const filed = await ctx.db.query("aircraftFiles").collect();
    expect(filed).toHaveLength(AIRCRAFT_FILE_UPLOADS_PER_HOUR);
    expect(await ctx.db.system.query("_storage").collect()).toHaveLength(
      filed.length,
    );
  });
  // Another member's allowance is their own.
  await pilot.action(api.aircraftFiles.upload, photo);
  vi.setSystemTime(Date.UTC(2026, 10, 19, 11, 0));
  await crew.action(api.aircraftFiles.upload, upload);
});

it("spends the upload allowance only on a document it files", async () => {
  pinClockMidHour();
  const { t } = await fixture();
  const crew = await addCrew(t);
  await fillAircraft(t, "form-337", MAX_CURRENT_AIRCRAFT_FILES["form-337"]);
  await expect(crew.action(api.aircraftFiles.upload, upload)).rejects.toThrow(
    "maximum of 200 current Form 337 copies",
  );
  for (let i = 0; i < AIRCRAFT_FILE_UPLOADS_PER_HOUR; i++)
    await crew.action(api.aircraftFiles.upload, photo);
  await expect(
    crew.action(api.aircraftFiles.upload, photo),
  ).rejects.toMatchObject(TOO_MANY_UPLOADS);
});

it("deletes the stored file of an upload the cap refuses", async () => {
  const { t, tech } = await fixture();
  const blobs = () =>
    t.run(
      async (ctx) => (await ctx.db.system.query("_storage").collect()).length,
    );
  await fillAircraft(t, "form-337", MAX_CURRENT_AIRCRAFT_FILES["form-337"]);
  await expect(tech.action(api.aircraftFiles.upload, upload)).rejects.toThrow(
    "maximum of 200 current Form 337 copies",
  );
  expect(await blobs()).toBe(1);
});

it("still lists a copy whose stored file is missing", async () => {
  const { t, reader } = await fixture();
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["337"]));
    await ctx.storage.delete(storageId);
    await ctx.db.insert("aircraftFiles", {
      aircraftUuid: upload.aircraftUuid,
      category: "form-337",
      storageId,
      name: "missing.pdf",
      type: "application/pdf",
      size: 3,
      uploadedAt: 1,
    });
  });
  const seen = (await reader.query(api.operations.snapshot, {}))!;
  expect(seen.aircraftFiles).toMatchObject([{ name: "missing.pdf" }]);
});

it("refuses a file whose first bytes are not its declared type, storing nothing", async () => {
  const { t, tech, pilot } = await fixture();
  const text = (body: string) => new TextEncoder().encode(body).buffer;
  const heic = new Uint8Array([
    0,
    0,
    0,
    24,
    ...new TextEncoder().encode("ftypheic"),
  ]);
  const refusals = [
    pilot.action(api.aircraftFiles.upload, {
      ...photo,
      name: "x.png",
      type: "image/png",
      bytes: text('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    }),
    pilot.action(api.aircraftFiles.upload, {
      ...photo,
      name: "IMG_0001.jpg",
      bytes: heic.buffer,
    }),
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      bytes: text("<html><body>337</body></html>"),
    }),
  ];
  for (const refusal of refusals)
    await expect(refusal).rejects.toThrow(
      "This file's contents do not match its type. Choose a PDF, JPEG, PNG or WebP file.",
    );
  await t.run(async (ctx) => {
    expect(await ctx.db.query("aircraftFiles").collect()).toEqual([]);
    expect(await ctx.db.system.query("_storage").collect()).toEqual([]);
  });
});

it("lets a pilot attach and archive a photo of a flight's logbook line, linked to a flight on the aircraft", async () => {
  const { t, tech, pilot, reader } = await fixture();
  await pilot.action(api.aircraftFiles.upload, photo);
  await expect(reader.action(api.aircraftFiles.upload, photo)).rejects.toThrow(
    "Aircraft flight permission required.",
  );
  await expect(pilot.action(api.aircraftFiles.upload, upload)).rejects.toThrow(
    "Aircraft maintenance permission required.",
  );
  await expect(
    pilot.action(api.aircraftFiles.upload, {
      ...photo,
      name: "IMG_0001.HEIC",
      type: "image/heic",
    }),
  ).rejects.toThrow("HEIC photos are not accepted.");
  await expect(
    pilot.action(api.aircraftFiles.upload, { ...photo, linkedUuid: "missing" }),
  ).rejects.toThrow("Flight not found.");
  // A flight on another aircraft is not this aircraft's record.
  await expect(
    pilot.action(api.aircraftFiles.upload, {
      ...photo,
      linkedUuid: FOREIGN_FLIGHT_UUID,
    }),
  ).rejects.toThrow("Flight not found.");
  await expect(
    pilot.action(api.aircraftFiles.upload, {
      ...photo,
      linkedKind: undefined,
      linkedUuid: undefined,
    }),
  ).rejects.toThrow("Link the photo to a flight or work order.");
  await expect(
    tech.action(api.aircraftFiles.upload, {
      ...upload,
      linkedKind: "flight",
      linkedUuid: FLIGHT_UUID,
    }),
  ).rejects.toThrow("A Form 337 copy is not linked to a record.");
  const seen = (await reader.query(api.operations.snapshot, {}))!;
  expect(seen.aircraftFiles).toMatchObject([
    {
      category: "logbook-page",
      linkedKind: "flight",
      linkedUuid: FLIGHT_UUID,
      name: "logbook-line.jpg",
      type: "image/jpeg",
      size: 4,
    },
  ]);
  const stored = await t.run(
    async (ctx) => (await ctx.db.query("aircraftFiles").first())!,
  );
  await expect(
    reader.mutation(api.aircraftFiles.archive, {
      id: stored._id,
      reason: "Wrong flight",
      programUuid: "demo-program",
    }),
  ).rejects.toThrow("Aircraft flight permission required.");
  await pilot.mutation(api.aircraftFiles.archive, {
    id: stored._id,
    reason: "Wrong flight",
    programUuid: "demo-program",
  });
  const row = await t.run((ctx) => ctx.db.get(stored._id));
  expect(row).toMatchObject({
    storageId: stored.storageId,
    archiveReason: "Wrong flight",
    archivedBy: { name: "read,flight" },
  });
  const audit = (await tech.query(api.operations.snapshot, {}))!.audit.filter(
    (a) => a.action.startsWith("aircraft.file_"),
  );
  expect(audit.map((a) => a.action).sort()).toEqual([
    "aircraft.file_archived",
    "aircraft.file_uploaded",
  ]);
  const uploaded = audit.find((a) => a.action === "aircraft.file_uploaded")!;
  expect(JSON.parse(uploaded.after!)).toMatchObject({
    category: "logbook-page",
    linkedKind: "flight",
    linkedUuid: FLIGHT_UUID,
  });
});

it("needs maintenance permission for a work order's signed page and a work order on the aircraft", async () => {
  const { tech, pilot } = await fixture();
  const order = workOrderCommand();
  await tech.mutation(api.workOrders.save, {
    programUuid: "demo-program",
    payload: JSON.stringify(order),
  });
  const page = {
    ...photo,
    linkedKind: "work-order" as const,
    linkedUuid: order.uuid,
    name: "signed-page.jpg",
  };
  await expect(pilot.action(api.aircraftFiles.upload, page)).rejects.toThrow(
    "Aircraft maintenance permission required.",
  );
  await expect(
    tech.action(api.aircraftFiles.upload, { ...page, linkedUuid: "missing" }),
  ).rejects.toThrow("Work order not found.");
  await tech.action(api.aircraftFiles.upload, page);
  const seen = (await tech.query(api.operations.snapshot, {}))!;
  expect(seen.aircraftFiles).toMatchObject([
    {
      linkedKind: "work-order",
      linkedUuid: order.uuid,
      name: "signed-page.jpg",
    },
  ]);
});
