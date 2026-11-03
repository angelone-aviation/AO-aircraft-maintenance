import { z } from "zod";
import type { Address } from "./addresses";
export const addressLookupSchema = z.object({
  street: z.string().trim().min(1).max(2000),
  city: z.string().trim().max(300),
  region: z.string().trim().max(300),
  postalCode: z.string().trim().max(100),
  country: z.string().trim().min(1).max(150),
});
export type AddressLookupInput = z.infer<typeof addressLookupSchema>;
export interface AddressSuggestion {
  formatted: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  confidence: number;
  matchLevel: string;
  attribution: string;
}
export function lookupInput(a: Address): AddressLookupInput {
  return addressLookupSchema.parse({
    street: a.street,
    city: a.city,
    region: a.region,
    postalCode: a.postalCode,
    country: a.country,
  });
}
const resultSchema = z.object({
  results: z.array(
    z.object({
      formatted: z.string(),
      housenumber: z.string().optional(),
      street: z.string().optional(),
      city: z.string().optional(),
      town: z.string().optional(),
      village: z.string().optional(),
      state: z.string().optional(),
      state_code: z.string().optional(),
      postcode: z.string().optional(),
      country: z.string().optional(),
      result_type: z.string().optional(),
      rank: z
        .object({ confidence: z.number().min(0).max(1).optional() })
        .optional(),
      datasource: z.object({ attribution: z.string().optional() }).optional(),
    }),
  ),
});
export function parseAddressSuggestions(raw: unknown): AddressSuggestion[] {
  return resultSchema
    .parse(raw)
    .results.slice(0, 5)
    .map((r) => ({
      formatted: r.formatted,
      street: [r.housenumber, r.street].filter(Boolean).join(" "),
      city: r.city ?? r.town ?? r.village ?? "",
      region: r.state_code ?? r.state ?? "",
      postalCode: r.postcode ?? "",
      country: r.country ?? "",
      confidence: r.rank?.confidence ?? 0,
      matchLevel: r.result_type ?? "unknown",
      attribution: r.datasource?.attribution ?? "© OpenStreetMap contributors",
    }));
}
export async function fetchAddressSuggestions(
  input: AddressLookupInput,
  key: string,
): Promise<AddressSuggestion[]> {
  const a = addressLookupSchema.parse(input);
  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.search = new URLSearchParams({
    text: [a.street, a.city, a.region, a.postalCode, a.country]
      .filter(Boolean)
      .join(", "),
    format: "json",
    limit: "5",
    lang: "en",
    bias: "countrycode:none",
    apiKey: key,
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    throw Error(
      "Address lookup could not connect. Your address has not been changed.",
    );
  }
  if (!response.ok)
    throw Error(
      response.status === 401 || response.status === 403
        ? "The Geoapify key was not accepted. Ask a system administrator to check Address verification in Settings → System."
        : response.status === 429
          ? "Address lookup quota reached. Try again later."
          : "The address service is unavailable. Your address has not been changed.",
    );
  try {
    return parseAddressSuggestions(await response.json());
  } catch {
    throw Error(
      "The address service returned an unexpected response. Your address has not been changed.",
    );
  }
}
