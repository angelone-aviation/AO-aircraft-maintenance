/**
 * Responsibility: The one photo shown for each aircraft: uploading, replacing
 *   and removing it with its stored image.
 * Layer: Server. A public action and mutation over internal steps; every
 *   change needs maintenance permission on the aircraft and is audited.
 * Dependencies: convex/programContext, convex/access, convex/attachments,
 *   convex/userErrors, src/domain/model, src/domain/aircraftPhotos,
 *   src/domain/inventoryAttachments.
 */
import { ConvexError, v } from "convex/values";
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
import { assertFileContents } from "../src/domain/inventoryAttachments";
import { audit } from "./access";
import { storeThenFinish } from "./attachments";
import { exposeRejections } from "./userErrors";

const target = {
  aircraftUuid: v.string(),
  programUuid: v.optional(v.string()),
};

type Target = { aircraftUuid: string; programUuid?: string };

/**
 * Refuses a caller without maintenance permission on the aircraft, for the
 * upload to call before it stores anything.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @throws {ConvexError} "Aircraft maintenance permission required."
 * @throws As `checkContext`, first.
 */
export const check = internalQuery({
  args: target,
  handler: async (ctx, args) => {
    await requireMaintenance(ctx, args);
  },
});

/**
 * Makes a stored image the aircraft's photo, deleting the image it replaces,
 * and audits "aircraft.photo_updated".
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @param storageId - The uploaded image.
 * @throws As {@link check}.
 */
export const finish = internalMutation({
  args: { ...target, storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const state = await requireMaintenance(ctx, args);
    const old = await findPhoto(ctx, args.aircraftUuid);
    if (old) {
      await ctx.db.patch(old._id, { storageId: args.storageId });
      await ctx.storage.delete(old.storageId);
    } else
      await ctx.db.insert("aircraftPhotos", {
        aircraftUuid: args.aircraftUuid,
        storageId: args.storageId,
      });
    await auditPhoto(ctx, state.user.id, "aircraft.photo_updated", args);
  },
});

/**
 * Sets the aircraft's photo, replacing any earlier one. If saving fails after
 * the image is stored, the stored image is deleted again.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @param type - The image's MIME type.
 * @param bytes - The image.
 * @throws {ConvexError} The refusals of `validateAircraftPhoto`, then "This
 *   file's contents do not match its type. Choose a PDF, JPEG, PNG or WebP
 *   file." when the first bytes are not the declared type's, both before any
 *   permission check and storing nothing; as {@link check}.
 */
export const upload = action({
  args: { ...target, type: v.string(), bytes: v.bytes() },
  handler: async (ctx, args): Promise<void> => {
    exposeRejections(() => {
      validateAircraftPhoto(args.type, args.bytes.byteLength);
      assertFileContents(args.type, args.bytes);
    });
    const scope = {
      aircraftUuid: args.aircraftUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.aircraftPhotos.check, scope);
    await storeThenFinish(ctx, args, (storageId) =>
      ctx.runMutation(internal.aircraftPhotos.finish, { ...scope, storageId }),
    );
  },
});

/**
 * Removes the aircraft's photo and its stored image. Audits
 * "aircraft.photo_removed" even when the aircraft had no photo.
 *
 * @param aircraftUuid - The aircraft.
 * @param programUuid - The caller's active Flight Program.
 * @throws As {@link check}.
 */
export const remove = mutation({
  args: target,
  handler: async (ctx, args) => {
    const state = await requireMaintenance(ctx, args);
    const photo = await findPhoto(ctx, args.aircraftUuid);
    if (photo) {
      await ctx.db.delete(photo._id);
      await ctx.storage.delete(photo.storageId);
    }
    await auditPhoto(ctx, state.user.id, "aircraft.photo_removed", args);
  },
});

async function requireMaintenance(ctx: QueryCtx | MutationCtx, args: Target) {
  const state = await checkContext(ctx, args.programUuid);
  if (!can(state, args.aircraftUuid, "maintenance"))
    throw new ConvexError("Aircraft maintenance permission required.");
  return state;
}

function findPhoto(ctx: QueryCtx, aircraftUuid: string) {
  return ctx.db
    .query("aircraftPhotos")
    .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
    .unique();
}

async function auditPhoto(
  ctx: MutationCtx,
  actorId: string,
  action: string,
  { aircraftUuid, programUuid }: Target,
): Promise<void> {
  await audit(ctx, actorId, action, aircraftUuid, {
    programUuid,
    aircraftUuid,
  });
}
