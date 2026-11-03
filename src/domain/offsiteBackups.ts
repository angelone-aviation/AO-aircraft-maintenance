// Freshness of the nightly off-site backup (ADR-0008, "Freshness alarm").
// The backup job records each successful upload with
// backups:recordOffsiteCopy; Settings → System and the daily alert digest
// read the newest one through this rule.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The newest copy may be this old before system administrators are warned. */
export const OFFSITE_STALE_AFTER_MS = 36 * HOUR;

/** The newest recorded off-site copy, as system administrators see it. */
export interface OffsiteCopy {
  completedAt: number;
  /** Size of the encrypted object in R2. */
  bytes: number;
  objectKey: string;
  /** Set only on the night that copy also made the monthly archive. */
  monthlyKey?: string;
  envUploaded: boolean;
  /** When the newest monthly archive was made, if there is one. */
  monthlyCompletedAt?: number;
}

export type OffsiteStatus = "ok" | "stale" | "none";
export interface OffsiteFreshness {
  status: OffsiteStatus;
  /** One plain sentence for Settings and the alert email. */
  message: string;
}

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
/** "45 minutes", "37 hours", "2 days": whole units, rounded down. */
function span(ms: number) {
  if (ms < HOUR) return count(Math.floor(ms / MINUTE), "minute");
  if (ms < 2 * DAY) return count(Math.floor(ms / HOUR), "hour");
  return count(Math.floor(ms / DAY), "day");
}

/** `ok` until the newest copy is more than 36 hours old, then `stale`;
 * `none` before the first copy is recorded. */
export function offsiteFreshness(
  latest: Pick<OffsiteCopy, "completedAt"> | null | undefined,
  now: number,
): OffsiteFreshness {
  if (!latest)
    return {
      status: "none",
      message: "No off-site backup has been recorded yet.",
    };
  // The job's clock may run slightly ahead of the server's.
  const age = Math.max(0, now - latest.completedAt);
  if (age > OFFSITE_STALE_AFTER_MS)
    return {
      status: "stale",
      message: `No off-site backup for ${span(age)}. Check the Nightly backup job in GitHub Actions.`,
    };
  return {
    status: "ok",
    message:
      age < MINUTE
        ? "Last off-site backup less than a minute ago."
        : `Last off-site backup ${span(age)} ago.`,
  };
}
