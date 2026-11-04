/**
 * Responsibility: Pins the guided flight refusals, the section choices and
 *   the draft's shutdown readings; the checklist-run record is pinned in
 *   flightFluids.test.ts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/guidedFlight.ts, ./rejection.
 */
import { expect, it } from "vitest";
import {
  guidedDraftSchema,
  guidedFlightLink,
  suggestedPreflightSection,
  suggestedShutdownSection,
  suggestedStartSection,
  type GuidedDraft,
} from "./guidedFlight";
import { Rejection } from "./rejection";

const SHUTDOWN_READINGS = [
  "hobbsOn",
  "tachOn",
  "cyclicHobbsOn",
  "flightTimeLogOn",
] as const;

it("refuses unverified meters, then incomplete fluids", () => {
  const draft = {
    fuel: { unit: "L", start: 20, end: 15 },
    oil: [{ engine: "single", unit: "US qt", start: 6, added: 0 }],
  } as GuidedDraft;
  const unverified = () => guidedFlightLink(draft, false);
  expect(unverified).toThrow(Rejection);
  expect(unverified).toThrow(
    "Verify the preflight meter readings against the aircraft first.",
  );
  const verified = { ...draft, metersVerifiedAt: "2026-11-04T10:00:00Z" };
  const incomplete = () => guidedFlightLink(verified, false);
  expect(incomplete).toThrow(Rejection);
  expect(incomplete).toThrow(
    "Enter starting level and quantity added (0 if none) for fuel and each engine’s oil, plus the shutdown fuel level.",
  );
});

const sections = (...titles: string[]) =>
  titles.map((title, i) => ({ objectId: `s${i}`, title }));

it("starts engines from the first plain start section", () => {
  expect(
    suggestedStartSection(
      sections("Preflight", "Pre-start", "Engine start", "Starting"),
    ),
  ).toBe("s2");
  expect(suggestedStartSection(sections("Before start", "Taxi"))).toBe("");
  expect(suggestedStartSection([{ objectId: "untitled" }])).toBe("");
});

it.each([
  [["Cockpit", "Before start", "Taxi", "After flight", "Secure"], "s1", "s3"],
  [["Pre-flight", "Preflight walk", "Shutdown", "After-flight"], "s0", "s2"],
  [["Alpha", "Beta", "Gamma"], "s0", "s2"],
  [[], "", ""],
])(
  "reads preflight and shutdown from the first titled sections, else the ends: %j",
  (titles, preflight, shutdown) => {
    expect(suggestedPreflightSection(sections(...titles))).toBe(preflight);
    expect(suggestedShutdownSection(sections(...titles))).toBe(shutdown);
  },
);

// Finding 4: the guided flight stored 2342.25 h as typed, and only the final
// review met the tenths-of-an-hour rule.
it.each(SHUTDOWN_READINGS)(
  "keeps the %s shutdown reading in whole tenths of an hour",
  (key) => {
    const reading = guidedDraftSchema.shape[key];
    expect(reading.parse(undefined)).toBeUndefined();
    expect(reading.parse(8431920)).toBe(8431920);
    expect(reading.safeParse(8432100).error?.issues[0].message).toBe(
      "Meter readings must use tenths of an hour",
    );
  },
);
