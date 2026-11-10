/**
 * Responsibility: Lists the fields on which two copies of a record differ,
 *   with human labels and display values in plain words, for a stale-save
 *   review or a held flight's comparison with the aircraft.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: none.
 */

/** What a field holds: a list's item, or the value itself. */
type Inner<V> =
  NonNullable<V> extends readonly (infer Item)[] ? Item : NonNullable<V>;

/** How one field is shown: its label, and how its value becomes text. */
export interface FieldSpec<V = unknown> {
  label: string;
  /** Formats a value; omit for the default text. */
  format?: (value: unknown) => string;
  /** Labels for the fields inside an object, or inside each item of a list. */
  fields?: FieldSpecs<Inner<V>>;
  /** Names one item of a list, as in "Task 2 (Inspect fittings)". */
  item?(item: Inner<V>, index: number): string;
  /** The field that identifies a list's items; "uuid" by default. */
  itemKey?: string;
}

/** Labels (or full specs) by field; unlisted fields get a label from their
 * name, as {@link fieldLabel} makes it. */
export type FieldSpecs<T> = {
  readonly [K in keyof T]?: string | FieldSpec<T[K]>;
};

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
 * appear on `mine`; nested values compare as {@link sameValue} does.
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
    if (ignore.includes(key) || sameValue(mine[key], theirs[key])) continue;
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
 * The default text for a value, in plain words: a blank (unset, null, "" or
 * an empty list) reads {@link EMPTY_FIELD_TEXT}, booleans "Yes" or "No", a
 * list its items joined by "; ", and an object its filled fields as
 * "Label: value" joined by ", ". Record ids (`uuid`, `…Uuid`) are left out:
 * they mean nothing to a reader.
 *
 * @param value - The field's value.
 */
export function fieldText(value: unknown): string {
  if (isBlank(value)) return value === false ? "No" : EMPTY_FIELD_TEXT;
  if (typeof value === "boolean") return "Yes";
  if (Array.isArray(value))
    return value.map(fieldText).join("; ") || EMPTY_FIELD_TEXT;
  if (typeof value === "object" && value) return objectText(value);
  return String(value);
}

/**
 * Whether two values of a field are the same to a reader. A form reads a
 * blank field as "" or false where a stored record leaves it unset, so every
 * blank (unset, null, "", false) counts as one value; objects compare field
 * by field in any key order, lists item by item in order.
 *
 * @param a - One copy's value.
 * @param b - The other copy's value.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) return sameList(a, b);
  const [left, right] = [a as Fields, b as Fields];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(
    (key) => sameValue(left[key], right[key]),
  );
}

/**
 * The spec to show a field with.
 *
 * @param key - The field's name.
 * @param spec - What the caller listed for it: a label, a spec or nothing.
 * @returns The spec; an unlisted field is labelled by {@link fieldLabel}.
 */
export function specOf(
  key: string,
  spec: string | FieldSpec | undefined,
): FieldSpec {
  if (spec === undefined) return { label: fieldLabel(key) };
  return typeof spec === "string" ? { label: spec } : spec;
}

/**
 * A field's value as text: {@link EMPTY_FIELD_TEXT} when unset, else the
 * spec's format, else {@link fieldText}.
 *
 * @param value - The field's value.
 * @param spec - How the field is shown.
 */
export function formatField(value: unknown, spec: FieldSpec) {
  if (value === undefined || value === null) return EMPTY_FIELD_TEXT;
  return spec.format ? spec.format(value) : fieldText(value);
}

type Fields = Record<string, unknown>;

const ID_FIELD = /^uuid$|Uuid$/;

function objectText(value: object) {
  const parts = Object.entries(value)
    .filter(([key, inner]) => !ID_FIELD.test(key) && !isBlank(inner))
    .map(([key, inner]) => `${fieldLabel(key)}: ${fieldText(inner)}`);
  return parts.join(", ") || EMPTY_FIELD_TEXT;
}

function sameList(a: unknown, b: unknown) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
}

function changer<T extends object>(
  mine: unknown,
  theirs: unknown,
  loaded: T | undefined,
  key: keyof T,
): FieldDifference["changedBy"] {
  if (!loaded) return undefined;
  const youChanged = !sameValue(mine, loaded[key]);
  const theyChanged = !sameValue(theirs, loaded[key]);
  if (youChanged && theyChanged) return "both";
  return youChanged ? "you" : "them";
}

function isBlank(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && !value.length)
  );
}
