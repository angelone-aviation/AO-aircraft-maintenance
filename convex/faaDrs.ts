/**
 * Responsibility: The FAA DRS requests an AD search or a monitor check makes:
 *   paging through one filtered query, and running a check's queries in order.
 * Layer: Server. Helpers for Convex actions, the only code that calls the DRS
 *   data API; the queries, parsing, merging and limits are the domain's.
 * Dependencies: src/domain (faa, faaSearch, faaMonitoringSearch, rejection).
 */
import {
  addDrsCandidate,
  drsCandidate,
  parseDrsPage,
  type DrsType,
  type FaaCandidate,
} from "../src/domain/faa";
import {
  faaSearchQueries,
  mergeSearchResults,
  sortSearchResults,
  type FaaSearchInput,
  type FaaSearchResult,
} from "../src/domain/faaSearch";
import {
  mergeMonitoringCandidates,
  type MonitoringQuery,
} from "../src/domain/faaMonitoringSearch";
import { Rejection } from "../src/domain/rejection";

const DRS_DATA_PULL = "https://drs.faa.gov/api/drs/data-pull/";
const DRS_MAX_PAGES = 20;
const DRS_TIMEOUT_MS = 30000;

/**
 * Fetches every DRS document of one type that matches the filters, page by
 * page.
 *
 * @param key - The FAA DRS API key.
 * @param type - ADFRAWD (final rule) or ADFREAD (emergency).
 * @param filters - DRS document filters, by field.
 * @param request - The fetch to use (a stub in tests).
 * @returns The candidates, once each by id, in the order DRS returned them.
 * @throws {Rejection} "More than 400 matching documents. Narrow the
 *   aircraft/component search terms."
 * @throws {Error} When DRS rejects the key (401 or 403), fails, sends a page
 *   it cannot read, stops paging early, or needs more than 20 pages.
 */
export async function fetchDrsFiltered(
  key: string,
  type: DrsType,
  filters: Record<string, string[]>,
  request: typeof fetch = fetch,
): Promise<FaaCandidate[]> {
  const found = new Map<string, FaaCandidate>();
  let offset = 0;
  for (let page = 0; page < DRS_MAX_PAGES; page++) {
    const body = { offset, sortOrder: "ASC", documentFilters: filters };
    const { summary, documents } = await requestDrsPage(
      key,
      type,
      body,
      request,
    );
    for (const doc of documents)
      addDrsCandidate(found, drsCandidate(doc, type));
    if (!summary.hasMoreItems) return [...found.values()];
    if (!documents.length)
      throw Error("FAA pagination stalled. Check was not completed.");
    offset += documents.length;
  }
  throw Error("FAA results exceeded the page limit. Check was not completed.");
}

/**
 * Runs an AD search against FAA DRS, one request per query, and merges the
 * documents by AD number.
 *
 * @param key - The FAA DRS API key.
 * @param raw - The search.
 * @param request - The fetch to use.
 * @returns The ADs, as `sortSearchResults` orders them.
 * @throws {ZodError} On an invalid search, before any request.
 * @throws {Rejection} A `faaSearchQueries` refusal, before any request; or
 *   "More than 400 ADs matched. …", in which case nothing is returned.
 * @throws As {@link fetchDrsFiltered}.
 */
export async function searchFAA(
  key: string,
  raw: FaaSearchInput,
  request: typeof fetch = fetch,
): Promise<FaaSearchResult[]> {
  const found = new Map<string, FaaSearchResult>();
  for (const q of faaSearchQueries(raw)) {
    const candidates = await fetchDrsFiltered(key, q.type, q.filters, request);
    mergeSearchResults(found, candidates, q.assets);
  }
  return sortSearchResults(found);
}

/**
 * Runs a monitor check's searches in order against FAA DRS.
 *
 * @param key - The FAA DRS API key.
 * @param queries - From `monitoringQueries`.
 * @param request - The fetch to use (a stub in tests).
 * @returns Each candidate once, in the order found, with the assetIds of the
 *   queries that found it (undefined if none named an asset).
 * @throws {Rejection} "No aircraft or component search data is available.",
 *   or a `mergeMonitoringCandidates` refusal.
 * @throws {Error} "<label>: <reason>" when a search fails, a refusal of
 *   {@link fetchDrsFiltered} included.
 */
export async function fetchMonitoringCandidates(
  key: string,
  queries: MonitoringQuery[],
  request: typeof fetch = fetch,
): Promise<FaaCandidate[]> {
  if (!queries.length)
    throw new Rejection("No aircraft or component search data is available.");
  const found = new Map<string, FaaCandidate>();
  for (const q of queries)
    mergeMonitoringCandidates(found, q, await searchDrs(key, q, request));
  return [...found.values()];
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

async function requestDrsPage(
  key: string,
  type: DrsType,
  body: object,
  request: typeof fetch,
) {
  const response = await request(`${DRS_DATA_PULL}${type}/filtered`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    redirect: "error",
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DRS_TIMEOUT_MS),
  });
  if (!response.ok)
    throw Error(
      response.status === 403 || response.status === 401
        ? "FAA rejected the API key. Request or renew the DRS key."
        : `FAA request failed (${response.status}). Try again later.`,
    );
  return parseDrsPage(await response.json());
}
