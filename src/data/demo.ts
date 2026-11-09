/**
 * Responsibility: The fictional workspace demo mode starts from, and the
 *   sample owner and board member it can switch to.
 * Layer: Data. Fixture builders only; no storage, no React.
 * Dependencies: src/domain/model.ts (types).
 *
 * Server tests seed from demoSnapshot() too, so a change here changes them.
 */
import type {
  Aircraft,
  Discrepancy,
  Group,
  Inspection,
  Member,
  Snapshot,
} from "../domain/model";

const DEMO_PROGRAM_UUID = "demo-program";
const DEMO_ADMIN_ID = "demo-admin";
const HOUR_SECONDS = 3600;
const DAY_MS = 86_400_000;

/**
 * Builds the demo workspace: one program, three Cessnas, the administrator
 * signed in, a pilot group, an open problem report and four inspections.
 *
 * @returns A new snapshot on each call, so callers may mutate it. Times are
 *   relative to now: the report is a day old, annuals fall due in 24 and 84
 *   days. `user` is the same object as `members[0]`.
 */
export function demoSnapshot(): Snapshot {
  const now = Date.now();
  const user = {
    activeProgramUuid: DEMO_PROGRAM_UUID,
    id: DEMO_ADMIN_ID,
    name: "Alex Morgan",
    email: "alex@example.test",
    isAdmin: true,
    active: true,
    groupIds: [],
  };
  const aircraft = [
    demoAircraft("demo-206", "N206MA", "206 Stationair", 2341.2, 1894),
    demoAircraft("demo-208", "N208MA", "208 Caravan", 4218.6, 3201),
    demoAircraft("demo-182", "N182MA", "182 Skylane", 1650.4, 1142),
  ];
  return {
    activeProgramUuid: DEMO_PROGRAM_UUID,
    user,
    programs: [demoProgram()],
    authenticatedAt: now,
    syncedAt: now,
    members: [user, demoPilot()],
    groups: [demoPilotGroup(aircraft.map((a) => a.uuid))],
    aircraft,
    flights: [],
    discrepancies: [demoReport(user.id, now)],
    inspections: demoInspections(now),
    audit: [],
  };
}

/** The sample aircraft owner's member id, used to switch the demo to them. */
export const DEMO_OWNER_ID = "demo-owner";
/** The sample board member's id, used to switch the demo to them. */
export const DEMO_BOARD_ID = "demo-board";

/** The demo accounts the workspace can be viewed as. */
export type DemoRole = "admin" | "owner" | "board";

// Each sample account with the group that gives it its reduced view.
const DEMO_SAMPLE_ACCOUNTS: Record<
  Exclude<DemoRole, "admin">,
  { group: Group; member: Member }
> = {
  owner: {
    group: {
      id: "demo-owners",
      name: "Aircraft owners",
      programUuid: DEMO_PROGRAM_UUID,
      owner: true,
      aircraftIds: ["demo-206"],
      permissions: ["read"],
    },
    member: {
      id: DEMO_OWNER_ID,
      name: "Sam Rivera",
      email: "sam@example.test",
      isAdmin: false,
      active: true,
      groupIds: ["demo-owners"],
      activeProgramUuid: DEMO_PROGRAM_UUID,
    },
  },
  board: {
    group: {
      id: "demo-board",
      name: "Board (read-only)",
      programUuid: DEMO_PROGRAM_UUID,
      board: true,
      aircraftIds: [],
      permissions: ["read"],
    },
    member: {
      id: DEMO_BOARD_ID,
      name: "Taylor Brooks",
      email: "taylor@example.test",
      isAdmin: false,
      active: true,
      groupIds: ["demo-board"],
      activeProgramUuid: DEMO_PROGRAM_UUID,
    },
  },
};

/**
 * Switches the demo workspace between the administrator and a sample aircraft
 * owner of N206MA, adding the owner and their group the first time.
 *
 * @param s - The full demo snapshot.
 * @param owner - True for the owner, false for the administrator.
 * @returns A copy with that user; existing owner records are kept as they are.
 * @throws {Error} "Demo account not found." when the administrator is missing.
 */
export function withDemoUser(s: Snapshot, owner: boolean): Snapshot {
  return signInAs(
    addSampleAccount(s, "owner"),
    owner ? DEMO_OWNER_ID : DEMO_ADMIN_ID,
  );
}

/**
 * Switches the demo workspace to the administrator, the sample aircraft owner
 * or the sample board member, adding the sample account and its group the
 * first time.
 *
 * @param s - The full demo snapshot.
 * @param role - The account to sign the demo in as.
 * @returns A copy with that user; existing sample records are kept as they
 *   are.
 * @throws {Error} "Demo account not found." when the administrator is missing.
 */
export function withDemoRole(s: Snapshot, role: DemoRole): Snapshot {
  if (role === "admin") return signInAs(s, DEMO_ADMIN_ID);
  return signInAs(
    addSampleAccount(s, role),
    DEMO_SAMPLE_ACCOUNTS[role].member.id,
  );
}

function addSampleAccount(
  s: Snapshot,
  role: Exclude<DemoRole, "admin">,
): Snapshot {
  const { group, member } = DEMO_SAMPLE_ACCOUNTS[role];
  return {
    ...s,
    groups: s.groups.some((g) => g.id === group.id)
      ? s.groups
      : [...s.groups, group],
    members: s.members.some((m) => m.id === member.id)
      ? s.members
      : [...s.members, member],
  };
}

function signInAs(s: Snapshot, memberId: string): Snapshot {
  const user = s.members.find((m) => m.id === memberId);
  if (!user) throw new Error("Demo account not found.");
  return { ...s, user };
}

// Tach runs 80 hours behind Hobbs, and landings 300 ahead of cycles.
function demoAircraft(
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
    programUuid: DEMO_PROGRAM_UUID,
    meter: "hobbs",
    adjustmentSeconds: 0,
    baselineHobbs: Math.round(hobbs * HOUR_SECONDS),
    baselineTach: Math.round((hobbs - 80) * HOUR_SECONDS),
    baselineLandings: cycles + 300,
    baselineCycles: cycles,
    currentHobbs: Math.round(hobbs * HOUR_SECONDS),
    currentTach: Math.round((hobbs - 80) * HOUR_SECONDS),
    landings: cycles + 300,
    cycles,
    version: 0,
    operationalStatus: "unknown",
  };
}

function demoProgram(): NonNullable<Snapshot["programs"]>[number] {
  return {
    uuid: DEMO_PROGRAM_UUID,
    version: 1,
    name: "Mission operations",
    address: "Demo airfield",
    email: "operations@example.test",
    contactName: "Demo coordinator",
    website: "https://example.test",
  };
}

function demoPilot(): Member {
  return {
    id: "demo-pilot",
    name: "Jordan Lee",
    email: "jordan@example.test",
    isAdmin: false,
    active: true,
    groupIds: ["demo-pilots"],
  };
}

function demoPilotGroup(aircraftIds: string[]): Group {
  return {
    id: "demo-pilots",
    name: "Pilots",
    programUuid: DEMO_PROGRAM_UUID,
    aircraftIds,
    permissions: ["read", "flight", "discrepancy"],
  };
}

function demoReport(authorId: string, now: number): Discrepancy {
  return {
    uuid: "demo-report",
    aircraftUuid: "demo-208",
    description:
      "Left landing light is intermittent. Inspect the connector before next operation.",
    status: "open",
    authorId,
    createdAt: now - DAY_MS,
  };
}

function demoInspections(now: number): Inspection[] {
  const date = (days: number) =>
    new Date(now + days * DAY_MS).toISOString().slice(0, 10);
  return [
    {
      uuid: "demo-insp-1",
      aircraftUuid: "demo-206",
      reference: "100-hour inspection",
      description: "Airframe and engine inspection",
      dueSeconds: 2350 * HOUR_SECONDS,
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
      dueSeconds: 4250 * HOUR_SECONDS,
    },
    {
      uuid: "demo-insp-4",
      aircraftUuid: "demo-182",
      reference: "Annual inspection",
      description: "Calendar inspection",
      dueDate: date(24),
    },
  ];
}
