import { certificationsSchema } from "../src/domain/certifications";
import { can, type Snapshot } from "../src/domain/model";
import { context } from "./programContext";
import { getAuthUserId, getAuthSessionId } from "@convex-dev/auth/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";
import type { Permission, Member, Group } from "../src/domain/model";
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
export async function activeIdentity(ctx: QueryCtx | MutationCtx) {
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
export async function currentUser(ctx: QueryCtx | MutationCtx) {
  const identity = await activeIdentity(ctx);
  if (!identity) throw new Error("An active account and session are required.");
  return identity.user;
}
export async function admin(ctx: QueryCtx | MutationCtx) {
  const user = await currentUser(ctx);
  if (!user.isAdmin) throw new Error("Administrator permission required.");
  return user;
}
export async function authorized(
  ctx: QueryCtx | MutationCtx,
  aircraftUuid: string,
  permission: Permission,
  // Pass the already-loaded program context to avoid loading it twice.
  state?: Snapshot,
) {
  const user = await currentUser(ctx);
  if (can(state ?? (await context(ctx, user)), aircraftUuid, permission))
    return user;
  throw new Error("You do not have permission for this aircraft.");
}
export async function aircraftByUuid(
  ctx: QueryCtx | MutationCtx,
  uuid: string,
) {
  const aircraft = await ctx.db
    .query("aircraft")
    .withIndex("uuid", (q) => q.eq("uuid", uuid))
    .unique();
  if (!aircraft) throw new Error("Aircraft not found.");
  return aircraft;
}
// Change-log rows are append-only (ADR-0005). writeAudit is the one insert
// into the audit table: commands write through runCommand's log, everything
// else through audit() below.
export type AuditRow = WithoutSystemFields<Doc<"audit">>;
export async function writeAudit(ctx: MutationCtx, row: AuditRow) {
  await ctx.db.insert("audit", row);
}
export interface AuditFields {
  programUuid?: string;
  aircraftUuid?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}
// A new row by `actorId`, now; before and after are stored as JSON.
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
export async function audit(
  ctx: MutationCtx,
  actorId: string,
  action: string,
  entityUuid: string,
  options: AuditFields = {},
) {
  await writeAudit(ctx, auditRow(actorId, action, entityUuid, options));
}
