/**
 * Responsibility: Pins the OK-to-fly verdict and which single reason it
 *   names, including the priority order between reason kinds.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightReadiness.ts, src/domain/aircraftStatus.ts.
 */
import { describe, expect, it } from "vitest";
import type { AircraftStatus, AircraftStatusReason } from "./aircraftStatus";
import { flightReadiness } from "./flightReadiness";

const reason = (
  kind: AircraftStatusReason["kind"],
  label: string = kind,
): AircraftStatusReason => ({ kind, label, entityUuid: label });

const grounded = (...reasons: AircraftStatusReason[]): AircraftStatus => ({
  level: "grounded",
  reasons,
});

describe("flightReadiness", () => {
  it("is OK to fly without a reason when airworthy", () => {
    expect(flightReadiness({ level: "airworthy", reasons: [] })).toEqual({
      ok: true,
      level: "airworthy",
      reason: undefined,
      more: 0,
    });
  });

  it("stays OK to fly when due soon, naming the due-soon item", () => {
    const status: AircraftStatus = {
      level: "due-soon",
      reasons: [reason("inspection", "Annual due soon"), reason("ad")],
    };
    expect(flightReadiness(status)).toEqual({
      ok: true,
      level: "due-soon",
      reason: "Annual due soon",
      more: 1,
    });
  });

  it("stays OK to fly when setup is incomplete, naming a setup gap first", () => {
    const result = flightReadiness({
      level: "setup-incomplete",
      reasons: [
        reason("inspection", "Annual due soon"),
        reason("setup", "No components"),
      ],
    });
    expect(result).toEqual({
      ok: true,
      level: "setup-incomplete",
      reason: "No components",
      more: 1,
    });
  });

  it("is not OK to fly when grounded", () => {
    const result = flightReadiness(
      grounded(reason("inspection", "Annual overdue")),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "Annual overdue",
      more: 0,
    });
  });

  it("names reasons in the order profile, discrepancy, deferral, inspection, AD, component", () => {
    const order = [
      "profile",
      "discrepancy",
      "deferral",
      "inspection",
      "ad",
      "component",
    ] as const;
    // Each round removes the winner, so every adjacent pair is compared.
    for (let i = 0; i < order.length; i++) {
      const rest = order
        .slice(i)
        .reverse()
        .map((k) => reason(k));
      expect(flightReadiness(grounded(...rest)).reason).toBe(order[i]);
    }
  });

  it("keeps the domain's order between reasons of the same kind", () => {
    const status = grounded(
      reason("inspection", "100 hour overdue"),
      reason("inspection", "Annual overdue"),
    );
    expect(flightReadiness(status).reason).toBe("100 hour overdue");
  });
});
