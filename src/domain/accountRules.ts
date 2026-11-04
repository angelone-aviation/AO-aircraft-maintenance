/**
 * Responsibility: The rules, limits and fixed answers of account
 *   administration: accounts, permission groups, and who gets which group.
 * Layer: Domain. Pure functions and constants; no I/O, no React.
 * Dependencies: ./model (types), ./groupAircraft, ./ownerView, ./rejection.
 *
 * Shared by the Convex functions and the offline demo adapter so both refuse
 * and answer account-administration requests the same way (issue #29).
 */
import type { Group, Permission } from "./model";
import {
  assertGroupAircraftChoice,
  assertGroupProgramChange,
} from "./groupAircraft";
import { validateOwnerGroup } from "./ownerView";
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
  if (requested.some((id) => !isProgramGroup(groups, id, programUuid)))
    throw new Rejection(
      "Users can only be assigned groups in this Flight Program.",
    );
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
 * Whether any of the groups grants read access.
 */
export function grantsRead(groups: Group[], groupIds: string[]): boolean {
  return groups.some(
    (g) => groupIds.includes(g.id) && g.permissions.includes("read"),
  );
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
 * @param systemAdmin - Whether the user is a system administrator.
 * @returns The fields (name trimmed, ids without repeats, flags false unless
 *   set), and `assigned`: true when this save gives an unscoped group its
 *   first Flight Program.
 * @throws {Rejection} In order: as `assertGroupProgramChange`; "Group name is
 *   required." (blank, or over 100 characters after trimming); "Write
 *   permissions also require read access."; as `validateOwnerGroup` and
 *   `assertGroupAircraftChoice`; "Select a Flight Program for this group."
 */
export function normalizeGroup(
  input: GroupInput,
  existing: Group | undefined,
  systemAdmin: boolean,
): { fields: GroupFields; assigned: boolean } {
  const assigned = assertGroupProgramChange(existing, input, systemAdmin);
  const name = input.name.trim();
  if (!name || name.length > GROUP_NAME_MAX_LENGTH)
    throw new Rejection("Group name is required.");
  if (!input.permissions.includes("read") && input.permissions.length)
    throw new Rejection("Write permissions also require read access.");
  validateOwnerGroup(input);
  assertGroupAircraftChoice(existing, input);
  if (!input.programUuid)
    throw new Rejection("Select a Flight Program for this group.");
  const fields = {
    programUuid: input.programUuid,
    programAdmin: input.programAdmin ?? false,
    owner: input.owner ?? false,
    name,
    aircraftIds: [...new Set(input.aircraftIds)],
    permissions: [...new Set(input.permissions)],
  };
  return { fields, assigned };
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
