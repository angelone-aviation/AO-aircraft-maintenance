/**
 * Responsibility: Decides which FAA AD candidates an aircraft's reviewer still
 *   has to see, hiding ADs already imported from the same FAA source.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./airworthiness, ./faa (types), ./model (types), ./faaSearch.
 */
import { adAircraftUuid, adNumber, type AD } from "./airworthiness";
import type { FaaCandidate } from "./faa";
import type { Snapshot } from "./model";
import { searchAssets, type SearchAsset } from "./faaSearch";

type Scope = Pick<Snapshot, "aircraft" | "management" | "airworthiness">;

// Recurrence and section may be set by the reviewer; neither is evidence of an
// FAA revision.
const FAA_SOURCE_FIELDS = [
  "amendment",
  "issued",
  "effective",
  "subject",
  "supersededBy",
  "url",
  "source",
  "make",
  "model",
  "sourceNotes",
] as const;

/**
 * Keeps the candidates the reviewer must still decide for one aircraft. One is
 * hidden only when each asset it targets has a record of the same AD number
 * from the same FAA source; local decisions such as applicability don't count.
 * Its targets are its matched assets, else the assets of a model it lists,
 * else those of its section; a candidate with no target is kept.
 *
 * @param s - The aircraft, the program's components and AD records.
 * @param aircraftUuid - The aircraft under review.
 * @param candidates - Candidates from the FAA search.
 * @returns The candidates still to review, in the given order.
 */
export function monitoringReviewCandidates(
  s: Scope,
  aircraftUuid: string,
  candidates: FaaCandidate[],
): FaaCandidate[] {
  const records = (s.airworthiness ?? []).filter(
    (r) => adAircraftUuid(s, r) === aircraftUuid,
  );
  const assets = searchAssets(s, aircraftUuid);
  return candidates.filter((c) => !isAlreadyImported(c, records, assets));
}

function isAlreadyImported(
  c: FaaCandidate,
  records: AD[],
  assets: SearchAsset[],
): boolean {
  const matching = records.filter(
    (r) => adNumber(r.source.number) === adNumber(c.source.number),
  );
  if (!matching.length) return false;
  const targetIds = targetAssetIds(c, assets);
  if (!targetIds.length) return false;
  return targetIds.every((id) =>
    matching.some((r) => r.componentUuid === id && sameSource(c, r)),
  );
}

function targetAssetIds(c: FaaCandidate, assets: SearchAsset[]): string[] {
  if (c.matchedAssetIds?.length) return c.matchedAssetIds;
  const models = c.source.model
    .split(/[,;]/)
    .map((x) => x.trim().toUpperCase());
  const modelAssets = assets.filter((a) =>
    models.includes(a.model.toUpperCase()),
  );
  const sectionAssets = assets.filter((a) => a.section === c.source.section);
  return (modelAssets.length ? modelAssets : sectionAssets).map((a) => a.id);
}

function sameSource(c: FaaCandidate, r: AD): boolean {
  const normalize = (v: string) => v.trim().replace(/\s+/g, " ");
  const sameFields = FAA_SOURCE_FIELDS.every(
    (k) => normalize(c.source[k]) === normalize(r.source[k]),
  );
  if (!sameFields) return false;
  if (r.source.faaModified !== undefined)
    return r.source.faaModified === c.modified;
  // Older imports did not keep FAA's modification time: an unreadable or
  // earlier one counts as the same revision.
  const modified = Date.parse(c.modified);
  return !Number.isFinite(modified) || modified <= r.updatedAt;
}
