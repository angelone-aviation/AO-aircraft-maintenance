/**
 * Responsibility: The FAA DRS API key an administrator saves, and the renewal
 *   reminder for it.
 * Layer: Domain. Pure zod schema and functions; no I/O, no React (a `today`
 *   left to its default reads the clock).
 * Dependencies: zod, src/domain/model.ts (localDate).
 */
import { z } from "zod";
import { localDate } from "./model";

/**
 * The key warns from this many days before expiry, and keeps warning after
 * it (docs/airworthiness.md "Renewal reminders").
 */
export const RENEWAL_WARNING_DAYS = 60;
const MS_PER_DAY = 86_400_000;

/**
 * A replacement FAA API key with the expiry date the FAA gave for it.
 * `version` is the stored credential's version, so a stale form is refused.
 */
export const faaCredentialInput = z.object({
  key: z
    .string()
    .trim()
    .min(16)
    .max(512)
    .regex(/^[A-Za-z0-9._-]+$/, "Enter the FAA API key without spaces."),
  expiresOn: z.iso.date(),
  version: z.number().int().nonnegative(),
});

/** What the snapshot says about the stored key; never the key itself. */
export interface FaaCredentialStatus {
  configured: boolean;
  /** ISO date, or "" when none was recorded. */
  expiresOn: string;
  version: number;
}

/**
 * Builds the renewal notice for the stored FAA API key.
 *
 * @param status - The stored key's status; undefined when there is none.
 * @param today - ISO date; the local date by default.
 * @returns `warning` when the key is missing, has no expiry, or expires in 60
 *   days or fewer (expired included), with the notice to show.
 */
export function faaRenewal(
  status: FaaCredentialStatus | undefined,
  today = localDate(),
): { warning: boolean; message: string } {
  if (!status?.configured)
    return { warning: true, message: "FAA API key is not configured." };
  if (!status.expiresOn)
    return {
      warning: true,
      message: "FAA API key renewal date is not recorded.",
    };
  const days = Math.ceil(
    (Date.parse(status.expiresOn) - Date.parse(today)) / MS_PER_DAY,
  );
  return {
    warning: days <= RENEWAL_WARNING_DAYS,
    message: describeExpiry(status.expiresOn, days),
  };
}

function describeExpiry(expiresOn: string, days: number) {
  if (days < 0)
    return `FAA API key expired on ${expiresOn}. Renew it to continue AD checks.`;
  if (days === 0)
    return "FAA API key expires today. Renew it to continue AD checks.";
  const reminder =
    days <= RENEWAL_WARNING_DAYS
      ? " Renew it before AD monitoring is interrupted."
      : "";
  return `FAA API key expires on ${expiresOn} (${days} days remaining).${reminder}`;
}
