/**
 * Responsibility: Finds permission groups that an edit before the fix for #34
 *   silently opened to every aircraft in their Flight Program.
 * Layer: Server. A public query for system administrators and a one-time
 *   internal check; read-only, nothing here changes a group.
 * Dependencies: convex/access, convex/memberships,
 *   src/domain/groupAccessReview.
 *
 * An administrator reviews each group found in Administration.
 */
import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { admin, group } from "./access";
import { programUsers } from "./memberships";
import {
  GROUP_SAVED,
  coversAllThroughEmptyList,
  endsAllAircraftPeriod,
  groupAccessFinding,
  groupAccessReport,
  groupAccessSummary,
  sortReports,
  type GroupAccessFinding,
} from "../src/domain/groupAccessReview";

// Groups the one-time check reads per run, by default and at most.
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Lists the permission groups to review, for Administration → Permission
 * groups.
 *
 * @returns One report per group found, as `sortReports` orders them.
 * @throws {ConvexError} "Administrator permission required." for anyone but
 *   a system administrator.
 * @throws The session refusal of `currentUser`.
 */
export const groupsToReview = query({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return reviewGroups(ctx, await ctx.db.query("groups").collect());
  },
});

/**
 * The one-time check after deploying the fix:
 * `npx convex run groupAudit:findWidenedGroups`. It walks the groups table in
 * pages; while `isDone` is false, run it again with
 * `'{"cursor": "<continueCursor>"}'`.
 *
 * @param cursor - The previous page's `continueCursor`; none to start.
 * @param numItems - Groups per page, rounded down to 1 through 200; 50 when
 *   omitted.
 * @returns `widened`: groups whose change log shows that an edit emptied
 *   their aircraft list; `review`: groups covering all aircraft whose log
 *   cannot show that this was chosen; each with a one-line `summary`. Also
 *   the page's `groupsScanned`, `isDone` and `continueCursor`.
 */
export const findWidenedGroups = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, numItems }) => {
    const batch = await ctx.db.query("groups").paginate({
      cursor: cursor ?? null,
      numItems: Math.min(
        Math.max(Math.floor(numItems ?? PAGE_SIZE), 1),
        MAX_PAGE_SIZE,
      ),
    });
    const reports = (await reviewGroups(ctx, batch.page)).map((r) => ({
      ...r,
      summary: `${r.groupName} (${r.programName}): ${groupAccessSummary(
        r,
        (at) => new Date(at).toISOString(),
      )}`,
    }));
    return {
      widened: reports.filter((r) => r.flag === "widened"),
      review: reports.filter((r) => r.flag === "review"),
      groupsScanned: batch.page.length,
      isDone: batch.isDone,
      continueCursor: batch.continueCursor,
    };
  },
});

async function reviewGroups(ctx: QueryCtx, groups: Doc<"groups">[]) {
  const programs = await ctx.db.query("programs").collect();
  const reports = [];
  for (const g of groups) {
    // Only groups that now reach every program aircraft through an empty
    // list need their change log read.
    if (!coversAllThroughEmptyList(g)) continue;
    const saves = await readAllAircraftSaves(ctx, g);
    const finding = groupAccessFinding(g, saves, g._creationTime);
    if (finding) reports.push(await buildReport(ctx, g, finding, programs));
  }
  return sortReports(reports);
}

// Newest first through this group's own entries (the entity index), back to
// where its current all-aircraft access began; the rest of the change log is
// never read.
async function readAllAircraftSaves(ctx: QueryCtx, g: Doc<"groups">) {
  const saves: Doc<"audit">[] = [];
  for await (const entry of ctx.db
    .query("audit")
    .withIndex("entity", (q) => q.eq("entityUuid", g._id))
    .order("desc")) {
    if (entry.action !== GROUP_SAVED) continue;
    saves.push(entry);
    if (endsAllAircraftPeriod(entry)) break;
  }
  return saves;
}

async function buildReport(
  ctx: QueryCtx,
  g: Doc<"groups">,
  finding: GroupAccessFinding,
  programs: Doc<"programs">[],
) {
  const aircraft = (
    await Promise.all(
      finding.aircraftBefore.map((uuid) =>
        ctx.db
          .query("aircraft")
          .withIndex("uuid", (q) => q.eq("uuid", uuid))
          .unique(),
      ),
    )
  ).filter((a): a is Doc<"aircraft"> => a !== null);
  const actorId = finding.savedBy
    ? ctx.db.normalizeId("users", finding.savedBy)
    : null;
  const actor = actorId ? await ctx.db.get(actorId) : null;
  // Members through the memberships index (memberships:backfill);
  // groupAccessReport keeps only those whose groupIds name the group.
  const users = await programUsers(ctx, g.programUuid, g._id);
  return groupAccessReport(group(g), finding, {
    programs,
    aircraft,
    users: [...users, ...(actor ? [actor] : [])].map(toReviewUser),
  });
}

function toReviewUser(u: Doc<"users">) {
  return {
    id: u._id,
    name: u.name ?? "Unnamed user",
    email: u.email ?? "",
    active: u.active === true,
    groupIds: u.groupIds ?? [],
  };
}
