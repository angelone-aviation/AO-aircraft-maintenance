#!/usr/bin/env node
// Uploads the readable records workbook to Dropbox (ADR-0011). Setup and
// troubleshooting: docs/runbooks/dropbox-records-copy.md.
//
//   DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... DROPBOX_REFRESH_TOKEN=... \
//   node scripts/backup/dropbox-upload.mjs --file <records.xlsx> \
//     [--tz America/New_York] [--date YYYY-MM-DD]
//
// The Dropbox app is limited to its own App folder; paths are inside it:
//   /Daily/Angel One records YYYY-MM-DD.xlsx   every night, removed after 90 days
//   /Monthly/Angel One records YYYY-MM.xlsx    first successful night of a month,
//                                              never removed
// Files are added, never overwritten. Only /Daily/ is pruned, and only files
// named as above. Retries on 429 and 5xx, honouring Retry-After. Never prints
// a token or secret. Exit codes: 0 done, 1 Dropbox or file error, 2 setup.
import { open, readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";

const KEEP_DAILY_DAYS = 90;
const NAME = "Angel One records";
const DAILY = /^Angel One records (\d{4}-\d{2}-\d{2})\.xlsx$/;
const MAX_ATTEMPTS = 6;
const RUNBOOK = "docs/runbooks/dropbox-records-copy.md";

class Failure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// Production endpoints, or one local fake server for the tests. The test
// override only accepts a loopback address, so it cannot send the tokens
// anywhere else.
function endpoints(env) {
  const test = env.DROPBOX_TEST_BASE_URL;
  if (test && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(test))
    throw new Failure("DROPBOX_TEST_BASE_URL must be a loopback address.", 2);
  const number = (name, fallback) =>
    test && env[name] ? Number(env[name]) : fallback;
  return {
    token: `${test ?? "https://api.dropbox.com"}/oauth2/token`,
    api: `${test ?? "https://api.dropboxapi.com"}/2`,
    content: `${test ?? "https://content.dropboxapi.com"}/2`,
    // Dropbox accepts at most 150 MB per request.
    sessionAbove: number("DROPBOX_TEST_SESSION_THRESHOLD", 150 * 1024 * 1024),
    // Upload session chunks must be multiples of 4 MiB, except the last.
    chunk: number("DROPBOX_TEST_CHUNK_BYTES", 32 * 1024 * 1024),
    backoff: number("DROPBOX_TEST_BACKOFF_MS", 1000),
  };
}

function today(timeZone, now = Date.now()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(now))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}
const daysBetween = (from, to) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
// HTTP headers are ASCII; Dropbox wants other characters escaped.
const apiArg = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const size = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function run(argv, env) {
  const secrets = [
    env.DROPBOX_APP_KEY,
    env.DROPBOX_APP_SECRET,
    env.DROPBOX_REFRESH_TOKEN,
  ].filter((s) => s && s.length >= 4);
  // Every line goes through here, so no secret can be printed.
  const redact = (line) => {
    let text = String(line);
    for (const s of secrets) text = text.replaceAll(s, "[redacted]");
    return text;
  };
  const say = (line) => console.log(redact(line));
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          file: { type: "string" },
          tz: { type: "string", default: "America/New_York" },
          date: { type: "string" },
        },
      }));
    } catch (error) {
      throw new Failure(error.message, 2);
    }
    if (!values.file)
      throw new Failure(
        "Usage: node scripts/backup/dropbox-upload.mjs --file <records.xlsx> [--tz America/New_York] [--date YYYY-MM-DD]",
        2,
      );
    for (const name of [
      "DROPBOX_APP_KEY",
      "DROPBOX_APP_SECRET",
      "DROPBOX_REFRESH_TOKEN",
    ])
      if (!env[name])
        throw new Failure(
          `${name} is not set. Add the Dropbox secrets to the "backups" environment (${RUNBOOK}).`,
          2,
        );
    let date;
    try {
      date = values.date ?? today(values.tz);
    } catch {
      throw new Failure(`Unknown time zone "${values.tz}".`, 2);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
      throw new Failure(`--date must be YYYY-MM-DD, not "${date}".`, 2);
    const ends = endpoints(env);
    let bytes;
    try {
      bytes = (await stat(values.file)).size;
    } catch {
      throw new Failure(`Cannot read ${values.file}.`);
    }

    // One request with retries on rate limits, server errors and dropped
    // connections. Returns { status, json } for 2xx, 409 and any status in
    // `accept`; throws otherwise.
    const request = async (what, url, init, accept = []) => {
      for (let attempt = 1; ; attempt++) {
        let response;
        try {
          response = await fetch(url, init());
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS)
            throw new Failure(
              `Could not reach Dropbox (${what}): ${error instanceof Error ? error.message : error}`,
            );
          await sleep(ends.backoff * 2 ** (attempt - 1));
          continue;
        }
        const status = response.status;
        if (status === 429 || status >= 500) {
          await response.arrayBuffer();
          if (attempt >= MAX_ATTEMPTS)
            throw new Failure(
              `Dropbox kept answering ${status} to ${what} after ${MAX_ATTEMPTS} attempts. Try again later.`,
            );
          const header = response.headers.get("retry-after");
          const seconds = Number(header);
          const wait =
            header !== null && Number.isFinite(seconds)
              ? seconds * 1000
              : header !== null && !Number.isNaN(Date.parse(header))
                ? Math.max(0, Date.parse(header) - Date.now())
                : Math.min(60_000, ends.backoff * 2 ** (attempt - 1));
          say(
            `Dropbox answered ${status} to ${what}; retrying in ${Math.ceil(wait / 1000)} s.`,
          );
          await sleep(wait);
          continue;
        }
        const text = await response.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { error_summary: text.slice(0, 300) };
        }
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
    };

    // Exchange the long-lived refresh token for a short-lived access token.
    const basic = Buffer.from(
      `${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`,
    ).toString("base64");
    const signIn = await request(
      "sign-in",
      ends.token,
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
    const token = signIn.json.access_token;
    if (signIn.status !== 200 || typeof token !== "string")
      throw new Failure(
        `Dropbox refused the app key, secret or refresh token (${signIn.json.error ?? signIn.status}). The token may have been revoked or belong to another app; create a new one (${RUNBOOK}).`,
      );
    secrets.push(token);
    const auth = { Authorization: `Bearer ${token}` };
    const rpc = (what, endpoint, arg) =>
      request(what, `${ends.api}${endpoint}`, () => ({
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(arg),
      }));
    const content = (what, endpoint, arg, body) =>
      request(what, `${ends.content}${endpoint}`, () => ({
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": apiArg(arg),
        },
        body,
      }));
    const summary = (json) => String(json.error_summary ?? "");

    // Adds a file; returns false when one already exists at that path.
    const upload = async (path) => {
      const commit = { path, mode: "add", autorename: false, mute: true };
      const what = `the upload of ${path}`;
      let result;
      if (bytes <= ends.sessionAbove) {
        const body = await readFile(values.file);
        result = await content(what, "/files/upload", commit, body);
      } else {
        const fh = await open(values.file, "r");
        try {
          const chunk = async (offset) => {
            const length = Math.min(ends.chunk, bytes - offset);
            const buffer = Buffer.alloc(length);
            await fh.read(buffer, 0, length, offset);
            return buffer;
          };
          const first = await chunk(0);
          const started = await content(
            what,
            "/files/upload_session/start",
            { close: false },
            first,
          );
          if (started.status === 409)
            throw new Failure(
              `Dropbox rejected ${what} (${summary(started.json)}).`,
            );
          const session = started.json.session_id;
          let offset = first.length;
          while (bytes - offset > ends.chunk) {
            const piece = await chunk(offset);
            const appended = await content(
              what,
              "/files/upload_session/append_v2",
              { cursor: { session_id: session, offset }, close: false },
              piece,
            );
            if (appended.status === 409) {
              // A retried chunk Dropbox already had: resume where it says.
              const correct = appended.json.error?.correct_offset;
              if (typeof correct !== "number")
                throw new Failure(
                  `Dropbox rejected ${what} (${summary(appended.json)}).`,
                );
              offset = correct;
              continue;
            }
            offset += piece.length;
          }
          result = await content(
            what,
            "/files/upload_session/finish",
            { cursor: { session_id: session, offset }, commit },
            await chunk(offset),
          );
        } finally {
          await fh.close();
        }
      }
      if (result.status === 409) {
        if (summary(result.json).startsWith("path/conflict")) return false;
        throw new Failure(
          `Dropbox rejected ${what} (${summary(result.json)}).`,
        );
      }
      return true;
    };

    const daily = `/Daily/${NAME} ${date}.xlsx`;
    say(
      (await upload(daily))
        ? `Uploaded ${daily} (${size(bytes)}).`
        : `${daily} already exists; left it unchanged.`,
    );

    // The first successful night of a month also keeps a monthly copy.
    const monthly = `/Monthly/${NAME} ${date.slice(0, 7)}.xlsx`;
    const existing = await rpc(
      `the check for ${monthly}`,
      "/files/get_metadata",
      {
        path: monthly,
      },
    );
    if (
      existing.status === 409 &&
      summary(existing.json).startsWith("path/not_found")
    )
      say(
        (await upload(monthly))
          ? `Uploaded ${monthly}, this month's copy to keep.`
          : `${monthly} already exists; left it unchanged.`,
      );
    else if (existing.status === 409)
      throw new Failure(
        `Dropbox rejected the check for ${monthly} (${summary(existing.json)}).`,
      );
    else say(`${monthly} already exists; left it unchanged.`);

    // Daily copies older than 90 days go; nothing else is touched.
    const entries = [];
    let page = await rpc("the listing of /Daily", "/files/list_folder", {
      path: "/Daily",
      recursive: false,
      include_deleted: false,
    });
    if (page.status === 409 && !summary(page.json).startsWith("path/not_found"))
      throw new Failure(
        `Dropbox rejected the listing of /Daily (${summary(page.json)}).`,
      );
    while (page.status !== 409) {
      entries.push(...(page.json.entries ?? []));
      if (!page.json.has_more) break;
      page = await rpc("the listing of /Daily", "/files/list_folder/continue", {
        cursor: page.json.cursor,
      });
      if (page.status === 409)
        throw new Failure(
          `Dropbox rejected the listing of /Daily (${summary(page.json)}).`,
        );
    }
    const old = entries.filter((e) => {
      const match = e[".tag"] === "file" && DAILY.exec(e.name);
      return match && daysBetween(match[1], date) > KEEP_DAILY_DAYS;
    });
    for (const e of old) {
      const removed = await rpc(
        `the removal of ${e.name}`,
        "/files/delete_v2",
        {
          path: e.path_lower ?? `/Daily/${e.name}`,
        },
      );
      if (
        removed.status === 409 &&
        !summary(removed.json).startsWith("path_lookup/not_found")
      )
        throw new Failure(
          `Dropbox rejected the removal of ${e.name} (${summary(removed.json)}).`,
        );
    }
    say(
      old.length
        ? `Removed ${old.length} daily cop${old.length === 1 ? "y" : "ies"} older than ${KEEP_DAILY_DAYS} days: ${old.map((e) => e.name).join(", ")}.`
        : `No daily copies older than ${KEEP_DAILY_DAYS} days.`,
    );
    return 0;
  } catch (error) {
    console.error(
      redact(
        `Dropbox upload failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return error instanceof Failure ? error.code : 1;
  }
}

process.exitCode = await run(process.argv.slice(2), process.env);
