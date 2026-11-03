#!/usr/bin/env node
/**
 * Responsibility: Copies the readable records workbook to Dropbox (ADR-0011)
 *   and removes daily copies older than 90 days.
 * Layer: Script. Talks only to the Dropbox HTTP API; never prints a secret.
 * Dependencies: Node.js built-ins; DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
 *   DROPBOX_REFRESH_TOKEN. Setup: docs/runbooks/dropbox-records-copy.md.
 *
 *   node scripts/backup/dropbox-upload.mjs --file <records.xlsx> \
 *     [--tz America/New_York] [--date YYYY-MM-DD]
 *
 * The Dropbox app is limited to its own App folder; paths are inside it:
 *   /Daily/Angel One records YYYY-MM-DD.xlsx   every night, removed after 90 days
 *   /Monthly/Angel One records YYYY-MM.xlsx    first successful night of a month,
 *                                              never removed
 * Files are added, never overwritten. Only /Daily/ is pruned, and only files
 * named as above. Retries on 429 and 5xx, honouring Retry-After.
 * Exit codes: 0 done, 1 Dropbox or file error, 2 setup.
 */
import { open, readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";

const KEEP_DAILY_DAYS = 90;
const NAME = "Angel One records";
const DAILY = /^Angel One records (\d{4}-\d{2}-\d{2})\.xlsx$/;
const MAX_ATTEMPTS = 6;
const MAX_BACKOFF_MS = 60_000;
const RUNBOOK = "docs/runbooks/dropbox-records-copy.md";
const SECRET_NAMES = [
  "DROPBOX_APP_KEY",
  "DROPBOX_APP_SECRET",
  "DROPBOX_REFRESH_TOKEN",
];
// Redacting shorter values would rewrite ordinary words in the output.
const MIN_SECRET_LENGTH = 4;
const EXIT_FAILED = 1;
const EXIT_SETUP = 2;
const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;

class Failure extends Error {
  constructor(message, code = EXIT_FAILED) {
    super(message);
    this.code = code;
  }
}

async function run(argv, env) {
  const log = createLog(env);
  try {
    const job = await readJob(argv, env);
    const token = await signIn({ ends: job.ends, say: log.say }, env);
    log.hide(token);
    const auth = { Authorization: `Bearer ${token}` };
    const dropbox = { ends: job.ends, say: log.say, auth };
    await uploadDailyCopy(dropbox, job);
    await keepMonthlyCopy(dropbox, job);
    await pruneDailyCopies(dropbox, job.date);
    return 0;
  } catch (error) {
    console.error(
      log.redact(
        `Dropbox upload failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return error instanceof Failure ? error.code : EXIT_FAILED;
  }
}

// Every line goes through say() or redact(), so no secret can be printed.
function createLog(env) {
  const secrets = SECRET_NAMES.map((name) => env[name]).filter(
    (s) => s && s.length >= MIN_SECRET_LENGTH,
  );
  const redact = (line) => {
    let text = String(line);
    for (const s of secrets) text = text.replaceAll(s, "[redacted]");
    return text;
  };
  return {
    redact,
    say: (line) => console.log(redact(line)),
    hide: (secret) => secrets.push(secret),
  };
}

// Checks the setup (exit 2), then that the file can be read (exit 1).
async function readJob(argv, env) {
  const values = parseOptions(argv);
  if (!values.file)
    throw new Failure(
      "Usage: node scripts/backup/dropbox-upload.mjs --file <records.xlsx> [--tz America/New_York] [--date YYYY-MM-DD]",
      EXIT_SETUP,
    );
  const missing = SECRET_NAMES.find((name) => !env[name]);
  if (missing)
    throw new Failure(
      `${missing} is not set. Add the Dropbox secrets to the "backups" environment (${RUNBOOK}).`,
      EXIT_SETUP,
    );
  const date = readDate(values);
  const ends = endpoints(env);
  return { file: values.file, date, ends, bytes: await fileSize(values.file) };
}

function parseOptions(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        file: { type: "string" },
        tz: { type: "string", default: "America/New_York" },
        date: { type: "string" },
      },
    }).values;
  } catch (error) {
    throw new Failure(error.message, EXIT_SETUP);
  }
}

function readDate(values) {
  let date;
  try {
    date = values.date ?? today(values.tz);
  } catch {
    throw new Failure(`Unknown time zone "${values.tz}".`, EXIT_SETUP);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
    throw new Failure(`--date must be YYYY-MM-DD, not "${date}".`, EXIT_SETUP);
  return date;
}

function today(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Production endpoints, or one local fake server for the tests. The test
// override only accepts a loopback address, so it cannot send the tokens
// anywhere else.
function endpoints(env) {
  const test = env.DROPBOX_TEST_BASE_URL;
  if (test && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(test))
    throw new Failure(
      "DROPBOX_TEST_BASE_URL must be a loopback address.",
      EXIT_SETUP,
    );
  const number = (name, fallback) =>
    test && env[name] ? Number(env[name]) : fallback;
  return {
    token: `${test ?? "https://api.dropbox.com"}/oauth2/token`,
    api: `${test ?? "https://api.dropboxapi.com"}/2`,
    content: `${test ?? "https://content.dropboxapi.com"}/2`,
    // Dropbox accepts at most 150 MB per request.
    sessionAbove: number("DROPBOX_TEST_SESSION_THRESHOLD", 150 * MIB),
    // Upload session chunks must be multiples of 4 MiB, except the last.
    chunk: number("DROPBOX_TEST_CHUNK_BYTES", 32 * MIB),
    backoff: number("DROPBOX_TEST_BACKOFF_MS", 1000),
  };
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    throw new Failure(`Cannot read ${file}.`);
  }
}

// Exchanges the long-lived refresh token for a short-lived access token.
async function signIn(client, env) {
  const basic = Buffer.from(
    `${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`,
  ).toString("base64");
  const answer = await request(
    client,
    "sign-in",
    client.ends.token,
    () => ({
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: env.DROPBOX_REFRESH_TOKEN,
      }),
    }),
    [400, 401],
  );
  const token = answer.json.access_token;
  if (answer.status !== 200 || typeof token !== "string")
    throw new Failure(
      `Dropbox refused the app key, secret or refresh token (${answer.json.error ?? answer.status}). The token may have been revoked or belong to another app; create a new one (${RUNBOOK}).`,
    );
  return token;
}

// One request with retries on rate limits, server errors and dropped
// connections. Returns { status, json } for 2xx, 409 and any status in
// `accept`; throws otherwise.
async function request(client, what, url, init, accept = []) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetchOrWait(client, what, url, init, attempt);
    if (!response) continue;
    if (response.status === 429 || response.status >= 500) {
      await waitToRetry(client, what, response, attempt);
      continue;
    }
    return readAnswer(what, response, accept);
  }
}

// Undefined after a dropped connection, once it has waited to retry.
async function fetchOrWait(client, what, url, init, attempt) {
  try {
    return await fetch(url, init());
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS)
      throw new Failure(
        `Could not reach Dropbox (${what}): ${error instanceof Error ? error.message : error}`,
      );
    await sleep(client.ends.backoff * 2 ** (attempt - 1));
    return undefined;
  }
}

async function waitToRetry(client, what, response, attempt) {
  const status = response.status;
  await response.arrayBuffer();
  if (attempt >= MAX_ATTEMPTS)
    throw new Failure(
      `Dropbox kept answering ${status} to ${what} after ${MAX_ATTEMPTS} attempts. Try again later.`,
    );
  const header = response.headers.get("retry-after");
  const wait = retryDelay(header, client.ends.backoff, attempt);
  client.say(
    `Dropbox answered ${status} to ${what}; retrying in ${Math.ceil(wait / 1000)} s.`,
  );
  await sleep(wait);
}

// Retry-After holds seconds or an HTTP date, and is honoured as given.
// Without a usable one, the wait doubles each attempt, up to a minute.
function retryDelay(header, backoff, attempt) {
  if (header !== null && Number.isFinite(Number(header)))
    return Number(header) * 1000;
  if (header !== null && !Number.isNaN(Date.parse(header)))
    return Math.max(0, Date.parse(header) - Date.now());
  return Math.min(MAX_BACKOFF_MS, backoff * 2 ** (attempt - 1));
}

async function readAnswer(what, response, accept) {
  const status = response.status;
  const json = parseBody(await response.text());
  if (
    (status >= 200 && status < 300) ||
    status === 409 ||
    accept.includes(status)
  )
    return { status, json };
  if (status === 401)
    throw new Failure(
      `Dropbox refused the access token for ${what} (${json.error_summary ?? status}). Check that the app has the files.content.write, files.content.read and files.metadata.read permissions, then create a new refresh token (${RUNBOOK}).`,
    );
  throw new Failure(
    `Dropbox rejected ${what} (${status}: ${json.error_summary ?? json.error_description ?? json.error ?? "no detail"}).`,
  );
}

// Some Dropbox errors (400 Bad Input among them) are plain text.
function parseBody(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error_summary: text.slice(0, 300) };
  }
}

function rpc(dropbox, what, endpoint, arg) {
  return request(dropbox, what, `${dropbox.ends.api}${endpoint}`, () => ({
    method: "POST",
    headers: { ...dropbox.auth, "Content-Type": "application/json" },
    body: JSON.stringify(arg),
  }));
}

function content(dropbox, what, endpoint, arg, body) {
  return request(dropbox, what, `${dropbox.ends.content}${endpoint}`, () => ({
    method: "POST",
    headers: {
      ...dropbox.auth,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": apiArg(arg),
    },
    body,
  }));
}

// HTTP headers are ASCII; Dropbox wants other characters escaped.
function apiArg(value) {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function uploadDailyCopy(dropbox, job) {
  const daily = `/Daily/${NAME} ${job.date}.xlsx`;
  dropbox.say(
    (await upload(dropbox, job, daily))
      ? `Uploaded ${daily} (${describeSize(job.bytes)}).`
      : `${daily} already exists; left it unchanged.`,
  );
}

// The first successful night of a month also keeps a monthly copy.
async function keepMonthlyCopy(dropbox, job) {
  const monthly = `/Monthly/${NAME} ${job.date.slice(0, 7)}.xlsx`;
  const what = `the check for ${monthly}`;
  const existing = await rpc(dropbox, what, "/files/get_metadata", {
    path: monthly,
  });
  const missing =
    existing.status === 409 &&
    summary(existing.json).startsWith("path/not_found");
  if (existing.status === 409 && !missing) throw rejected(what, existing);
  dropbox.say(
    missing && (await upload(dropbox, job, monthly))
      ? `Uploaded ${monthly}, this month's copy to keep.`
      : `${monthly} already exists; left it unchanged.`,
  );
}

// Adds a file; returns false when one already exists at that path.
async function upload(dropbox, job, path) {
  const commit = { path, mode: "add", autorename: false, mute: true };
  const what = `the upload of ${path}`;
  const result =
    job.bytes <= dropbox.ends.sessionAbove
      ? await content(
          dropbox,
          what,
          "/files/upload",
          commit,
          await readFile(job.file),
        )
      : await uploadInSession(dropbox, { ...job, what }, commit);
  if (result.status !== 409) return true;
  if (summary(result.json).startsWith("path/conflict")) return false;
  throw rejected(what, result);
}

async function uploadInSession(dropbox, job, commit) {
  const fh = await open(job.file, "r");
  try {
    return await sendSession(dropbox, { ...job, fh }, commit);
  } finally {
    await fh.close();
  }
}

async function sendSession(dropbox, transfer, commit) {
  const first = await readChunk(dropbox, transfer, 0);
  const started = await content(
    dropbox,
    transfer.what,
    "/files/upload_session/start",
    { close: false },
    first,
  );
  if (started.status === 409) throw rejected(transfer.what, started);
  const session = started.json.session_id;
  const offset = await appendChunks(dropbox, transfer, session, first.length);
  return content(
    dropbox,
    transfer.what,
    "/files/upload_session/finish",
    { cursor: { session_id: session, offset }, commit },
    await readChunk(dropbox, transfer, offset),
  );
}

// Appends chunks until at most one chunk is left, which goes with finish.
async function appendChunks(dropbox, transfer, session, start) {
  let offset = start;
  while (transfer.bytes - offset > dropbox.ends.chunk) {
    const piece = await readChunk(dropbox, transfer, offset);
    const appended = await content(
      dropbox,
      transfer.what,
      "/files/upload_session/append_v2",
      { cursor: { session_id: session, offset }, close: false },
      piece,
    );
    offset =
      appended.status === 409
        ? correctOffset(transfer.what, appended)
        : offset + piece.length;
  }
  return offset;
}

// A retried chunk Dropbox already had: resume where it says.
function correctOffset(what, appended) {
  const correct = appended.json.error?.correct_offset;
  if (typeof correct !== "number") throw rejected(what, appended);
  return correct;
}

async function readChunk(dropbox, transfer, offset) {
  const length = Math.min(dropbox.ends.chunk, transfer.bytes - offset);
  const buffer = Buffer.alloc(length);
  await transfer.fh.read(buffer, 0, length, offset);
  return buffer;
}

// Daily copies older than 90 days go; nothing else is touched.
async function pruneDailyCopies(dropbox, date) {
  const entries = await listDailyFolder(dropbox);
  const old = entries.filter((entry) => isExpiredDaily(entry, date));
  for (const entry of old) await removeDailyCopy(dropbox, entry);
  dropbox.say(
    old.length
      ? `Removed ${old.length} daily cop${old.length === 1 ? "y" : "ies"} older than ${KEEP_DAILY_DAYS} days: ${old.map((e) => e.name).join(", ")}.`
      : `No daily copies older than ${KEEP_DAILY_DAYS} days.`,
  );
}

// No /Daily folder yet lists as empty.
async function listDailyFolder(dropbox) {
  const what = "the listing of /Daily";
  const entries = [];
  let page = await rpc(dropbox, what, "/files/list_folder", {
    path: "/Daily",
    recursive: false,
    include_deleted: false,
  });
  if (page.status === 409 && !summary(page.json).startsWith("path/not_found"))
    throw rejected(what, page);
  while (page.status !== 409) {
    entries.push(...(page.json.entries ?? []));
    if (!page.json.has_more) break;
    page = await rpc(dropbox, what, "/files/list_folder/continue", {
      cursor: page.json.cursor,
    });
    if (page.status === 409) throw rejected(what, page);
  }
  return entries;
}

function isExpiredDaily(entry, date) {
  const match = entry[".tag"] === "file" && DAILY.exec(entry.name);
  return match && daysBetween(match[1], date) > KEEP_DAILY_DAYS;
}

// A copy that is already gone is the outcome wanted.
async function removeDailyCopy(dropbox, entry) {
  const what = `the removal of ${entry.name}`;
  const removed = await rpc(dropbox, what, "/files/delete_v2", {
    path: entry.path_lower ?? `/Daily/${entry.name}`,
  });
  if (
    removed.status === 409 &&
    !summary(removed.json).startsWith("path_lookup/not_found")
  )
    throw rejected(what, removed);
}

function summary(json) {
  return String(json.error_summary ?? "");
}

function rejected(what, answer) {
  return new Failure(`Dropbox rejected ${what} (${summary(answer.json)}).`);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function describeSize(bytes) {
  return bytes < MIB
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / MIB).toFixed(1)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.exitCode = await run(process.argv.slice(2), process.env);
