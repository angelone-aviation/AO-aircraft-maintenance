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
} from "../src/domain/groupAccessReview";

// Follow-up to #34: permission groups that an edit before the fix silently
// opened to every aircraft in their Flight Program. Read-only: nothing here
// changes a group; an administrator reviews each one in Administration.

const user = (u: Doc<"users">) => ({
  id: u._id,
  name: u.name ?? "Unnamed user",
  email: u.email ?? "",
  active: u.active === true,
  groupIds: u.groupIds ?? [],
});

async function review(ctx: QueryCtx, groups: Doc<"groups">[]) {
  const programs = await ctx.db.query("programs").collect();
  const reports = [];
  for (const g of groups) {
    // Only groups that now reach every program aircraft through an empty
    // list need their change log read.
    if (!coversAllThroughEmptyList(g)) continue;
    // Newest first through this group's own entries (the entity index), back
    // to where its current all-aircraft access began; the rest of the
    // change log is never read.
    const saves: Doc<"audit">[] = [];
    for await (const entry of ctx.db
      .query("audit")
      .withIndex("entity", (q) => q.eq("entityUuid", g._id))
      .order("desc")) {
      if (entry.action !== GROUP_SAVED) continue;
      saves.push(entry);
      if (endsAllAircraftPeriod(entry)) break;
    }
    const finding = groupAccessFinding(g, saves, g._creationTime);
    if (!finding) continue;
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
    reports.push(
      groupAccessReport(group(g), finding, {
        programs,
        aircraft,
        users: [...users, ...(actor ? [actor] : [])].map(user),
      }),
    );
  }
  return sortReports(reports);
}

/** Administration → Permission groups lists these for system administrators. */
export const groupsToReview = query({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return review(ctx, await ctx.db.query("groups").collect());
  },
});

const PAGE = 50;
/**
 * One-time post-deploy check, read-only:
 * `npx convex run groupAudit:findWidenedGroups`. Lists groups whose change log
 * shows that an edit emptied their list of selected aircraft (`widened`), and
 * groups covering all aircraft whose log cannot show that this was chosen
 * (`review`). Walks the groups table in pages; while `isDone` is false, run it
 * again with `'{"cursor": "<continueCursor>"}'`.
 */
export const findWidenedGroups = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, { cursor, numItems }) => {
    const batch = await ctx.db.query("groups").paginate({
      cursor: cursor ?? null,
      numItems: Math.min(Math.max(Math.floor(numItems ?? PAGE), 1), 200),
    });
    const reports = (await review(ctx, batch.page)).map((r) => ({
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
