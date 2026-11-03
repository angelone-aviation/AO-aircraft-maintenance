/**
 * Responsibility: The freshness rule for the nightly off-site backup (ADR-0008
 *   "Freshness alarm"), and the sentence that reports it.
 * Layer: Domain. Pure types and functions; no I/O, no React.
 * Dependencies: None.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAYS_FROM = 2 * DAY;

/** How old the newest copy may be before system administrators are warned. */
export const OFFSITE_STALE_AFTER_MS = 36 * HOUR;

/** The newest recorded off-site copy, as system administrators see it. */
export interface OffsiteCopy {
  completedAt: number;
  /** Size of the encrypted object in R2. */
  bytes: number;
  objectKey: string;
  /** Set only on the night that copy also made the monthly archive. */
  monthlyKey?: string;
  /** Whether that night also uploaded the environment variables, as it does
   * only when they changed. */
  envUploaded: boolean;
  /** When the newest monthly archive was made, if there is one. */
  monthlyCompletedAt?: number;
}

/** `ok`, `stale` once the newest copy is too old, or `none` before any. */
export type OffsiteStatus = "ok" | "stale" | "none";

/** The backup's status, with one plain sentence for system administrators. */
export interface OffsiteFreshness {
  status: OffsiteStatus;
  message: string;
}

/**
 * Rates the newest off-site copy against the 36-hour limit, and words its age
 * in whole minutes, hours (under two days) or days, rounded down.
 *
 * @param latest - The newest recorded copy, or null/undefined before the first.
 * @param now - The current time (epoch ms). A copy stamped later, by a backup
 *   job whose clock runs ahead, counts as just made.
 * @returns `none` before the first copy; `ok` up to and including 36 hours;
 *   `stale` after that, with a message pointing to the backup job.
 */
export function offsiteFreshness(
  latest: Pick<OffsiteCopy, "completedAt"> | null | undefined,
  now: number,
): OffsiteFreshness {
  if (!latest)
    return {
      status: "none",
      message: "No off-site backup has been recorded yet.",
    };
  const age = Math.max(0, now - latest.completedAt);
  if (age > OFFSITE_STALE_AFTER_MS)
    return {
      status: "stale",
      message: `No off-site backup for ${describeAge(age)}. Check the Nightly backup job in GitHub Actions.`,
    };
  const ago = age < MINUTE ? "less than a minute" : describeAge(age);
  return { status: "ok", message: `Last off-site backup ${ago} ago.` };
}

function describeAge(ms: number): string {
  if (ms < HOUR) return pluralize(Math.floor(ms / MINUTE), "minute");
  if (ms < DAYS_FROM) return pluralize(Math.floor(ms / HOUR), "hour");
  return pluralize(Math.floor(ms / DAY), "day");
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
