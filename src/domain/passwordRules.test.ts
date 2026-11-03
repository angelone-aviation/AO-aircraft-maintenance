/**
 * Responsibility: Pins the rules for a password an administrator sets: length,
 *   no composition rules, and the common, repeated and email checks.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/passwordRules.ts, src/domain/commonPasswords.ts.
 */
import { expect, it } from "vitest";
import {
  PASSWORD_COMMON_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
  assertPassword,
  passwordProblem,
} from "./passwordRules";
import { COMMON_PASSWORDS } from "./commonPasswords";

it("accepts any password of 15 to 128 characters with no composition rules", () => {
  for (const password of [
    "plain lower case words",
    "fifteen chars!!",
    "ALL UPPER CASE PHRASE",
    "räksmörgås på tåget",
    "x".repeat(7) + "y".repeat(8),
  ])
    expect(passwordProblem(password)).toBeUndefined();
  expect(passwordProblem("a7#".repeat(42) + "zq")).toBeUndefined();
});

it("refuses passwords shorter than 15 or longer than 128 characters", () => {
  expect(passwordProblem("fourteen chars")).toBe(PASSWORD_LENGTH_MESSAGE);
  expect(passwordProblem("")).toBe(PASSWORD_LENGTH_MESSAGE);
  expect(passwordProblem("q".repeat(129))).toBe(PASSWORD_LENGTH_MESSAGE);
  // Counted in characters, not UTF-16 units.
  expect(passwordProblem("🛩".repeat(14))).toBe(PASSWORD_LENGTH_MESSAGE);
});

it("refuses common passwords whatever their case", () => {
  for (const password of [
    "123456789012345",
    "1q2w3e4r5t6y7u8i9o0p",
    "QwertyUiopAsdfG",
    "correct horse battery staple",
    "AngelOneAviation",
  ])
    expect(passwordProblem(password)).toBe(PASSWORD_COMMON_MESSAGE);
});

it("refuses a short phrase repeated and a password that contains the email", () => {
  expect(passwordProblem("aaaaaaaaaaaaaaaa")).toBe(PASSWORD_COMMON_MESSAGE);
  expect(passwordProblem("Summer24!Summer24!")).toBe(PASSWORD_COMMON_MESSAGE);
  expect(passwordProblem("pat@example.test-2026", "Pat@Example.test")).toBe(
    PASSWORD_COMMON_MESSAGE,
  );
  expect(
    passwordProblem("pat@example.test-2026", "other@example.test"),
  ).toBeUndefined();
});

it("keeps the bundled list small, lower-case and at least 15 characters", () => {
  const entries = COMMON_PASSWORDS.split("\n").filter(Boolean);
  expect(entries.length).toBeGreaterThan(1000);
  expect(entries.length).toBeLessThan(5000);
  for (const entry of entries) {
    expect(entry).toBe(entry.toLowerCase());
    expect(Array.from(entry).length).toBeGreaterThanOrEqual(15);
  }
});

it("compares in lower case after Unicode compatibility folding", () => {
  // Full-width digits fold to "123456789012345", which is on the list.
  expect(
    passwordProblem(
      "\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18\uff19\uff10\uff11\uff12\uff13\uff14\uff15",
    ),
  ).toBe(PASSWORD_COMMON_MESSAGE);
  expect(passwordProblem("ABCABCABCABCABC")).toBe(PASSWORD_COMMON_MESSAGE);
});

it("trims the email, and ignores a blank one", () => {
  expect(passwordProblem("pat@example.test-2026", " pat@example.test ")).toBe(
    PASSWORD_COMMON_MESSAGE,
  );
  expect(passwordProblem("plain lower case words", "  ")).toBeUndefined();
});

it("checks the length before anything else", () => {
  expect(passwordProblem("a".repeat(14))).toBe(PASSWORD_LENGTH_MESSAGE);
});

it("throws the refusal as an Error from assertPassword", () => {
  expect(() => assertPassword("fourteen chars")).toThrow(
    Error(PASSWORD_LENGTH_MESSAGE),
  );
  expect(() =>
    assertPassword("pat@example.test-2026", "pat@example.test"),
  ).toThrow(Error(PASSWORD_COMMON_MESSAGE));
  expect(() => assertPassword("plain lower case words")).not.toThrow();
});
