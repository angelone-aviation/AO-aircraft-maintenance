import type { Snapshot } from "./model";
import { adAircraftUuid } from "./airworthiness";
import { blankSearch, searchAssets, searchFilters } from "./faaSearch";
import { fetchDrsFiltered, type FaaCandidate } from "./faa";

type Scope = Pick<Snapshot, "aircraft" | "management" | "airworthiness">;
export function monitoringQueries(
  s: Scope,
  aircraftUuid: string,
  extra: string[] = [],
) {
  const assets = searchAssets(s, aircraftUuid);
  const form = blankSearch(aircraftUuid, assets);
  const queries: {
    type: "ADFRAWD" | "ADFREAD";
    filters: Record<string, string[]>;
    label: string;
    assetIds: string[];
  }[] = [];
  const numbers = [
    ...new Set(
      (s.airworthiness ?? [])
        .filter((r) => adAircraftUuid(s, r) === aircraftUuid)
        .map((r) => r.source.number),
    ),
  ];
  for (const type of ["ADFRAWD", "ADFREAD"] as const) {
    for (const asset of assets) {
      // Do not silently skip incomplete profiles or declare partial coverage successful.
      if (!asset.model && !asset.keywords)
        throw Error(
          `${asset.label}: enter a model, FAA search model, or component part number before checking.`,
        );
      queries.push({
        type,
        assetIds: [asset.id],
        filters: searchFilters(form, asset, type),
        label: `${asset.label}: ${asset.id ? asset.section : "Aircraft"} ${asset.model || asset.keywords}`,
      });
    }
    for (let i = 0; i < numbers.length; i += 10)
      queries.push({
        type,
        filters: {
          "drs:documentNumber": numbers.slice(i, i + 10),
          "drs:status": ["Current", "Historical"],
        },
        assetIds: [],
        label: `Tracked ADs: ${numbers.slice(i, i + 10).join(", ")}`,
      });
    for (const keyword of [
      ...new Set(extra.map((x) => x.trim()).filter(Boolean)),
    ])
      queries.push({
        type,
        filters: { Keyword: [keyword], "drs:status": ["Current"] },
        assetIds: [],
        label: `Additional keyword: ${keyword}`,
      });
  }
  const unique = new Map<string, (typeof queries)[number]>();
  for (const q of queries) {
    const key = q.type + JSON.stringify(q.filters);
    const old = unique.get(key);
    unique.set(
      key,
      old
        ? { ...q, assetIds: [...new Set([...old.assetIds, ...q.assetIds])] }
        : q,
    );
  }
  return [...unique.values()];
}
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
    return [e instanceof Error ? e.message : "Incomplete aircraft search data"];
  }
}
export async function fetchMonitoringCandidates(
  key: string,
  queries: ReturnType<typeof monitoringQueries>,
  request: typeof fetch = fetch,
) {
  if (!queries.length)
    throw Error("No aircraft or component search data is available.");
  const found = new Map<string, FaaCandidate>();
  for (const q of queries) {
    try {
      for (const c of await fetchDrsFiltered(key, q.type, q.filters, request)) {
        const ids = [
          ...new Set([
            ...(found.get(c.id)?.matchedAssetIds ?? []),
            ...q.assetIds,
          ]),
        ];
        found.set(c.id, {
          ...c,
          matchedAssetIds: ids.length ? ids : undefined,
        });
      }
      if (found.size > 400)
        throw Error(
          "More than 400 documents across monitoring searches. Narrow additional keywords before checking again.",
        );
    } catch (e) {
      throw Error(
        `${q.label}: ${e instanceof Error ? e.message : "FAA request failed"}`,
      );
    }
  }
  return [...found.values()];
}
