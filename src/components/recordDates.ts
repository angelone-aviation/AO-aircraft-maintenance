/**
 * Responsibility: How the record screens write a date and a time.
 * Layer: UI. Formatting in the user's locale; no state, no React.
 * Dependencies: none.
 */

/** The record screens' time of day: 24-hour hours and minutes. */
export const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * A day in the user's locale, such as "Nov 12, 2026".
 *
 * @param at - Epoch ms, or a date string `Date` parses.
 */
export const shortDate = (at: number | string) =>
  new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * A day and a 24-hour time, such as "Nov 12, 2026 · 14:50".
 *
 * @param at - Epoch ms, or a date string `Date` parses.
 */
export const dateTime = (at: number | string) =>
  `${shortDate(at)} · ${new Date(at).toLocaleTimeString(undefined, TIME_OPTIONS)}`;
