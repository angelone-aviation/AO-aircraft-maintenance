/**
 * Responsibility: Address suggestions from Geoapify for an address a person
 *   is typing: what is sent, the request, and how the reply is read.
 * Layer: Domain, except that fetchAddressSuggestions does network I/O
 *   (CONTEXT.md §5).
 * Dependencies: zod, src/domain/addresses.ts (types).
 */
import { z } from "zod";
import type { Address } from "./addresses";

const GEOAPIFY_SEARCH_URL = "https://api.geoapify.com/v1/geocode/search";
const SUGGESTION_LIMIT = 5;
const LOOKUP_TIMEOUT_MS = 15000;

/**
 * The physical address fields sent to Geoapify, trimmed.
 *
 * @throws {z.ZodError} From `parse()`: "Enter a street address to look up.",
 *   "Enter a country to look up.", or "<Field> is too long to look up (up to
 *   N characters)." Postal code (100) and country (150) are capped below the
 *   300 characters an {@link Address} may store.
 */
export const addressLookupSchema = z.object({
  street: lookupField("Street address", 2000).min(
    1,
    "Enter a street address to look up.",
  ),
  city: lookupField("City", 300),
  region: lookupField("State / province", 300),
  postalCode: lookupField("ZIP / postal code", 100),
  country: lookupField("Country", 150).min(1, "Enter a country to look up."),
});

/** A parsed {@link addressLookupSchema} input. */
export type AddressLookupInput = z.infer<typeof addressLookupSchema>;

/**
 * A candidate address for a person to accept or ignore. `confidence` runs
 * from 0 to 1; `matchLevel` is Geoapify's result type, such as "city".
 */
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

/**
 * Picks what may be sent to the address service: the physical fields only,
 * never the contact's name, email or phone.
 *
 * @param address - The address being entered.
 * @returns The lookup input.
 * @throws {z.ZodError} When the fields fail {@link addressLookupSchema}.
 */
export function lookupInput(address: Address): AddressLookupInput {
  return addressLookupSchema.parse({
    street: address.street,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
  });
}

// Geoapify's JSON reply; only the fields read below are checked.
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

/**
 * Reads Geoapify's reply as suggestions.
 *
 * @param raw - The reply body, untrusted.
 * @returns The first five results in Geoapify's order. Missing parts become
 *   "" (city falls back to town, then village; region prefers the state code),
 *   confidence 0, match level "unknown", and OpenStreetMap's credit.
 * @throws {z.ZodError} When the body is not shaped like Geoapify's reply.
 */
export function parseAddressSuggestions(raw: unknown): AddressSuggestion[] {
  return resultSchema
    .parse(raw)
    .results.slice(0, SUGGESTION_LIMIT)
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

/**
 * Asks Geoapify for addresses matching the input.
 *
 * @param input - The fields from {@link lookupInput}.
 * @param key - The Geoapify API key; no error message contains it.
 * @returns Suggestions as {@link parseAddressSuggestions} reads them.
 * @throws {z.ZodError} When the input fails {@link addressLookupSchema}.
 * @throws {Error} "Address lookup could not connect. …" on a network failure
 *   or after 15 seconds; "The Geoapify key was not accepted. …" on HTTP 401
 *   or 403; "Address lookup quota reached. …" on 429; "The address service
 *   is unavailable. …" on any other HTTP error; "The address service returned
 *   an unexpected response. …" when the reply cannot be read.
 */
export async function fetchAddressSuggestions(
  input: AddressLookupInput,
  key: string,
): Promise<AddressSuggestion[]> {
  const url = buildSearchUrl(addressLookupSchema.parse(input), key);
  const response = await requestSuggestions(url);
  if (!response.ok) throw Error(describeHttpFailure(response.status));
  try {
    return parseAddressSuggestions(await response.json());
  } catch {
    throw Error(
      "The address service returned an unexpected response. Your address has not been changed.",
    );
  }
}

function buildSearchUrl(input: AddressLookupInput, key: string): URL {
  const url = new URL(GEOAPIFY_SEARCH_URL);
  url.search = new URLSearchParams({
    text: [
      input.street,
      input.city,
      input.region,
      input.postalCode,
      input.country,
    ]
      .filter(Boolean)
      .join(", "),
    format: "json",
    limit: String(SUGGESTION_LIMIT),
    lang: "en",
    bias: "countrycode:none",
    apiKey: key,
  }).toString();
  return url;
}

async function requestSuggestions(url: URL): Promise<Response> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    // The network error can quote the request URL, and with it the key.
    throw Error(
      "Address lookup could not connect. Your address has not been changed.",
    );
  }
}

function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403)
    return "The Geoapify key was not accepted. Ask a system administrator to check Address verification in Settings → System.";
  if (status === 429) return "Address lookup quota reached. Try again later.";
  return "The address service is unavailable. Your address has not been changed.";
}

function lookupField(label: string, maxLength: number) {
  return z
    .string()
    .trim()
    .max(
      maxLength,
      `${label} is too long to look up (up to ${maxLength.toLocaleString("en-US")} characters).`,
    );
}
