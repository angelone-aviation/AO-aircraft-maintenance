/**
 * Responsibility: Pins the order and visibility of the Overview's sections
 *   for each role.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/overview.ts, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Permission } from "./model";
import { overviewSections } from "./overview";

const SAFETY_SECTIONS = ["fleet", "adAlerts", "kpis"];

describe("overviewSections", () => {
  it("keeps the fleet summary first for a system administrator", () => {
    expect(overviewSections(demoSnapshot())).toEqual([
      "inventory",
      "kpis",
      "fleet",
      "adAlerts",
      "faaRenewal",
      "outlook",
      "records",
    ]);
  });

  it("keeps the fleet summary first for a program administrator who also maintains", () => {
    const s = member(["read", "maintenance", "flight"], true);
    expect(overviewSections(s)[0]).toBe("inventory");
    expect(overviewSections(s)[1]).toBe("kpis");
  });

  it("puts what is overdue and due soon first for a mechanic, then the fleet", () => {
    expect(overviewSections(member(["read", "maintenance", "flight"]))).toEqual(
      [
        "outlook",
        "adAlerts",
        "inventory",
        "kpis",
        "fleet",
        "faaRenewal",
        "records",
      ],
    );
  });

  it("puts a pilot's aircraft first, then grounding alerts, and leaves out maintenance planning", () => {
    expect(overviewSections(member(["read", "flight", "discrepancy"]))).toEqual(
      ["fleet", "adAlerts", "kpis", "records"],
    );
  });

  it("keeps the administrator order for a member with no flight or maintenance role", () => {
    expect(overviewSections(member(["read", "resolve"]))).toEqual(
      overviewSections(demoSnapshot()),
    );
  });

  it("never hides aircraft status, AD alerts or the due counts from any role", () => {
    for (const permissions of [
      ["read", "flight"],
      ["read", "maintenance"],
      ["read"],
    ] as Permission[][])
      expect(overviewSections(member(permissions))).toEqual(
        expect.arrayContaining(SAFETY_SECTIONS),
      );
  });
});

/** The demo user as a non-administrator in one group of the demo program. */
function member(permissions: Permission[], programAdmin = false) {
  const s = demoSnapshot();
  s.user = {
    ...s.user,
    isAdmin: false,
    groupIds: ["role"],
    activeProgramUuid: "demo-program",
  };
  s.groups = [
    {
      id: "role",
      name: "Role",
      programUuid: "demo-program",
      aircraftIds: [],
      permissions,
      programAdmin,
    },
  ];
  return s;
}
