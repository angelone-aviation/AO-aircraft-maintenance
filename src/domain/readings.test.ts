/**
 * Responsibility: Pins the meter-reading rules: typed hours to stored seconds,
 *   the comma rule every number field shares, the tenths-of-an-hour schema,
 *   and the texts a reading is shown and edited as.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: ./readings, ./model (re-export), ./rejection.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseHours as modelParseHours } from "./model";
import { Rejection } from "./rejection";
import {
  DECIMAL_COMMA_MESSAGE,
  EXPONENT_MESSAGE,
  hoursField,
  hoursToSeconds,
  meterReadingSchema,
  numberEntryProblem,
  parseHours,
  plainNumberText,
  readingText,
} from "./readings";

const ONE_DECIMAL = "Use hours of 0 or more, with at most one decimal place.";

describe("parseHours", () => {
  it.each([
    ["1", 3600],
    ["1.2", 4320],
    ["1234.5", 4444200],
    ["2501999792983.6", 9007199254740960],
  ])("reads %s hours as %i seconds", (text, seconds) => {
    expect(parseHours(text)).toBe(seconds);
  });

  it("reads a blank field as no reading", () => {
    expect(parseHours("")).toBeUndefined();
    expect(parseHours("   ")).toBeUndefined();
  });

  it.each(["1.25", "abc", "-1", " 1", "1 ", "1.", ".5", "1e3"])(
    "refuses %j",
    (text) => {
      expect(refusal(text)).toEqual([true, ONE_DECIMAL]);
    },
  );

  it("reads thousands commas only beside a decimal point", () => {
    expect(parseHours("2,342.5")).toBe(8433000);
    expect(parseHours("1,234,567.8")).toBe(4444444080);
    for (const text of ["2342,5", "1,234", "2,34.5", "2.342,5", ",5"])
      expect(refusal(text)).toEqual([true, DECIMAL_COMMA_MESSAGE]);
  });

  it("refuses a reading past the largest safe integer", () => {
    expect(refusal("2501999792983.7")).toEqual([
      true,
      "Meter reading is too large.",
    ]);
  });

  it("accepts zero, as its refusal says", () => {
    expect(parseHours("0")).toBe(0);
  });

  it("is the one model.ts re-exports", () => {
    expect(modelParseHours).toBe(parseHours);
  });
});

describe("plainNumberText and numberEntryProblem", () => {
  it("drops thousands commas beside a decimal point and refuses any other comma", () => {
    expect(plainNumberText("2342.5")).toBe("2342.5");
    expect(plainNumberText("2,342.50")).toBe("2342.50");
    expect(plainNumberText(" 12 ")).toBe(" 12 ");
    for (const text of ["45,50", "4,550", "2342,5", "1,23.4", "1,234,56.0"])
      expect(() => plainNumberText(text)).toThrow(DECIMAL_COMMA_MESSAGE);
  });

  it("refuses a comma or an exponent going into a number input", () => {
    expect(numberEntryProblem(",")).toBe(DECIMAL_COMMA_MESSAGE);
    expect(numberEntryProblem("2342,5")).toBe(DECIMAL_COMMA_MESSAGE);
    expect(numberEntryProblem("e")).toBe(EXPONENT_MESSAGE);
    expect(numberEntryProblem("1E5")).toBe(EXPONENT_MESSAGE);
    expect(numberEntryProblem("2342.5")).toBeUndefined();
    expect(numberEntryProblem("")).toBeUndefined();
  });
});

describe("meterReadingSchema", () => {
  it("takes whole, non-negative seconds in tenths of an hour", () => {
    for (const seconds of [0, 360, 4444200])
      expect(meterReadingSchema.parse(seconds)).toBe(seconds);
  });

  it.each([180, 4500, -360, 360.5])("refuses %d", (seconds) => {
    expect(() => meterReadingSchema.parse(seconds)).toThrow(z.ZodError);
  });

  it("names the rule a reading between tenths breaks", () => {
    expect(meterReadingSchema.safeParse(4500).error?.issues[0].message).toBe(
      "Meter readings must use tenths of an hour",
    );
  });
});

describe("readingText", () => {
  it("shows hours to one decimal, without separators", () => {
    expect(readingText(4444200)).toBe("1234.5");
    expect(readingText(0)).toBe("0.0");
    expect(readingText(4500)).toBe("1.3");
  });
});

describe("hoursField", () => {
  it("starts a field with the unrounded hours, or blank", () => {
    expect(hoursField(undefined)).toBe("");
    expect(hoursField(4500)).toBe("1.25");
    expect(hoursField(-3600)).toBe("-1");
  });

  it("gives back every stored reading through parseHours", () => {
    for (const seconds of [0, 360, 1080, 3960, 8431920, 4444200])
      expect(parseHours(hoursField(seconds))).toBe(seconds);
  });
});

describe("hoursToSeconds", () => {
  it("rounds to the nearest second, without the tenths rule", () => {
    expect(hoursToSeconds(1.1)).toBe(3960);
    expect(hoursToSeconds(1.25)).toBe(4500);
    expect(hoursToSeconds(-0.5)).toBe(-1800);
  });
});

function refusal(text: string) {
  try {
    parseHours(text);
  } catch (error) {
    return [error instanceof Rejection, (error as Error).message];
  }
  return [false, "read"];
}
