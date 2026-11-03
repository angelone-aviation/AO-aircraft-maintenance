/**
 * Responsibility: Writes records as CSV text that spreadsheets open safely.
 * Layer: Domain. Pure function; no I/O, no React.
 * Dependencies: None.
 */

// Excel opens a CSV as UTF-8 only when it starts with a byte-order mark.
const UTF8_BOM = "\uFEFF";

// Text a spreadsheet would run as a formula (OWASP "CSV injection").
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Renders records as a CSV file for download.
 *
 * @param rows - Records to export; a key a record lacks leaves its cell empty.
 * @returns A UTF-8 byte-order mark, a header row of every key in first-seen
 *   order, then one line per record, joined with CRLF. Every cell is
 *   double-quoted: null and undefined become "", objects become JSON, and text
 *   starting with = + - @, tab or CR gets a leading "'" so it stays text.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const lines = [
    keys.map(formatCell),
    ...rows.map((row) => keys.map((key) => formatCell(row[key]))),
  ];
  return UTF8_BOM + lines.map((cells) => cells.join(",")).join("\r\n");
}

function formatCell(value: unknown): string {
  const text = stringifyValue(value);
  // Numbers are data, not formulas; only text is neutralized.
  const safe =
    typeof value !== "number" && FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
