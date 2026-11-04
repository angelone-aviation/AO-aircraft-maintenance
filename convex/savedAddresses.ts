/**
 * Responsibility: A Flight Program's named ship-to addresses: listing them
 *   with the program's inventory locations, and saving them.
 * Layer: Server. A public query for readers and a mutation for program
 *   administrators; every save is audited.
 * Dependencies: convex/access, convex/programContext, src/domain (programs,
 *   savedAddresses, management).
 */
import { writeAudit } from "./access";
import {
  query,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { checkContext, managementDocs } from "./programContext";
import { programPermission } from "../src/domain/programs";
import {
  prepareSavedAddress,
  savedAddressInput,
  type AddressChoices,
  type SavedAddressInput,
} from "../src/domain/savedAddresses";
import { locationSchema } from "../src/domain/management";

const MAX_SAVED_ADDRESSES = 200;

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
        .map(({ _id, _creationTime, nameKey: _nameKey, ...entry }) => entry)
        .sort((a, b) => a.name.localeCompare(b.name)),
      locations: records
        .filter((r) => r.programUuid === programUuid && r.kind === "location")
        .map((r) => toLocationChoice(r, admin)),
    };
  },
});

/**
 * Adds or edits a saved address as its next version, stored confirmed; audits
 * `address.saved`.
 *
 * @param programUuid - The caller's active Flight Program.
 * @param payload - JSON, as `savedAddressInput`; `version` is the one edited.
 * @returns The address as saved.
 * @throws {ConvexError} After `checkContext`'s, in order: "Select a Flight
 *   Program."; "Flight Program administrator required."; "Enter an address
 *   name and complete …" for any invalid entry; "Address not found in this
 *   Flight Program."; "Address changed. Reopen it before saving."; "An address
 *   with this name already exists …" (ignoring case); "A Flight Program can
 *   keep up to 200 …" for a new address.
 */
export const save = mutation({
  args: { programUuid: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    if (!args.programUuid) throw new ConvexError("Select a Flight Program.");
    if (!programPermission(s, "admin"))
      throw new ConvexError("Flight Program administrator required.");
    const input = parseSavedAddress(args.payload);
    const previous = await ctx.db
      .query("savedAddresses")
      .withIndex("uuid", (q) => q.eq("uuid", input.uuid))
      .unique();
    if (previous && previous.programUuid !== args.programUuid)
      throw new ConvexError("Address not found in this Flight Program.");
    if ((previous?.version ?? 0) !== input.version)
      throw new ConvexError("Address changed. Reopen it before saving.");
    const nameKey = input.name.toLowerCase();
    await assertNameFree(ctx, args.programUuid, nameKey, input.uuid);
    const saved = {
      ...input,
      version: input.version + 1,
      programUuid: args.programUuid,
    };
    if (previous) await ctx.db.replace(previous._id, { ...saved, nameKey });
    else await insertAddress(ctx, { ...saved, nameKey });
    await writeAudit(ctx, {
      uuid: crypto.randomUUID(),
      at: Date.now(),
      actorId: s.user.id,
      programUuid: args.programUuid,
      action: "address.saved",
      entityUuid: input.uuid,
    });
    return saved;
  },
});

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

// The form lists each field's issue before it saves (addressIssues), so the
// server answers any parse or completeness failure with one summary.
function parseSavedAddress(payload: string): SavedAddressInput {
  try {
    return prepareSavedAddress(savedAddressInput.parse(JSON.parse(payload)));
  } catch {
    throw new ConvexError(
      "Enter an address name and complete the recipient name, address, email and phone fields.",
    );
  }
}

async function assertNameFree(
  ctx: QueryCtx,
  programUuid: string,
  nameKey: string,
  uuid: string,
): Promise<void> {
  const duplicate = await ctx.db
    .query("savedAddresses")
    .withIndex("name", (q) =>
      q.eq("programUuid", programUuid).eq("nameKey", nameKey),
    )
    .unique();
  if (duplicate && duplicate.uuid !== uuid)
    throw new ConvexError(
      "An address with this name already exists in this program. Select it or use another name.",
    );
}

async function insertAddress(
  ctx: MutationCtx,
  address: Omit<Doc<"savedAddresses">, "_id" | "_creationTime">,
): Promise<void> {
  const existing = await ctx.db
    .query("savedAddresses")
    .withIndex("program", (q) => q.eq("programUuid", address.programUuid))
    .take(MAX_SAVED_ADDRESSES);
  if (existing.length >= MAX_SAVED_ADDRESSES)
    throw new ConvexError(
      `A Flight Program can keep up to ${MAX_SAVED_ADDRESSES} saved addresses. Edit an existing address instead.`,
    );
  await ctx.db.insert("savedAddresses", address);
}
