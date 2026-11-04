/**
 * Responsibility: The FAA DRS searches a monitored aircraft needs, and running
 *   them into one list of AD candidates.
 * Layer: Domain. Pure functions, except fetchMonitoringCandidates, which calls
 *   the FAA DRS API through faa.ts (CONTEXT.md §5); only Convex actions run it.
 * Dependencies: ./model (types), ./airworthiness, ./faaSearch, ./faa, ./rejection.
 */
import type { Snapshot } from "./model";
import { adAircraftUuid } from "./airworthiness";
import { blankSearch, searchAssets, searchFilters } from "./faaSearch";
import { fetchDrsFiltered, type FaaCandidate } from "./faa";
import { Rejection } from "./rejection";

const DRS_TYPES = ["ADFRAWD", "ADFREAD"] as const;
const AD_NUMBERS_PER_REQUEST = 10;

// The monitor stores at most 400 candidates (faa.ts MAX_CANDIDATES), and a
// larger result is refused, never truncated (docs/airworthiness.md).
const MAX_MONITORING_DOCUMENTS = 400;

type Scope = Pick<Snapshot, "aircraft" | "management" | "airworthiness">;

interface MonitoringQuery {
  type: (typeof DRS_TYPES)[number];
  filters: Record<string, string[]>;
  label: string;
  assetIds: string[];
}

/**
 * The DRS searches that monitor one aircraft, final rules then emergency ADs:
 * each asset by model or part number, tracked AD numbers, extra keywords.
 *
 * @param s - The aircraft, its components and the program's ADs.
 * @param aircraftUuid - The monitored aircraft.
 * @param extra - Saved keywords; trimmed, blanks and repeats dropped.
 * @returns One query per type and filters; a repeat adds its assetIds to the
 *   first and replaces its label.
 * @throws {Rejection} "<asset>: enter a model, FAA search model, or component
 *   part number before checking."; a {@link searchFilters} refusal.
 */
export function monitoringQueries(
  s: Scope,
  aircraftUuid: string,
  extra: string[] = [],
) {
  const assets = searchAssets(s, aircraftUuid);
  const form = blankSearch(aircraftUuid, assets);
  const batches = trackedAdBatches(s, aircraftUuid);
  const keywords = [...new Set(extra.map((x) => x.trim()).filter(Boolean))];
  const queries = DRS_TYPES.flatMap((type): MonitoringQuery[] => [
    ...assets.map((asset) => assetQuery(form, asset, type)),
    ...batches.map((batch) => ({
      type,
      filters: {
        "drs:documentNumber": batch,
        "drs:status": ["Current", "Historical"],
      },
      assetIds: [],
      label: `Tracked ADs: ${batch.join(", ")}`,
    })),
    ...keywords.map((keyword) => ({
      type,
      filters: { Keyword: [keyword], "drs:status": ["Current"] },
      assetIds: [],
      label: `Additional keyword: ${keyword}`,
    })),
  ]);
  return mergeRepeatedQueries(queries);
}

/**
 * The coverage of {@link monitoringQueries}, compared with the monitor's
 * checked terms to tell when coverage changed.
 *
 * @param s - As {@link monitoringQueries}.
 * @param aircraftUuid - The monitored aircraft.
 * @param extra - Saved keywords.
 * @returns Each query as "<type>: <filters JSON>", sorted; for an incomplete
 *   profile, its refusal message alone.
 */
export function monitoringScope(
  s: Scope,
  aircraftUuid: string,
  extra: string[] = [],
) {
  try {
    return monitoringQueries(s, aircraftUuid, extra)
      .map((q) => `${q.type}: ${JSON.stringify(q.filters)}`)
      .sort();
  } catch (e) {
    // The refusal stands in for the scope, so it never matches a checked one.
    return [e instanceof Error ? e.message : "Incomplete aircraft search data"];
  }
}

/**
 * Runs the monitoring searches in order against FAA DRS.
 *
 * @param key - The FAA DRS API key.
 * @param queries - From {@link monitoringQueries}.
 * @param request - The fetch to use (a stub in tests).
 * @returns Each candidate once, in the order found, with the assetIds of the
 *   queries that found it (undefined if none named an asset).
 * @throws {Rejection} "No aircraft or component search data is available.",
 *   or "<label>: More than 400 documents across monitoring searches. …".
 * @throws {Error} "<label>: <reason>" when a search fails.
 */
export async function fetchMonitoringCandidates(
  key: string,
  queries: ReturnType<typeof monitoringQueries>,
  request: typeof fetch = fetch,
) {
  if (!queries.length)
    throw new Rejection("No aircraft or component search data is available.");
  const found = new Map<string, FaaCandidate>();
  for (const q of queries) {
    for (const c of await searchDrs(key, q, request))
      found.set(c.id, withAssetIds(c, q.assetIds, found.get(c.id)));
    if (found.size > MAX_MONITORING_DOCUMENTS)
      throw new Rejection(
        `${q.label}: More than 400 documents across monitoring searches. Narrow additional keywords before checking again.`,
      );
  }
  return [...found.values()];
}

function trackedAdBatches(s: Scope, aircraftUuid: string) {
  const numbers = (s.airworthiness ?? [])
    .filter((r) => adAircraftUuid(s, r) === aircraftUuid)
    .map((r) => r.source.number);
  const unique = [...new Set(numbers)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += AD_NUMBERS_PER_REQUEST)
    batches.push(unique.slice(i, i + AD_NUMBERS_PER_REQUEST));
  return batches;
}

function assetQuery(
  form: ReturnType<typeof blankSearch>,
  asset: ReturnType<typeof searchAssets>[number],
  type: MonitoringQuery["type"],
): MonitoringQuery {
  // Do not silently skip incomplete profiles or declare partial coverage successful.
  if (!asset.model && !asset.keywords)
    throw new Rejection(
      `${asset.label}: enter a model, FAA search model, or component part number before checking.`,
    );
  return {
    type,
    assetIds: [asset.id],
    filters: searchFilters(form, asset, type),
    label: `${asset.label}: ${asset.id ? asset.section : "Aircraft"} ${asset.model || asset.keywords}`,
  };
}

function mergeRepeatedQueries(queries: MonitoringQuery[]) {
  const unique = new Map<string, MonitoringQuery>();
  for (const q of queries) {
    const key = q.type + JSON.stringify(q.filters);
    const assetIds = [...(unique.get(key)?.assetIds ?? []), ...q.assetIds];
    unique.set(key, { ...q, assetIds: [...new Set(assetIds)] });
  }
  return [...unique.values()];
}

function withAssetIds(c: FaaCandidate, ids: string[], prior?: FaaCandidate) {
  const all = [...new Set([...(prior?.matchedAssetIds ?? []), ...ids])];
  return { ...c, matchedAssetIds: all.length ? all : undefined };
}

async function searchDrs(
  key: string,
  q: MonitoringQuery,
  request: typeof fetch,
) {
  try {
    return await fetchDrsFiltered(key, q.type, q.filters, request);
  } catch (e) {
    // Name the search that failed; the stored error is all the user sees.
    throw Error(
      `${q.label}: ${e instanceof Error ? e.message : "FAA request failed"}`,
    );
  }
}
