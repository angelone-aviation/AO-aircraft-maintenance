/**
 * Responsibility: Pins the guided flight refusals and the start section
 *   choice; the checklist-run record is pinned in flightFluids.test.ts.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/guidedFlight.ts, ./rejection.
 */
import { expect, it } from "vitest";
import {
  guidedFlightLink,
  suggestedStartSection,
  type GuidedDraft,
} from "./guidedFlight";
import { Rejection } from "./rejection";

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

it("starts engines from the first plain start section", () => {
  const sections = (...titles: string[]) =>
    titles.map((title, i) => ({ objectId: `s${i}`, title }));
  expect(
    suggestedStartSection(
      sections("Preflight", "Pre-start", "Engine start", "Starting"),
    ),
  ).toBe("s2");
  expect(suggestedStartSection(sections("Before start", "Taxi"))).toBe("");
  expect(suggestedStartSection([{ objectId: "untitled" }])).toBe("");
});
