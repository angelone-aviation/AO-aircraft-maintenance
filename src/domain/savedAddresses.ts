import { z } from "zod";
import { addressSchema, addressIssues, type Address } from "./addresses";
export const savedAddressInput = z.object({
  uuid: z.string().min(1).max(200),
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1, "Enter an address name.").max(200),
  address: addressSchema,
});
export type SavedAddressInput = z.infer<typeof savedAddressInput>;
export type SavedAddress = SavedAddressInput & { programUuid: string };
export type AddressChoices = {
  entries: SavedAddress[];
  locations: {
    uuid: string;
    name: string;
    address?: Address;
    legacy: string;
  }[];
};
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
