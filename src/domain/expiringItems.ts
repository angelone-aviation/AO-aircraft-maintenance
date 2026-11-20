/**
 * Responsibility: Expiring dates (GLOSSARY "Expiring date") a Flight Program
 *   or the deployment must renew: their schema, the save and archive
 *   applier, and whether each is coming due or has passed.
 * Layer: Domain. Pure zod schema and functions; no I/O, no React.
 * Dependencies: zod, ./model (types), ./programs, ./changeLog,
 *   ./commandRequest, ./rejection, ./faaCredential.
 *
 * An item without a Flight Program is system-wide (a Cloudflare token,
 * security.txt): only system administrators see and edit it. A
 * program's items are its administrators'. Archiving hides an item and keeps
 * it, as every record here is kept.
 */
import { z } from "zod";
import { auditEntry } from "./changeLog";
import { requestUuidField } from "./commandRequest";
import {
  RENEWAL_WARNING_DAYS,
  type FaaCredentialStatus,
} from "./faaCredential";
import type { Snapshot } from "./model";
import {
  activeProgram,
  canSeeExpiringItem,
  programPermission,
} from "./programs";
import { Rejection } from "./rejection";

/** What an expiring date is for, as {@link expiringKindLabels} names it. */
export const EXPIRING_KINDS = [
  "insurance",
  "registration",
  "service-key",
  "secret",
  "other",
] as const;

/** One of {@link EXPIRING_KINDS}. */
export type ExpiringKind = (typeof EXPIRING_KINDS)[number];

/** The label each kind shows in lists and alerts. */
export const expiringKindLabels: Record<ExpiringKind, string> = {
  insurance: "Insurance",
  registration: "Registration",
  "service-key": "Service key",
  secret: "Secret",
  other: "Other",
};

/** How many days before expiry an item alerts, unless it says otherwise. */
export const DEFAULT_WARN_DAYS = 60;

/** The computed row for the FAA DRS API key; never stored. */
export const FAA_KEY_ITEM_UUID = "faa-api-key";

const LABEL_MAX_LENGTH = 120;
const NOTE_MAX_LENGTH = 1000;
// Two years: longer gives no warning at all for yearly renewals.
const MAX_WARN_DAYS = 730;
const DAY_MS = 86_400_000;
const STALE = "This expiring date changed. Refresh and try again.";

/**
 * One expiring date. `programUuid` absent means system-wide. `version` is 0
 * for a new item; every save and archive raises it by one.
 *
 * @throws {z.ZodError} From `parse()`: a label of 1–120 characters, a
 *   YYYY-MM-DD date, warn days 0–730 (60 by default), a note of at most
 *   1000 characters.
 */
export const expiringItemSchema = z.object({
  uuid: z.string().uuid(),
  programUuid: z.string().min(1).optional(),
  kind: z.enum(EXPIRING_KINDS),
  label: z.string().trim().min(1).max(LABEL_MAX_LENGTH),
  expiresOn: z.iso.date(),
  warnDays: z
    .number()
    .int()
    .min(0)
    .max(MAX_WARN_DAYS)
    .default(DEFAULT_WARN_DAYS),
  note: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
  aircraftUuid: z.string().min(1).optional(),
  version: z.number().int().nonnegative(),
  archived: z.boolean().optional(),
});

/** A parsed expiring date. */
export type ExpiringItem = z.infer<typeof expiringItemSchema>;

/**
 * The commands on expiring dates: save (create or edit) an item, or archive
 * one. `version` is the stored version the form was opened with.
 *
 * @throws {z.ZodError} From `parse()` on a malformed command.
 */
export const expiringCommandSchema = z.discriminatedUnion("action", [
  z.object({
    ...requestUuidField,
    action: z.literal("save"),
    item: expiringItemSchema,
  }),
  z.object({
    ...requestUuidField,
    action: z.literal("archive"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
  }),
]);

/** A parsed expiring-date command. */
export type ExpiringCommand = z.infer<typeof expiringCommandSchema>;

/** Where an expiring date stands today. */
export type ExpiringStatus = "ok" | "expiring" | "expired";

/**
 * Applies a save or archive to the snapshot's expiring dates and adds the
 * change-log row (`expiring-date.saved` or `expiring-date.archived`, with the
 * item before and after, under the command's request id when it has one) to
 * `s.audit`, newest first.
 *
 * @param s - The working snapshot; `expiringItems` and `audit` are changed.
 * @param command - The parsed command.
 * @param now - When the change happened (epoch ms).
 * @returns The item as stored after the command.
 * @throws {Rejection} "Administrator permission required." for a system-wide
 *   item by anyone else; "Expiring dates belong to the active Flight
 *   Program." and "Flight Program administrator required." for a program
 *   item; "Expiring date not found."; "This expiring date changed. Refresh
 *   and try again." for a stale version; "Expiring dates cannot move between
 *   Flight Programs."; "Aircraft must belong to this Flight Program."; "This
 *   expiring date is already archived."
 */
export function applyExpiringCommand(
  s: Snapshot,
  command: ExpiringCommand,
  now = Date.now(),
): ExpiringItem {
  const items = s.expiringItems ?? [];
  const uuid = command.action === "save" ? command.item.uuid : command.uuid;
  const existing = items.find((i) => i.uuid === uuid);
  const next =
    command.action === "save"
      ? savedItem(s, command.item, existing)
      : archivedItem(s, command.version, existing);
  s.expiringItems = existing
    ? items.map((i) => (i.uuid === uuid ? next : i))
    : [...items, next];
  s.audit.unshift(
    auditEntry(
      s,
      {
        uuid: command.requestUuid,
        action: `expiring-date.${command.action === "save" ? "saved" : "archived"}`,
        entityUuid: uuid,
        aircraftUuid: next.aircraftUuid,
        programUuid: next.programUuid,
        before: existing,
        after: next,
      },
      now,
    ),
  );
  return next;
}

/**
 * Where an expiring date stands on a day.
 *
 * @param item - Its expiry date and warning window.
 * @param today - A YYYY-MM-DD date.
 * @returns "expired" from the day after `expiresOn` (GLOSSARY "Overdue"
 *   counts calendar limits the same way), "expiring" from `warnDays` before
 *   it through the date itself, else "ok".
 */
export function expiringStatus(
  item: Pick<ExpiringItem, "expiresOn" | "warnDays">,
  today: string,
): ExpiringStatus {
  const remaining = daysUntil(today, item.expiresOn);
  if (remaining < 0) return "expired";
  return remaining <= item.warnDays ? "expiring" : "ok";
}

/**
 * Whole days from one date to another.
 *
 * @returns Negative once `date` has passed; 0 on the day.
 */
export function daysUntil(today: string, date: string): number {
  return Math.round((Date.parse(date) - Date.parse(today)) / DAY_MS);
}

/**
 * The FAA DRS API key as a read-only expiring date, so it lists with the
 * deployment's other system-wide dates.
 *
 * @param status - The stored key's status, from the snapshot.
 * @returns The row, or undefined until a key with a recorded renewal date is
 *   saved (the FAA key panel already warns about those).
 */
export function faaKeyExpiringItem(
  status: FaaCredentialStatus | undefined,
): ExpiringItem | undefined {
  if (!status?.configured || !status.expiresOn) return undefined;
  return {
    uuid: FAA_KEY_ITEM_UUID,
    kind: "service-key",
    label: "FAA DRS API key",
    expiresOn: status.expiresOn,
    warnDays: RENEWAL_WARNING_DAYS,
    note: "Renew it on the FAA website, then a system administrator enters the new key in Settings → System.",
    version: status.version,
  };
}

/**
 * The expiring dates the user sees, current (unarchived) and in order.
 *
 * @param s - The scoped snapshot.
 * @param scope - "system" for the deployment's dates (with the FAA key row),
 *   "program" for the active Flight Program's.
 * @returns Soonest expiry first, then by label; none the user may not see.
 */
export function listExpiringItems(
  s: Snapshot,
  scope: "system" | "program",
): ExpiringItem[] {
  const faa =
    scope === "system" ? faaKeyExpiringItem(s.faaCredential) : undefined;
  const stored = (s.expiringItems ?? []).filter(
    (i) =>
      !i.archived &&
      (scope === "system") === (i.programUuid === undefined) &&
      canSeeExpiringItem(s, i),
  );
  return [...(faa && s.user.isAdmin ? [faa] : []), ...stored].sort(
    (x, y) =>
      x.expiresOn.localeCompare(y.expiresOn) || x.label.localeCompare(y.label),
  );
}

function savedItem(
  s: Snapshot,
  item: ExpiringItem,
  existing: ExpiringItem | undefined,
): ExpiringItem {
  if (existing && existing.programUuid !== item.programUuid)
    throw new Rejection("Expiring dates cannot move between Flight Programs.");
  assertWriter(s, item.programUuid);
  assertFresh(item.version, existing);
  if (existing?.archived)
    throw new Rejection("This expiring date is already archived.");
  assertAircraftInProgram(s, item);
  return { ...item, archived: undefined, version: item.version + 1 };
}

function archivedItem(
  s: Snapshot,
  version: number,
  existing: ExpiringItem | undefined,
): ExpiringItem {
  if (!existing) throw new Rejection("Expiring date not found.");
  assertWriter(s, existing.programUuid);
  assertFresh(version, existing);
  if (existing.archived)
    throw new Rejection("This expiring date is already archived.");
  return { ...existing, archived: true, version: existing.version + 1 };
}

// The same messages the server's own checks use, so a user cannot tell a
// refused program item from one they never had access to.
function assertWriter(s: Snapshot, programUuid: string | undefined) {
  if (programUuid === undefined) {
    if (!s.user.isAdmin)
      throw new Rejection("Administrator permission required.");
    return;
  }
  if (programUuid !== activeProgram(s))
    throw new Rejection("Expiring dates belong to the active Flight Program.");
  if (!programPermission(s, "admin"))
    throw new Rejection("Flight Program administrator required.");
}

function assertFresh(version: number, existing: ExpiringItem | undefined) {
  if (version !== (existing?.version ?? 0)) throw new Rejection(STALE);
}

function assertAircraftInProgram(s: Snapshot, item: ExpiringItem) {
  if (!item.aircraftUuid) return;
  const aircraft = s.aircraft.find((a) => a.uuid === item.aircraftUuid);
  if (!item.programUuid || aircraft?.programUuid !== item.programUuid)
    throw new Rejection("Aircraft must belong to this Flight Program.");
}
