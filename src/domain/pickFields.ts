/**
 * Responsibility: Copies the fields of a record named in a list, the step the
 *   reduced views (board view, owner portal) build their whitelists from.
 * Layer: Domain. Pure function; no I/O, no React.
 * Dependencies: none.
 */

/**
 * The named fields a record holds, and no other.
 *
 * @param record - The record to copy from.
 * @param keys - The fields to copy; one the record lacks is left out.
 * @returns A new object with only those fields.
 */
export function pickFields<T extends object, K extends keyof T>(
  record: T,
  keys: readonly K[],
): Pick<T, K> {
  const picked = {} as Pick<T, K>;
  for (const key of keys) if (key in record) picked[key] = record[key];
  return picked;
}
