/**
 * Responsibility: Reads what each measured call cost from the local
 *   backend's own log stream: documents and bytes read, index ranges, user
 *   code time and the returned size.
 * Layer: Script. Load test only; imported by measure.mjs and paging.mjs,
 *   which check the backend with ./guard.mjs first.
 * Dependencies: ./common.mjs, node:child_process, node:fs.
 *
 * Index ranges and the bytes counted against the 16 MiB limit appear only as
 * the backend's limit warnings, which it logs for every call when started
 * with FUNCTION_LIMIT_WARNING_RATIO set very low (README "Index ranges").
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { appendResult, DATA_DIR, errorText, REPO_ROOT } from "./common.mjs";

const LOG_LINE_LIMIT = 400;
// The log stream needs a moment to connect, and to flush after the last call.
const LOG_STREAM_WARMUP_MS = 4000;
const LOG_STREAM_DRAIN_MS = 3000;
// Log timestamps are whole milliseconds on another clock read.
const LOG_MATCH_SLACK_MS = 50;
const MS_PER_SECOND = 1000;
// The backend's limit warnings, each "(actual: <n>[ bytes], limit: …)".
const LIMIT_WARNINGS = {
  indexRanges: /Many reads in a single function execution \(actual: (\d+)/,
  limitReadBytes: /Many bytes read in a single function execution \(actual: (\d+)/,
};

/**
 * Starts streaming the backend's log to DATA_DIR/results/logs-<name>.jsonl.
 *
 * @param name - The step or run the file is named after.
 * @returns The stream's process and file, for {@link recordUsage}.
 */
export async function startUsageLog(name) {
  mkdirSync(`${DATA_DIR}/results`, { recursive: true });
  const file = `${DATA_DIR}/results/logs-${name}.jsonl`;
  const out = openSync(file, "w");
  const stream = spawn("npx", ["convex", "logs", "--jsonl"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", out, "ignore"],
    detached: true,
  });
  await new Promise((resolve) => setTimeout(resolve, LOG_STREAM_WARMUP_MS));
  return { stream, file };
}

/**
 * Stops the log stream and appends one "usage" result per timed call: the
 * uncached execution of its function inside its time window that read the
 * most bytes.
 *
 * @param log - What {@link startUsageLog} returned.
 * @param step - The step the results belong to.
 * @param windows - Each call's `{ name, role, fn, t0, t1 }`.
 */
export async function recordUsage(log, step, windows) {
  await new Promise((resolve) => setTimeout(resolve, LOG_STREAM_DRAIN_MS));
  stopStream(log.stream);
  const entries = readCompletions(log.file);
  for (const window of windows) {
    const hits = executionsIn(entries, window);
    if (hits.length) recordExecution(step, window, hits);
  }
}

/**
 * What one logged execution cost, against Convex's per-function limits.
 *
 * @param entry - A "Completion" entry of `convex logs --jsonl`.
 * @returns Documents and bytes read (usage), the bytes and index ranges the
 *   limits count (null without the limit warnings), user time in ms and the
 *   returned bytes.
 */
export function executionUsage(entry) {
  const usage = entry.usageStats;
  const messages = (entry.logLines ?? []).flatMap(lineMessages);
  return {
    readDocuments: usage.databaseReadDocuments,
    readBytes: usage.databaseReadBytes,
    limitReadBytes: warningValue(messages, LIMIT_WARNINGS.limitReadBytes),
    indexRanges: warningValue(messages, LIMIT_WARNINGS.indexRanges),
    writeDocuments: usage.databaseWriteDocuments,
    userExecutionMs: Math.round(entry.userExecutionTime * MS_PER_SECOND),
    returnBytes: entry.returnBytes,
  };
}

function stopStream(stream) {
  try {
    process.kill(-stream.pid);
  } catch (error) {
    // The group is gone when the stream already exited; stop the child alone.
    console.warn("Log stream group:", errorText(error, LOG_LINE_LIMIT));
    stream.kill();
  }
}

function readCompletions(file) {
  const parse = (line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      // The last line is cut off when the stream is stopped mid-write.
      return [];
    }
  };
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap(parse)
    .filter((e) => e.kind === "Completion" && !e.cachedResult);
}

function executionsIn(entries, window) {
  const at = (e) => e.executionTimestamp * MS_PER_SECOND;
  const within = (e) =>
    at(e) >= window.t0 - LOG_MATCH_SLACK_MS &&
    at(e) <= window.t1 + LOG_MATCH_SLACK_MS;
  return entries.filter((e) => e.identifier === window.fn && within(e));
}

function recordExecution(step, window, hits) {
  const byBytes = (a, b) =>
    b.usageStats.databaseReadBytes - a.usageStats.databaseReadBytes;
  const worst = hits.sort(byBytes)[0];
  const extra = {
    of: window.name,
    fn: window.fn,
    executions: hits.length,
    ...executionUsage(worst),
    memoryUsedMb: worst.usageStats.memoryUsedMb,
    error: worst.error ? String(worst.error).slice(0, LOG_LINE_LIMIT) : null,
  };
  appendResult({
    step,
    area: "server",
    name: "usage",
    role: window.role,
    ok: worst.error == null,
    extra,
    at: new Date().toISOString(),
  });
  console.log(step, "usage", window.name, window.role, JSON.stringify(extra));
}

function lineMessages(line) {
  if (typeof line === "string") return [line];
  return line.messages ?? [];
}

function warningValue(messages, pattern) {
  for (const message of messages) {
    const match = pattern.exec(message);
    if (match) return Number(match[1]);
  }
  return null;
}
