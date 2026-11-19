/**
 * Responsibility: Pins certificate approval (S20, A5): a filed or changed
 *   certificate waits for an administrator, only approved ones are cited,
 *   printed or unlock the inspection signoff, who may approve whose, and the
 *   change-log entries each change writes.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/certificateApproval.ts, ./certifications,
 *   ./taskCards, ./model, ./rejection, src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  approveCertification,
  certificatesAwaitingApproval,
  certificationChanges,
  fileCertifications,
  mayApproveCertificates,
} from "./certificateApproval";
import {
  certificateOptions,
  certificateSummary,
  memberLicense,
  type Certification,
} from "./certifications";
import type { Group, Member, Snapshot } from "./model";
import { Rejection } from "./rejection";
import {
  inspectorCertificatePending,
  inspectorCertificateProblem,
  inspectorMaintenanceCertificateRequired,
} from "./taskCards";

const TODAY = "2026-11-19";
const pilot: Certification = {
  kind: "pilot",
  number: "P-1",
  issuedOn: "2020-01-01",
};
const mechanic: Certification = {
  kind: "mechanic",
  number: "M-1",
  issuedOn: "2020-01-01",
  airframe: true,
  powerplant: true,
};
const pending = (c: Certification): Certification => ({ ...c, pending: true });

describe("filing a certificate", () => {
  it("marks a new or changed certificate pending, and keeps an unchanged one as it was", () => {
    expect(fileCertifications(undefined, [pilot])).toEqual([pending(pilot)]);
    const changed = fileCertifications(
      [pilot, mechanic],
      [pilot, { ...mechanic, ia: true }],
    );
    expect(changed).toEqual([pilot, pending({ ...mechanic, ia: true })]);
    expect(fileCertifications(changed, changed)).toEqual(changed);
  });

  it("ignores the pending flag a save sends, so nobody approves by saving", () => {
    const sent = { ...pilot, number: "P-2", pending: false };
    expect(fileCertifications([pilot], [sent])).toEqual([
      pending({ ...pilot, number: "P-2" }),
    ]);
    expect(fileCertifications([pending(pilot)], [pilot])).toEqual([
      pending(pilot),
    ]);
  });

  it("lists each change for the change log with the certificate before and after", () => {
    const before = [pilot, mechanic];
    const after = fileCertifications(before, [{ ...mechanic, number: "M-2" }]);
    expect(certificationChanges(before, after)).toEqual([
      { action: "user.certification_removed", before: pilot, after: null },
      {
        action: "user.certification_edited",
        before: mechanic,
        after: after[0],
      },
    ]);
    expect(certificationChanges(undefined, [pending(pilot)])).toEqual([
      {
        action: "user.certification_filed",
        before: null,
        after: pending(pilot),
      },
    ]);
    expect(certificationChanges(before, before)).toEqual([]);
  });
});

describe("approved certificates only", () => {
  it("cites and prints only approved certificates", () => {
    const certifications = [pending(pilot), mechanic];
    expect(certificateOptions({ certifications }, TODAY)).toEqual([
      { key: "mechanic", licenseNumber: "M-1", certificateType: "A&P" },
    ]);
    expect(memberLicense({ certifications: [pending(mechanic)] })).toEqual({
      licenseNumber: "",
      certificateType: "",
    });
  });

  it("unlocks the inspection signoff only once the mechanic certificate is approved", () => {
    const waiting = [pending(mechanic)];
    expect(
      inspectorCertificateProblem({ certifications: waiting }, TODAY),
    ).toBe(inspectorCertificatePending);
    expect(
      inspectorCertificateProblem({ certifications: [pending(pilot)] }, TODAY),
    ).toBe(inspectorMaintenanceCertificateRequired);
    const approved = approveCertification(waiting, mechanic);
    expect(
      inspectorCertificateProblem({ certifications: approved }, TODAY),
    ).toBeUndefined();
  });

  it("approves a pending certificate only exactly as the approver reviewed it", () => {
    const waiting = [pilot, pending(mechanic)];
    expect(approveCertification(waiting, mechanic)).toEqual([pilot, mechanic]);
    const notWaiting = () => approveCertification(waiting, pilot);
    expect(notWaiting).toThrow(Rejection);
    expect(notWaiting).toThrow(
      /^This certificate is not waiting for approval\.$/,
    );
    expect(() =>
      approveCertification(waiting, { ...mechanic, number: "M-9" }),
    ).toThrow(
      /^This certificate changed since you opened it\. Review it again\.$/,
    );
  });
});

const group = (id: string, programUuid: string, admin = false): Group => ({
  id,
  name: id,
  programUuid,
  programAdmin: admin,
  aircraftIds: [],
  permissions: ["read"],
});
const person = (id: string, groupIds: string[], isAdmin = false): Member => ({
  id,
  name: id,
  email: "",
  active: true,
  isAdmin,
  groupIds,
  activeProgramUuid: "demo-program",
});

function approverState(user: Member): Snapshot {
  return {
    ...demoSnapshot(),
    user,
    groups: [
      group("managers", "demo-program", true),
      group("crew", "demo-program"),
      group("elsewhere", "other-program"),
    ],
    programs: [
      ...demoSnapshot().programs!,
      { ...demoSnapshot().programs![0], uuid: "other-program" },
    ],
  };
}

it("shows a pending certificate as waiting for approval", () => {
  expect(certificateSummary(pending({ ...mechanic, ia: true }))).toBe(
    "No. M-1 · Airframe, Powerplant, IA · Waiting for approval",
  );
  expect(certificateSummary(pilot)).toBe("No. P-1");
});

describe("who approves", () => {
  const crew = person("crew-member", ["crew"]);
  const outsider = person("outsider", ["elsewhere"]);

  it("lets a program administrator approve their program's members, and a system administrator anyone, but nobody themself", () => {
    const manager = approverState(person("manager", ["managers"]));
    expect(mayApproveCertificates(manager, crew)).toBe(true);
    expect(mayApproveCertificates(manager, outsider)).toBe(false);
    expect(mayApproveCertificates(manager, manager.user)).toBe(false);
    const system = approverState(person("root", [], true));
    expect(mayApproveCertificates(system, outsider)).toBe(true);
    expect(mayApproveCertificates(system, system.user)).toBe(false);
    const member = approverState(person("member", ["crew"]));
    expect(mayApproveCertificates(member, crew)).toBe(false);
  });

  it("lists the pending certificates the approver may approve, in member order", () => {
    const manager = approverState(person("manager", ["managers"]));
    const members = [
      { ...crew, certifications: [pilot, pending(mechanic)] },
      { ...outsider, certifications: [pending(pilot)] },
      { ...manager.user, certifications: [pending(pilot)] },
    ];
    expect(certificatesAwaitingApproval(manager, members)).toEqual([
      { userId: "crew-member", name: "crew-member", certificate: mechanic },
    ]);
  });
});
