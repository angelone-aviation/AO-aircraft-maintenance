/**
 * Responsibility: FAA AD searches for one aircraft: the form, the assets it
 *   covers, the DRS filters per asset, and the merged results.
 * Layer: Domain. Zod schemas and functions; `searchFAA` calls the FAA DRS API
 *   through ./faa (a known exception to the no-I/O rule, CONTEXT.md §5).
 * Dependencies: zod, ./airworthiness, ./faa, ./model, ./rejection.
 */
import { z } from "zod";
import { adNumber } from "./airworthiness";
import { fetchDrsFiltered, type FaaCandidate } from "./faa";
import type { Snapshot } from "./model";
import { Rejection } from "./rejection";

// FAA DRS limits: filters per request (status included), and the results one
// search may import.
const MAX_FILTERS = 5;
const MAX_RESULTS = 400;

type DocumentType = "ADFRAWD" | "ADFREAD";
// Final rules, then emergency ADs.
const DOCUMENT_TYPES: readonly DocumentType[] = ["ADFRAWD", "ADFREAD"];

const text = z.string().trim().max(200);

/**
 * One searched asset: the airframe (`id` "") or an installed component, with
 * the model, make and keywords sent to the FAA.
 *
 * @throws {z.ZodError} From `parse()` on text over 200 characters.
 */
export const searchAssetSchema = z.object({
  id: z.string(),
  section: z.enum(["Airframe", "Engine", "Propeller", "Appliance"]),
  model: text,
  make: text,
  useMake: z.boolean(),
  keywords: text,
});

/**
 * An AD search: 1–20 assets, the document types, and the optional fields
 * and date range shared by every asset.
 *
 * @throws {z.ZodError} From `parse()`, including "Choose final rules or
 *   emergency ADs.", "Enter both dates in chronological order." and
 *   "Duplicate search assets."
 */
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

/** A validated AD search. */
export type FaaSearchInput = z.infer<typeof faaSearchSchema>;

/** A searched asset with what the form shows about it. */
export type SearchAsset = z.infer<typeof searchAssetSchema> & {
  label: string;
  serial: string;
  partNumber: string;
};

/** One AD found, the assets it matched, and each FAA document for it. */
export interface FaaSearchResult {
  candidate: FaaCandidate;
  assetIds: string[];
  documents: { url: string; emergency: boolean }[];
}

/**
 * Lists the assets an aircraft's AD search covers: the airframe, then each
 * installed component. The FAA search model is used when set, else the
 * model; a component with neither searches by part number.
 *
 * @param s - The aircraft and the program's components.
 * @param aircraftUuid - The aircraft.
 * @returns The assets, airframe first, manufacturer filtering off; [] for an
 *   unknown aircraft.
 */
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
        section: faaSection(c.componentType),
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

/**
 * Starts a search form: current final rules and emergency ADs by effective
 * date, with no other fields set.
 *
 * @param aircraftUuid - The aircraft.
 * @param assets - The assets to search.
 * @returns The form.
 */
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

/**
 * Builds the DRS filters for one asset and document type. Blank fields are
 * left out; the airframe is searched as product type "Aircraft".
 *
 * @param s - The search.
 * @param a - The asset.
 * @param type - "ADFRAWD" (final rules) or "ADFREAD" (emergency ADs).
 * @returns The filters by DRS field name, status first.
 * @throws {Rejection} "Each selected asset needs a model or keyword, or enter
 *   an AD number." or "FAA allows five filters per search, …"
 */
export function searchFilters(
  s: FaaSearchInput,
  a: FaaSearchInput["assets"][number],
  type: DocumentType,
) {
  const p = "drs:" + type.toLowerCase();
  const emergency = type === "ADFREAD";
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
  add(p + (emergency ? "ProductTypes" : "ProductType"), productType(a));
  add(p + (emergency ? "ProductSubTypes" : "ProductSubType"), s.productSubtype);
  add(p + "Amendment", s.amendment);
  add(p + "DocketNo", s.docket);
  add(p + "AffectedAD", s.affectedAD);
  add(p + "SupersededBy", s.supersededBy);
  if (s.dateFrom && s.dateTo)
    f[dateFilterKey(s.dateField, p)] = [s.dateFrom, s.dateTo];
  if (!a.model && !a.keywords && !s.number)
    throw new Rejection(
      "Each selected asset needs a model or keyword, or enter an AD number.",
    );
  if (Object.keys(f).length > MAX_FILTERS)
    throw new Rejection(
      "FAA allows five filters per search, including status. Remove some advanced fields or disable the manufacturer filter.",
    );
  return f;
}

/**
 * Runs a search against FAA DRS, one request per distinct set of filters,
 * and merges the documents by AD number.
 *
 * @param key - The FAA DRS API key.
 * @param raw - The search.
 * @param request - The fetch to use.
 * @returns The ADs, newest effective (else issued) date first, then by AD
 *   number descending.
 * @throws {z.ZodError} On an invalid search.
 * @throws {Rejection} A {@link searchFilters} refusal, or "More than 400 ADs
 *   matched. …", in which case nothing is returned.
 */
export async function searchFAA(
  key: string,
  raw: FaaSearchInput,
  request: typeof fetch = fetch,
): Promise<FaaSearchResult[]> {
  const input = faaSearchSchema.parse(raw);
  const found = new Map<string, FaaSearchResult>();
  for (const q of groupQueries(input).values()) {
    const candidates = await fetchDrsFiltered(key, q.type, q.filters, request);
    mergeResults(found, candidates, q.assets);
  }
  return [...found.values()].sort(compareNewestFirst);
}

interface DrsQuery {
  type: DocumentType;
  filters: Record<string, string[]>;
  assets: string[];
}

function faaSection(componentType: string): SearchAsset["section"] {
  if (/propeller/i.test(componentType)) return "Propeller";
  if (/engine/i.test(componentType)) return "Engine";
  return "Appliance";
}

// A component filed under Airframe is searched as an appliance.
function productType(a: FaaSearchInput["assets"][number]) {
  if (a.id === "") return "Aircraft";
  return a.section === "Airframe" ? "Appliance" : a.section;
}

function dateFilterKey(field: FaaSearchInput["dateField"], p: string) {
  if (field === "effective") return "drs:effectiveDate";
  return p + (field === "issued" ? "IssueDate" : "CitationPublishDate");
}

// Assets with identical filters share one request.
function groupQueries(input: FaaSearchInput) {
  const queries = new Map<string, DrsQuery>();
  for (const type of DOCUMENT_TYPES) {
    if (type === "ADFRAWD" ? !input.finalRules : !input.emergency) continue;
    for (const asset of input.assets) {
      const filters = searchFilters(input, asset, type);
      const id = type + JSON.stringify(filters);
      const q = queries.get(id);
      if (q) q.assets.push(asset.id);
      else queries.set(id, { type, filters, assets: [asset.id] });
    }
  }
  return queries;
}

function mergeResults(
  found: Map<string, FaaSearchResult>,
  candidates: FaaCandidate[],
  assets: string[],
) {
  for (const candidate of candidates) {
    const id = adNumber(candidate.source.number);
    const old = found.get(id);
    if (old) mergeCandidate(old, candidate, assets);
    else
      found.set(id, {
        candidate,
        assetIds: [...assets],
        documents: [
          { url: candidate.source.url, emergency: candidate.emergency },
        ],
      });
    if (found.size > MAX_RESULTS)
      throw new Rejection(
        "More than 400 ADs matched. Narrow your search; no partial results were imported.",
      );
  }
}

// One AD can come back as a final rule and an emergency AD: keep every
// document, and show a current one before a historical one, then a final rule
// before an emergency AD, then the latest modified.
function mergeCandidate(
  old: FaaSearchResult,
  candidate: FaaCandidate,
  assets: string[],
) {
  old.assetIds = [...new Set([...old.assetIds, ...assets])];
  if (!old.documents.some((d) => d.url === candidate.source.url))
    old.documents.push({
      url: candidate.source.url,
      emergency: candidate.emergency,
    });
  const better = rankCandidate(candidate) - rankCandidate(old.candidate);
  if (
    better > 0 ||
    (better === 0 && candidate.modified > old.candidate.modified)
  )
    old.candidate = candidate;
}

function rankCandidate(c: FaaCandidate) {
  return (c.status.toLowerCase() === "current" ? 2 : 0) + (c.emergency ? 0 : 1);
}

function compareNewestFirst(a: FaaSearchResult, b: FaaSearchResult) {
  return (
    publishedAt(b) - publishedAt(a) ||
    b.candidate.source.number.localeCompare(a.candidate.source.number)
  );
}

function publishedAt(r: FaaSearchResult) {
  const source = r.candidate.source;
  return Date.parse(source.effective) || Date.parse(source.issued) || 0;
}
