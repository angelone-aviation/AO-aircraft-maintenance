/**
 * Responsibility: Pins the meter-reading rules: typed hours to stored seconds,
 *   the tenths-of-an-hour schema, and the texts a reading is shown and edited
 *   as.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: ./readings, ./model (re-export), ./rejection.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseHours as modelParseHours } from "./model";
import { Rejection } from "./rejection";
import {
  hoursField,
  hoursToSeconds,
  meterReadingSchema,
  parseHours,
  readingText,
} from "./readings";

const ONE_DECIMAL = "Use positive hours with at most one decimal place.";

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

  it.each(["1.25", "abc", "-1", " 1", "1 ", "1.", ".5", "1e3", "1,234"])(
    "refuses %j",
    (text) => {
      expect(refusal(text)).toEqual([true, ONE_DECIMAL]);
    },
  );

  it("refuses a reading past the largest safe integer", () => {
    expect(refusal("2501999792983.7")).toEqual([
      true,
      "Meter reading is too large.",
    ]);
  });

  it("characterizes current behaviour: zero passes, though the message says positive", () => {
    expect(parseHours("0")).toBe(0);
  });

  it("is the one model.ts re-exports", () => {
    expect(modelParseHours).toBe(parseHours);
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
