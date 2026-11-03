import { z } from "zod";
import { adSourceSchema, type ADSource } from "./airworthiness";
import type { Snapshot } from "./model";
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
export const faaMonitorSchema = z.object({
  aircraftUuid: z.string(),
  enabled: z.boolean(),
  terms: z.array(z.string().trim().min(2).max(100)).max(30),
  lastAttempt: z.number().optional(),
  lastSuccess: z.number().optional(),
  error: z.string(),
  runId: z.string(),
  candidates: z.array(faaCandidateSchema).max(400),
  checkedTerms: z.array(z.string()).optional(),
});
export type FaaMonitor = z.infer<typeof faaMonitorSchema>;
export type FaaCandidate = z.infer<typeof faaCandidateSchema>;
export const faaCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("configure"),
    aircraftUuid: z.string(),
    enabled: z.boolean(),
    terms: z.array(z.string().trim().min(2).max(100)).max(30),
  }),
  z.object({ kind: z.literal("check"), aircraftUuid: z.string() }),
  z.object({
    kind: z.literal("review"),
    aircraftUuid: z.string(),
    id: z.string(),
    reason: z.string().trim().min(1).max(2000),
  }),
]);
export type FaaCommand = z.infer<typeof faaCommandSchema>;
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
export function faaSearchTerms(
  s: Pick<Snapshot, "aircraft" | "management" | "airworthiness">,
  aircraftUuid: string,
  extra: string[] = [],
) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  const components = (s.management ?? [])
    .filter((c) => c.kind === "component")
    .filter((c) => c.aircraftUuid === aircraftUuid && c.installed);
  return [
    ...new Set(
      [
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
        .filter((x): x is string => !!x && x.length >= 2),
    ),
  ];
}
const value = (d: Record<string, unknown>, key: string) => {
  const v = d[key];
  return v === undefined || v === null || v === "_EMPTY_"
    ? ""
    : Array.isArray(v)
      ? v.filter((x) => x !== "_EMPTY_").join(", ")
      : String(v);
};
export function drsCandidate(
  d: Record<string, unknown>,
  type: "ADFRAWD" | "ADFREAD",
): FaaCandidate {
  const prefix = "drs:" + type.toLowerCase();
  const number = value(d, "drs:documentNumber");
  const id = value(d, "documentGuid");
  if (!id || !number)
    throw Error(
      "FAA returned an AD without an identifier. Check was not completed.",
    );
  const product =
    value(d, prefix + "ProductType") + value(d, prefix + "ProductTypes");
  const section: ADSource["section"] = /engine/i.test(product)
    ? "Engine"
    : /propeller/i.test(product)
      ? "Propeller"
      : /appliance/i.test(product)
        ? "Appliance"
        : "Airframe";
  const rawUrl = value(d, "documentURL");
  const url = rawUrl.startsWith("https://drs.faa.gov/")
    ? rawUrl
    : "https://drs.faa.gov/browse/" + type + "/doctypeDetails";
  return faaCandidateSchema.parse({
    id: type + ":" + id,
    modified: value(d, "docLastModifiedDate"),
    emergency: type === "ADFREAD",
    status: value(d, "drs:status"),
    reviewReason: "",
    source: {
      number,
      faaModified: value(d, "docLastModifiedDate"),
      amendment: value(d, prefix + "Amendment"),
      issued: value(d, prefix + "IssueDate"),
      effective: value(d, "drs:effectiveDate"),
      subject: (value(d, prefix + "Subject") || value(d, "drs:title")).slice(
        0,
        2000,
      ),
      recurring: "Unknown",
      supersededBy: value(d, prefix + "SupersededBy"),
      url,
      source: "FAA DRS " + type,
      section,
      make: value(d, prefix + "Make"),
      model: value(d, prefix + "Model"),
      sourceNotes: (
        "Status: " +
        value(d, "drs:status") +
        "\nSupersedes: " +
        value(d, prefix + "SupersededAD") +
        "\nAffected ADs: " +
        value(d, prefix + "AffectedAD")
      ).slice(0, 2000),
    },
  });
}
export async function fetchDrsFiltered(
  key: string,
  type: "ADFRAWD" | "ADFREAD",
  filters: Record<string, string[]>,
  request: typeof fetch = fetch,
): Promise<FaaCandidate[]> {
  const found = new Map<string, FaaCandidate>();
  let offset = 0;
  let complete = false;
  for (let page = 0; page < 20; page++) {
    const response = await request(
      `https://drs.faa.gov/api/drs/data-pull/${type}/filtered`,
      {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        redirect: "error",
        body: JSON.stringify({
          offset,
          sortOrder: "ASC",
          documentFilters: filters,
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw Error(
        response.status === 403 || response.status === 401
          ? "FAA rejected the API key. Request or renew the DRS key."
          : `FAA request failed (${response.status}). Try again later.`,
      );
    const body: unknown = await response.json();
    const parsed = z
      .object({
        summary: z.object({ hasMoreItems: z.boolean() }),
        documents: z.array(z.record(z.string(), z.unknown())),
      })
      .safeParse(body);
    if (!parsed.success)
      throw Error("Unexpected FAA response. Check was not completed.");
    for (const doc of parsed.data.documents) {
      const c = drsCandidate(doc, type);
      found.set(c.id, c);
      if (found.size > 400)
        throw Error(
          "More than 400 matching documents. Narrow the aircraft/component search terms.",
        );
    }
    if (!parsed.data.summary.hasMoreItems) {
      complete = true;
      break;
    }
    if (!parsed.data.documents.length)
      throw Error("FAA pagination stalled. Check was not completed.");
    offset += parsed.data.documents.length;
  }
  if (!complete)
    throw Error(
      "FAA results exceeded the page limit. Check was not completed.",
    );
  return [...found.values()];
}
export async function fetchDrsCandidates(
  key: string,
  terms: string[],
  request: typeof fetch = fetch,
): Promise<FaaCandidate[]> {
  if (!terms.length)
    throw Error(
      "Add an aircraft model, component model, or search term first.",
    );
  const found = new Map<string, FaaCandidate>();
  for (const type of ["ADFRAWD", "ADFREAD"] as const)
    for (let start = 0; start < terms.length; start += 10) {
      for (const c of await fetchDrsFiltered(
        key,
        type,
        { Keyword: terms.slice(start, start + 10) },
        request,
      ))
        found.set(c.id, c);
      if (found.size > 400)
        throw Error(
          "More than 400 matching documents. Narrow the aircraft/component search terms.",
        );
    }
  return [...found.values()];
}
export function mergeCandidates(old: FaaCandidate[], incoming: FaaCandidate[]) {
  const map = new Map(old.map((c) => [c.id, c]));
  for (const c of incoming) {
    const prior = map.get(c.id);
    map.set(
      c.id,
      prior &&
        prior.modified === c.modified &&
        JSON.stringify(prior.source) === JSON.stringify(c.source) &&
        prior.status === c.status
        ? prior
        : c,
    );
  }
  if (map.size > 400)
    throw Error(
      "Monitoring history reached 400 documents; narrow the monitoring scope before continuing.",
    );
  return [...map.values()];
}
