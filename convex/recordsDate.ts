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
  const parts = zoneParts(recordsZone(), now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The moment a records-time-zone day begins: 00:00 on the date in the zone
 * {@link recordsDate} uses.
 *
 * @param date - The date as YYYY-MM-DD.
 * @returns Epoch ms of that midnight. In a zone whose clocks jump over
 *   midnight, the first moment of the date.
 */
export function recordsMidnight(date: string): number {
  const zone = recordsZone();
  const utcMidnight = Date.parse(date + "T00:00:00Z");
  // The zone's offset can differ between UTC midnight and local midnight on
  // a daylight-saving day, so the guess is corrected once with the offset at
  // the guess itself.
  const guess = utcMidnight - zoneOffset(zone, utcMidnight);
  return utcMidnight - zoneOffset(zone, guess);
}

function recordsZone(): string {
  const configured = process.env.RECORDS_TIME_ZONE;
  if (!configured) return DEFAULT_RECORDS_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configured });
    return configured;
  } catch (error) {
    // Intl throws a RangeError for a name it does not know; anything else is
    // a fault to surface.
    if (!(error instanceof RangeError)) throw error;
    console.error(
      "RECORDS_TIME_ZONE is not an IANA time zone; using",
      DEFAULT_RECORDS_TIME_ZONE,
    );
    return DEFAULT_RECORDS_TIME_ZONE;
  }
}

// How far the zone's wall clock is ahead of UTC at a moment, in ms.
function zoneOffset(timeZone: string, at: number): number {
  const p = zoneParts(timeZone, at);
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

function zoneParts(timeZone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((x) => x.type === type)?.value ?? "";
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}
