import type { Aircraft, Snapshot } from "../domain/model";
export function demoSnapshot(): Snapshot {
  const now = Date.now();
  const user = {
    activeProgramUuid: "demo-program",
    id: "demo-admin",
    name: "Alex Morgan",
    email: "alex@example.test",
    isAdmin: true,
    active: true,
    groupIds: [],
  };
  function aircraft(
    uuid: string,
    registration: string,
    model: string,
    hobbs: number,
    cycles: number,
  ): Aircraft {
    return {
      uuid,
      registration,
      model,
      make: "Cessna",
      serial: "DEMO-" + uuid,
      program: "Mission operations",
      programUuid: "demo-program",
      meter: "hobbs",
      adjustmentSeconds: 0,
      baselineHobbs: Math.round(hobbs * 3600),
      baselineTach: Math.round((hobbs - 80) * 3600),
      baselineLandings: cycles + 300,
      baselineCycles: cycles,
      currentHobbs: Math.round(hobbs * 3600),
      currentTach: Math.round((hobbs - 80) * 3600),
      landings: cycles + 300,
      cycles,
      version: 0,
      operationalStatus: "unknown",
    };
  }
  const aircrafts = [
    aircraft("demo-206", "N206MA", "206 Stationair", 2341.2, 1894),
    aircraft("demo-208", "N208MA", "208 Caravan", 4218.6, 3201),
    aircraft("demo-182", "N182MA", "182 Skylane", 1650.4, 1142),
  ];
  const date = (days: number) =>
    new Date(now + days * 86400000).toISOString().slice(0, 10);
  return {
    activeProgramUuid: "demo-program",
    user,
    programs: [
      {
        uuid: "demo-program",
        version: 1,
        name: "Mission operations",
        address: "Demo airfield",
        email: "operations@example.test",
        contactName: "Demo coordinator",
        website: "https://example.test",
      },
    ],
    authenticatedAt: now,
    syncedAt: now,
    members: [
      user,
      {
        id: "demo-pilot",
        name: "Jordan Lee",
        email: "jordan@example.test",
        isAdmin: false,
        active: true,
        groupIds: ["demo-pilots"],
      },
    ],
    groups: [
      {
        id: "demo-pilots",
        name: "Pilots",
        programUuid: "demo-program",
        aircraftIds: aircrafts.map((a) => a.uuid),
        permissions: ["read", "flight", "discrepancy"],
      },
    ],
    aircraft: aircrafts,
    flights: [],
    discrepancies: [
      {
        uuid: "demo-report",
        aircraftUuid: "demo-208",
        description:
          "Left landing light is intermittent. Inspect the connector before next operation.",
        status: "open",
        authorId: user.id,
        createdAt: now - 86400000,
      },
    ],
    inspections: [
      {
        uuid: "demo-insp-1",
        aircraftUuid: "demo-206",
        reference: "100-hour inspection",
        description: "Airframe and engine inspection",
        dueSeconds: 2350 * 3600,
      },
      {
        uuid: "demo-insp-2",
        aircraftUuid: "demo-206",
        reference: "Annual inspection",
        description: "Calendar inspection",
        dueDate: date(84),
      },
      {
        uuid: "demo-insp-3",
        aircraftUuid: "demo-208",
        reference: "100-hour inspection",
        description: "Airframe and engine inspection",
        dueSeconds: 4250 * 3600,
      },
      {
        uuid: "demo-insp-4",
        aircraftUuid: "demo-182",
        reference: "Annual inspection",
        description: "Calendar inspection",
        dueDate: date(24),
      },
    ],
    audit: [],
  };
}
export const DEMO_OWNER_ID = "demo-owner";
/** Switches the demo workspace between the administrator and a sample
 * aircraft owner (N206MA), adding the owner account and group if missing. */
export function withDemoUser(s: Snapshot, owner: boolean): Snapshot {
  const group = {
    id: "demo-owners",
    name: "Aircraft owners",
    programUuid: "demo-program",
    owner: true,
    aircraftIds: ["demo-206"],
    permissions: ["read" as const],
  };
  const member = {
    id: DEMO_OWNER_ID,
    name: "Sam Rivera",
    email: "sam@example.test",
    isAdmin: false,
    active: true,
    groupIds: [group.id],
    activeProgramUuid: "demo-program",
  };
  const groups = s.groups.some((g) => g.id === group.id)
    ? s.groups
    : [...s.groups, group];
  const members = s.members.some((m) => m.id === member.id)
    ? s.members
    : [...s.members, member];
  const user = members.find(
    (m) => m.id === (owner ? DEMO_OWNER_ID : "demo-admin"),
  );
  if (!user) throw new Error("Demo account not found.");
  return { ...s, groups, members, user };
}
