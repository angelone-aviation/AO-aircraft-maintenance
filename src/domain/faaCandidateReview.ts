import { adAircraftUuid, adNumber, type AD } from "./airworthiness";
import type { FaaCandidate } from "./faa";
import type { Snapshot } from "./model";
import { searchAssets } from "./faaSearch";

type Scope = Pick<Snapshot, "aircraft" | "management" | "airworthiness">;
function sameSource(c: FaaCandidate, r: AD) {
  // Recurrence and section may be set by the reviewer; neither is evidence of an FAA revision.
  const normalize = (v: string) => v.trim().replace(/\s+/g, " ");
  const fields = [
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
  if (!fields.every((k) => normalize(c.source[k]) === normalize(r.source[k])))
    return false;
  if (r.source.faaModified !== undefined)
    return r.source.faaModified === c.modified;
  // Older imports did not retain FAA's modification timestamp.
  const modified = Date.parse(c.modified);
  return !Number.isFinite(modified) || modified <= r.updatedAt;
}
export function monitoringReviewCandidates(
  s: Scope,
  aircraftUuid: string,
  candidates: FaaCandidate[],
) {
  const records = (s.airworthiness ?? []).filter(
    (r) => adAircraftUuid(s, r) === aircraftUuid,
  );
  const assets = searchAssets(s, aircraftUuid);
  return candidates.filter((c) => {
    const matching = records.filter(
      (r) => adNumber(r.source.number) === adNumber(c.source.number),
    );
    if (!matching.length) return true;
    const models = c.source.model
      .split(/[,;]/)
      .map((x) => x.trim().toUpperCase());
    const sectionAssets = assets.filter((a) => a.section === c.source.section);
    const modelAssets = assets.filter((a) =>
      models.includes(a.model.toUpperCase()),
    );
    const targetIds = c.matchedAssetIds?.length
      ? c.matchedAssetIds
      : (modelAssets.length ? modelAssets : sectionAssets).map((a) => a.id);
    if (!targetIds.length) return true;
    // Suppress only when every matching asset already has the same AD revision/source.
    return !targetIds.every((id) =>
      matching.some((r) => r.componentUuid === id && sameSource(c, r)),
    );
  });
}
