import type { Aircraft, AuditEntry, Group, Member, Snapshot } from "./model";
import { listsAllAircraft } from "./groupAircraft";
import { defaultPermissionGroups } from "./defaultPermissionGroups";

// Follow-up to #34. Before that fix, editing a group whose restricted aircraft
// had left its Flight Program saved an empty aircraft list, which means every
// aircraft in the program. The group record cannot say whether an empty list
// was intended; its `group.saved` change-log entries (before/after) can.
// Shared by convex/groupAudit.ts, the demo backend and Administration.

export const GROUP_SAVED = "group.saved";

/** The group fields a `group.saved` entry records. `allAircraft` is present
 * only on entries saved since the server records the administrator's
 * explicit aircraft-access choice. */
interface SavedGroup {
  name?: unknown;
  owner?: unknown;
  programAdmin?: unknown;
  aircraftIds: string[];
  permissions?: unknown;
  allAircraft?: unknown;
}
type Access = "all" | "limited" | "administrator" | "unknown";

function savedGroup(json: string | undefined): SavedGroup | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    if (
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as SavedGroup).aircraftIds) &&
      (value as SavedGroup).aircraftIds.every((id) => typeof id === "string")
    )
      return value as SavedGroup;
  } catch {
    // An entry that is not group JSON records no group state.
  }
  return undefined;
}
function access(g: SavedGroup | undefined): Access {
  if (!g) return "unknown";
  if (g.programAdmin === true) return "administrator";
  return listsAllAircraft({
    owner: g.owner === true,
    aircraftIds: g.aircraftIds,
  })
    ? "all"
    : "limited";
}

/** True when this `group.saved` entry left the group with something other
 * than every program aircraft (or recorded no state), so it ends the search
 * back through the change log for when the current access began. */
export const endsAllAircraftPeriod = (entry: Pick<AuditEntry, "after">) =>
  access(savedGroup(entry.after)) !== "all";

/** A group created by ensureDefaultGroups (convex/defaultGroups.ts) as one of
 * the defaults that cover every aircraft by design. */
function defaultAllAircraftGroup(g: SavedGroup) {
  const permissions = Array.isArray(g.permissions) ? g.permissions : [];
  return defaultPermissionGroups.some(
    (d) =>
      !d.owner &&
      !d.programAdmin &&
      !d.aircraftIds.length &&
      d.name === g.name &&
      g.owner !== true &&
      d.permissions.length === new Set(permissions).size &&
      d.permissions.every((p) => permissions.includes(p)),
  );
}

/** Groups that reach every aircraft of their Flight Program through an empty
 * list, the only ones whose change log needs reading. Unscoped groups grant
 * nothing; administrator and owner groups never reach every aircraft through
 * their list. */
export const coversAllThroughEmptyList = (
  g: Pick<Group, "programUuid" | "programAdmin" | "owner" | "aircraftIds">,
) => !!g.programUuid && !g.programAdmin && listsAllAircraft(g);

// A creation entry is written in the same transaction as the group.
const CREATION_WINDOW_MS = 60000;

export type GroupAccessReason =
  /** Widened: an edit emptied a list of selected aircraft. */
  | "aircraft_removed"
  /** Widened: an owner group with no aircraft became an ordinary group. */
  | "owner_removed"
  /** Review: created with an empty list before the choice was recorded. */
  | "created_all"
  /** Review: the log does not show the aircraft before the group's current
   * access began. */
  | "no_before"
  /** Review: the log does not show the change to all aircraft at all. */
  | "unrecorded_change"
  /** Review: no `group.saved` entries. */
  | "no_history";

export interface GroupAccessFinding {
  /** `widened`: the log shows the group was limited before an edit emptied
   * it. `review`: it cannot show whether all aircraft was intended. */
  flag: "widened" | "review";
  reason: GroupAccessReason;
  /** The entry where the group's current all-aircraft access began. */
  savedAt?: number;
  savedBy?: string;
  /** Aircraft the group listed before that entry (widened groups). */
  aircraftBefore: string[];
}

/**
 * Whether a group that now reaches every aircraft of its Flight Program
 * through an empty list needs an administrator to confirm that. `saves` are
 * the group's `group.saved` entries, newest first; the search stops at the
 * first entry for which endsAllAircraftPeriod is true. `createdAt` is the
 * group's creation time, when known.
 *
 * A group is cleared once any entry in its current all-aircraft period records
 * an explicit all-aircraft choice. Entries saved before the server recorded
 * that choice cannot prove it, so they are judged by what changed: a list of
 * selected aircraft (or an owner group) becoming empty is `widened`; anything
 * the log cannot explain is `review`. Groups are never changed here.
 */
export function groupAccessFinding(
  group: Pick<Group, "programUuid" | "programAdmin" | "owner" | "aircraftIds">,
  saves: Pick<AuditEntry, "at" | "actorId" | "before" | "after">[],
  createdAt?: number,
): GroupAccessFinding | undefined {
  if (!coversAllThroughEmptyList(group)) return undefined;
  const period: {
    at: number;
    actorId: string;
    before?: SavedGroup;
    after: SavedGroup;
  }[] = [];
  let earlier: SavedGroup | undefined;
  let ended = false;
  for (const save of saves) {
    if (endsAllAircraftPeriod(save)) {
      earlier = savedGroup(save.after);
      ended = true;
      break;
    }
    period.push({
      at: save.at,
      actorId: save.actorId,
      before: savedGroup(save.before),
      after: savedGroup(save.after)!,
    });
  }
  if (period.some((e) => e.after.allAircraft === true)) return undefined;
  const start = period.at(-1);
  if (!start)
    return {
      flag: "review",
      reason: ended ? "unrecorded_change" : "no_history",
      aircraftBefore: [],
    };
  const found = (
    flag: GroupAccessFinding["flag"],
    reason: GroupAccessReason,
    aircraftBefore: string[] = [],
  ): GroupAccessFinding => ({
    flag,
    reason,
    savedAt: start.at,
    savedBy: start.actorId,
    aircraftBefore,
  });
  // The entry's own before-state, or the state the previous entry left.
  const before = start.before ?? earlier;
  if (ended && start.before && access(start.before) === "all")
    // The previous entry left it limited, yet this one found it open.
    return found("review", "unrecorded_change");
  switch (access(before)) {
    case "limited":
      return before!.aircraftIds.length
        ? found("widened", "aircraft_removed", before!.aircraftIds)
        : found("widened", "owner_removed");
    // It already covered every aircraft as an administrator group.
    case "administrator":
      return undefined;
  }
  const creation =
    !ended &&
    !start.before &&
    (createdAt === undefined ||
      Math.abs(start.at - createdAt) <= CREATION_WINDOW_MS);
  if (creation)
    return defaultAllAircraftGroup(start.after)
      ? undefined
      : found("review", "created_all");
  return found("review", "no_before");
}

export interface GroupAccessReport extends Omit<
  GroupAccessFinding,
  "savedBy" | "aircraftBefore"
> {
  groupId: string;
  groupName: string;
  programUuid: string;
  programName: string;
  savedBy?: { id: string; name: string };
  aircraftBefore: {
    uuid: string;
    registration?: string;
    programUuid?: string;
    programName?: string;
    /** No longer in the group's program (or no longer exists). */
    transferredAway: boolean;
  }[];
  members: { id: string; name: string; email: string; active: boolean }[];
}

/** Resolves a finding's ids. `users` holds the actor and anyone who may be a
 * member; members are those whose groupIds name the group. */
export function groupAccessReport(
  group: Group,
  finding: GroupAccessFinding,
  lookup: {
    programs: { uuid: string; name: string }[];
    aircraft: Pick<Aircraft, "uuid" | "registration" | "programUuid">[];
    users: Pick<Member, "id" | "name" | "email" | "active" | "groupIds">[];
  },
): GroupAccessReport {
  const programName = (uuid: string | undefined) =>
    lookup.programs.find((p) => p.uuid === uuid)?.name;
  const actor = finding.savedBy;
  return {
    groupId: group.id,
    groupName: group.name,
    programUuid: group.programUuid!,
    programName: programName(group.programUuid) ?? "Unknown Flight Program",
    flag: finding.flag,
    reason: finding.reason,
    ...(finding.savedAt === undefined ? {} : { savedAt: finding.savedAt }),
    ...(actor === undefined
      ? {}
      : {
          savedBy: {
            id: actor,
            name:
              lookup.users.find((u) => u.id === actor)?.name ??
              (actor === "system" ? "the system" : "an unknown user"),
          },
        }),
    aircraftBefore: finding.aircraftBefore.map((uuid) => {
      const a = lookup.aircraft.find((x) => x.uuid === uuid);
      return a
        ? {
            uuid,
            registration: a.registration,
            programUuid: a.programUuid,
            programName: programName(a.programUuid),
            transferredAway: a.programUuid !== group.programUuid,
          }
        : { uuid, transferredAway: true };
    }),
    members: lookup.users
      .filter((u) => u.groupIds.includes(group.id))
      .map(({ id, name, email, active }) => ({ id, name, email, active })),
  };
}

/** Every group of a full snapshot (the demo's all-program copy) that needs
 * review, widened groups first. */
export function groupAccessReports(
  s: Pick<Snapshot, "groups" | "programs" | "aircraft" | "members" | "audit">,
): GroupAccessReport[] {
  const lookup = {
    programs: s.programs ?? [],
    aircraft: s.aircraft,
    users: s.members,
  };
  return sortReports(
    s.groups.flatMap((g) => {
      const saves = s.audit
        .filter((a) => a.entityUuid === g.id && a.action === GROUP_SAVED)
        .sort((a, b) => b.at - a.at);
      const finding = groupAccessFinding(g, saves);
      return finding ? [groupAccessReport(g, finding, lookup)] : [];
    }),
  );
}

export const sortReports = (reports: GroupAccessReport[]) =>
  [...reports].sort(
    (a, b) =>
      (a.flag === b.flag ? 0 : a.flag === "widened" ? -1 : 1) ||
      a.programName.localeCompare(b.programName) ||
      a.groupName.localeCompare(b.groupName),
  );

function list(names: string[]) {
  return names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** One sentence on what the change log shows, for Administration and the
 * system-administrator check. */
export function groupAccessSummary(
  r: GroupAccessReport,
  date: (at: number) => string,
) {
  const by = r.savedBy?.name ?? "an unknown user";
  const on = r.savedAt === undefined ? "" : ` on ${date(r.savedAt)}`;
  switch (r.reason) {
    case "aircraft_removed":
      return `Limited to ${list(
        r.aircraftBefore.map((a) =>
          !a.registration
            ? "an aircraft no longer in Angel One"
            : a.transferredAway
              ? `${a.registration} (now in ${a.programName ?? "no Flight Program"})`
              : a.registration,
        ),
      )} until ${by} saved it with no aircraft${on}.`;
    case "owner_removed":
      return `An aircraft owner group with no aircraft until ${by} saved it as an ordinary group${on}.`;
    case "created_all":
      return `Cannot determine: ${by} created it with all aircraft${on}, before the form asked for an explicit choice.`;
    case "no_before":
      return `Cannot determine: the change log does not show its aircraft before ${by} saved it${on}.`;
    case "unrecorded_change":
      return "Cannot determine: the change log does not show how it came to cover all aircraft.";
    case "no_history":
      return "Cannot determine: this group has no change-log entries.";
  }
}
