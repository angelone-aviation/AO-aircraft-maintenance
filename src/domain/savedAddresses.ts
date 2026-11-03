/**
 * Responsibility: A Flight Program's named ship-to addresses, the check they
 *   pass before saving, and the address choices a form offers.
 * Layer: Domain. Pure zod schema and function; no I/O, no React.
 * Dependencies: zod, src/domain/addresses.ts.
 */
import { z } from "zod";
import { addressSchema, addressIssues, type Address } from "./addresses";

/**
 * A saved address as an administrator submits it. Trims the name.
 *
 * @throws {z.ZodError} From `parse()` on a malformed entry or an invalid
 *   address; "Enter an address name." for a blank name.
 */
export const savedAddressInput = z.object({
  uuid: z.string().min(1).max(200),
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1, "Enter an address name.").max(200),
  address: addressSchema,
});

/** A parsed {@link savedAddressInput} entry. */
export type SavedAddressInput = z.infer<typeof savedAddressInput>;

/** A saved address as stored, in the Flight Program that owns it. */
export type SavedAddress = SavedAddressInput & { programUuid: string };

/**
 * The addresses a form can ship to: the program's saved addresses, and its
 * inventory locations with their structured address or legacy text.
 */
export type AddressChoices = {
  entries: SavedAddress[];
  locations: {
    uuid: string;
    name: string;
    address?: Address;
    legacy: string;
  }[];
};

/**
 * Readies a saved address for storage. Saving it counts as a person's review,
 * so the address is stored confirmed.
 *
 * @param input - The entry as submitted.
 * @returns The parsed entry, its address named after the entry and confirmed.
 * @throws {z.ZodError} When the entry fails {@link savedAddressInput}.
 * @throws {Error} The {@link addressIssues} messages joined with spaces, when
 *   the address is not complete enough to ship to.
 */
export function prepareSavedAddress(
  input: SavedAddressInput,
): SavedAddressInput {
  const parsed = savedAddressInput.parse(input);
  const issues = addressIssues(parsed.address);
  if (issues.length) throw Error(issues.join(" "));
  return {
    ...parsed,
    address: { ...parsed.address, addressName: parsed.name, confirmed: true },
  };
}
