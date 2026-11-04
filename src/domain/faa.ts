/**
 * Responsibility: FAA DRS airworthiness-directive monitoring: the monitor
 *   record and its commands, search terms, and AD candidates read from DRS
 *   result pages.
 * Layer: Domain. Zod schemas and pure functions; no I/O. The DRS requests are
 *   made in convex/faaDrs.ts.
 * Dependencies: zod, ./airworthiness, ./model, ./rejection.
 */
import { z } from "zod";
import { adSourceSchema, type ADSource } from "./airworthiness";
import type { Snapshot } from "./model";
import { Rejection } from "./rejection";

/** A DRS document type: final-rule ADs (ADFRAWD) or emergency ADs (ADFREAD). */
export type DrsType = "ADFRAWD" | "ADFREAD";

// A monitor keeps at most this many candidates, and a check or search that
// finds more is refused.
const MAX_CANDIDATES = 400;

const MIN_TERM_LENGTH = 2;
const MANUAL_CHECK_INTERVAL_MS = 60_000;
const DRS_SITE = "https://drs.faa.gov/";
const SOURCE_TEXT_MAX = 2000;

// DRS writes "_EMPTY_" for a field with no value, alone or in a list.
const DRS_EMPTY = "_EMPTY_";

const PRODUCT_SECTIONS: [RegExp, ADSource["section"]][] = [
  [/engine/i, "Engine"],
  [/propeller/i, "Propeller"],
  [/appliance/i, "Appliance"],
];

const searchTerms = z
  .array(z.string().trim().min(MIN_TERM_LENGTH).max(100))
  .max(30);

const drsPageSchema = z.object({
  summary: z.object({ hasMoreItems: z.boolean() }),
  documents: z.array(z.record(z.string(), z.unknown())),
});

/**
 * An AD found in FAA DRS, awaiting review. `id` is the DRS type and document
 * guid; `matchedAssetIds` lists the aircraft or components it was found for.
 *
 * @throws {z.ZodError} From `parse()` on a missing or mistyped field.
 */
export const faaCandidateSchema = z.object({
  id: z.string(),
  modified: z.string(),
  matchedAssetIds: z.array(z.string()).optional(),
  source: adSourceSchema,
  emergency: z.boolean(),
  status: z.string(),
  reviewReason: z.string(),
  reviewedAt: z.number().optional(),
});

/**
 * An aircraft's FAA AD monitor: up to 30 extra search terms of 2–100
 * characters, its last run, and up to 400 candidates.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const faaMonitorSchema = z.object({
  aircraftUuid: z.string(),
  enabled: z.boolean(),
  terms: searchTerms,
  lastAttempt: z.number().optional(),
  lastSuccess: z.number().optional(),
  error: z.string(),
  runId: z.string(),
  candidates: z.array(faaCandidateSchema).max(MAX_CANDIDATES),
  checkedTerms: z.array(z.string()).optional(),
});

/** A parsed FAA monitor. */
export type FaaMonitor = z.infer<typeof faaMonitorSchema>;

/** A parsed FAA AD candidate. */
export type FaaCandidate = z.infer<typeof faaCandidateSchema>;

/**
 * A command on an aircraft's FAA monitor: configure it, check now, or review
 * a candidate with a reason of 1–2,000 characters.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind or invalid field.
 */
export const faaCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("configure"),
    aircraftUuid: z.string(),
    enabled: z.boolean(),
    terms: searchTerms,
  }),
  z.object({ kind: z.literal("check"), aircraftUuid: z.string() }),
  z.object({
    kind: z.literal("review"),
    aircraftUuid: z.string(),
    id: z.string(),
    reason: z.string().trim().min(1).max(2000),
  }),
]);

/** A parsed FAA monitor command. */
export type FaaCommand = z.infer<typeof faaCommandSchema>;

/**
 * Starts an aircraft's FAA monitor: disabled, with no terms or candidates.
 *
 * @param aircraftUuid - The aircraft.
 * @returns A new monitor that has never run.
 */
export function emptyMonitor(aircraftUuid: string): FaaMonitor {
  return {
    aircraftUuid,
    enabled: false,
    terms: [],
    error: "",
    runId: "",
    candidates: [],
  };
}

/**
 * Applies a command to an aircraft's monitor. Configuring saves the settings
 * and drops any running check, so the next check verifies them; reviewing
 * records a reason on a candidate; checking starts a run.
 *
 * @param monitor - The aircraft's monitor; left unchanged.
 * @param cmd - The command, for this monitor's aircraft.
 * @param now - The current time, in ms.
 * @returns The changed monitor; after a check, its `runId` is the run to start.
 * @throws {Rejection} "Candidate not found." for a review of an unknown
 *   candidate; "Wait one minute before checking again." for a check within a
 *   minute of the last attempt.
 */
export function applyFaaCommand(
  monitor: FaaMonitor,
  cmd: FaaCommand,
  now: number,
): FaaMonitor {
  if (cmd.kind === "configure")
    return {
      ...monitor,
      enabled: cmd.enabled,
      terms: cmd.terms,
      runId: "",
      error: "Settings changed. Run a check to verify coverage.",
    };
  if (cmd.kind === "review") return reviewCandidate(monitor, cmd, now);
  if (monitorAttemptedWithin(monitor, MANUAL_CHECK_INTERVAL_MS, now))
    throw new Rejection("Wait one minute before checking again.");
  return startFaaRun(monitor, now);
}

/**
 * Starts a check: a new run id, attempted now, with no error.
 *
 * @param monitor - The aircraft's monitor; left unchanged.
 * @param now - The current time, in ms.
 * @returns The monitor expecting the new run; results of any other run are
 *   ignored.
 */
export function startFaaRun(monitor: FaaMonitor, now: number): FaaMonitor {
  return {
    ...monitor,
    runId: crypto.randomUUID(),
    lastAttempt: now,
    error: "",
  };
}

/**
 * Whether a monitor's last check started less than `ms` before `now`.
 *
 * @param monitor - The aircraft's monitor.
 * @param ms - The interval.
 * @param now - The current time, in ms.
 */
export function monitorAttemptedWithin(
  monitor: FaaMonitor,
  ms: number,
  now: number,
): boolean {
  return !!monitor.lastAttempt && now - monitor.lastAttempt < ms;
}

/**
 * Lists the keywords an aircraft's AD search uses.
 *
 * @param s - The aircraft, its components and its ADs.
 * @param aircraftUuid - The aircraft.
 * @param extra - Further terms the user added.
 * @returns The aircraft's FAA search model (or model), each installed
 *   component's search model (or model) and part number, its AD numbers, then
 *   `extra`: trimmed, first occurrence only, none under 2 characters.
 */
export function faaSearchTerms(
  s: Pick<Snapshot, "aircraft" | "management" | "airworthiness">,
  aircraftUuid: string,
  extra: string[] = [],
) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  const components = (s.management ?? [])
    .filter((c) => c.kind === "component")
    .filter((c) => c.aircraftUuid === aircraftUuid && c.installed);
  const terms = [
    a?.faaSearchModel?.trim() || a?.model,
    ...components.flatMap((c) => [
      c.faaSearchModel?.trim() || c.model,
      c.partNumber,
    ]),
    ...(s.airworthiness ?? [])
      .filter((r) => r.aircraftUuid === aircraftUuid)
      .map((r) => r.source.number),
    ...extra,
  ]
    .map((x) => x?.trim())
    .filter((x): x is string => !!x && x.length >= MIN_TERM_LENGTH);
  return [...new Set(terms)];
}

/**
 * Turns one DRS document into an AD candidate. Absent, null and "_EMPTY_"
 * fields read as "", and lists are joined with ", ".
 *
 * @param d - The document's fields as DRS returns them.
 * @param type - ADFRAWD (final rule) or ADFREAD (emergency).
 * @returns An unreviewed candidate, its section from the product type
 *   (Airframe by default) and its link kept only when it is on drs.faa.gov.
 * @throws {Error} "FAA returned an AD without an identifier. Check was not
 *   completed." when the guid or AD number is missing.
 * @throws {z.ZodError} When the result fails {@link faaCandidateSchema}.
 */
export function drsCandidate(
  d: Record<string, unknown>,
  type: DrsType,
): FaaCandidate {
  const number = readDrsField(d, "drs:documentNumber");
  const id = readDrsField(d, "documentGuid");
  if (!id || !number)
    throw Error(
      "FAA returned an AD without an identifier. Check was not completed.",
    );
  return faaCandidateSchema.parse({
    id: type + ":" + id,
    modified: readDrsField(d, "docLastModifiedDate"),
    emergency: type === "ADFREAD",
    status: readDrsField(d, "drs:status"),
    reviewReason: "",
    source: readDrsSource(d, type, number),
  });
}

/**
 * Reads one page of DRS results.
 *
 * @param body - The page's JSON, as DRS sent it.
 * @returns `summary.hasMoreItems` and the page's documents.
 * @throws {Error} "Unexpected FAA response. Check was not completed." for a
 *   body of any other shape.
 */
export function parseDrsPage(body: unknown) {
  const parsed = drsPageSchema.safeParse(body);
  if (!parsed.success)
    throw Error("Unexpected FAA response. Check was not completed.");
  return parsed.data;
}

/**
 * Adds a candidate to a query's results by id. A document DRS sends again, on
 * a later page, keeps its first place and takes the later copy.
 *
 * @param found - The query's candidates so far; updated in place.
 * @param c - The candidate.
 * @throws {Rejection} "More than 400 matching documents. Narrow the
 *   aircraft/component search terms."
 */
export function addDrsCandidate(
  found: Map<string, FaaCandidate>,
  c: FaaCandidate,
): void {
  found.set(c.id, c);
  if (found.size > MAX_CANDIDATES)
    throw new Rejection(
      "More than 400 matching documents. Narrow the aircraft/component search terms.",
    );
}

/**
 * Adds a check's candidates to a monitor's history. An unchanged document
 * (same modified date, source and status) keeps its prior entry and review.
 *
 * @param old - The monitor's candidates.
 * @param incoming - Candidates from the latest check.
 * @returns The prior candidates in their order, updated where changed, then
 *   new ones in the order received.
 * @throws {Rejection} "Monitoring history reached 400 documents; narrow the
 *   monitoring scope before continuing."
 */
export function mergeCandidates(old: FaaCandidate[], incoming: FaaCandidate[]) {
  const map = new Map(old.map((c) => [c.id, c]));
  for (const c of incoming) {
    const prior = map.get(c.id);
    map.set(c.id, prior && isSameDocument(prior, c) ? prior : c);
  }
  if (map.size > MAX_CANDIDATES)
    throw new Rejection(
      "Monitoring history reached 400 documents; narrow the monitoring scope before continuing.",
    );
  return [...map.values()];
}

function reviewCandidate(
  monitor: FaaMonitor,
  cmd: Extract<FaaCommand, { kind: "review" }>,
  now: number,
): FaaMonitor {
  const index = monitor.candidates.findIndex((c) => c.id === cmd.id);
  if (index < 0) throw new Rejection("Candidate not found.");
  const candidates = [...monitor.candidates];
  candidates[index] = {
    ...candidates[index],
    reviewReason: cmd.reason,
    reviewedAt: now,
  };
  return { ...monitor, candidates };
}

function readDrsField(d: Record<string, unknown>, key: string) {
  const v = d[key];
  if (v === undefined || v === null || v === DRS_EMPTY) return "";
  if (Array.isArray(v)) return v.filter((x) => x !== DRS_EMPTY).join(", ");
  return String(v);
}

function readDrsSource(
  d: Record<string, unknown>,
  type: DrsType,
  number: string,
) {
  const field = (name: string) =>
    readDrsField(d, "drs:" + type.toLowerCase() + name);
  const subject = field("Subject") || readDrsField(d, "drs:title");
  const notes = [
    "Status: " + readDrsField(d, "drs:status"),
    "Supersedes: " + field("SupersededAD"),
    "Affected ADs: " + field("AffectedAD"),
  ].join("\n");
  return {
    number,
    faaModified: readDrsField(d, "docLastModifiedDate"),
    amendment: field("Amendment"),
    issued: field("IssueDate"),
    effective: readDrsField(d, "drs:effectiveDate"),
    subject: subject.slice(0, SOURCE_TEXT_MAX),
    recurring: "Unknown",
    supersededBy: field("SupersededBy"),
    url: readDrsUrl(d, type),
    source: "FAA DRS " + type,
    section: productSection(field("ProductType") + field("ProductTypes")),
    make: field("Make"),
    model: field("Model"),
    sourceNotes: notes.slice(0, SOURCE_TEXT_MAX),
  };
}

// Only a link on the FAA's own site is kept; anything else falls back to the
// DRS browse page for the document type.
function readDrsUrl(d: Record<string, unknown>, type: DrsType) {
  const url = readDrsField(d, "documentURL");
  return url.startsWith(DRS_SITE)
    ? url
    : DRS_SITE + "browse/" + type + "/doctypeDetails";
}

function productSection(product: string): ADSource["section"] {
  const match = PRODUCT_SECTIONS.find(([pattern]) => pattern.test(product));
  return match?.[1] ?? "Airframe";
}

function isSameDocument(prior: FaaCandidate, c: FaaCandidate) {
  return (
    prior.modified === c.modified &&
    JSON.stringify(prior.source) === JSON.stringify(c.source) &&
    prior.status === c.status
  );
}
