/**
 * Responsibility: The rules, limits and fixed answers of account
 *   administration: accounts, permission groups, and who gets which group.
 * Layer: Domain. Pure functions and constants; no I/O, no React.
 * Dependencies: ./model (types), ./groupAircraft, ./ownerView, ./boardView,
 *   ./rejection.
 *
 * Shared by the Convex functions and the offline demo adapter so both refuse
 * and answer account-administration requests the same way (issue #29).
 */
import type { Group, Member, Permission } from "./model";
import {
  assertGroupAircraftChoice,
  assertGroupProgramFixed,
} from "./groupAircraft";
import { validateOwnerGroup } from "./ownerView";
import { validateBoardGroup } from "./boardView";
import { Rejection } from "./rejection";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GROUP_NAME_MAX_LENGTH = 100;

// The default read-only group (src/domain/defaultPermissionGroups.ts), matched
// by name and exact shape, so a renamed or widened group is never granted to
// a user nobody chose it for.
const OBSERVERS_GROUP_NAME = "Observers";

/**
 * The one message for every refused account creation, so the response does
 * not depend on whether a guessed password matched the existing account.
 */
export const EMAIL_UNAVAILABLE =
  "This email cannot be used for a new account. If the person already has an account, use Add existing user.";

/**
 * The answer to adding an existing user, the same whether or not an active
 * account uses the email.
 */
export const ADD_EXISTING_RESULT =
  "If an active account uses this email, it now has access to this Flight Program.";

/**
 * Requests one user may make per hour, counted separately for account
 * creation and for adding an existing user.
 */
export const ACCOUNT_REQUESTS_PER_HOUR = 20;

/** The refusal once a user has spent {@link ACCOUNT_REQUESTS_PER_HOUR}. */
export const ACCOUNT_REQUESTS_LIMITED =
  "Too many account requests. Try again within the hour.";

/**
 * Shortest password an administrator may set (ADR-0009, NIST SP 800-63B): a
 * length rule and no composition rules; passwordRules.ts also refuses common
 * passwords. Sign-in does not check the limits, so a shorter existing password
 * keeps working until the user's next reset.
 */
export const PASSWORD_MIN_LENGTH = 15;

/** Longest password an administrator may set. */
export const PASSWORD_MAX_LENGTH = 128;

/** Longest account name, counted after trimming, as it is stored. */
export const ACCOUNT_NAME_MAX_LENGTH = 150;

/** A permission group as its save form submits it. */
export interface GroupInput {
  programUuid?: string;
  programAdmin?: boolean;
  owner?: boolean;
  board?: boolean;
  name: string;
  aircraftIds: string[];
  /** The form's explicit "all aircraft in this program" choice (#34). */
  allAircraft?: boolean;
  permissions: Permission[];
}

/** A permission group's fields as stored. */
export interface GroupFields {
  programUuid: string;
  programAdmin: boolean;
  owner: boolean;
  board: boolean;
  name: string;
  aircraftIds: string[];
  permissions: Permission[];
}

/**
 * The groups a new member of a Flight Program gets: the chosen ones, plus the
 * program's Observers group when none of them grants read access.
 *
 * @returns The chosen ids without repeats, in order, then Observers if added.
 * @throws {Rejection} "Users can only be assigned groups in this Flight
 *   Program." for a group of another program or none; "Select a permission
 *   group; Observers read-only access is unavailable." without Observers.
 */
export function programGroupIds(
  groups: Group[],
  programUuid: string,
  requested: string[],
): string[] {
  assertProgramGroups(groups, programUuid, requested);
  const groupIds = [...new Set(requested)];
  if (grantsRead(groups, groupIds)) return groupIds;
  const observers = observersGroup(groups, programUuid);
  if (!observers)
    throw new Rejection(
      "Select a permission group; Observers read-only access is unavailable.",
    );
  return [...groupIds, observers.id];
}

/**
 * Refuses account administration to anyone but an active system
 * administrator.
 *
 * @throws {Rejection} "Administrator permission required."
 */
export function assertAccountAdministrator(user: Member): void {
  if (!user.active || !user.isAdmin)
    throw new Rejection("Administrator permission required.");
}

/**
 * Refuses a group id that no group has.
 *
 * @param groups - Every group the account could be given.
 * @throws {Rejection} "Group not found."
 */
export function assertKnownGroups(
  groups: Pick<Group, "id">[],
  groupIds: string[],
): void {
  if (groupIds.some((id) => !groups.some((g) => g.id === id)))
    throw new Rejection("Group not found.");
}

/**
 * Refuses a group a member cannot be given in a Flight Program: one of another
 * program, or an id no group has.
 *
 * @throws {Rejection} "Users can only be assigned groups in this Flight
 *   Program."
 */
export function assertProgramGroups(
  groups: Group[],
  programUuid: string,
  groupIds: string[],
): void {
  if (groupIds.some((id) => !isProgramGroup(groups, id, programUuid)))
    throw new Rejection(
      "Users can only be assigned groups in this Flight Program.",
    );
}

/**
 * Whether a member belongs to a Flight Program: any of their groups is one of
 * the program's, whatever its permissions.
 */
export function isProgramMember(
  groups: Group[],
  groupIds: string[],
  programUuid: string,
): boolean {
  return groupIds.some((id) => isProgramGroup(groups, id, programUuid));
}

/**
 * Whether any of the groups grants read access.
 */
export function grantsRead(groups: Group[], groupIds: string[]): boolean {
  return groups.some(
    (g) => groupIds.includes(g.id) && g.permissions.includes("read"),
  );
}

/**
 * Refuses a member's groups in a Flight Program when none grants read access,
 * without which the member cannot open the program.
 *
 * @throws {Rejection} "Select a group with read access."
 */
export function assertGrantsRead(groups: Group[], groupIds: string[]): void {
  if (!grantsRead(groups, groupIds))
    throw new Rejection("Select a group with read access.");
}

/**
 * Checks the groups that replace a member's access to a Flight Program. To
 * leave none, the member's access is removed instead.
 *
 * @throws {Rejection} "Select at least one permission group or remove program
 *   access." for none; then as {@link assertGrantsRead}.
 */
export function assertAccessGroups(groups: Group[], groupIds: string[]): void {
  if (!groupIds.length)
    throw new Rejection(
      "Select at least one permission group or remove program access.",
    );
  assertGrantsRead(groups, groupIds);
}

/**
 * A Flight Program's default read-only group: named "Observers", read only,
 * over every aircraft, and not an administrator group.
 *
 * @returns The group, or undefined when the program has none of that shape.
 */
export function observersGroup(
  groups: Group[],
  programUuid: string,
): Group | undefined {
  return groups.find(
    (g) =>
      g.programUuid === programUuid &&
      g.name === OBSERVERS_GROUP_NAME &&
      !g.programAdmin &&
      !g.aircraftIds.length &&
      g.permissions.length === 1 &&
      g.permissions[0] === "read",
  );
}

/**
 * Checks a permission group before it is saved and gives its stored fields.
 *
 * @param existing - The stored group; undefined for a new one.
 * @returns The fields: name trimmed, ids without repeats, flags false unless
 *   set.
 * @throws {Rejection} In order: as `assertGroupProgramFixed`; "Group name is
 *   required." (blank, or over 100 characters after trimming); "Write
 *   permissions also require read access."; as `validateOwnerGroup`,
 *   `validateBoardGroup` and `assertGroupAircraftChoice`; "Select a Flight
 *   Program for this group."
 */
export function normalizeGroup(
  input: GroupInput,
  existing: Group | undefined,
): GroupFields {
  assertGroupProgramFixed(existing, input);
  const name = input.name.trim();
  if (!name || name.length > GROUP_NAME_MAX_LENGTH)
    throw new Rejection("Group name is required.");
  if (!input.permissions.includes("read") && input.permissions.length)
    throw new Rejection("Write permissions also require read access.");
  validateOwnerGroup(input);
  validateBoardGroup(input);
  assertGroupAircraftChoice(existing, input);
  if (!input.programUuid)
    throw new Rejection("Select a Flight Program for this group.");
  return {
    programUuid: input.programUuid,
    programAdmin: input.programAdmin ?? false,
    owner: input.owner ?? false,
    board: input.board ?? false,
    name,
    aircraftIds: [...new Set(input.aircraftIds)],
    permissions: [...new Set(input.permissions)],
  };
}

/**
 * Checks a new account's email and name and gives them as stored.
 *
 * @returns The email trimmed and lower-cased, and the name trimmed.
 * @throws {Rejection} "A valid email and name are required." for an email
 *   that is not name@domain.tld, or a name blank or over 150 characters
 *   after trimming.
 */
export function normalizeAccount(
  email: string,
  name: string,
): { email: string; name: string } {
  const account = { email: email.trim().toLowerCase(), name: name.trim() };
  if (
    !EMAIL_PATTERN.test(account.email) ||
    !account.name ||
    account.name.length > ACCOUNT_NAME_MAX_LENGTH
  )
    throw new Rejection("A valid email and name are required.");
  return account;
}

function isProgramGroup(groups: Group[], id: string, programUuid: string) {
  return groups.some((g) => g.id === id && g.programUuid === programUuid);
}
