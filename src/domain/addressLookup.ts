/**
 * Responsibility: Address suggestions from Geoapify for an address a person
 *   is typing: what may be sent, and how the reply is read.
 * Layer: Domain. Pure schemas and functions; no I/O, no React. The server
 *   makes the request (convex/addressVerification.ts).
 * Dependencies: zod, src/domain/addresses.ts (types).
 */
import { z } from "zod";
import type { Address } from "./addresses";

/** How many suggestions are asked for, and shown. */
export const ADDRESS_SUGGESTION_LIMIT = 5;

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
    .results.slice(0, ADDRESS_SUGGESTION_LIMIT)
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

function lookupField(label: string, maxLength: number) {
  return z
    .string()
    .trim()
    .max(
      maxLength,
      `${label} is too long to look up (up to ${maxLength.toLocaleString("en-US")} characters).`,
    );
}
