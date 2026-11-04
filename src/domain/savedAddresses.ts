/**
 * Responsibility: A Flight Program's named ship-to addresses, the rules for
 *   saving one, and the address choices a form offers.
 * Layer: Domain. Pure zod schema and functions; no I/O, no React.
 * Dependencies: zod, src/domain/addresses.ts, src/domain/model.ts,
 *   src/domain/programs.ts, src/domain/rejection.ts.
 */
import { z } from "zod";
import { addressSchema, addressIssues, type Address } from "./addresses";
import type { Snapshot } from "./model";
import { programPermission } from "./programs";
import { Rejection } from "./rejection";

/** Most saved addresses one Flight Program keeps. */
export const MAX_SAVED_ADDRESSES = 200;

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
 * @throws {Rejection} The {@link addressIssues} messages joined with spaces,
 *   when the address is not complete enough to ship to.
 */
export function prepareSavedAddress(
  input: SavedAddressInput,
): SavedAddressInput {
  const parsed = savedAddressInput.parse(input);
  const issues = addressIssues(parsed.address);
  if (issues.length) throw new Rejection(issues.join(" "));
  return {
    ...parsed,
    address: { ...parsed.address, addressName: parsed.name, confirmed: true },
  };
}

/** The stored addresses a save is checked against. */
export interface StoredAddresses {
  /** The address with the entry's uuid, in any Flight Program. */
  previous: SavedAddress | null;
  /** The program's address with the entry's {@link savedAddressNameKey}. */
  sameName: SavedAddress | null;
  /** How many addresses the program keeps, counted up to the maximum. */
  count: number;
}

/**
 * The key under which names that differ only in case collide.
 *
 * @param name - A parsed entry's name.
 */
export function savedAddressNameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Reads an entry for saving, once the caller may save addresses.
 *
 * @param s - The snapshot, for the caller's program permission.
 * @param programUuid - The Flight Program the address is saved in.
 * @param raw - The entry, as {@link savedAddressInput}.
 * @returns The entry as {@link prepareSavedAddress} stores it.
 * @throws {Rejection} In order: "Select a Flight Program."; "Flight Program
 *   administrator required."; one summary, "Enter an address name and
 *   complete …", for any invalid or incomplete entry.
 */
export function parseAddressSave(
  s: Snapshot,
  programUuid: string,
  raw: unknown,
): SavedAddressInput {
  if (!programUuid) throw new Rejection("Select a Flight Program.");
  if (!programPermission(s, "admin"))
    throw new Rejection("Flight Program administrator required.");
  try {
    return prepareSavedAddress(savedAddressInput.parse(raw));
  } catch (error) {
    // The form lists each field's issue before it saves (addressIssues), so
    // a refused entry gets one summary.
    if (error instanceof z.ZodError || error instanceof Rejection)
      throw new Rejection(
        "Enter an address name and complete the recipient name, address, email and phone fields.",
      );
    throw error;
  }
}

/**
 * Checks a read entry against the stored addresses.
 *
 * @param programUuid - The Flight Program the address is saved in.
 * @param input - The entry from {@link parseAddressSave}; `version` is the
 *   one edited, 0 for a new address.
 * @param stored - What is stored under its uuid and name.
 * @returns The address to store, as its next version.
 * @throws {Rejection} In order: "Address not found in this Flight Program.";
 *   "Address changed. Reopen it before saving."; "An address with this name
 *   already exists …"; "A Flight Program can keep up to 200 …" for a new
 *   address.
 */
export function saveAddress(
  programUuid: string,
  input: SavedAddressInput,
  stored: StoredAddresses,
): SavedAddress {
  const { previous, sameName } = stored;
  if (previous && previous.programUuid !== programUuid)
    throw new Rejection("Address not found in this Flight Program.");
  if ((previous?.version ?? 0) !== input.version)
    throw new Rejection("Address changed. Reopen it before saving.");
  if (sameName && sameName.uuid !== input.uuid)
    throw new Rejection(
      "An address with this name already exists in this program. Select it or use another name.",
    );
  if (!previous && stored.count >= MAX_SAVED_ADDRESSES)
    throw new Rejection(
      `A Flight Program can keep up to ${MAX_SAVED_ADDRESSES} saved addresses. Edit an existing address instead.`,
    );
  return { ...input, version: input.version + 1, programUuid };
}
