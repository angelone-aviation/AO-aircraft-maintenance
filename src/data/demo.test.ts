/**
 * Responsibility: Pins the demo fixture's promises: fresh snapshots, dates
 *   relative to now, the meter offsets, and the owner switch.
 * Layer: Test.
 * Dependencies: vitest, src/data/demo.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_OWNER_ID, demoSnapshot, withDemoUser } from "./demo";

const NOW = new Date("2026-11-03T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("demoSnapshot", () => {
  it("returns a new snapshot on each call, signed in as members[0]", () => {
    const first = demoSnapshot();
    first.aircraft[0].registration = "CHANGED";

    const second = demoSnapshot();

    expect(second.aircraft[0].registration).toBe("N206MA");
    expect(second.user).toBe(second.members[0]);
    expect(second.user.isAdmin).toBe(true);
  });

  it("dates records relative to now", () => {
    const s = demoSnapshot();

    expect(s.authenticatedAt).toBe(NOW.getTime());
    expect(s.discrepancies[0].createdAt).toBe(NOW.getTime() - 86_400_000);
    expect(s.inspections.map((i) => i.dueDate).filter(Boolean)).toEqual([
      "2027-01-26",
      "2026-11-27",
    ]);
  });

  it("runs tach 80 hours behind Hobbs and landings 300 ahead of cycles", () => {
    const [stationair] = demoSnapshot().aircraft;

    expect(stationair).toMatchObject({
      baselineHobbs: 8_428_320,
      currentTach: 8_140_320,
      cycles: 1894,
      landings: 2194,
    });
  });
});

describe("withDemoUser", () => {
  it("switches to the N206MA owner, adding them once", () => {
    const owner = withDemoUser(withDemoUser(demoSnapshot(), true), true);

    expect(owner.user.id).toBe(DEMO_OWNER_ID);
    expect(owner.members.filter((m) => m.id === DEMO_OWNER_ID)).toHaveLength(1);
    expect(owner.groups.find((g) => g.id === "demo-owners")).toMatchObject({
      owner: true,
      aircraftIds: ["demo-206"],
      permissions: ["read"],
    });
  });

  it("switches back to the administrator and keeps existing owner records", () => {
    const owner = withDemoUser(demoSnapshot(), true);
    const renamed = {
      ...owner,
      members: owner.members.map((m) =>
        m.id === DEMO_OWNER_ID ? { ...m, name: "Renamed owner" } : m,
      ),
    };

    const admin = withDemoUser(renamed, false);

    expect(admin.user.id).toBe("demo-admin");
    expect(admin.members.find((m) => m.id === DEMO_OWNER_ID)?.name).toBe(
      "Renamed owner",
    );
  });

  it("refuses a snapshot without the administrator", () => {
    const s = demoSnapshot();

    expect(() => withDemoUser({ ...s, members: [] }, false)).toThrow(
      "Demo account not found.",
    );
  });
});
