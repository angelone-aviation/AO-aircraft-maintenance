import { expect, it } from "vitest";
import {
  ACCOUNTS_MANAGED,
  MICROSOFT_PERSONAL_TENANT,
  googleProfile,
  microsoftProfile,
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
