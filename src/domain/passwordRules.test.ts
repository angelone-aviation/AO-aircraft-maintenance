import { expect, it } from "vitest";
import {
  PASSWORD_COMMON_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
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
