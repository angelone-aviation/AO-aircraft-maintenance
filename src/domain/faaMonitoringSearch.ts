/**
 * Responsibility: The FAA DRS searches a monitored aircraft needs, and merging
 *   their results into one list of AD candidates.
 * Layer: Domain. Pure functions; no I/O. convex/faaDrs.ts runs the searches.
 * Dependencies: ./model (types), ./airworthiness, ./faaSearch, ./faa (types),
 *   ./rejection.
 */
import type { Snapshot } from "./model";
import { adAircraftUuid } from "./airworthiness";
import { blankSearch, searchAssets, searchFilters } from "./faaSearch";
import type { DrsType, FaaCandidate } from "./faa";
import { Rejection } from "./rejection";

const DRS_TYPES: readonly DrsType[] = ["ADFRAWD", "ADFREAD"];
const AD_NUMBERS_PER_REQUEST = 10;

// The monitor stores at most 400 candidates (faa.ts MAX_CANDIDATES), and a
// larger result is refused, never truncated (docs/airworthiness.md).
const MAX_MONITORING_DOCUMENTS = 400;

type Scope = Pick<Snapshot, "aircraft" | "management" | "airworthiness">;

/**
 * One DRS search of a monitor check; `label` names it in an error, and
 * `assetIds` are the aircraft ("") or components it covers.
 */
export interface MonitoringQuery {
  type: DrsType;
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
 * Merges one monitoring search's candidates into the check's results, each
 * once by id, with the assets of every search that found it.
 *
 * @param found - The check's candidates so far, by id; updated in place.
 * @param q - The search.
 * @param candidates - What DRS returned for it.
 * @throws {Rejection} "<label>: More than 400 documents across monitoring
 *   searches. Narrow additional keywords before checking again."
 */
export function mergeMonitoringCandidates(
  found: Map<string, FaaCandidate>,
  q: MonitoringQuery,
  candidates: FaaCandidate[],
): void {
  for (const c of candidates)
    found.set(c.id, withAssetIds(c, q.assetIds, found.get(c.id)));
  if (found.size > MAX_MONITORING_DOCUMENTS)
    throw new Rejection(
      `${q.label}: More than 400 documents across monitoring searches. Narrow additional keywords before checking again.`,
    );
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
  // Do not silently skip incomplete profiles or declare partial coverage
  // successful.
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
