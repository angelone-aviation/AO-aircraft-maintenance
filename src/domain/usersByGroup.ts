/**
 * Responsibility: Counts the active users in each permission group, for the
 *   Administration chart.
 * Layer: Domain. Pure data shaping; no I/O, no React.
 * Dependencies: src/domain/model.ts (types).
 */
import type { Group, Member, Snapshot } from "./model";

/** One permission group and how many active accounts belong to it. */
export type GroupUserCount = { label: string; users: number };

type ProgramName = Pick<
  NonNullable<Snapshot["programs"]>[number],
  "uuid" | "name"
>;

/**
 * Counts the active accounts in each permission group. A disabled account
 * cannot use its groups, so it is not counted; a user in two groups counts
 * in both.
 *
 * @param members - Every account the snapshot lists.
 * @param groups - The groups to count, empty ones included.
 * @param programs - Names the Flight Program of a group whose name another
 *   group shares.
 * @returns One entry per group, most users first, then by label A to Z. A
 *   shared group name is followed by its Flight Program in brackets.
 */
export function usersByGroup(
  members: readonly Pick<Member, "active" | "groupIds">[],
  groups: readonly Pick<Group, "id" | "name" | "programUuid">[],
  programs: readonly ProgramName[] = [],
): GroupUserCount[] {
  const active = members.filter((m) => m.active);
  return groups
    .map((group) => ({
      label: groupLabel(group, groups, programs),
      users: active.filter((m) => m.groupIds.includes(group.id)).length,
    }))
    .sort((a, b) => b.users - a.users || a.label.localeCompare(b.label));
}

function groupLabel(
  group: Pick<Group, "id" | "name" | "programUuid">,
  groups: readonly Pick<Group, "id" | "name">[],
  programs: readonly ProgramName[],
) {
  const shared = groups.some((g) => g.id !== group.id && g.name === group.name);
  const program = programs.find((p) => p.uuid === group.programUuid);
  return shared && program ? `${group.name} (${program.name})` : group.name;
}
