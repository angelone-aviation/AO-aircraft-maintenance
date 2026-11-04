/**
 * Responsibility: Pins the FAA API key input rules and the renewal notice.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/faaCredential.ts.
 */
import { it, expect } from "vitest";
import { faaCredentialInput, faaRenewal } from "./faaCredential";
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
