/**
 * Responsibility: Pins the CSV layout and the spreadsheet-formula guard.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/csv.ts.
 */
import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

const BOM = "\uFEFF";

describe("toCsv", () => {
  it("writes a header of every key in first-seen order, one CRLF line per record", () => {
    expect(
      toCsv([
        { a: 1, b: 2 },
        { c: 3, a: 4 },
      ]),
    ).toBe(`${BOM}"a","b","c"\r\n"1","2",""\r\n"4","","3"`);
    expect(toCsv([])).toBe(BOM);
  });
  it("writes null and undefined as empty, objects as JSON, and doubles quotes", () => {
    expect(
      toCsv([{ none: null, missing: undefined, list: [1, "x"], quote: 'a"b' }]),
    ).toBe(`${BOM}"none","missing","list","quote"\r\n"","","[1,""x""]","a""b"`);
  });
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t1", "\r1"])(
    "keeps text %j from running as a formula",
    (text) => {
      expect(toCsv([{ text }])).toBe(`${BOM}"text"\r\n"'${text}"`);
    },
  );
  it("leaves numbers and other text as they are", () => {
    expect(toCsv([{ delta: -5, note: "1=1" }])).toBe(
      `${BOM}"delta","note"\r\n"-5","1=1"`,
    );
  });
});
