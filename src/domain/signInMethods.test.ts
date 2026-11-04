/**
 * Responsibility: Pins which provider claims prove an email, and how little a
 *   refused Google or Microsoft sign-in tells the sign-in screen.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/signInMethods.ts.
 */
import { expect, it } from "vitest";
import {
  ACCOUNTS_MANAGED,
  MICROSOFT_PERSONAL_TENANT,
  googleProfile,
  isSsoProvider,
  microsoftProfile,
  normalizeSsoEmail,
  signInErrorCode,
  signInErrorMessage,
} from "./signInMethods";

it("trusts a Google email only when Google says it is verified", () => {
  expect(
    googleProfile({
      sub: "1",
      email: " Pat@Example.TEST ",
      email_verified: true,
    }),
  ).toEqual({ id: "1", email: "pat@example.test", emailVerified: true });
  for (const email_verified of [false, "true", undefined])
    expect(
      googleProfile({ sub: "1", email: "pat@example.test", email_verified })
        .emailVerified,
    ).toBe(false);
  expect(() => googleProfile({ email: "pat@example.test" })).toThrow();
});

it("trusts a Microsoft email only for personal accounts or a verified domain", () => {
  const claims = { sub: "s", email: "Pat@Company.test" };
  expect(
    microsoftProfile({ ...claims, tid: MICROSOFT_PERSONAL_TENANT }),
  ).toEqual({ id: "s", email: "pat@company.test", emailVerified: true });
  expect(
    microsoftProfile({ ...claims, tid: "other", xms_edov: true }).emailVerified,
  ).toBe(true);
  for (const xms_edov of [false, "1", undefined])
    expect(
      microsoftProfile({ ...claims, tid: "other", xms_edov }).emailVerified,
    ).toBe(false);
});

it("lower-cases only A to Z in a provider's email, so a look-alike stays distinct", () => {
  expect(normalizeSsoEmail(" Pat.O'Neil@Example.TEST ")).toBe(
    "pat.o'neil@example.test",
  );
  expect(normalizeSsoEmail("\u212Aate@example.test")).toBe(
    "\u212Aate@example.test",
  );
  expect(
    microsoftProfile({
      sub: "s",
      tid: MICROSOFT_PERSONAL_TENANT,
      email: "\u212Aate@Example.test",
    }).email,
  ).toBe("\u212Aate@example.test");
});

it("tells the sign-in screen as little as it needs", () => {
  expect(signInErrorCode("no_account")).toBe("account");
  expect(signInErrorCode("disabled")).toBe("account");
  expect(signInErrorCode("ambiguous")).toBe("account");
  expect(signInErrorCode("email_not_verified")).toBe("unverified");
  expect(signInErrorCode(undefined)).toBe("failed");
  expect(signInErrorMessage("account", "google")?.title).toBe(ACCOUNTS_MANAGED);
  expect(signInErrorMessage("failed", "microsoft-entra-id")?.title).toBe(
    "Sign-in with Microsoft did not finish.",
  );
  // Unknown values in the address are ignored or named generically.
  expect(signInErrorMessage("<script>", "google")).toBeUndefined();
  expect(signInErrorMessage("failed", "<b>")?.title).toBe(
    "Sign-in with Google or Microsoft did not finish.",
  );
});

it("requires an account id and drops a blank or non-text email", () => {
  for (const sub of [undefined, "", 7])
    expect(() => microsoftProfile({ sub, email: "pat@example.test" })).toThrow(
      Error("The sign-in provider returned no account id."),
    );
  for (const email of ["  ", 7, undefined])
    expect(googleProfile({ sub: "1", email, email_verified: true })).toEqual({
      id: "1",
      email: undefined,
      emailVerified: true,
    });
});

it("recognizes only the supported provider ids", () => {
  expect(isSsoProvider("google")).toBe(true);
  expect(isSsoProvider("microsoft-entra-id")).toBe(true);
  for (const id of ["password", "Google", null, undefined])
    expect(isSsoProvider(id)).toBe(false);
});

it("explains each error code, naming the provider", () => {
  expect(signInErrorMessage("account", "microsoft-entra-id")).toEqual({
    title: ACCOUNTS_MANAGED,
    detail:
      "No active Angel One account uses the email of that Microsoft account. Sign in with your password, or ask your administrator.",
  });
  expect(signInErrorMessage("unverified", "google")).toEqual({
    title: "Google did not confirm that email address.",
    detail:
      "A Google account is linked only by an email address Google has verified. Sign in with your password.",
  });
  expect(signInErrorMessage("failed", null)).toEqual({
    title: "Sign-in with Google or Microsoft did not finish.",
    detail: "Try again, or sign in with your password.",
  });
  expect(signInErrorMessage(null, "google")).toBeUndefined();
});
