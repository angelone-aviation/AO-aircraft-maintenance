/**
 * Responsibility: Pins that domain refusals share the one Rejection class,
 *   and that every stale save is one StaleRecordRejection with one message.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/rejection.ts, src/domain/flightSubmission.ts,
 *   src/domain/components.ts.
 */
import { expect, it } from "vitest";
import {
  Rejection,
  STALE_RECORD_MESSAGE,
  StaleRecordRejection,
} from "./rejection";
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

it("refuses a stale save with the one message and the version to resubmit against", () => {
  const stale = new StaleRecordRejection("inspection", 4);
  expect(stale).toBeInstanceOf(Rejection);
  expect(stale.message).toBe(STALE_RECORD_MESSAGE);
  expect(STALE_RECORD_MESSAGE).toBe(
    "This record was changed by someone else. Review the differences.",
  );
  expect(stale.recordKind).toBe("inspection");
  expect(stale.currentVersion).toBe(4);
});
