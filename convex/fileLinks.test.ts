/**
 * Responsibility: Pins short-lived file links: issued for exactly the aircraft
 *   documents each reader's snapshot lists, refused without a session or in
 *   another program, and served only while signed, unexpired and unaltered.
 * Layer: Test. convex-test suite; never shipped in the build.
 * Dependencies: convex/fileLinks, convex/fileTokens, convex/operations
 *   (snapshot), convex/schema, convex/_generated, src/domain/fileLinks,
 *   src/data/demo (fixture).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { demoSnapshot } from "../src/data/demo";
import { issueFileLink } from "./fileTokens";
import {
  FILE_LINK_TTL_MS,
  MAX_FILE_LINKS,
  type FileLink,
} from "../src/domain/fileLinks";

const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/*.js",
  "!./**/*.test.ts",
  "!./**/*.d.ts",
]);
const K1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const K2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
const SITE = "https://test.convex.site";
const PROGRAM = "demo-program";
const DAY_MS = 86_400_000;
const EXPIRED = "This link has expired. Open the file again from Angel One.";
const OWNED = demoSnapshot().aircraft[0].uuid;
const OTHER = demoSnapshot().aircraft[1].uuid;
type Role = "reader" | "owner" | "board" | "admin";
// By name until convex/_generated is next regenerated against a deployment.
const links = makeFunctionReference<
  "mutation",
  { programUuid?: string; files: { kind: "aircraftFile"; id: string }[] },
  (FileLink | null)[]
>("fileLinks:links");

beforeEach(() => {
  vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The demo program and a foreign one, with Form 337 copies (current and
 * archived) and a logbook photo on {@link OWNED}, a copy on {@link OTHER} and
 * one on the foreign aircraft; a reader of OWNED, its owner, a board member
 * and a system administrator.
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const demo = demoSnapshot();
    await ctx.db.insert("programs", demo.programs![0]);
    await ctx.db.insert("programs", {
      ...demo.programs![0],
      uuid: "foreign",
      name: "Foreign",
    });
    for (const a of demo.aircraft.slice(0, 2))
      await ctx.db.insert("aircraft", a);
    await ctx.db.insert("aircraft", {
      ...demo.aircraft[0],
      uuid: "foreign-aircraft",
      programUuid: "foreign",
    });
    const file = async (
      aircraftUuid: string,
      category: "form-337" | "logbook-page",
      name: string,
      archivedAt?: number,
    ) =>
      ctx.db.insert("aircraftFiles", {
        aircraftUuid,
        category,
        storageId: await ctx.storage.store(
          new Blob([name], { type: "application/pdf" }),
        ),
        name,
        type: "application/pdf",
        size: name.length,
        uploadedAt: 1,
        ...(category === "logbook-page"
          ? { linkedKind: "flight" as const, linkedUuid: "flight-1" }
          : {}),
        ...(archivedAt ? { archivedAt, archiveReason: "Superseded" } : {}),
      });
    const files = {
      current: await file(OWNED, "form-337", "337 alteration.pdf"),
      archived: await file(OWNED, "form-337", "old-337.pdf", 2),
      photo: await file(OWNED, "logbook-page", "line.pdf"),
      other: await file(OTHER, "form-337", "other-337.pdf"),
      foreign: await file("foreign-aircraft", "form-337", "foreign-337.pdf"),
    };
    const user = async (
      group: { owner?: boolean; board?: boolean; aircraftIds: string[] },
      isAdmin = false,
    ) => {
      const groupId = await ctx.db.insert("groups", {
        programUuid: PROGRAM,
        name: JSON.stringify(group),
        permissions: ["read"],
        ...group,
      });
      const id = await ctx.db.insert("users", {
        name: "Member",
        active: true,
        isAdmin,
        activeProgramUuid: PROGRAM,
        groupIds: isAdmin ? [] : [groupId],
      });
      const session = await ctx.db.insert("authSessions", {
        userId: id,
        expirationTime: Date.now() + DAY_MS,
      });
      return `${id}|${session}`;
    };
    const subjects: Record<Role, string> = {
      reader: await user({ aircraftIds: [OWNED] }),
      owner: await user({ owner: true, aircraftIds: [OWNED] }),
      board: await user({ board: true, aircraftIds: [] }),
      admin: await user({ aircraftIds: [] }, true),
    };
    return { files, subjects };
  });
  await t.mutation(internal.memberships.backfill, {});
  const as = (role: Role) => t.withIdentity({ subject: ids.subjects[role] });
  return { t, files: ids.files, as };
}

const refs = (ids: string[]) =>
  ids.map((id) => ({ kind: "aircraftFile" as const, id }));

describe("issuing links", () => {
  it("issues a link for exactly the files each reader's snapshot lists", async () => {
    const { files, as } = await fixture();
    const all = Object.values(files);
    const expected: Record<Exclude<Role, "board">, Id<"aircraftFiles">[]> = {
      reader: [files.current, files.archived, files.photo],
      owner: [files.current],
      admin: [files.current, files.archived, files.photo, files.other],
    };
    for (const role of Object.keys(expected) as (keyof typeof expected)[]) {
      const snapshot = await as(role).query(api.operations.snapshot, {});
      const listed = (snapshot?.aircraftFiles ?? []).map((f) => f.uuid);
      expect(listed.sort(), role).toEqual([...expected[role]].sort());
      const issued = await as(role).mutation(links, {
        programUuid: PROGRAM,
        files: refs(all),
      });
      const opened = all.filter((_, i) => issued[i] !== null);
      expect(opened.sort(), role).toEqual([...expected[role]].sort());
    }
  });

  it("gives each link a five-minute lifetime on the deployment's site", async () => {
    const { files, as } = await fixture();
    const before = Date.now();
    const [link] = await as("reader").mutation(links, {
      programUuid: PROGRAM,
      files: refs([files.current]),
    });
    expect(FILE_LINK_TTL_MS).toBe(5 * 60 * 1000);
    expect(link!.expiresAt).toBeGreaterThanOrEqual(before + FILE_LINK_TTL_MS);
    expect(link!.expiresAt).toBeLessThanOrEqual(Date.now() + FILE_LINK_TTL_MS);
    expect(link!.url).toMatch(
      /^https:\/\/test\.convex\.site\/files\/v1\/v1\.k1\.[\w-]+\.[\w-]+$/,
    );
  });

  it("refuses board members, whose view lists no files", async () => {
    const { files, as } = await fixture();
    const board = await as("board").query(api.operations.snapshot, {});
    expect(board?.aircraftFiles ?? []).toEqual([]);
    await expect(
      as("board").mutation(links, {
        programUuid: PROGRAM,
        files: refs([files.current]),
      }),
    ).rejects.toThrow("Files are not available in the board view.");
  });

  it("refuses callers without a session, in another program, or asking for too many", async () => {
    const { t, files, as } = await fixture();
    const args = { programUuid: PROGRAM, files: refs([files.current]) };
    await expect(t.mutation(links, args)).rejects.toThrow(
      "An active account and session are required.",
    );
    await expect(
      as("reader").mutation(links, {
        ...args,
        programUuid: "foreign",
      }),
    ).rejects.toThrow(
      "Flight Program changed. Reopen the form in the correct program.",
    );
    await expect(
      as("reader").mutation(links, {
        ...args,
        files: refs(Array(MAX_FILE_LINKS + 1).fill(files.current)),
      }),
    ).rejects.toThrow(`Ask for at most ${MAX_FILE_LINKS} files at a time.`);
    const [missing] = await as("reader").mutation(links, {
      ...args,
      files: refs(["not-an-id"]),
    });
    expect(missing).toBeNull();
  });
});

describe("serving a link", () => {
  it("streams the file inline, uncached, to any origin", async () => {
    const { t, files, as } = await fixture();
    const [link] = await as("reader").mutation(links, {
      programUuid: PROGRAM,
      files: refs([files.current]),
    });
    const response = await t.fetch(path(link!.url), { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("337 alteration.pdf");
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/pdf",
      "content-disposition": "inline; filename*=UTF-8''337%20alteration.pdf",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
    });
  });

  it("sends a type that could run as a page as a download", async () => {
    const { t, files } = await fixture();
    const storageId = await t.run(async (ctx) => {
      const row = await ctx.db.get(files.current);
      return row!.storageId;
    });
    const link = await issueFileLink(
      { storageId, type: "text/html", name: "it's (bad).html" },
      Date.now(),
    );
    const response = await t.fetch(path(link.url), { method: "GET" });
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''it%27s%20%28bad%29.html",
    );
  });

  it("refuses an expired, altered or foreign-key link, and a deleted file", async () => {
    const { t, files, as } = await fixture();
    const storageId = await t.run(
      async (ctx) => (await ctx.db.get(files.current))!.storageId,
    );
    const file = { storageId, type: "application/pdf", name: "a.pdf" };
    const now = Date.now();
    const expired = await issueFileLink(file, now - FILE_LINK_TTL_MS - 1);
    const valid = await issueFileLink(file, now);
    const [, , payload, signature] = path(valid.url)
      .split("/")
      .at(-1)!
      .split(".");
    const altered = path(valid.url).replace(payload, payload.slice(1));
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K2);
    const foreign = await issueFileLink(file, now);
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", K1);
    for (const url of [
      path(expired.url),
      altered,
      path(foreign.url),
      `/files/v1/v2.k1.${payload}.${signature}`,
      `/files/v1/v1.k9.${payload}.${signature}`,
      "/files/v1/garbage",
    ]) {
      const response = await t.fetch(url, { method: "GET" });
      expect(response.status, url).toBe(403);
      expect(await response.text()).toBe(EXPIRED);
    }
    await t.run((ctx) => ctx.storage.delete(storageId));
    expect((await t.fetch(path(valid.url), { method: "GET" })).status).toBe(
      404,
    );
    const [gone] = await as("reader").mutation(links, {
      programUuid: PROGRAM,
      files: refs([files.current]),
    });
    expect(gone).toBeNull();
  });
});

function path(url: string) {
  return new URL(url).pathname;
}
