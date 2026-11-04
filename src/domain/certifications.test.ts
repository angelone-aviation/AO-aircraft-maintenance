/**
 * Responsibility: Pins how certificates fold into one mechanic certificate,
 *   which certificate an entry cites, and the license-copy file rules.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/certifications.ts, programs.ts, rejection.ts,
 *   src/data/demo.ts (fixture).
 */
import { it, expect } from "vitest";
import {
  certificationsSchema,
  memberLicense,
  certificateOptions,
  normalizeCertifications,
  validateCertificationFile,
  type Certification,
} from "./certifications";
import { demoSnapshot } from "../data/demo";
import { scopedSnapshot } from "./programs";
import { Rejection } from "./rejection";
const cert = (
  kind: Certification["kind"],
  number = "12345",
): Certification => ({ kind, number, issuedOn: "2020-01-01", expiresOn: "" });
it("uses one mechanic license with its ratings and keeps pilot separate", () => {
  const certifications = certificationsSchema.parse([
    cert("pilot", "P-1"),
    {
      ...cert("mechanic", "M-123"),
      airframe: true,
      powerplant: true,
      ia: true,
      renewalDate: "2026-03-01",
    },
  ]);
  expect(certificateOptions({ certifications })).toEqual([
    { key: "pilot", licenseNumber: "P-1", certificateType: "Pilot" },
    { key: "mechanic", licenseNumber: "M-123", certificateType: "A&P IA" },
  ]);
  expect(memberLicense({ certifications })).toEqual({
    licenseNumber: "M-123",
    certificateType: "A&P IA",
  });
});
it("folds old rating records into the mechanic record without losing their original details", () => {
  const certifications = certificationsSchema.parse([
    cert("mechanic", "M-123"),
    cert("airframe", "A-1"),
    cert("powerplant", "P-2"),
    { ...cert("ia"), renewalDate: "2026-03-01" },
  ]);
  expect(certifications).toHaveLength(1);
  expect(certifications[0]).toMatchObject({
    kind: "mechanic",
    number: "M-123",
    airframe: true,
    powerplant: true,
    ia: true,
    renewalDate: "2026-03-01",
  });
  expect(certifications[0].legacyQualifications?.map((c) => c.number)).toEqual([
    "A-1",
    "P-2",
    "12345",
  ]);
  expect(certificationsSchema.parse(certifications)).toEqual(certifications);
});
it("uses issue dates for logbooks without applying removed expiration dates", () => {
  const certifications = [{ ...cert("mechanic"), expiresOn: "2025-12-31" }];
  expect(memberLicense({ certifications }, "2025-06-01").licenseNumber).toBe(
    "12345",
  );
  expect(memberLicense({ certifications }, "2026-10-22").licenseNumber).toBe(
    "12345",
  );
  expect(memberLicense({ certifications }, "2019-01-01").licenseNumber).toBe(
    "",
  );
  expect(
    memberLicense({ licenseNumber: "OLD", certificateType: "AME" }),
  ).toEqual({ licenseNumber: "OLD", certificateType: "AME" });
});
it("validates dates, duplicate selections and license copy formats and limits", () => {
  expect(() =>
    certificationsSchema.parse([{ ...cert("ia"), renewalDate: "2019-01-01" }]),
  ).toThrow(/Renewal/);
  expect(() =>
    certificationsSchema.parse([cert("pilot"), cert("pilot")]),
  ).toThrow(/once/);
  expect(() =>
    validateCertificationFile("license.pdf", "application/pdf", 100),
  ).not.toThrow();
  expect(() =>
    validateCertificationFile("license.jpg", "image/jpeg", 100),
  ).not.toThrow();
  expect(() =>
    validateCertificationFile("script.html", "text/html", 100),
  ).toThrow(/Upload/);
  expect(() =>
    validateCertificationFile(
      "license.pdf",
      "application/pdf",
      6 * 1024 * 1024,
    ),
  ).toThrow(/5 MB/);
});
it("does not expose other users' certification details or license copies to ordinary members", () => {
  const s = demoSnapshot();
  s.members[0].certifications = [cert("mechanic")];
  s.certificationFiles = [
    {
      id: "private",
      userId: s.members[0].id,
      kind: "mechanic",
      name: "license.pdf",
      type: "application/pdf",
      size: 100,
      uploadedAt: 0,
      url: "private-url",
    },
  ];
  s.user = s.members[1];
  const visible = scopedSnapshot(s);
  expect(visible.certificationFiles).toEqual([]);
  expect(
    visible.members.find((m) => m.id === "demo-admin")?.certifications,
  ).toBeUndefined();
});
it("cites a mechanic by ratings and skips certificates without a number or not yet issued", () => {
  const typeOf = (ratings: Partial<Certification>) =>
    certificateOptions({
      certifications: [{ ...cert("mechanic"), ...ratings }],
    })[0].certificateType;
  expect(typeOf({ airframe: true })).toBe("Airframe (A)");
  expect(typeOf({ airframe: true, ia: true })).toBe("Airframe (A) IA");
  expect(typeOf({ powerplant: true, ia: true })).toBe("Powerplant (P) IA");
  expect(typeOf({})).toBe("Mechanic");
  expect(typeOf({ ia: true })).toBe("Mechanic IA");
  expect(
    certificateOptions(
      {
        certifications: [
          cert("pilot", ""),
          { ...cert("mechanic"), issuedOn: "2026-06-02" },
        ],
      },
      "2026-06-01",
    ),
  ).toEqual([]);
  expect(
    certificateOptions(
      {
        certifications: [
          { ...cert("pilot"), issuedOn: "" },
          { ...cert("mechanic"), issuedOn: "2026-06-01" },
        ],
      },
      "2026-06-01",
    ),
  ).toHaveLength(2);
});
it("prints the mechanic certificate before the pilot certificate", () => {
  expect(memberLicense({ certifications: [cert("pilot", "P-1")] })).toEqual({
    licenseNumber: "P-1",
    certificateType: "Pilot",
  });
  expect(
    memberLicense({
      certifications: [cert("mechanic", "M-1"), cert("pilot", "P-1")],
    }).licenseNumber,
  ).toBe("M-1");
  expect(memberLicense({ certifications: [] })).toEqual({
    licenseNumber: "",
    certificateType: "",
  });
});
it("takes a missing mechanic number and issue date from the first numbered rating", () => {
  const rows = [cert("pilot")];
  expect(normalizeCertifications(rows)).toBe(rows);
  const [pilot, mechanic] = normalizeCertifications([
    { ...cert("mechanic", ""), issuedOn: "" },
    cert("ia", ""),
    { ...cert("powerplant", "P-2"), issuedOn: "2021-02-03" },
    cert("pilot", "PIL"),
  ]);
  expect(pilot.number).toBe("PIL");
  expect(mechanic).toMatchObject({
    number: "P-2",
    issuedOn: "2021-02-03",
    airframe: false,
    powerplant: true,
    ia: true,
  });
});
it("accepts a license copy up to 5 MiB with a 200-character name, refusing with a Rejection", () => {
  const MIB = 1024 * 1024;
  const name = `${"n".repeat(196)}.PDF`;
  expect(() =>
    validateCertificationFile(name, "application/pdf", 5 * MIB),
  ).not.toThrow();
  const refusals: [string, string, number][] = [
    [`n${name}`, "application/pdf", 1],
    ["license.png", "image/jpeg", 1],
    ["license.pdf", "application/pdf", 5 * MIB + 1],
    ["license.pdf", "application/pdf", 0],
  ];
  for (const [file, type, size] of refusals)
    expect(() => validateCertificationFile(file, type, size)).toThrow(
      Rejection,
    );
  expect(() =>
    validateCertificationFile("license.png", "image/jpeg", 1),
  ).toThrow(Error("Upload a PDF, JPEG, PNG, WebP, HEIC or HEIF license copy."));
  expect(() =>
    validateCertificationFile("license.pdf", "application/pdf", 0),
  ).toThrow(Error("License copies must be between 1 byte and 5 MB."));
});
