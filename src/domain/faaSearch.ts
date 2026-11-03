import { z } from "zod";
import { adNumber } from "./airworthiness";
import { fetchDrsFiltered, type FaaCandidate } from "./faa";
import type { Snapshot } from "./model";
const text = z.string().trim().max(200);
export const searchAssetSchema = z.object({
  id: z.string(),
  section: z.enum(["Airframe", "Engine", "Propeller", "Appliance"]),
  model: text,
  make: text,
  useMake: z.boolean(),
  keywords: text,
});
export const faaSearchSchema = z
  .object({
    aircraftUuid: z.string().min(1),
    assets: z.array(searchAssetSchema).min(1).max(20),
    finalRules: z.boolean(),
    emergency: z.boolean(),
    historical: z.boolean(),
    number: text,
    subject: text,
    productSubtype: text,
    amendment: text,
    docket: text,
    affectedAD: text,
    supersededBy: text,
    dateField: z.enum(["effective", "issued", "published"]),
    dateFrom: z.union([z.iso.date(), z.literal("")]),
    dateTo: z.union([z.iso.date(), z.literal("")]),
  })
  .superRefine((s, ctx) => {
    if (!s.finalRules && !s.emergency)
      ctx.addIssue({
        code: "custom",
        message: "Choose final rules or emergency ADs.",
      });
    if (!!s.dateFrom !== !!s.dateTo || s.dateFrom > s.dateTo)
      ctx.addIssue({
        code: "custom",
        message: "Enter both dates in chronological order.",
      });
    if (new Set(s.assets.map((a) => a.id)).size !== s.assets.length)
      ctx.addIssue({ code: "custom", message: "Duplicate search assets." });
  });
export type FaaSearchInput = z.infer<typeof faaSearchSchema>;
export type SearchAsset = z.infer<typeof searchAssetSchema> & {
  label: string;
  serial: string;
  partNumber: string;
};
export interface FaaSearchResult {
  candidate: FaaCandidate;
  assetIds: string[];
  documents: { url: string; emergency: boolean }[];
}
export function searchAssets(
  s: Pick<Snapshot, "aircraft" | "management">,
  aircraftUuid: string,
): SearchAsset[] {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!a) return [];
  return [
    {
      id: "",
      section: "Airframe",
      label: a.registration,
      serial: a.serial,
      partNumber: "",
      model: a.faaSearchModel?.trim() || a.model,
      make: a.make,
      useMake: false,
      keywords: "",
    },
    ...(s.management ?? [])
      .filter((c) => c.kind === "component")
      .filter((c) => c.installed && c.aircraftUuid === aircraftUuid)
      .map((c) => ({
        id: c.uuid,
        section: (/propeller/i.test(c.componentType)
          ? "Propeller"
          : /engine/i.test(c.componentType)
            ? "Engine"
            : "Appliance") as SearchAsset["section"],
        label: [c.componentType, c.installPosition].filter(Boolean).join(" · "),
        serial: c.serial,
        partNumber: c.partNumber,
        model: c.faaSearchModel?.trim() || c.model || "",
        make: c.manufacturer,
        useMake: false,
        keywords: c.faaSearchModel?.trim() || c.model ? "" : c.partNumber,
      })),
  ];
}
export function blankSearch(
  aircraftUuid: string,
  assets: SearchAsset[],
): FaaSearchInput {
  return {
    aircraftUuid,
    assets,
    finalRules: true,
    emergency: true,
    historical: false,
    number: "",
    subject: "",
    productSubtype: "",
    amendment: "",
    docket: "",
    affectedAD: "",
    supersededBy: "",
    dateField: "effective",
    dateFrom: "",
    dateTo: "",
  };
}
export function searchFilters(
  s: FaaSearchInput,
  a: FaaSearchInput["assets"][number],
  type: "ADFRAWD" | "ADFREAD",
) {
  const p = "drs:" + type.toLowerCase();
  const f: Record<string, string[]> = {
    "drs:status": s.historical ? ["Current", "Historical"] : ["Current"],
  };
  const add = (k: string, v: string) => {
    if (v.trim()) f[k] = [v.trim()];
  };
  add(p + "Model", a.model);
  if (a.useMake) add(p + "Make", a.make);
  add("Keyword", a.keywords);
  add("drs:documentNumber", s.number);
  add(p + "Subject", s.subject);
  add(
    p + (type === "ADFREAD" ? "ProductTypes" : "ProductType"),
    a.id === ""
      ? "Aircraft"
      : a.section === "Airframe"
        ? "Appliance"
        : a.section,
  );
  add(
    p + (type === "ADFREAD" ? "ProductSubTypes" : "ProductSubType"),
    s.productSubtype,
  );
  add(p + "Amendment", s.amendment);
  add(p + "DocketNo", s.docket);
  add(p + "AffectedAD", s.affectedAD);
  add(p + "SupersededBy", s.supersededBy);
  if (s.dateFrom && s.dateTo)
    f[
      s.dateField === "effective"
        ? "drs:effectiveDate"
        : p + (s.dateField === "issued" ? "IssueDate" : "CitationPublishDate")
    ] = [s.dateFrom, s.dateTo];
  if (!a.model && !a.keywords && !s.number)
    throw Error(
      "Each selected asset needs a model or keyword, or enter an AD number.",
    );
  if (Object.keys(f).length > 5)
    throw Error(
      "FAA allows five filters per search, including status. Remove some advanced fields or disable the manufacturer filter.",
    );
  return f;
}
export async function searchFAA(
  key: string,
  raw: FaaSearchInput,
  request: typeof fetch = fetch,
): Promise<FaaSearchResult[]> {
  const input = faaSearchSchema.parse(raw);
  const found = new Map<string, FaaSearchResult>();
  const queries = new Map<
    string,
    {
      type: "ADFRAWD" | "ADFREAD";
      filters: Record<string, string[]>;
      assets: string[];
    }
  >();
  for (const type of ["ADFRAWD", "ADFREAD"] as const) {
    if (type === "ADFRAWD" ? !input.finalRules : !input.emergency) continue;
    for (const asset of input.assets) {
      const filters = searchFilters(input, asset, type);
      const key = type + JSON.stringify(filters);
      const q = queries.get(key);
      if (q) q.assets.push(asset.id);
      else queries.set(key, { type, filters, assets: [asset.id] });
    }
  }
  for (const q of queries.values())
    for (const candidate of await fetchDrsFiltered(
      key,
      q.type,
      q.filters,
      request,
    )) {
      const key = adNumber(candidate.source.number);
      const old = found.get(key);
      if (old) {
        old.assetIds = [...new Set([...old.assetIds, ...q.assets])];
        if (!old.documents.some((d) => d.url === candidate.source.url))
          old.documents.push({
            url: candidate.source.url,
            emergency: candidate.emergency,
          });
        const rank = (c: FaaCandidate) =>
          (c.status.toLowerCase() === "current" ? 2 : 0) +
          (c.emergency ? 0 : 1);
        if (
          rank(candidate) > rank(old.candidate) ||
          (rank(candidate) === rank(old.candidate) &&
            candidate.modified > old.candidate.modified)
        )
          old.candidate = candidate;
      } else
        found.set(key, {
          candidate,
          assetIds: [...q.assets],
          documents: [
            { url: candidate.source.url, emergency: candidate.emergency },
          ],
        });
      if (found.size > 400)
        throw Error(
          "More than 400 ADs matched. Narrow your search; no partial results were imported.",
        );
    }
  return [...found.values()].sort(
    (a, b) =>
      (Date.parse(b.candidate.source.effective) ||
        Date.parse(b.candidate.source.issued) ||
        0) -
        (Date.parse(a.candidate.source.effective) ||
          Date.parse(a.candidate.source.issued) ||
          0) ||
      b.candidate.source.number.localeCompare(a.candidate.source.number),
  );
}
