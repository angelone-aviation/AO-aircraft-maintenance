/**
 * Responsibility: Pins each Flight Program's share of an allowance every
 *   program draws on: an equal split, rounded down, never below the floor.
 * Layer: Test. Vitest over a pure domain function.
 * Dependencies: src/domain/programShare.ts.
 */
import { expect, it } from "vitest";
import { programShare } from "./programShare";

it("splits an allowance equally between programs, rounding down, never below the floor", () => {
  expect(programShare(2900, 0, 100)).toBe(2900);
  expect(programShare(2900, 1, 100)).toBe(2900);
  expect(programShare(2900, 3, 100)).toBe(966);
  expect(programShare(2900, 28, 100)).toBe(103);
  expect(programShare(2900, 29, 100)).toBe(100);
  expect(programShare(2900, 30, 100)).toBe(100);
});
