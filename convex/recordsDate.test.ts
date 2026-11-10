/**
 * Responsibility: Pins the server's calendar "today": the records time zone
 *   from RECORDS_TIME_ZONE, its US Eastern default, and the fallback for a
 *   name that is not a zone.
 * Layer: Test. vitest; never shipped.
 * Dependencies: convex/recordsDate.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { recordsDate } from "./recordsDate";

// 20:00 on 10 Nov in New York, 17:00 in Los Angeles, 01:00 UTC on 11 Nov.
const EVENING = Date.parse("2026-11-11T01:00:00Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("gives the US Eastern date by default, not the UTC date", () => {
  expect(recordsDate(EVENING)).toBe("2026-11-10");
  // 23:59 and 00:00 Eastern Standard Time.
  expect(recordsDate(Date.parse("2026-11-11T04:59:59Z"))).toBe("2026-11-10");
  expect(recordsDate(Date.parse("2026-11-11T05:00:00Z"))).toBe("2026-11-11");
  // Daylight time: midnight is 04:00 UTC.
  expect(recordsDate(Date.parse("2026-07-01T03:59:59Z"))).toBe("2026-06-30");
  expect(recordsDate(Date.parse("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
});

it("follows RECORDS_TIME_ZONE", () => {
  vi.stubEnv("RECORDS_TIME_ZONE", "Pacific/Auckland");
  expect(recordsDate(EVENING)).toBe("2026-11-11");
  vi.stubEnv("RECORDS_TIME_ZONE", "America/Los_Angeles");
  expect(recordsDate(Date.parse("2026-11-11T07:59:59Z"))).toBe("2026-11-10");
  expect(recordsDate(Date.parse("2026-11-11T08:00:00Z"))).toBe("2026-11-11");
});

it("falls back to US Eastern, with a logged error, for a name that is not a zone", () => {
  vi.stubEnv("RECORDS_TIME_ZONE", "Nowhere/Special");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(recordsDate(EVENING)).toBe("2026-11-10");
  expect(error).toHaveBeenCalledWith(
    "RECORDS_TIME_ZONE is not an IANA time zone; using",
    "America/New_York",
  );
});
