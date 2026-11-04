/**
 * Responsibility: Who the caller is and what they may touch: the signed-in
 *   account, the administrator and per-aircraft checks, and the one writer of
 *   change-log rows.
 * Layer: Server. Convex helpers; the permission rules come from src/domain.
 * Dependencies: @convex-dev/auth/server, convex/values, convex/server,
 *   ./_generated, ./programContext, src/domain (model, certifications).
 *
 * Refusals are ConvexErrors so production shows their message. A missing or
 * lapsed session stays a plain Error: the offline outbox holds a ConvexError
 * as final, and a session that lapsed is not a final answer.
 */
import { ConvexError } from "convex/values";
import { certificationsSchema } from "../src/domain/certifications";
import { can, type Snapshot } from "../src/domain/model";
import { context } from "./programContext";
import { getAuthUserId, getAuthSessionId } from "@convex-dev/auth/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";
import type { Permission, Member, Group } from "../src/domain/model";

type Ctx = QueryCtx | MutationCtx;

/**
 * An account as the domain sees it.
 *
 * @returns The member; an unset name reads "Unnamed user", an unset email "",
 *   and `active` and `isAdmin` are true only when stored as true.
 * @throws {z.ZodError} When the stored certifications no longer parse.
 */
export function member(user: Doc<"users">): Member {
  return {
    certifications:
      user.certifications === undefined
        ? undefined
        : certificationsSchema.parse(user.certifications),
    licenseNumber: user.licenseNumber,
    logbookPhrases: user.logbookPhrases,
    releaseStatements: user.releaseStatements,
    certificateType: user.certificateType,
    activeProgramUuid: user.activeProgramUuid,
    emailAlerts: user.emailAlerts,
    id: user._id,
    name: user.name ?? "Unnamed user",
    email: user.email ?? "",
    active: user.active === true,
    isAdmin: user.isAdmin === true,
    groupIds: user.groupIds ?? [],
  };
}

/** A permission group as the domain sees it, keyed by its document id. */
export function group(doc: Doc<"groups">): Group {
  return {
    programUuid: doc.programUuid,
    programAdmin: doc.programAdmin,
    owner: doc.owner,
    id: doc._id,
    name: doc.name,
    aircraftIds: doc.aircraftIds,
    permissions: doc.permissions,
  };
}

/**
 * The signed-in account and its session, when both are current.
 *
 * @returns null unless the account is active and the session belongs to it
 *   and has not expired.
 */
export async function activeIdentity(ctx: Ctx) {
  const id = await getAuthUserId(ctx);
  const sessionId = await getAuthSessionId(ctx);
  if (!id || !sessionId) return null;
  const [user, session] = await Promise.all([
    ctx.db.get(id),
    ctx.db.get(sessionId),
  ]);
  if (
    !user?.active ||
    !session ||
    session.userId !== id ||
    session.expirationTime <= Date.now()
  )
    return null;
  return { user, session };
}

/**
 * The signed-in account, which must be active with a current session.
 *
 * @throws {Error} "An active account and session are required." A plain
 *   Error, not a ConvexError (see the header).
 */
export async function currentUser(ctx: Ctx) {
  const identity = await activeIdentity(ctx);
  if (!identity) throw new Error("An active account and session are required.");
  return identity.user;
}

/**
 * The signed-in account, which must be a system administrator.
 *
 * @throws {Error} The session refusal of {@link currentUser}.
 * @throws {ConvexError} "Administrator permission required."
 */
export async function admin(ctx: Ctx) {
  const user = await currentUser(ctx);
  if (!user.isAdmin)
    throw new ConvexError("Administrator permission required.");
  return user;
}

/**
 * The signed-in account, which must hold `permission` on the aircraft within
 * its active Flight Program.
 *
 * @param state - The caller's program context, when already loaded.
 * @throws {Error} The session refusal of {@link currentUser}.
 * @throws {ConvexError} "You do not have permission for this aircraft."
 */
export async function authorized(
  ctx: Ctx,
  aircraftUuid: string,
  permission: Permission,
  state?: Snapshot,
) {
  const user = await currentUser(ctx);
  if (can(state ?? (await context(ctx, user)), aircraftUuid, permission))
    return user;
  throw new ConvexError("You do not have permission for this aircraft.");
}

/**
 * An aircraft by uuid, in any Flight Program; it checks no access.
 *
 * @throws {ConvexError} "Aircraft not found."
 */
export async function aircraftByUuid(ctx: Ctx, uuid: string) {
  const aircraft = await ctx.db
    .query("aircraft")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  if (!aircraft) throw new ConvexError("Aircraft not found.");
  return aircraft;
}

/** A change-log row as stored. */
export type AuditRow = WithoutSystemFields<Doc<"audit">>;

/**
 * Inserts one change-log row. Rows are append-only (ADR-0005), and this is
 * the only insert into the audit table: commands write through runCommand's
 * log, everything else through {@link audit}.
 */
export async function writeAudit(ctx: MutationCtx, row: AuditRow) {
  await ctx.db.insert("audit", row);
}

/** The optional fields of a change-log row. */
export interface AuditFields {
  programUuid?: string;
  aircraftUuid?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

/**
 * A new change-log row by `actorId`, stamped now with a fresh uuid.
 *
 * @returns The row, with `before` and `after` stored as JSON text.
 */
export function auditRow(
  actorId: string,
  action: string,
  entityUuid: string,
  options: AuditFields = {},
): AuditRow {
  return {
    programUuid: options.programUuid,
    uuid: crypto.randomUUID(),
    actorId,
    action,
    entityUuid,
    at: Date.now(),
    aircraftUuid: options.aircraftUuid,
    reason: options.reason,
    before:
      options.before === undefined ? undefined : JSON.stringify(options.before),
    after:
      options.after === undefined ? undefined : JSON.stringify(options.after),
  };
}

/** Writes one new change-log row by `actorId` (see {@link auditRow}). */
export async function audit(
  ctx: MutationCtx,
  actorId: string,
  action: string,
  entityUuid: string,
  options: AuditFields = {},
) {
  await writeAudit(ctx, auditRow(actorId, action, entityUuid, options));
}
