/**
 * Responsibility: Pins the months-in-service conversion, its round trip and
 *   its limits.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/componentCalendar.ts, ./rejection.
 */
import { expect, it } from "vitest";
import {
  daysPerServiceMonth,
  serviceDaysFromMonths,
  serviceMonthsFromDays,
} from "./componentCalendar";
import { Rejection } from "./rejection";
it("converts months and preserves existing day baselines on reopening and saving", () => {
  expect(serviceDaysFromMonths("12")).toBe(365);
  expect(serviceDaysFromMonths("0")).toBe(0);
  for (const days of [1, 10, 20, 30, 31, 365, 366, 1000, 365000])
    expect(serviceDaysFromMonths(String(serviceMonthsFromDays(days)))).toBe(
      days,
    );
});
it.each(["", " ", "-1", "Infinity", "NaN", "12000"])(
  "rejects invalid service months %s",
  (value) => {
    expect(() => serviceDaysFromMonths(value)).toThrow("prior months");
    expect(() => serviceDaysFromMonths(value)).toThrow(Rejection);
  },
);
it("uses an average month and shows months to three decimals", () => {
  expect(daysPerServiceMonth).toBe(365.25 / 12);
  expect(serviceMonthsFromDays(1)).toBe(0.033);
});
it("rounds to the nearest day and caps the total at 365,000 days", () => {
  expect(serviceDaysFromMonths("1")).toBe(30);
  expect(serviceDaysFromMonths(" 1.5 ")).toBe(46);
  expect(serviceDaysFromMonths("11991.802")).toBe(365000);
  expect(() => serviceDaysFromMonths("11991.803")).toThrow(
    Error("Enter valid prior months in service between 0 and 11991.786."),
  );
});
