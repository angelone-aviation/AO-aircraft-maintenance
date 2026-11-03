/**
 * Responsibility: Pins that domain refusals share the one Rejection class.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/rejection.ts, src/domain/flightSubmission.ts,
 *   src/domain/components.ts.
 */
import { expect, it } from "vitest";
import { Rejection } from "./rejection";
import { FlightRejection } from "./flightSubmission";
import { ComponentUsageError } from "./components";

it("is an Error that keeps its message and cause", () => {
  const cause = new Error("stock lookup");
  const refusal = new Rejection("Aircraft changed. Refresh before saving.", {
    cause,
  });
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal.message).toBe("Aircraft changed. Refresh before saving.");
  expect(refusal.cause).toBe(cause);
});

it("is the parent of the existing domain refusals, and of no other error", () => {
  for (const Refusal of [FlightRejection, ComponentUsageError]) {
    const refusal = new Refusal("Refused.");
    expect(refusal).toBeInstanceOf(Rejection);
    expect(refusal).toBeInstanceOf(Refusal);
    expect(refusal.message).toBe("Refused.");
  }
  expect(new Error("Fault.")).not.toBeInstanceOf(Rejection);
});
