/**
 * Responsibility: Closing out an open discrepancy: deferring it under an MEL
 *   item or 14 CFR 91.213(d), when a deferral expires, and resolving it with
 *   the repair.
 * Layer: Domain. Zod schemas, rules and two appliers; no I/O, no React.
 * Dependencies: zod, ./model, ./changeLog, ./rejection.
 */
import { z } from "zod";
import { can, isLocalToday, type Discrepancy, type Snapshot } from "./model";
import { auditEntry } from "./changeLog";
import { Rejection } from "./rejection";

const DAY_MS = 86400000;
const MAX_RESOLUTION_LENGTH = 5000;

/**
 * MEL repair intervals by category, in calendar days excluding the day of
 * discovery (MMEL preamble repair categories). Category A intervals come from
 * the MEL item itself.
 */
export const MEL_CATEGORY_DAYS = { B: 3, C: 10, D: 120 } as const;

const placard = z
  .string()
  .trim()
  .min(1, "Enter the placard text.")
  .max(500, "Keep the placard text under 500 characters.");

/**
 * A deferral as the user enters it: an MEL item and repair category (days
 * from the MEL, 1–365, for category A only), or 91.213(d) inoperative
 * equipment confirmed not to be a hazard. Both need placard text.
 *
 * @throws {z.ZodError} From `parse()`, with a message for each field, and
 *   "Category A requires the number of days from the MEL; …" on `days`.
 */
export const deferralInputSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("mel"),
      melItem: z
        .string()
        .trim()
        .min(1, "Enter the MEL item number.")
        .max(50, "Keep the MEL item number under 50 characters."),
      category: z.enum(["A", "B", "C", "D"]),
      days: z
        .number()
        .int("Enter whole days.")
        .min(1, "Enter at least 1 day.")
        .max(365, "Category A deferrals are limited to 365 days.")
        .optional(),
      placard,
    }),
    z.strictObject({
      type: z.literal("91.213d"),
      placard,
      notHazard: z.literal(true, {
        message:
          "Confirm the inoperative equipment was determined not to be a hazard.",
      }),
    }),
  ])
  .refine(
    (d) => d.type !== "mel" || (d.category === "A") === (d.days !== undefined),
    {
      message:
        "Category A requires the number of days from the MEL; categories B, C and D use fixed intervals.",
      path: ["days"],
    },
  );

/** A parsed deferral input. */
export type DeferralInput = z.infer<typeof deferralInputSchema>;

/**
 * A recorded deferral: the input, who deferred it and when, and its expiry
 * date (MEL deferrals only).
 */
export type Deferral = DeferralInput & {
  deferredOn: string;
  deferredAt: number;
  deferredBy: string;
  deferredByName: string;
  expiresOn?: string;
};

/**
 * A request to defer one discrepancy, dated the day it is made.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field or deferral.
 */
export const deferCommandSchema = z.strictObject({
  uuid: z.string().min(1),
  deferredOn: z.iso.date(),
  deferral: deferralInputSchema,
});

/** A parsed defer command. */
export type DeferCommand = z.infer<typeof deferCommandSchema>;

/**
 * Works out when a deferral expires.
 *
 * @param input - The deferral; category A must carry its days.
 * @param deferredOn - The deferral date (YYYY-MM-DD).
 * @returns The deferral date plus the category's days for an MEL item, or
 *   undefined for 91.213(d), which does not expire.
 */
export function deferralExpiry(
  input: DeferralInput,
  deferredOn: string,
): string | undefined {
  if (input.type !== "mel") return undefined;
  return addDays(
    deferredOn,
    input.category === "A" ? input.days! : MEL_CATEGORY_DAYS[input.category],
  );
}

/**
 * Counts the days a deferral has left.
 *
 * @param d - The deferral's expiry date, if any.
 * @param today - The day to count from (YYYY-MM-DD).
 * @returns Days left including today: 0 on the last valid day, negative once
 *   expired; undefined when the deferral does not expire.
 */
export function deferralDaysRemaining(
  d: Pick<Deferral, "expiresOn">,
  today: string,
): number | undefined {
  if (d.expiresOn === undefined) return undefined;
  const ms =
    Date.parse(d.expiresOn + "T00:00:00Z") - Date.parse(today + "T00:00:00Z");
  return Math.round(ms / DAY_MS);
}

/**
 * Tells whether a deferral has expired.
 *
 * @param d - The deferral's expiry date, if any.
 * @param today - The day to judge on (YYYY-MM-DD).
 * @returns True from the day after the expiry date; false without one.
 */
export const deferralExpired = (
  d: Pick<Deferral, "expiresOn">,
  today: string,
) => (deferralDaysRemaining(d, today) ?? 0) < 0;

/**
 * Names a deferral for status reasons and lists.
 *
 * @param d - The deferral.
 * @returns "MEL <item> (Category <c>)", or "14 CFR 91.213(d) inoperative
 *   equipment".
 */
export function deferralLabel(d: Deferral) {
  return d.type === "mel"
    ? `MEL ${d.melItem} (Category ${d.category})`
    : "14 CFR 91.213(d) inoperative equipment";
}

/**
 * Defers an open discrepancy, recording who deferred it, when, and its expiry,
 * and adds a "discrepancy.deferred" change-log entry: the placard as reason,
 * the report before and the deferral after.
 *
 * @param s - Snapshot holding the discrepancy and the user; only its change
 *   log changes.
 * @param raw - The command, parsed with {@link deferCommandSchema}.
 * @param now - The time recorded as `deferredAt` and as the entry's time.
 * @returns A copy of the discrepancy; the caller persists it.
 * @throws {Rejection} "Report not found.", "You do not have permission for
 *   this aircraft." (needs `resolve`), "Only open discrepancies can be
 *   deferred.", "This discrepancy is already deferred.", "The deferral date
 *   must be today."; {z.ZodError} for a bad command.
 */
export function deferDiscrepancy(
  s: Snapshot,
  raw: unknown,
  now = Date.now(),
): Discrepancy {
  const command = deferCommandSchema.parse(raw);
  const d = findResolvableReport(s, command.uuid);
  if (d.status !== "open")
    throw new Rejection("Only open discrepancies can be deferred.");
  if (d.deferral) throw new Rejection("This discrepancy is already deferred.");
  if (!isLocalToday(command.deferredOn, now))
    throw new Rejection("The deferral date must be today.");
  const deferral: Deferral = {
    ...command.deferral,
    deferredOn: command.deferredOn,
    deferredAt: now,
    deferredBy: s.user.id,
    deferredByName: s.user.name,
    expiresOn: deferralExpiry(command.deferral, command.deferredOn),
  };
  recordReportChange(s, d, "deferred", deferral.placard, deferral, now);
  return { ...d, deferral };
}

/**
 * Resolves an open discrepancy with the repair that cleared it, and adds a
 * "discrepancy.resolved" change-log entry: the repair as entered as reason,
 * the report before and its {@link resolvedFields} after.
 *
 * @param s - Snapshot holding the discrepancy and the user; only its change
 *   log changes.
 * @param uuid - The discrepancy.
 * @param resolution - The repair, stored trimmed.
 * @param now - The time recorded as `resolvedAt` and as the entry's time.
 * @returns A copy of the discrepancy, resolved by the user; the caller
 *   persists it.
 * @throws {Rejection} "Report not found.", "You do not have permission for
 *   this aircraft." (needs `resolve`), "Describe the repair in 1–5000
 *   characters." (blank, or longer before trimming), "This report is already
 *   resolved."
 */
export function resolveDiscrepancy(
  s: Snapshot,
  uuid: string,
  resolution: string,
  now = Date.now(),
): Discrepancy {
  const d = findResolvableReport(s, uuid);
  if (!resolution.trim() || resolution.length > MAX_RESOLUTION_LENGTH)
    throw new Rejection(
      `Describe the repair in 1–${MAX_RESOLUTION_LENGTH} characters.`,
    );
  if (d.status === "resolved")
    throw new Rejection("This report is already resolved.");
  const next: Discrepancy = {
    ...d,
    status: "resolved",
    resolution: resolution.trim(),
    resolvedBy: s.user.id,
    resolvedAt: now,
  };
  recordReportChange(s, d, "resolved", resolution, resolvedFields(next), now);
  return next;
}

/**
 * The fields resolving sets, in the order the change log has always stored
 * them.
 *
 * @param d - The resolved report.
 * @returns `status`, `resolution`, `resolvedBy` and `resolvedAt`, in that
 *   order.
 */
export function resolvedFields(d: Discrepancy) {
  const { status, resolution, resolvedBy, resolvedAt } = d;
  return { status, resolution, resolvedBy, resolvedAt };
}

// Deferring and resolving both need the report and the resolve permission on
// its aircraft.
function findResolvableReport(s: Snapshot, uuid: string) {
  const d = s.discrepancies.find((d) => d.uuid === uuid);
  if (!d) throw new Rejection("Report not found.");
  if (!can(s, d.aircraftUuid, "resolve"))
    throw new Rejection("You do not have permission for this aircraft.");
  return d;
}

function recordReportChange(
  s: Snapshot,
  d: Discrepancy,
  change: "deferred" | "resolved",
  reason: string,
  after: unknown,
  now: number,
) {
  s.audit.unshift(
    auditEntry(
      s,
      {
        action: `discrepancy.${change}`,
        entityUuid: d.uuid,
        aircraftUuid: d.aircraftUuid,
        reason,
        before: d,
        after,
      },
      now,
    ),
  );
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
