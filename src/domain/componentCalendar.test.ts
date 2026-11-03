import { expect, it } from "vitest";
import {
  serviceDaysFromMonths,
  serviceMonthsFromDays,
} from "./componentCalendar";
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
  },
);
