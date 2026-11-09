/**
 * Responsibility: Lists the fields on which two copies of a record differ,
 *   with human labels and display values, for a stale-save review or a held
 *   flight's comparison with the aircraft.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: none.
 */

/** How one field is shown: its label, and how its value becomes text. */
export interface FieldSpec {
  label: string;
  /** Formats a value; omit for the default text. */
  format?: (value: unknown) => string;
}

/** Labels (or full specs) by field; unlisted fields get a label from their
 * name, as {@link fieldLabel} makes it. */
export type FieldSpecs<T> = { readonly [K in keyof T]?: string | FieldSpec };

/** One field that differs: who changed it, and both values as text. */
export interface FieldDifference {
  key: string;
  label: string;
  /** The value in the user's copy. */
  mine: string;
  /** The value in the other copy. */
  theirs: string;
  /** Who changed the field since the copy both started from; unset without
   * that copy. */
  changedBy?: "you" | "them" | "both";
}

/** Options for {@link fieldDiff}. */
export interface FieldDiffOptions<T> {
  /** Labels and formats by field. */
  specs?: FieldSpecs<T>;
  /** The copy both sides started from, to say who changed each field. */
  loaded?: T;
  /** Fields never compared; defaults to {@link DEFAULT_IGNORED_FIELDS}. */
  ignore?: readonly string[];
}

/** Bookkeeping fields a review never shows. */
export const DEFAULT_IGNORED_FIELDS: readonly string[] = [
  "version",
  "updatedAt",
  "createdAt",
  "programUuid",
];

/** Shown for a field one side leaves unset. */
export const EMPTY_FIELD_TEXT = "—";

/**
 * The fields of `mine` whose value differs from `theirs`, in the order they
 * appear on `mine`; nested values compare by their JSON.
 *
 * @param mine - The user's copy, whose fields are compared.
 * @param theirs - The other copy.
 * @param options - Labels, the loaded copy and the fields to skip.
 * @returns One entry per differing field, none for identical copies.
 */
export function fieldDiff<T extends object>(
  mine: T,
  theirs: T,
  options: FieldDiffOptions<T> = {},
): FieldDifference[] {
  const ignore = options.ignore ?? DEFAULT_IGNORED_FIELDS;
  const differences: FieldDifference[] = [];
  for (const key of Object.keys(mine) as (keyof T & string)[]) {
    if (ignore.includes(key) || same(mine[key], theirs[key])) continue;
    const spec = specOf(key, options.specs?.[key]);
    const changedBy = changer(mine[key], theirs[key], options.loaded, key);
    differences.push({
      key,
      label: spec.label,
      mine: formatField(mine[key], spec),
      theirs: formatField(theirs[key], spec),
      ...(changedBy && { changedBy }),
    });
  }
  return differences;
}

/**
 * A readable label for a field name: "lastSeconds" reads "Last seconds".
 *
 * @param key - The field name, in camelCase.
 * @returns The words, the first capitalised, the rest lower case.
 */
export function fieldLabel(key: string) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The default text for a value: a blank (unset, null or "") reads
 * {@link EMPTY_FIELD_TEXT}, booleans "Yes" or "No", objects their JSON.
 *
 * @param value - The field's value.
 */
export function fieldText(value: unknown): string {
  if (value === undefined || value === null || value === "")
    return EMPTY_FIELD_TEXT;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function specOf(key: string, spec: string | FieldSpec | undefined): FieldSpec {
  if (spec === undefined) return { label: fieldLabel(key) };
  return typeof spec === "string" ? { label: spec } : spec;
}

function formatField(value: unknown, spec: FieldSpec) {
  if (value === undefined || value === null) return EMPTY_FIELD_TEXT;
  return spec.format ? spec.format(value) : fieldText(value);
}

function changer<T extends object>(
  mine: unknown,
  theirs: unknown,
  loaded: T | undefined,
  key: keyof T,
): FieldDifference["changedBy"] {
  if (!loaded) return undefined;
  const youChanged = !same(mine, loaded[key]);
  const theyChanged = !same(theirs, loaded[key]);
  if (youChanged && theyChanged) return "both";
  return youChanged ? "you" : "them";
}

// A form reads a blank field as "" or false where a stored record leaves it
// unset, so every blank counts as the same value.
function same(a: unknown, b: unknown) {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function isBlank(value: unknown) {
  return (
    value === undefined || value === null || value === "" || value === false
  );
}
