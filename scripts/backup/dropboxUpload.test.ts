/**
 * Responsibility: Pins the Dropbox records copy: token exchange, the daily and
 *   monthly copies, 90-day pruning, retries, upload sessions and refusals.
 * Layer: Test. Vitest suite that runs the script as a child process.
 * Dependencies: scripts/backup/dropbox-upload.mjs, node:http,
 *   node:child_process.
 *
 * The script talks to a local fake of the Dropbox HTTP API through
 * DROPBOX_TEST_BASE_URL, which it honours only for loopback addresses.
 */
// @vitest-environment node
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "dropbox-upload.mjs");
const KEY = "fixture-app-key";
const SECRET = "fixture-app-secret-0123";
const REFRESH = "fixture-refresh-token-abcdef";
const ACCESS = "sl.fixture-access-token-987654";
// More entries than any test stores, so one page unless a test lowers it.
const DEFAULT_PAGE_SIZE = 100;

/** One request as the fake Dropbox received it. */
interface Call {
  path: string;
  arg?: Record<string, unknown>;
  body: Buffer;
  auth?: string;
}
/** A JSON answer from the fake Dropbox. */
interface Reply {
  status: number;
  value: unknown;
}
type Endpoint = (arg: Record<string, unknown>, body: Buffer) => Reply;
type SessionCursor = { session_id: string; offset: number };

let server: Server;
let base: string;
let dir: string;
let file: string;
const files = new Map<string, Buffer>();
let calls: Call[] = [];
// Makes the next `times` requests to `path` answer `status`, as when Dropbox
// is busy.
let busy: { path: string; times: number; status: number } | undefined;
let pageSize = DEFAULT_PAGE_SIZE;
const sessions = new Map<string, Buffer>();

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dropbox-upload-"));
  file = path.join(dir, "records.xlsx");
  await writeFile(file, Buffer.from("PK fixture workbook bytes, thirty+ long"));
  server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  files.clear();
  sessions.clear();
  calls = [];
  busy = undefined;
  pageSize = DEFAULT_PAGE_SIZE;
});

/**
 * Runs the upload script against the fake Dropbox with fixture credentials.
 *
 * @param env - Overrides the fixture environment; undefined unsets a name.
 * @returns The exit status, standard output and error, and the run time.
 */
function upload(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ status: number | null; out: string; err: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        PATH: process.env.PATH,
        DROPBOX_APP_KEY: KEY,
        DROPBOX_APP_SECRET: SECRET,
        DROPBOX_REFRESH_TOKEN: REFRESH,
        DROPBOX_TEST_BASE_URL: base,
        DROPBOX_TEST_BACKOFF_MS: "10",
        ...env,
      },
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) =>
      resolve({ status, out, err, ms: Date.now() - started }),
    );
  });
}
/** Fails the test if the output holds the app secret or either token. */
const noSecrets = (text: string) => {
  for (const s of [SECRET, REFRESH, ACCESS]) expect(text).not.toContain(s);
};

describe("dropbox-upload", () => {
  it("exchanges the refresh token, then adds the daily and the month's first copy", async () => {
    const r = await upload(["--file", file, "--date", "2026-11-04"]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const token = calls.find((c) => c.path === "/oauth2/token")!;
    expect(token.auth).toBe(
      `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`,
    );
    expect(
      Object.fromEntries(new URLSearchParams(token.body.toString())),
    ).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
    });
    const uploads = calls.filter((c) => c.path === "/2/files/upload");
    expect(uploads.map((c) => c.arg)).toEqual([
      {
        path: "/Daily/Angel One records 2026-11-04.xlsx",
        mode: "add",
        autorename: false,
        mute: true,
      },
      {
        path: "/Monthly/Angel One records 2026-11.xlsx",
        mode: "add",
        autorename: false,
        mute: true,
      },
    ]);
    for (const c of uploads) expect(c.auth).toBe(`Bearer ${ACCESS}`);
    expect(files.get("/Daily/Angel One records 2026-11-04.xlsx")).toEqual(
      uploads[0].body,
    );
    expect(r.out).toContain(
      "Uploaded /Daily/Angel One records 2026-11-04.xlsx",
    );
    expect(r.out).toContain("Uploaded /Monthly/Angel One records 2026-11.xlsx");
    noSecrets(r.out + r.err);
  });

  it("keeps the month's first copy and never replaces it", async () => {
    files.set("/Monthly/Angel One records 2026-11.xlsx", Buffer.from("first"));
    const r = await upload(["--file", file, "--date", "2026-11-05"]);
    expect(r.status).toBe(0);
    expect(
      files.get("/Monthly/Angel One records 2026-11.xlsx")!.toString(),
    ).toBe("first");
    expect(
      calls.filter((c) => c.path === "/2/files/upload").map((c) => c.arg!.path),
    ).toEqual(["/Daily/Angel One records 2026-11-05.xlsx"]);
    expect(r.out).toContain("already exists; left it unchanged");
    // Next month starts a new monthly copy.
    calls = [];
    const next = await upload(["--file", file, "--date", "2026-12-01"]);
    expect(next.status).toBe(0);
    expect(files.has("/Monthly/Angel One records 2026-12.xlsx")).toBe(true);
  });

  it("removes only daily copies older than 90 days, reading every page", async () => {
    pageSize = 2;
    const old = [
      "/Daily/Angel One records 2026-07-01.xlsx",
      "/Daily/Angel One records 2026-08-05.xlsx",
    ];
    const kept = [
      "/Daily/Angel One records 2026-08-06.xlsx",
      "/Daily/Angel One records 2026-10-30.xlsx",
      "/Daily/Notes from the board.xlsx",
      "/Monthly/Angel One records 2025-01.xlsx",
      "/Monthly/Angel One records 2026-11.xlsx",
    ];
    for (const p of [...old, ...kept]) files.set(p, Buffer.from(p));
    const r = await upload(["--file", file, "--date", "2026-11-04"]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    for (const p of old) expect(files.has(p)).toBe(false);
    for (const p of kept) expect(files.has(p)).toBe(true);
    expect(calls.some((c) => c.path === "/2/files/list_folder/continue")).toBe(
      true,
    );
    const deleted = calls
      .filter((c) => c.path === "/2/files/delete_v2")
      .map((c) => c.arg!.path);
    expect(deleted).toEqual(old.map((p) => p.toLowerCase()));
    expect(r.out).toContain("Removed 2 daily copies older than 90 days");
  });

  it("waits as Retry-After asks when Dropbox is busy, then succeeds", async () => {
    busy = { path: "/2/files/upload", times: 1, status: 429 };
    const r = await upload(["--file", file, "--date", "2026-11-04"]);
    expect(r.status).toBe(0);
    expect(r.ms).toBeGreaterThanOrEqual(1000);
    expect(calls.filter((c) => c.path === "/2/files/upload").length).toBe(3);
    expect(r.out).toContain("Dropbox answered 429");
    expect(files.has("/Daily/Angel One records 2026-11-04.xlsx")).toBe(true);
    busy = { path: "/2/files/get_metadata", times: 1, status: 503 };
    files.clear();
    const again = await upload(["--file", file, "--date", "2026-11-04"]);
    expect(again.status).toBe(0);
    expect(again.out).toContain("Dropbox answered 503");
  });

  it("uses an upload session for files above the single-request limit", async () => {
    const r = await upload(["--file", file, "--date", "2026-11-04"], {
      DROPBOX_TEST_SESSION_THRESHOLD: "10",
      DROPBOX_TEST_CHUNK_BYTES: "8",
    });
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/2/files/upload_session/start");
    expect(paths).toContain("/2/files/upload_session/append_v2");
    expect(paths).toContain("/2/files/upload_session/finish");
    expect(paths).not.toContain("/2/files/upload");
    expect(files.get("/Daily/Angel One records 2026-11-04.xlsx")).toEqual(
      await readFile(file),
    );
  });

  it("leaves an existing daily copy alone", async () => {
    files.set(
      "/Daily/Angel One records 2026-11-04.xlsx",
      Buffer.from("earlier"),
    );
    const r = await upload(["--file", file, "--date", "2026-11-04"]);
    expect(r.status).toBe(0);
    expect(
      files.get("/Daily/Angel One records 2026-11-04.xlsx")!.toString(),
    ).toBe("earlier");
    expect(r.out).toContain("already exists; left it unchanged");
  });

  it("fails clearly, without printing a token, when Dropbox refuses the token", async () => {
    const r = await upload(["--file", file, "--date", "2026-11-04"], {
      DROPBOX_REFRESH_TOKEN: "fixture-revoked-refresh-token",
    });
    expect(r.status).toBe(1);
    expect(r.err).toContain("refused the app key, secret or refresh token");
    expect(r.err).toContain("docs/runbooks/dropbox-records-copy.md");
    expect(r.out + r.err).not.toContain("fixture-revoked-refresh-token");
    noSecrets(r.out + r.err);
    expect(files.size).toBe(0);
  });

  it("explains missing setup and refuses a non-local test address", async () => {
    const missing = await upload(["--file", file], {
      DROPBOX_REFRESH_TOKEN: undefined,
    });
    expect(missing.status).toBe(2);
    expect(missing.err).toContain("DROPBOX_REFRESH_TOKEN is not set");
    const elsewhere = await upload(["--file", file], {
      DROPBOX_TEST_BASE_URL: "https://attacker.example",
    });
    expect(elsewhere.status).toBe(2);
    expect(calls).toEqual([]);
    const noFile = await upload(["--file", path.join(dir, "missing.xlsx")]);
    expect(noFile.status).toBe(1);
    expect(noFile.err).toContain("Cannot read");
  });
});

const ENDPOINTS = new Map<string, Endpoint>([
  ["/2/files/upload", (arg, body) => commit(String(arg.path), body)],
  ["/2/files/upload_session/start", (_arg, body) => startSession(body)],
  ["/2/files/upload_session/append_v2", appendToSession],
  ["/2/files/upload_session/finish", finishSession],
  ["/2/files/get_metadata", readMetadata],
  ["/2/files/list_folder", listFolder],
  ["/2/files/list_folder/continue", listFolder],
  ["/2/files/delete_v2", deleteFile],
]);
const PATH_NOT_FOUND: Reply = {
  status: 409,
  value: { error_summary: "path/not_found/.." },
};

async function answer(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  const url = req.url ?? "";
  const arg = readArg(req, body);
  calls.push({ path: url, arg, body, auth: req.headers.authorization });
  if (busy && busy.path === url && busy.times > 0) {
    busy.times--;
    // Seconds: the busy test checks the script waited this long.
    res.writeHead(busy.status, { "Retry-After": "1" });
    return res.end("busy");
  }
  const { status, value } =
    url === "/oauth2/token"
      ? exchangeToken(req, body)
      : callApi(req, url, arg, body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage) {
  return new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });
}

// Content endpoints carry the argument in a Dropbox-API-Arg header, the rest
// in a JSON body.
function readArg(
  req: IncomingMessage,
  body: Buffer,
): Record<string, unknown> | undefined {
  const header = req.headers["dropbox-api-arg"];
  if (typeof header === "string") return JSON.parse(header);
  if (body.length && req.headers["content-type"] === "application/json")
    return JSON.parse(body.toString());
  return undefined;
}

function exchangeToken(req: IncomingMessage, body: Buffer): Reply {
  const form = new URLSearchParams(body.toString());
  const basic = Buffer.from(`${KEY}:${SECRET}`).toString("base64");
  if (
    req.headers.authorization !== `Basic ${basic}` ||
    form.get("grant_type") !== "refresh_token" ||
    form.get("refresh_token") !== REFRESH
  )
    return reply(400, {
      error: "invalid_grant",
      error_description: `refresh token ${form.get("refresh_token")} is invalid`,
    });
  return reply(200, {
    access_token: ACCESS,
    token_type: "bearer",
    expires_in: 14400,
  });
}

function callApi(
  req: IncomingMessage,
  url: string,
  arg: Record<string, unknown> | undefined,
  body: Buffer,
): Reply {
  if (req.headers.authorization !== `Bearer ${ACCESS}`)
    return reply(401, { error_summary: "invalid_access_token/" });
  const endpoint = ENDPOINTS.get(url);
  if (!endpoint)
    return reply(400, { error_summary: `unknown endpoint ${url}` });
  return endpoint(arg!, body);
}

// Every upload uses mode "add", so an existing path is a conflict, never a
// replacement.
function commit(p: string, bytes: Buffer): Reply {
  if (files.has(p))
    return reply(409, { error_summary: "path/conflict/file/.." });
  files.set(p, bytes);
  return reply(200, metadata(p));
}

function startSession(body: Buffer): Reply {
  const id = `session-${sessions.size + 1}`;
  sessions.set(id, body);
  return reply(200, { session_id: id });
}

function appendToSession(arg: Record<string, unknown>, body: Buffer): Reply {
  const cursor = arg.cursor as SessionCursor;
  const had = sessions.get(cursor.session_id)!;
  if (cursor.offset !== had.length)
    return reply(409, {
      error_summary: "incorrect_offset/..",
      error: { ".tag": "incorrect_offset", correct_offset: had.length },
    });
  sessions.set(cursor.session_id, Buffer.concat([had, body]));
  return reply(200, null);
}

function finishSession(arg: Record<string, unknown>, body: Buffer): Reply {
  const cursor = arg.cursor as SessionCursor;
  const done = Buffer.concat([sessions.get(cursor.session_id)!, body]);
  const target = arg.commit as { path: string };
  return commit(target.path, done);
}

function readMetadata(arg: Record<string, unknown>): Reply {
  return files.has(String(arg.path))
    ? reply(200, metadata(String(arg.path)))
    : PATH_NOT_FOUND;
}

// The cursor is the index of the next entry; a folder that does not exist yet
// is not found, as on Dropbox.
function listFolder(arg: Record<string, unknown>): Reply {
  const start = arg.cursor ? Number(arg.cursor) : 0;
  const prefix = `${String(arg.path ?? "/Daily")}/`;
  const all = [...files.keys()].filter((p) => p.startsWith(prefix));
  if (!all.length && !arg.cursor) return PATH_NOT_FOUND;
  const page = all.slice(start, start + pageSize);
  return reply(200, {
    entries: page.map(metadata),
    cursor: String(start + pageSize),
    has_more: start + pageSize < all.length,
  });
}

// The script deletes by path_lower, so the lookup ignores case.
function deleteFile(arg: Record<string, unknown>): Reply {
  const target = [...files.keys()].find((p) => p.toLowerCase() === arg.path);
  if (!target) return reply(409, { error_summary: "path_lookup/not_found/.." });
  files.delete(target);
  return reply(200, { metadata: metadata(target) });
}

function metadata(p: string) {
  return {
    ".tag": "file",
    name: p.split("/").pop(),
    path_lower: p.toLowerCase(),
    path_display: p,
  };
}

function reply(status: number, value: unknown): Reply {
  return { status, value };
}
