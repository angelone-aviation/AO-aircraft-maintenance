import { writeAudit } from "./access";
import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { checkContext, managementDocs } from "./programContext";
import { programPermission } from "../src/domain/programs";
const MAX_SAVED_ADDRESSES = 200;
import {
  prepareSavedAddress,
  savedAddressInput,
  type AddressChoices,
} from "../src/domain/savedAddresses";
import { locationSchema } from "../src/domain/management";

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
        .map(({ _id, _creationTime, nameKey, ...entry }) => entry)
        .sort((a, b) => a.name.localeCompare(b.name)),
      locations: records
        .filter((r) => r.programUuid === programUuid && r.kind === "location")
        .map((r) => {
          const location = locationSchema.parse(JSON.parse(r.payload));
          return {
            uuid: location.uuid,
            name: location.name,
            address:
              admin || !location.addressDetails
                ? location.addressDetails
                : {
                    ...location.addressDetails,
                    contactName: "",
                    email: "",
                    phone: "",
                  },
            legacy: admin || !location.addressDetails ? location.address : "",
          };
        }),
    };
  },
});
export const save = mutation({
  args: { programUuid: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    if (!args.programUuid) throw new ConvexError("Select a Flight Program.");
    if (!programPermission(s, "admin"))
      throw new ConvexError("Flight Program administrator required.");
    let input;
    try {
      input = prepareSavedAddress(
        savedAddressInput.parse(JSON.parse(args.payload)),
      );
    } catch {
      throw new ConvexError(
        "Enter an address name and complete the recipient name, address, email and phone fields.",
      );
    }
    const previous = await ctx.db
      .query("savedAddresses")
      .withIndex("uuid", (q) => q.eq("uuid", input.uuid))
      .unique();
    if (previous && previous.programUuid !== args.programUuid)
      throw new ConvexError("Address not found in this Flight Program.");
    if ((previous?.version ?? 0) !== input.version)
      throw new ConvexError("Address changed. Reopen it before saving.");
    const nameKey = input.name.toLowerCase();
    const duplicate = await ctx.db
      .query("savedAddresses")
      .withIndex("name", (q) =>
        q.eq("programUuid", args.programUuid).eq("nameKey", nameKey),
      )
      .unique();
    if (duplicate && duplicate.uuid !== input.uuid)
      throw new ConvexError(
        "An address with this name already exists in this program. Select it or use another name.",
      );
    const saved = {
      ...input,
      version: input.version + 1,
      programUuid: args.programUuid,
    };
    if (previous) await ctx.db.replace(previous._id, { ...saved, nameKey });
    else {
      const existing = await ctx.db
        .query("savedAddresses")
        .withIndex("program", (q) => q.eq("programUuid", args.programUuid))
        .take(MAX_SAVED_ADDRESSES);
      if (existing.length >= MAX_SAVED_ADDRESSES)
        throw new ConvexError(
          `A Flight Program can keep up to ${MAX_SAVED_ADDRESSES} saved addresses. Edit an existing address instead.`,
        );
      await ctx.db.insert("savedAddresses", { ...saved, nameKey });
    }
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
