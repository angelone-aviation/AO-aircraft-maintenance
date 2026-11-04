/**
 * Responsibility: The date range a cost report covers: this calendar year,
 *   the twelve months ending today, or a custom range.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: zod; ../rejection.
 */
import { z } from "zod";
import { Rejection } from "../rejection";

const date = z.iso.date();

/** A date range for cost reports, inclusive, as ISO dates. */
export interface Period {
  from: string;
  to: string;
}

/**
 * The period a cost report covers.
 *
 * @param kind - "year" for this calendar year, "12m" for the twelve months
 *   ending today, or "custom".
 * @param custom - The custom range; ignored otherwise.
 * @throws {Rejection} "Choose a start and end date." or "Choose a start date
 *   on or before the end date." for a custom range.
 */
export function periodFor(
  kind: "year" | "12m" | "custom",
  today: string,
  custom?: Partial<Period>,
): Period {
  const year = today.slice(0, 4);
  if (kind === "year") return { from: `${year}-01-01`, to: `${year}-12-31` };
  if (kind === "12m") {
    const lastYear = `${Number(year) - 1}${today.slice(4)}`;
    // 2024-02-29 has no counterpart a year earlier; count from the 28th.
    const start = lastYear.endsWith("-02-29")
      ? lastYear.replace(/29$/, "28")
      : lastYear;
    return { from: addDays(start, 1), to: today };
  }
  const from = custom?.from ?? "",
    to = custom?.to ?? "";
  if (!date.safeParse(from).success || !date.safeParse(to).success)
    throw new Rejection("Choose a start and end date.");
  if (from > to)
    throw new Rejection("Choose a start date on or before the end date.");
  return { from, to };
}

/** Whether an ISO date falls in a period; any date does when there is none. */
export const inPeriod = (d: string, p?: Period) =>
  !p || (d >= p.from && d <= p.to);

const addDays = (d: string, days: number) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + days)).toISOString().slice(0, 10);
};
