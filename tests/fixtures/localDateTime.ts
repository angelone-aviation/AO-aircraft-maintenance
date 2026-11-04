/**
 * Responsibility: Formats a time the way a datetime-local input takes it.
 * Layer: Test. Fixture for the Playwright specs.
 * Dependencies: none.
 */

const MINUTE_MS = 60_000;

/**
 * Value for a datetime-local input: device-local wall-clock time, not UTC.
 * @param ms - Epoch milliseconds; defaults to now.
 * @returns `YYYY-MM-DDTHH:mm`, to the minute.
 */
export function localDateTime(ms = Date.now()) {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * MINUTE_MS)
    .toISOString()
    .slice(0, "YYYY-MM-DDTHH:mm".length);
}
