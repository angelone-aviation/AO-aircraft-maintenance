/**
 * Responsibility: A Flight Program's named ship-to addresses: listing them
 *   with the program's inventory locations, and saving them.
 * Layer: Server. A public query for readers and a mutation for program
 *   administrators; every save is audited.
 * Dependencies: convex/access, convex/programContext, convex/userErrors,
 *   src/domain (programs, savedAddresses, management).
 */
import { audit } from "./access";
import { query, mutation, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { checkContext, managementDocs } from "./programContext";
import { exposeRejections } from "./userErrors";
import { programPermission } from "../src/domain/programs";
import {
  MAX_SAVED_ADDRESSES,
  parseAddressSave,
  saveAddress,
  savedAddressNameKey,
  type AddressChoices,
} from "../src/domain/savedAddresses";
import { locationSchema } from "../src/domain/management";

/**
 * The addresses a form can ship to in the program, saved entries sorted by
 * name. Location contacts (name, email, phone) and legacy text are blanked
 * for anyone but a program administrator.
 *
 * @param programUuid - The caller's active Flight Program.
 * @returns At most {@link MAX_SAVED_ADDRESSES} entries, and every location.
 * @throws {ConvexError} "Select a Flight Program." without one.
 * @throws As `checkContext`, first.
 */
export const list = query({
  args: { programUuid: v.string() },
  handler: async (ctx, { programUuid }): Promise<AddressChoices> => {
    const s = await checkContext(ctx, programUuid);
    if (!programUuid) throw new ConvexError("Select a Flight Program.");
    const entries = await ctx.db
      .query("savedAddresses")
      .withIndex("program", (q) => q.eq("programUuid", programUuid))
      .take(MAX_SAVED_ADDRESSES);
    const records = await managementDocs(ctx, programUuid);
    // Parts requesters pick ship-to entries; inventory location contacts stay
    // with program administrators, matching snapshot visibility of locations.
    const admin = programPermission(s, "admin");
    return {
      entries: entries
        .map(toSavedAddress)
        .sort((a, b) => a.name.localeCompare(b.name)),
      locations: records
        .filter((r) => r.programUuid === programUuid && r.kind === "location")
        .map((r) => toLocationChoice(r, admin)),
    };
  },
});

/**
 * Adds or edits a saved address as its next version, stored confirmed; audits
 * `address.saved` with the address before (for an edit) and after, which
 * program administrators read in Change history.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param payload - JSON, as `savedAddressInput`; `version` is the one edited.
 * @returns The address as saved.
 * @throws {ConvexError} After `checkContext`'s, the refusals of
 *   `parseAddressSave` (malformed JSON as an invalid entry) and then
 *   `saveAddress`, with their messages.
 */
export const save = mutation({
  args: { programUuid: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const input = exposeRejections(() =>
      parseAddressSave(s, args.programUuid, readJson(args.payload)),
    );
    const nameKey = savedAddressNameKey(input.name);
    const stored = await loadStored(ctx, args.programUuid, input.uuid, nameKey);
    const saved = exposeRejections(() =>
      saveAddress(args.programUuid, input, stored),
    );
    if (stored.previous)
      await ctx.db.replace(stored.previous._id, { ...saved, nameKey });
    else await ctx.db.insert("savedAddresses", { ...saved, nameKey });
    // The stored row is replaced, so the change log is the only place the
    // earlier ship-to details survive.
    await audit(ctx, s.user.id, "address.saved", input.uuid, {
      programUuid: args.programUuid,
      before: stored.previous ? toSavedAddress(stored.previous) : undefined,
      after: saved,
    });
    return saved;
  },
});

// The record without Convex's fields and the name lookup key.
function toSavedAddress({
  _id,
  _creationTime,
  nameKey: _nameKey,
  ...entry
}: Doc<"savedAddresses">) {
  return entry;
}

function toLocationChoice(
  record: Doc<"management">,
  admin: boolean,
): AddressChoices["locations"][number] {
  const location = locationSchema.parse(JSON.parse(record.payload));
  const { uuid, name, addressDetails } = location;
  if (admin || !addressDetails)
    return { uuid, name, address: addressDetails, legacy: location.address };
  return {
    uuid,
    name,
    address: { ...addressDetails, contactName: "", email: "", phone: "" },
    legacy: "",
  };
}

// Malformed JSON is an invalid entry like any other: parseAddressSave refuses
// `undefined` with the same summary, after its access checks.
function readJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function loadStored(
  ctx: QueryCtx,
  programUuid: string,
  uuid: string,
  nameKey: string,
) {
  const previous = await ctx.db
    .query("savedAddresses")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  const sameName = await ctx.db
    .query("savedAddresses")
    .withIndex("name", (q) =>
      q.eq("programUuid", programUuid).eq("nameKey", nameKey),
    )
    .unique();
  const kept = await ctx.db
    .query("savedAddresses")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .take(MAX_SAVED_ADDRESSES);
  return { previous, sameName, count: kept.length };
}
