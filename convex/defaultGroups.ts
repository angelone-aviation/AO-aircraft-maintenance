/**
 * Responsibility: A Flight Program's default permission groups: creating the
 *   ones it lacks, with a new program or as a backfill.
 * Layer: Server. A helper for program-creating mutations and a public
 *   mutation for the system administrator; every group created is audited.
 * Dependencies: convex/access, convex/runCommand (CommandLog type),
 *   src/domain/defaultPermissionGroups.
 */
import { ConvexError, v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import { admin, audit } from "./access";
import type { CommandLog } from "./runCommand";
import { missingDefaultGroups } from "../src/domain/defaultPermissionGroups";

/**
 * Creates each default group whose name, ignoring case, the program does not
 * already have; existing groups and assignments stay as they are. Audits
 * `group.saved` with each new group's fields.
 *
 * @param actorId - Who the change-log rows name.
 * @param log - Inside a command, its log, so the rows are written with the
 *   command's; otherwise they are written now.
 * @returns The names of the groups created and of those already there.
 */
export async function ensureDefaultGroups(
  ctx: MutationCtx,
  programUuid: string,
  actorId: string,
  log?: CommandLog,
) {
  const existing = await ctx.db
    .query("groups")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .collect();
  const missing = missingDefaultGroups(existing);
  for (const group of missing) {
    const fields = { ...group, programUuid };
    const id = await ctx.db.insert("groups", fields);
    const entry = { programUuid, after: fields };
    if (log) log.entry("group.saved", id, entry);
    else await audit(ctx, actorId, "group.saved", id, entry);
  }
  return {
    created: missing.map((g) => g.name),
    preserved: existing.map((g) => g.name),
  };
}

/**
 * Adds the default groups a program created before they were automatic still
 * lacks, as {@link ensureDefaultGroups}. Running it again creates nothing.
 *
 * @param programUuid - The program, in any Flight Program.
 * @returns As {@link ensureDefaultGroups}.
 * @throws {Error} The session refusal of `admin`.
 * @throws {ConvexError} "Administrator permission required."; "Flight Program
 *   not found."
 */
export const initialize = mutation({
  args: { programUuid: v.string() },
  handler: async (ctx, { programUuid }) => {
    const actor = await admin(ctx);
    const program = await ctx.db
      .query("programs")
      .withIndex("uuid", (q) => q.eq("uuid", programUuid))
      .unique();
    if (!program) throw new ConvexError("Flight Program not found.");
    return ensureDefaultGroups(ctx, programUuid, actor._id);
  },
});
