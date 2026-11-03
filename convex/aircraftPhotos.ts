import { v } from "convex/values";
import {
  action,
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { checkContext } from "./programContext";
import { can } from "../src/domain/model";
import { validateAircraftPhoto } from "../src/domain/aircraftPhotos";
import { audit } from "./access";
const target = {
  aircraftUuid: v.string(),
  programUuid: v.optional(v.string()),
};
async function access(
  ctx: QueryCtx | MutationCtx,
  args: { aircraftUuid: string; programUuid?: string },
) {
  const state = await checkContext(ctx, args.programUuid);
  if (!can(state, args.aircraftUuid, "maintenance"))
    throw Error("Aircraft maintenance permission required.");
  return state;
}
export const check = internalQuery({
  args: target,
  handler: async (ctx, args) => {
    await access(ctx, args);
  },
});
export const finish = internalMutation({
  args: { ...target, storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const state = await access(ctx, args);
    const old = await ctx.db
      .query("aircraftPhotos")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", args.aircraftUuid))
      .unique();
    if (old) {
      await ctx.db.patch(old._id, { storageId: args.storageId });
      await ctx.storage.delete(old.storageId);
    } else
      await ctx.db.insert("aircraftPhotos", {
        aircraftUuid: args.aircraftUuid,
        storageId: args.storageId,
      });
    await audit(
      ctx,
      state.user.id,
      "aircraft.photo_updated",
      args.aircraftUuid,
      { programUuid: args.programUuid, aircraftUuid: args.aircraftUuid },
    );
  },
});
export const upload = action({
  args: { ...target, type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    validateAircraftPhoto(args.type, args.bytes.byteLength);
    const scope = {
      aircraftUuid: args.aircraftUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.aircraftPhotos.check, scope);
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.aircraftPhotos.finish, {
        ...scope,
        storageId,
      });
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
  },
});
export const remove = mutation({
  args: target,
  handler: async (ctx, args) => {
    const state = await access(ctx, args);
    const photo = await ctx.db
      .query("aircraftPhotos")
      .withIndex("aircraft", (q) => q.eq("aircraftUuid", args.aircraftUuid))
      .unique();
    if (photo) {
      await ctx.db.delete(photo._id);
      await ctx.storage.delete(photo.storageId);
    }
    await audit(
      ctx,
      state.user.id,
      "aircraft.photo_removed",
      args.aircraftUuid,
      { programUuid: args.programUuid, aircraftUuid: args.aircraftUuid },
    );
  },
});
