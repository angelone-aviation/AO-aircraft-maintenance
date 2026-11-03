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
import { audit } from "./access";
import { can, type Snapshot } from "../src/domain/model";
import {
  assertAircraftFileRoom,
  assertAircraftFileWriter,
  MAX_AIRCRAFT_FILES,
  validateAircraftFile,
  type AircraftFile,
} from "../src/domain/aircraftFiles";
const category = v.literal("form-337");
const target = {
  aircraftUuid: v.string(),
  programUuid: v.optional(v.string()),
};
async function access(
  ctx: QueryCtx | MutationCtx,
  args: { aircraftUuid: string; programUuid?: string },
) {
  const state = await checkContext(ctx, args.programUuid);
  assertAircraftFileWriter(state, args.aircraftUuid);
  const programUuid = state.aircraft.find(
    (a) => a.uuid === args.aircraftUuid,
  )?.programUuid;
  return { user: state.user, programUuid };
}
/** Files of every aircraft the snapshot's reader can read. */
export async function aircraftFileList(
  ctx: QueryCtx,
  s: Snapshot,
): Promise<AircraftFile[]> {
  const lists = await Promise.all(
    s.aircraft
      .filter((a) => can(s, a.uuid, "read"))
      .map(async (a) => {
        const files = await ctx.db
          .query("aircraftFiles")
          .withIndex("aircraft", (q) => q.eq("aircraftUuid", a.uuid))
          .take(MAX_AIRCRAFT_FILES);
        return Promise.all(
          files.map(async (f) => ({
            uuid: f._id,
            aircraftUuid: f.aircraftUuid,
            category: f.category,
            name: f.name,
            type: f.type,
            size: f.size,
            uploadedAt: f.uploadedAt,
            url: (await ctx.storage.getUrl(f.storageId)) ?? "",
          })),
        );
      }),
  );
  return lists.flat();
}
export const checkUpload = internalQuery({
  args: target,
  handler: async (ctx, args) => {
    await access(ctx, args);
  },
});
export const finishUpload = internalMutation({
  args: {
    ...target,
    category,
    storageId: v.id("_storage"),
    name: v.string(),
    type: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const owner = await access(ctx, args);
    validateAircraftFile(args.name, args.type, args.size);
    assertAircraftFileRoom(
      (
        await ctx.db
          .query("aircraftFiles")
          .withIndex("aircraft", (q) => q.eq("aircraftUuid", args.aircraftUuid))
          .take(MAX_AIRCRAFT_FILES)
      ).length,
    );
    const { programUuid: _program, ...fields } = args;
    await ctx.db.insert("aircraftFiles", { ...fields, uploadedAt: Date.now() });
    await audit(
      ctx,
      owner.user.id,
      "aircraft.file_uploaded",
      args.aircraftUuid,
      {
        programUuid: owner.programUuid,
        aircraftUuid: args.aircraftUuid,
        after: {
          category: args.category,
          name: args.name,
          type: args.type,
          size: args.size,
        },
      },
    );
  },
});
export const upload = action({
  args: {
    ...target,
    category,
    name: v.string(),
    type: v.string(),
    bytes: v.bytes(),
  },
  handler: async (ctx, args): Promise<void> => {
    validateAircraftFile(args.name, args.type, args.bytes.byteLength);
    const scope = {
      aircraftUuid: args.aircraftUuid,
      programUuid: args.programUuid,
    };
    await ctx.runQuery(internal.aircraftFiles.checkUpload, scope);
    const storageId = await ctx.storage.store(
      new Blob([args.bytes], { type: args.type }),
    );
    try {
      await ctx.runMutation(internal.aircraftFiles.finishUpload, {
        ...scope,
        category: args.category,
        storageId,
        name: args.name,
        type: args.type,
        size: args.bytes.byteLength,
      });
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
  },
});
export const remove = mutation({
  args: { id: v.id("aircraftFiles"), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.id);
    if (!file) throw new Error("Document not found.");
    const owner = await access(ctx, {
      aircraftUuid: file.aircraftUuid,
      programUuid: args.programUuid,
    });
    await ctx.db.delete(file._id);
    // Each upload stores its own blob; no other record refers to it.
    await ctx.storage.delete(file.storageId);
    await audit(
      ctx,
      owner.user.id,
      "aircraft.file_removed",
      file.aircraftUuid,
      {
        programUuid: owner.programUuid,
        aircraftUuid: file.aircraftUuid,
        before: {
          category: file.category,
          name: file.name,
          type: file.type,
          size: file.size,
          uploadedAt: file.uploadedAt,
        },
      },
    );
  },
});
