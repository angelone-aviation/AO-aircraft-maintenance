import { it, expect } from "vitest";
import { faaRenewal } from "./faaCredential";
it("shows reminders starting 60 days before expiry and keeps expired notices visible", () => {
  const status = { configured: true, expiresOn: "2027-10-14", version: 1 };
  expect(faaRenewal(status, "2027-08-14").warning).toBe(false);
  expect(faaRenewal(status, "2027-08-15").warning).toBe(true);
  expect(faaRenewal(status, "2027-10-14").message).toContain("today");
  expect(faaRenewal(status, "2027-10-15").message).toContain("expired");
  expect(faaRenewal({ ...status, expiresOn: "" }).warning).toBe(true);
});
