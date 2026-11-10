/**
 * Responsibility: Pins the FAA API key input rules and the renewal notice.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/faaCredential.ts.
 */
import { it, expect } from "vitest";
import {
  faaCredentialInput,
  faaKeyNoticeForMembers,
  faaRenewal,
} from "./faaCredential";
it("shows reminders starting 60 days before expiry and keeps expired notices visible", () => {
  const status = { configured: true, expiresOn: "2027-10-14", version: 1 };
  expect(faaRenewal(status, "2027-08-14").warning).toBe(false);
  expect(faaRenewal(status, "2027-08-15").warning).toBe(true);
  expect(faaRenewal(status, "2027-10-14").message).toContain("today");
  expect(faaRenewal(status, "2027-10-15").message).toContain("expired");
  expect(faaRenewal({ ...status, expiresOn: "" }).warning).toBe(true);
});
it("words each renewal notice exactly", () => {
  const status = { configured: true, expiresOn: "2027-10-14", version: 1 };
  expect(faaRenewal(undefined)).toEqual({
    warning: true,
    message: "FAA API key is not configured.",
  });
  expect(faaRenewal({ ...status, configured: false }, "2027-01-01")).toEqual(
    faaRenewal(undefined),
  );
  expect(faaRenewal({ ...status, expiresOn: "" }).message).toBe(
    "FAA API key renewal date is not recorded.",
  );
  expect(faaRenewal(status, "2027-08-14").message).toBe(
    "FAA API key expires on 2027-10-14 (61 days remaining).",
  );
  expect(faaRenewal(status, "2027-08-15").message).toBe(
    "FAA API key expires on 2027-10-14 (60 days remaining). Renew it before AD monitoring is interrupted.",
  );
  // Characterizes current behaviour: the day count is not singularized.
  expect(faaRenewal(status, "2027-10-13").message).toContain(
    "(1 days remaining)",
  );
  expect(faaRenewal(status, "2027-10-14")).toEqual({
    warning: true,
    message: "FAA API key expires today. Renew it to continue AD checks.",
  });
  expect(faaRenewal(status, "2027-10-15")).toEqual({
    warning: true,
    message:
      "FAA API key expired on 2027-10-14. Renew it to continue AD checks.",
  });
});
it("tells members who renews the key, warning exactly when administrators are warned", () => {
  const status = { configured: true, expiresOn: "2027-10-14", version: 1 };
  for (const today of ["2027-08-14", "2027-08-15", "2027-10-14", "2027-10-15"])
    expect(faaKeyNoticeForMembers(status, today).warning).toBe(
      faaRenewal(status, today).warning,
    );
  expect(faaKeyNoticeForMembers(status, "2027-10-13").message).toBe(
    "FAA AD checks stop when the FAA API key expires on 2027-10-14 (in 1 day). A system administrator renews it.",
  );
  expect(faaKeyNoticeForMembers(status, "2027-10-14").message).toBe(
    "FAA AD checks stop when the FAA API key expires on 2027-10-14 (today). A system administrator renews it.",
  );
  expect(faaKeyNoticeForMembers(status, "2027-10-15").message).toBe(
    "FAA AD checks stopped when the FAA API key expired on 2027-10-14. A system administrator renews it.",
  );
  expect(faaKeyNoticeForMembers(undefined)).toEqual({
    warning: true,
    message:
      "FAA AD checks need an FAA API key. A system administrator adds it.",
  });
  expect(
    faaKeyNoticeForMembers({ ...status, expiresOn: "" }, "2027-10-13").message,
  ).toBe(
    "The FAA API key's expiration date is not recorded. A system administrator records it.",
  );
  // No member notice asks the reader to renew.
  for (const today of ["2027-10-13", "2027-10-14", "2027-10-15"])
    expect(faaKeyNoticeForMembers(status, today).message).not.toMatch(
      /\bRenew\b/,
    );
});
it("accepts a trimmed 16 to 512 character key without spaces", () => {
  const input = { expiresOn: "2027-10-14", version: 0 };
  const parse = (key: string) =>
    faaCredentialInput.safeParse({ ...input, key });
  expect(parse(` ${"k".repeat(16)} `).data?.key).toBe("k".repeat(16));
  expect(parse("Ab0._-".padEnd(512, "x")).success).toBe(true);
  expect(parse("k".repeat(15)).success).toBe(false);
  expect(parse("k".repeat(513)).success).toBe(false);
  expect(parse("key with spaces in it").error?.issues[0].message).toBe(
    "Enter the FAA API key without spaces.",
  );
});
