/**
 * Responsibility: Finds permission groups whose all-aircraft access the change
 *   log cannot justify, and describes each for an administrator to review.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (types), groupAircraft.ts,
 *   defaultPermissionGroups.ts.
 *
 * Follow-up to #34: before that fix, editing a group whose restricted aircraft
 * had left its Flight Program saved an empty list, which means every aircraft.
 * The group cannot say whether that was intended; its `group.saved` entries
 * (before/after) can.
 */
import type { Aircraft, AuditEntry, Group, Member, Snapshot } from "./model";
import { listsAllAircraft } from "./groupAircraft";
import { defaultPermissionGroups } from "./defaultPermissionGroups";

const UNKNOWN_USER = "an unknown user";

const FLAG_ORDER: Record<GroupAccessFinding["flag"], number> = {
  widened: 0,
  review: 1,
};

/** The change-log action written each time a group is saved. */
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

/**
 * Tells whether a `group.saved` entry ends the search back through the change
 * log for when the group's current all-aircraft access began.
 *
 * @param entry - The entry.
 * @returns True when it left the group limited, as an administrator group, or
 *   with no readable group state.
 */
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

/**
 * Tells whether a group reaches every aircraft of its Flight Program through
 * an empty list, the only groups whose change log needs reading.
 *
 * @param g - The group.
 * @returns False for a group with no Flight Program (it grants nothing), and
 *   for administrator and owner groups, which never reach all through a list.
 */
export const coversAllThroughEmptyList = (
  g: Pick<Group, "programUuid" | "programAdmin" | "owner" | "aircraftIds">,
) => !!g.programUuid && !g.programAdmin && listsAllAircraft(g);

// A creation entry is written in the same transaction as the group.
const CREATION_WINDOW_MS = 60000;

/** Why a group's all-aircraft access was flagged. */
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

/** What the change log shows about a group that reaches every aircraft. */
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
 * Whether a group's all-aircraft access through an empty list needs an
 * administrator to confirm it. An explicit all-aircraft choice anywhere in
 * the current period clears it; older entries are judged by what changed.
 *
 * @param group - The group as stored now.
 * @param saves - Its `group.saved` entries, newest first.
 * @param createdAt - The group's creation time, when known.
 * @returns `widened` if a list of selected aircraft (or an owner group)
 *   became empty, `review` if the log cannot explain it, else undefined.
 */
export function groupAccessFinding(
  group: Pick<Group, "programUuid" | "programAdmin" | "owner" | "aircraftIds">,
  saves: Pick<AuditEntry, "at" | "actorId" | "before" | "after">[],
  createdAt?: number,
): GroupAccessFinding | undefined {
  if (!coversAllThroughEmptyList(group)) return undefined;
  const { period, earlier, ended } = readCurrentPeriod(saves);
  if (period.some((e) => e.after.allAircraft === true)) return undefined;
  const start = period.at(-1);
  if (!start)
    return {
      flag: "review",
      reason: ended ? "unrecorded_change" : "no_history",
      aircraftBefore: [],
    };
  return judgePeriodStart(start, earlier, ended, createdAt);
}

/** A finding with its ids resolved to names. */
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

/**
 * Resolves a finding's ids to names for the review screen.
 *
 * @param group - The flagged group; it belongs to a Flight Program.
 * @param finding - Its {@link groupAccessFinding}.
 * @param lookup - What to resolve against; `users` holds the actor and anyone
 *   who may be a member.
 * @returns The report. An unknown program reads "Unknown Flight Program", an
 *   unknown actor "an unknown user" (`system` reads "the system"), and the
 *   members are the users whose groupIds name the group.
 */
export function groupAccessReport(
  group: Group,
  finding: GroupAccessFinding,
  lookup: {
    programs: { uuid: string; name: string }[];
    aircraft: Pick<Aircraft, "uuid" | "registration" | "programUuid">[];
    users: Pick<Member, "id" | "name" | "email" | "active" | "groupIds">[];
  },
): GroupAccessReport {
  const actor = finding.savedBy;
  return {
    groupId: group.id,
    groupName: group.name,
    programUuid: group.programUuid!,
    programName:
      findProgramName(lookup, group.programUuid) ?? "Unknown Flight Program",
    flag: finding.flag,
    reason: finding.reason,
    ...(finding.savedAt === undefined ? {} : { savedAt: finding.savedAt }),
    ...(actor === undefined ? {} : { savedBy: resolveActor(lookup, actor) }),
    aircraftBefore: finding.aircraftBefore.map((uuid) =>
      resolveAircraftBefore(lookup, uuid, group.programUuid),
    ),
    members: lookup.users
      .filter((u) => u.groupIds.includes(group.id))
      .map(({ id, name, email, active }) => ({ id, name, email, active })),
  };
}

/**
 * Every group of a full snapshot (the demo's all-program copy) that needs
 * review.
 *
 * @param s - The snapshot; its audit entries may be in any order.
 * @returns One report per flagged group, ordered as {@link sortReports} does.
 */
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

/**
 * Orders reports for review.
 *
 * @param reports - The reports; not changed.
 * @returns A sorted copy: widened before review, then by program name, then
 *   by group name.
 */
export const sortReports = (reports: GroupAccessReport[]) =>
  [...reports].sort(
    (a, b) =>
      FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag] ||
      a.programName.localeCompare(b.programName) ||
      a.groupName.localeCompare(b.groupName),
  );

/**
 * One sentence on what the change log shows about a report.
 *
 * @param r - The report.
 * @param date - Formats a time for the sentence.
 * @returns The sentence for the report's reason.
 */
export function groupAccessSummary(
  r: GroupAccessReport,
  date: (at: number) => string,
) {
  const by = r.savedBy?.name ?? UNKNOWN_USER;
  const on = r.savedAt === undefined ? "" : ` on ${date(r.savedAt)}`;
  switch (r.reason) {
    case "aircraft_removed":
      return `Limited to ${joinWithAnd(
        r.aircraftBefore.map(describeListedAircraft),
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

interface PeriodEntry {
  at: number;
  actorId: string;
  before?: SavedGroup;
  after: SavedGroup;
}

type ReportLookup = Parameters<typeof groupAccessReport>[2];

/** Reads back from the newest save to the one that ended the period. */
function readCurrentPeriod(saves: Parameters<typeof groupAccessFinding>[1]) {
  const period: PeriodEntry[] = [];
  for (const save of saves) {
    if (endsAllAircraftPeriod(save))
      return { period, earlier: savedGroup(save.after), ended: true };
    period.push({
      at: save.at,
      actorId: save.actorId,
      before: savedGroup(save.before),
      after: savedGroup(save.after)!,
    });
  }
  return { period, earlier: undefined, ended: false };
}

function judgePeriodStart(
  start: PeriodEntry,
  earlier: SavedGroup | undefined,
  ended: boolean,
  createdAt: number | undefined,
): GroupAccessFinding | undefined {
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
  // The previous entry left it limited, yet this one found it open.
  if (ended && start.before && access(start.before) === "all")
    return found("review", "unrecorded_change");
  // The entry's own before-state, or the state the previous entry left.
  const before = start.before ?? earlier;
  const accessBefore = access(before);
  // It already covered every aircraft as an administrator group.
  if (accessBefore === "administrator") return undefined;
  if (accessBefore === "limited")
    return before!.aircraftIds.length
      ? found("widened", "aircraft_removed", before!.aircraftIds)
      : found("widened", "owner_removed");
  const creation =
    !ended &&
    !start.before &&
    (createdAt === undefined ||
      Math.abs(start.at - createdAt) <= CREATION_WINDOW_MS);
  if (!creation) return found("review", "no_before");
  return defaultAllAircraftGroup(start.after)
    ? undefined
    : found("review", "created_all");
}

function findProgramName(lookup: ReportLookup, uuid: string | undefined) {
  return lookup.programs.find((p) => p.uuid === uuid)?.name;
}

function resolveActor(lookup: ReportLookup, id: string) {
  const name =
    lookup.users.find((u) => u.id === id)?.name ??
    (id === "system" ? "the system" : UNKNOWN_USER);
  return { id, name };
}

function resolveAircraftBefore(
  lookup: ReportLookup,
  uuid: string,
  groupProgramUuid: string | undefined,
): GroupAccessReport["aircraftBefore"][number] {
  const a = lookup.aircraft.find((x) => x.uuid === uuid);
  if (!a) return { uuid, transferredAway: true };
  return {
    uuid,
    registration: a.registration,
    programUuid: a.programUuid,
    programName: findProgramName(lookup, a.programUuid),
    transferredAway: a.programUuid !== groupProgramUuid,
  };
}

function describeListedAircraft(
  a: GroupAccessReport["aircraftBefore"][number],
) {
  if (!a.registration) return "an aircraft no longer in Angel One";
  if (!a.transferredAway) return a.registration;
  return `${a.registration} (now in ${a.programName ?? "no Flight Program"})`;
}

function joinWithAnd(names: string[]) {
  const rest = names.slice(0, -1);
  return rest.length
    ? `${rest.join(", ")} and ${names.at(-1)}`
    : names.join("");
}
