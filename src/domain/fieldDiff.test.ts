/**
 * Responsibility: Pins what fieldDiff reports: which fields, in which order,
 *   with which labels, text and attribution.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/fieldDiff.ts.
 */
import { expect, it } from "vitest";
import {
  DEFAULT_IGNORED_FIELDS,
  EMPTY_FIELD_TEXT,
  fieldDiff,
  fieldLabel,
  fieldText,
  sameValue,
} from "./fieldDiff";

interface Sample {
  reference: string;
  description: string;
  lastSeconds?: number;
  archived?: boolean;
  tags?: string[];
  version: number;
  updatedAt?: number;
}

const loaded: Sample = {
  reference: "100-hour",
  description: "Airframe",
  lastSeconds: 3600,
  tags: ["a"],
  version: 1,
};
const hours = {
  label: "Last complied at",
  format: (v: unknown) => `${(v as number) / 3600} h`,
};

it("lists only the differing fields, in the draft's order, skipping bookkeeping", () => {
  const mine: Sample = { ...loaded, description: "Engine", tags: ["a", "b"] };
  const theirs: Sample = {
    ...loaded,
    reference: "200-hour",
    version: 2,
    updatedAt: 9,
  };
  expect(fieldDiff(mine, theirs)).toEqual([
    {
      key: "reference",
      label: "Reference",
      mine: "100-hour",
      theirs: "200-hour",
    },
    {
      key: "description",
      label: "Description",
      mine: "Engine",
      theirs: "Airframe",
    },
    { key: "tags", label: "Tags", mine: "a; b", theirs: "a" },
  ]);
  expect(fieldDiff(loaded, { ...loaded, version: 5 })).toEqual([]);
  expect(DEFAULT_IGNORED_FIELDS).toEqual([
    "version",
    "updatedAt",
    "createdAt",
    "programUuid",
  ]);
});

it("says who changed each field when given the copy both started from", () => {
  const mine = { ...loaded, description: "Engine", lastSeconds: 1 };
  const theirs = { ...loaded, reference: "200-hour", lastSeconds: 2 };
  const byKey = Object.fromEntries(
    fieldDiff(mine, theirs, { loaded }).map((d) => [d.key, d.changedBy]),
  );
  expect(byKey).toEqual({
    reference: "them",
    description: "you",
    lastSeconds: "both",
  });
  expect(fieldDiff(mine, theirs)[0].changedBy).toBeUndefined();
});

it("applies labels and formats, and shows an unset value as empty", () => {
  const diff = fieldDiff(
    { ...loaded, lastSeconds: 7200 },
    { ...loaded, lastSeconds: undefined },
    { specs: { lastSeconds: hours } },
  );
  expect(diff).toEqual([
    {
      key: "lastSeconds",
      label: "Last complied at",
      mine: "2 h",
      theirs: EMPTY_FIELD_TEXT,
    },
  ]);
});

it("reads a form's blank (\"\" or false) and a record's unset field as one value", () => {
  const fromForm: Sample = { ...loaded, archived: false, tags: undefined };
  const stored: Sample = { ...loaded, archived: undefined, tags: null! };
  expect(fieldDiff(fromForm, stored)).toEqual([]);
  expect(fieldDiff({ ...loaded, reference: "" }, { ...loaded })).toHaveLength(
    1,
  );
  expect(fieldDiff({ ...loaded, archived: true }, { ...loaded })).toEqual([
    {
      key: "archived",
      label: "Archived",
      mine: "Yes",
      theirs: EMPTY_FIELD_TEXT,
    },
  ]);
});

it("labels camelCase names and renders booleans and numbers", () => {
  expect(fieldLabel("lastSeconds")).toBe("Last seconds");
  expect(fieldLabel("installPosition")).toBe("Install position");
  expect(fieldLabel("reference")).toBe("Reference");
  expect(fieldText(true)).toBe("Yes");
  expect(fieldText(false)).toBe("No");
  expect(fieldText(12.5)).toBe("12.5");
});

it("puts lists and objects in plain words, without ids or blank fields", () => {
  expect(fieldText(["a", "b"])).toBe("a; b");
  expect(fieldText([])).toBe(EMPTY_FIELD_TEXT);
  expect(
    fieldText([
      { uuid: "1111", partNumber: "MS-1", quantity: 2, stockUuid: "s1" },
      { uuid: "2222", partNumber: "MS-2", quantity: 1, notes: "" },
    ]),
  ).toBe("Part number: MS-1, Quantity: 2; Part number: MS-2, Quantity: 1");
  expect(fieldText({ uuid: "1111" })).toBe(EMPTY_FIELD_TEXT);
});

it("compares nested values field by field: key order and blanks do not count", () => {
  expect(sameValue({ a: 1, b: "" }, { b: undefined, a: 1 })).toBe(true);
  expect(sameValue({ a: 1 }, { a: 1, c: false })).toBe(true);
  expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  expect(sameValue([{ a: 1 }], [{ a: 1 }])).toBe(true);
  expect(sameValue([1, 2], [2, 1])).toBe(false);
  expect(sameValue([], undefined)).toBe(true);
  expect(sameValue([1], { 0: 1 })).toBe(false);
  expect(sameValue("2", 2)).toBe(false);
});

it("renders blanks", () => {
  expect(fieldText("")).toBe(EMPTY_FIELD_TEXT);
  expect(fieldText(null)).toBe(EMPTY_FIELD_TEXT);
});
