/**
 * Responsibility: Pins that refusals from functions outside runCommand reach
 *   the client as ConvexErrors with their message or zod issue text, and
 *   that faults and the session refusal keep their own class.
 * Layer: Test. Unit and convex-test suite; never shipped in the build.
 * Dependencies: convex/userErrors.ts, convex/schema.ts, src/domain
 *   (rejection, validationText, faaSearch, and the certification and
 *   wording schemas), src/data/demo.ts (fixture).
 *
 * convex-test does not redact errors as production does, so the refusals are
 * checked by class: only a ConvexError keeps its message in production.
 */
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { ConvexError } from "convex/values";
import { z, ZodError } from "zod";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { demoSnapshot } from "../src/data/demo";
import { blankSearch, searchAssets } from "../src/domain/faaSearch";
import type { Permission } from "../src/domain/model";
import { Rejection, STALE_RECORD_MESSAGE } from "../src/domain/rejection";
import { validationText } from "../src/domain/validationText";
import { certificationsSchema } from "../src/domain/certifications";
import { logbookPhrasesSchema } from "../src/domain/logbookWording";
import { releaseStatementsSchema } from "../src/domain/releaseStatements";
import { exposeRejections } from "./userErrors";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const PROGRAM = "demo-program";
const AIRCRAFT = demoSnapshot().aircraft[0];
const DAY = 86400000;
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF").buffer;

// The error a run rejects with.
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error("Expected a refusal.");
    },
    (error: unknown) => error,
  );

// The error a synchronous run throws.
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal.");
}

const shown = (message: string) => ({ name: "ConvexError", data: message });

it("shows a Rejection from a check, a promise or an async function as a ConvexError", async () => {
  const refuse = () => {
    throw new Rejection("Enter a reason.");
  };
  expect(thrown(() => exposeRejections(refuse))).toMatchObject(
    shown("Enter a reason."),
  );
  expect(
    await refusal(exposeRejections(Promise.reject(new Rejection("Stale.")))),
  ).toMatchObject(shown("Stale."));
  expect(await refusal(exposeRejections(async () => refuse()))).toMatchObject(
    shown("Enter a reason."),
  );
});

it("passes any other error through unchanged and returns what the work returns", async () => {
  const fault = new Error("payload is undefined");
  const refused = new ConvexError("Already shown.");
  expect(
    thrown(() =>
      exposeRejections(() => {
        throw fault;
      }),
    ),
  ).toBe(fault);
  expect(await refusal(exposeRejections(Promise.reject(fault)))).toBe(fault);
  expect(
    await refusal(
      exposeRejections(async () => {
        throw refused;
      }),
    ),
  ).toBe(refused);
  expect(exposeRejections(() => 7)).toBe(7);
  expect(await exposeRejections(Promise.resolve(7))).toBe(7);
});

it("shows a zod refusal as its issue text, and keeps one without issues hidden", async () => {
  const name = z.string().min(1, "Enter a name.");
  expect(thrown(() => exposeRejections(() => name.parse("")))).toMatchObject(
    shown("Enter a name."),
  );
  expect(await refusal(exposeRejections(name.parseAsync("")))).toMatchObject(
    shown("Enter a name."),
  );
  const empty = new ZodError([]);
  expect(
    thrown(() =>
      exposeRejections(() => {
        throw empty;
      }),
    ),
  ).toBe(empty);
});

async function server() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("programs", demoSnapshot().programs![0]);
    await ctx.db.insert("aircraft", AIRCRAFT);
    const account = async (
      permissions: Permission[],
      role: { programAdmin?: boolean; isAdmin?: boolean } = {},
    ) => {
      const group = await ctx.db.insert("groups", {
        programUuid: PROGRAM,
        name: permissions.join(","),
        programAdmin: role.programAdmin ?? false,
        aircraftIds: [AIRCRAFT.uuid],
        permissions,
      });
      const id = await ctx.db.insert("users", {
        name: "Member",
        active: true,
        isAdmin: role.isAdmin ?? false,
        activeProgramUuid: PROGRAM,
        groupIds: [group],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + DAY,
      });
      return { id, group, subject: `${id}|${session}` };
    };
    const storageId = await ctx.storage.store(new Blob([PDF]));
    const file = { storageId, name: "a.pdf", type: "application/pdf", size: 1 };
    const maintainer = await account(["read", "maintenance"]);
    const removedLicense = await ctx.db.insert("certificationFiles", {
      ...file,
      userId: maintainer.id,
      kind: "mechanic",
      uploadedAt: 0,
    });
    const removedPoFile = await ctx.db.insert("poFiles", {
      ...file,
      poUuid: "po",
      programUuid: PROGRAM,
      uploadedAt: 0,
    });
    await ctx.db.delete(removedLicense);
    await ctx.db.delete(removedPoFile);
    return {
      maintainer,
      reader: await account(["read"]),
      manager: await account(["read"], { programAdmin: true }),
      systemAdmin: await account(["read"], { isAdmin: true }),
      removedLicense,
      removedPoFile,
      form337: await ctx.db.insert("aircraftFiles", {
        ...file,
        aircraftUuid: AIRCRAFT.uuid,
        category: "form-337",
        uploadedAt: 0,
      }),
    };
  });
  const as = (who: { subject: string }) => t.withIdentity(who);
  return { t, ids, as };
}

it("shows refusals from functions outside runCommand to the client", async () => {
  const { t, ids, as } = await server();
  const maintainer = as(ids.maintainer);
  const reader = as(ids.reader);
  const manager = as(ids.manager);
  const systemAdmin = as(ids.systemAdmin);
  const target = { aircraftUuid: AIRCRAFT.uuid, programUuid: PROGRAM };
  const passwordLogin = await t.run((ctx) =>
    ctx.db.insert("authAccounts", {
      userId: ids.maintainer.id,
      provider: "password",
      providerAccountId: "member@example.test",
    }),
  );
  const faaKey = { key: "synthetic-test-key-000001", version: 0 };
  const pdf = { name: "a.pdf", type: "application/pdf", bytes: PDF };
  const manual = {
    aircraftUuid: AIRCRAFT.uuid,
    title: "Maintenance Manual",
    documentNumber: "",
    revision: "1",
    revisionDate: "",
    filename: "manual.txt",
    size: 1,
    pageCount: 1,
  };
  const search = blankSearch(
    AIRCRAFT.uuid,
    searchAssets(demoSnapshot(), AIRCRAFT.uuid),
  );
  const cases: [string, () => Promise<unknown>][] = [
    [
      "Upload a PDF, JPEG, PNG, WebP, HEIC or HEIF license copy.",
      () =>
        maintainer.action(api.certifications.upload, {
          userId: ids.maintainer.id,
          kind: "mechanic",
          name: "notes.txt",
          type: "text/plain",
          bytes: PDF,
        }),
    ],
    [
      "License copy not found.",
      () =>
        maintainer.mutation(api.certifications.remove, {
          id: ids.removedLicense,
        }),
    ],
    [
      "Aircraft maintenance permission required.",
      () =>
        reader.action(api.aircraftFiles.upload, {
          ...target,
          ...pdf,
          category: "form-337",
        }),
    ],
    [
      "Enter a reason for archiving this copy.",
      () =>
        maintainer.mutation(api.aircraftFiles.archive, {
          id: ids.form337,
          reason: " ",
          programUuid: PROGRAM,
        }),
    ],
    [
      "Inventory administrator access to this item is required.",
      () =>
        manager.action(api.inventoryFiles.upload, {
          ...pdf,
          stockUuid: "missing",
          programUuid: PROGRAM,
        }),
    ],
    [
      "Attachment not found.",
      () =>
        manager.mutation(api.poFiles.remove, {
          id: ids.removedPoFile,
          programUuid: PROGRAM,
        }),
    ],
    [
      "Choose a PDF up to 200 MiB.",
      () =>
        maintainer.mutation(api.manuals.beginUpload, {
          payload: JSON.stringify(manual),
          sha256: "",
          programUuid: PROGRAM,
        }),
    ],
    [
      "Aircraft maintenance permission required.",
      () =>
        reader.action(api.faaSearch.search, {
          payload: JSON.stringify(search),
          programUuid: PROGRAM,
        }),
    ],
    [
      "Account changed. Reload before disconnecting.",
      () =>
        manager.mutation(api.aircraftSpruce.disconnect, {
          programUuid: PROGRAM,
          version: 1,
        }),
    ],
    [
      "Aircraft maintenance permission required.",
      () => reader.mutation(api.aircraftPhotos.remove, target),
    ],
    [
      "This group or its members changed. Close this dialog and review deletion again.",
      () =>
        manager.mutation(api.groupDeletion.remove, {
          id: ids.reader.group,
          programUuid: PROGRAM,
          expected: "stale",
        }),
    ],
    [
      STALE_RECORD_MESSAGE,
      () =>
        systemAdmin.mutation(internal.addressVerification.commit, {
          key: "sealed",
          version: 1,
        }),
    ],
    [
      "The renewal date must be in the future.",
      () =>
        systemAdmin.action(api.faaCredentials.replace, {
          ...faaKey,
          expiresOn: "2000-01-01",
        }),
    ],
    [
      STALE_RECORD_MESSAGE,
      () =>
        systemAdmin.mutation(internal.faaCredentials.commit, {
          key: "sealed",
          expiresOn: "2099-10-14",
          version: 1,
        }),
    ],
    [
      "Linked identity not found.",
      () =>
        systemAdmin.mutation(api.identities.remove, {
          userId: ids.maintainer.id,
          id: passwordLogin,
        }),
    ],
    [
      "History not found.",
      () =>
        reader.query(api.auditHistory.page, {
          programUuid: PROGRAM,
          entityUuid: "missing",
          cursor: null,
          numItems: 5,
        }),
    ],
  ];
  for (const [message, run] of cases)
    expect(await refusal(run()), message).toMatchObject(shown(message));
});

it("shows the issue text of a refused certification or logbook wording", async () => {
  const { ids, as } = await server();
  const member = as(ids.maintainer);
  const certifications = [
    {
      kind: "mechanic",
      number: "1",
      issuedOn: "2026-01-02",
      renewalDate: "2026-01-01",
    },
  ];
  const payload = JSON.stringify(certifications);
  const phrases = ["Inspected", "inspected"];
  const statements = [
    { label: "Return", text: "Returned to service." },
    { label: "return", text: "Returned again." },
  ];
  const cases: [string, z.ZodType, unknown, () => Promise<unknown>][] = [
    [
      "Renewal date must be on or after the issue date.",
      certificationsSchema,
      certifications,
      () =>
        member.mutation(api.certifications.save, {
          userId: ids.maintainer.id,
          payload,
        }),
    ],
    [
      "Renewal date must be on or after the issue date.",
      certificationsSchema,
      certifications,
      () =>
        as(ids.systemAdmin).mutation(api.admin.updateUser, {
          id: ids.maintainer.id,
          active: true,
          isAdmin: false,
          groupIds: [ids.maintainer.group],
          certificationsPayload: payload,
        }),
    ],
    [
      "Remove duplicate phrases.",
      logbookPhrasesSchema,
      phrases,
      () => member.mutation(api.admin.saveLogbookPhrases, { phrases }),
    ],
    [
      "Use a unique name for each release statement.",
      releaseStatementsSchema,
      statements,
      () => member.mutation(api.admin.saveReleaseStatements, { statements }),
    ],
  ];
  for (const [message, refuses, input, run] of cases) {
    expect(validationText(refuses.safeParse(input).error!)).toBe(message);
    expect(await refusal(run()), message).toMatchObject(shown(message));
  }
});

it("keeps a fault and the session refusal out of the user's sight", async () => {
  const { t, ids, as } = await server();
  const fault = await refusal(
    as(ids.maintainer).mutation(api.certifications.save, {
      userId: ids.maintainer.id,
      payload: "{",
    }),
  );
  expect(fault).toBeInstanceOf(SyntaxError);
  const lapsed = await refusal(
    t.query(api.certifications.list, { userId: ids.maintainer.id }),
  );
  expect(lapsed).toMatchObject({
    message: "An active account and session are required.",
  });
  for (const error of [fault, lapsed])
    expect(error).not.toBeInstanceOf(ConvexError);
});
