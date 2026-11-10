/**
 * Responsibility: The calendar date in the deployment's records time zone,
 *   the server's one notion of "today".
 * Layer: Server. Reads the RECORDS_TIME_ZONE environment variable; no
 *   database, no network.
 * Dependencies: none.
 *
 * Convex runs in UTC, where the date changes in the evening across the
 * Americas. A calendar limit is overdue only from the day after its due
 * date (GLOSSARY "Overdue"), so judging it on the UTC date announced
 * "overdue" and "grounded" hours before the program's own day had ended.
 */

/** The records time zone when RECORDS_TIME_ZONE is unset or not a zone. */
export const DEFAULT_RECORDS_TIME_ZONE = "America/New_York";

/**
 * The calendar date where the deployment keeps its records: the zone named
 * by RECORDS_TIME_ZONE (an IANA name, as the nightly records workbook reads
 * it), or US Eastern time.
 *
 * @param now - The time (epoch ms).
 * @returns The date as YYYY-MM-DD. A RECORDS_TIME_ZONE that is not a time
 *   zone is logged and the default zone used, so alerts keep going out.
 */
export function recordsDate(now = Date.now()): string {
  const configured = process.env.RECORDS_TIME_ZONE;
  if (!configured) return zoneDate(DEFAULT_RECORDS_TIME_ZONE, now);
  try {
    return zoneDate(configured, now);
  } catch (error) {
    // Intl throws a RangeError for a name it does not know; anything else is
    // a fault to surface.
    if (!(error instanceof RangeError)) throw error;
    console.error(
      "RECORDS_TIME_ZONE is not an IANA time zone; using",
      DEFAULT_RECORDS_TIME_ZONE,
    );
    return zoneDate(DEFAULT_RECORDS_TIME_ZONE, now);
  }
}

function zoneDate(timeZone: string, now: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
