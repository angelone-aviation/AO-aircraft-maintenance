/**
 * Responsibility: Pins who gets the board view, the read-only rule for board
 *   groups, and what the board snapshot keeps (status inputs, totals) and
 *   clears (text, people, rates, files).
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/boardView.ts, ./programs, ./aircraftStatus,
 *   ./defaultPermissionGroups, ./model, ./rejection, ./airworthiness,
 *   ./management, ./components/records (schemas), tests/fixtures.
 */
import { describe, it, expect } from "vitest";
import { partsFixture } from "../../tests/fixtures/requiredParts";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { can, type Group, type Snapshot } from "./model";
import { scopedSnapshot } from "./programs";
import { aircraftStatus } from "./aircraftStatus";
import type { WorkOrder } from "./workOrders";
import type { AD } from "./airworthiness";
import {
  defaultPermissionGroups,
  missingDefaultGroups,
} from "./defaultPermissionGroups";
import {
  BOARD_FIELDS,
  boardCostTotals,
  boardSnapshot,
  isBoardView,
  validateBoardGroup,
} from "./boardView";
import {
  adComplianceSchema,
  adSchema,
  adSourceSchema,
  adTaskSchema,
} from "./airworthiness";
import { inspectionSchema } from "./management";
import { componentSchema, requirementSchema } from "./components/records";
import { Rejection } from "./rejection";

const AIRCRAFT = "demo-206";
const TODAY = "2026-11-09";
const BOARD_GROUP: Group = {
  id: "board",
  name: "Board (read-only)",
  programUuid: "demo-program",
  board: true,
  aircraftIds: [],
  permissions: ["read"],
};

function completedWorkOrder(uuid: string): WorkOrder {
  return {
    uuid,
    version: 1,
    recordedAt: 1,
    createdBy: "demo-admin",
    number: "WO-" + uuid,
    aircraftUuid: AIRCRAFT,
    dateOpened: "2026-10-01",
    completionDate: "2026-10-15",
    status: "completed",
    priority: "routine",
    scope: "Annual inspection",
    supervisor: "Chief inspector",
    releaseOutcome: "Internal release note",
    finalReview: "Internal review note",
    aircraft: {
      registration: "N206MA",
      make: "Cessna",
      model: "206",
      serial: "1",
      totalSeconds: 0,
      hobbs: 0,
      tach: 0,
      meter: "hobbs",
      cycles: 0,
    },
    componentReadings: [],
    tasks: [],
  };
}

function laborEntry(uuid: string, date: string, minutes: number) {
  return {
    uuid,
    date,
    technician: "Pat Technician",
    minutes,
    rateCents: 10_000,
    createdBy: "demo-admin",
    createdAt: 1,
  };
}

function ad(): AD {
  return {
    uuid: "11111111-1111-4111-8111-111111111111",
    version: 1,
    programUuid: "demo-program",
    aircraftUuid: AIRCRAFT,
    componentUuid: "",
    source: {
      number: "2026-01-01",
      subject: "Fuel line inspection",
      url: "",
      recurring: "Yes",
      sourceNotes: "",
    } as AD["source"],
    applicability: "Applicable",
    reason: "Internal applicability reasoning",
    tasks: [],
    history: [
      {
        uuid: "22222222-2222-4222-8222-222222222222",
        taskUuid: "33333333-3333-4333-8333-333333333333",
        date: "2026-10-01",
        hours: null,
        cycles: null,
        method: "Inspected",
        serviceBulletin: "",
        terminatedBy: "",
        workOrderUuid: "",
        mechanic: "Pat Technician",
        certificate: "A&P 123",
        evidence: "Logbook page 7",
        recordedAt: 1,
        recordedBy: "demo-admin",
        correctionReason: "Internal correction reason",
      },
    ],
    sourceHistory: [],
    reviewRequired: false,
    updatedAt: 1,
  };
}

// A board member of the demo program, with the records the whitelist must
// reduce: costed work orders, a budget, an AD with compliance, a grounding
// discrepancy, internal notes on a component.
function boardState(): Snapshot {
  const s = partsFixture();
  s.management = [
    ...(s.management ?? []),
    {
      ...workOrderComponent(),
      notes: "Internal component note",
      locationUuid: "parts-location",
    },
  ];
  s.user = {
    ...s.user,
    id: "board-member",
    isAdmin: false,
    groupIds: ["board"],
  };
  s.members = [...s.members, s.user];
  s.groups = [...s.groups, BOARD_GROUP];
  s.discrepancies = [
    ...s.discrepancies,
    {
      uuid: "grounding",
      aircraftUuid: AIRCRAFT,
      description: "Private: hydraulic leak",
      status: "open",
      grounding: true,
      authorId: "demo-pilot",
      createdAt: 1,
    },
  ];
  s.workOrders = [completedWorkOrder("wo-1"), completedWorkOrder("wo-2")];
  s.costs = [
    {
      uuid: "rate",
      version: 1,
      programUuid: "demo-program",
      kind: "settings",
      laborRateCents: 9_000,
    },
    {
      uuid: "budget",
      version: 1,
      programUuid: "demo-program",
      kind: "budget",
      aircraftUuid: AIRCRAFT,
      year: 2026,
      amountCents: 500_000,
    },
    {
      uuid: "cost-1",
      version: 1,
      programUuid: "demo-program",
      kind: "workOrder",
      aircraftUuid: AIRCRAFT,
      workOrderUuid: "wo-1",
      // One hour in Q4, one hour in Q3: $100 this quarter, $200 this year.
      labor: [
        laborEntry("l1", "2026-10-15", 60),
        laborEntry("l2", "2026-09-30", 60),
      ],
      other: [],
      partUnitCosts: [],
    },
  ];
  s.airworthiness = [ad()];
  s.audit = [
    {
      uuid: "a",
      aircraftUuid: AIRCRAFT,
      actorId: "demo-admin",
      at: 1,
      action: "flight.created",
      entityUuid: "f",
    },
  ];
  return s;
}

describe("board view", () => {
  it("recognises only board-only membership in the active program", () => {
    const s = boardState();
    expect(isBoardView(s)).toBe(true);
    expect(isBoardView({ ...s, user: { ...s.user, isAdmin: true } })).toBe(
      false,
    );
    expect(isBoardView({ ...s, user: { ...s.user, active: false } })).toBe(
      false,
    );
    // A board member who also holds another read group keeps the workspace.
    const pilots = s.groups.find((g) => g.id === "demo-pilots")!;
    expect(
      isBoardView({
        ...s,
        user: { ...s.user, groupIds: ["board", pilots.id] },
      }),
    ).toBe(false);
  });

  it("rejects board groups that could write, administer or own aircraft", () => {
    const read: Group["permissions"] = ["read"];
    expect(() =>
      validateBoardGroup({ board: true, permissions: read }),
    ).not.toThrow();
    expect(() =>
      validateBoardGroup({
        board: false,
        programAdmin: true,
        permissions: read,
      }),
    ).not.toThrow();
    expect(() =>
      validateBoardGroup({ board: true, permissions: ["read", "flight"] }),
    ).toThrow(
      new Rejection(
        "Board groups are read-only: remove administrator and write permissions.",
      ),
    );
    expect(() =>
      validateBoardGroup({
        board: true,
        programAdmin: true,
        permissions: read,
      }),
    ).toThrow(Rejection);
    expect(() =>
      validateBoardGroup({ board: true, owner: true, permissions: read }),
    ).toThrow(
      new Rejection(
        "A group is a board group or an aircraft owner group, not both.",
      ),
    );
  });

  it("keeps identity, status inputs and totals; clears text, people, rates and files", () => {
    const full = boardState();
    const b = scopedSnapshot(full);
    expect(b.flights).toEqual([]);
    expect(b.audit).toEqual([]);
    expect(b.members.map((m) => m.id)).toEqual(["board-member"]);
    expect(b.groups.map((g) => g.id)).toEqual(["board"]);
    expect(b.aircraft.map((a) => a.uuid)).toEqual(
      full.aircraft.map((a) => a.uuid),
    );
    expect(b.costs).toBeUndefined();
    expect(b.aircraftFiles).toBeUndefined();
    expect(b.purchaseOrders).toBeUndefined();
    expect(b.partsRequests).toBeUndefined();
    expect(b.partsInventory).toBeUndefined();
    const grounding = b.discrepancies.find((d) => d.uuid === "grounding")!;
    expect(grounding).toEqual({
      uuid: "grounding",
      aircraftUuid: AIRCRAFT,
      description: "",
      status: "open",
      createdAt: 1,
      authorId: "",
      grounding: true,
      deferral: undefined,
    });
    expect(b.workOrders).toHaveLength(2);
    expect(b.workOrders![0].scope).toBe("Annual inspection");
    expect(b.airworthiness![0].history[0].date).toBe("2026-10-01");
    const text = JSON.stringify(b);
    expect(text).not.toMatch(
      /rateCents|laborRateCents|Internal|Private|Pat Technician|A&P|Logbook page|Chief/,
    );
    expect(aircraftStatus(b, AIRCRAFT).level).toBe(
      aircraftStatus(full, AIRCRAFT).level,
    );
    expect(aircraftStatus(b, AIRCRAFT).level).toBe("grounded");
    expect(full.aircraft.some((a) => can(b, a.uuid, "flight"))).toBe(false);
  });

  it("totals this quarter's and this year's spend against the budget", () => {
    const totals = boardCostTotals(boardState(), TODAY);
    expect(totals.find((t) => t.aircraftUuid === AIRCRAFT)).toEqual({
      aircraftUuid: AIRCRAFT,
      year: 2026,
      quarterLabel: "Q4 2026",
      quarterCents: 10_000,
      yearCents: 20_000,
      budgetCents: 500_000,
      overBudget: false,
    });
    expect(boardCostTotals(boardState(), "2026-03-31")[0].quarterLabel).toBe(
      "Q1 2026",
    );
    expect(scopedSnapshot(boardState()).boardCosts).toEqual(
      boardCostTotals(boardState()),
    );
  });

  it("passes the backup time through and nothing else from outside the whitelist", () => {
    const s = {
      ...boardState(),
      offsiteBackupAt: 42,
      savedAddresses: [{ programUuid: "demo-program" }] as never,
    };
    const b = boardSnapshot(s, TODAY);
    expect(b.offsiteBackupAt).toBe(42);
    expect(b.savedAddresses).toBeUndefined();
    expect(Object.keys(b).sort()).toEqual(
      [
        "activeProgramUuid",
        "aircraft",
        "airworthiness",
        "audit",
        "authenticatedAt",
        "boardCosts",
        "discrepancies",
        "flights",
        "groups",
        "inspections",
        "management",
        "members",
        "offsiteBackupAt",
        "programScopeVersion",
        "programs",
        "syncedAt",
        "user",
        "workOrders",
      ].sort(),
    );
  });

  it("ships a read-only default board group that programs created earlier still lack", () => {
    const board = defaultPermissionGroups.find((g) => g.board)!;
    expect(board.name).toBe("Board (read-only)");
    expect(() => validateBoardGroup(board)).not.toThrow();
    expect(
      missingDefaultGroups([{ name: "Observers" }]).map((g) => g.name),
    ).toContain("Board (read-only)");
    expect(
      missingDefaultGroups([{ name: "board (READ-ONLY)" }]).map((g) => g.name),
    ).not.toContain("Board (read-only)");
  });
});

// What the board never reads, by record: typed text, people, parts and
// places. A schema key in neither this list nor BOARD_FIELDS fails the test,
// so a new field is decided on before it can reach the board.
const BOARD_WITHHELD = {
  inspection: [
    "calendarExemptReason",
    "calendarExemptChangedBy",
    "requiredParts",
    "manualReference",
    "materials",
  ],
  ad: ["reason", "source", "sourceHistory", "tasks", "history"],
  adSource: ["sourceNotes"],
  adTask: ["description"],
  adCompliance: [
    "method",
    "serviceBulletin",
    "terminatedBy",
    "mechanic",
    "certificate",
    "evidence",
    "recordedBy",
    "correctionReason",
  ],
  component: [
    "outForRepair",
    "incomingTag",
    "manualReference",
    "notes",
    "locationUuid",
    "partsLocation",
  ],
  requirement: ["requiredParts", "manualReference", "notes"],
} satisfies Record<keyof typeof BOARD_FIELDS, string[]>;

const SCHEMAS = {
  inspection: inspectionSchema,
  ad: adSchema,
  adSource: adSourceSchema,
  adTask: adTaskSchema,
  adCompliance: adComplianceSchema,
  component: componentSchema,
  requirement: requirementSchema,
} satisfies Record<keyof typeof BOARD_FIELDS, { shape: object }>;

describe("the board whitelist", () => {
  it.each(Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[])(
    "decides every %s field: passed by name or withheld",
    (record) => {
      const passed: readonly string[] = BOARD_FIELDS[record];
      const withheld: readonly string[] = BOARD_WITHHELD[record];
      expect(passed.filter((k) => withheld.includes(k))).toEqual([]);
      expect([...passed, ...withheld].sort()).toEqual(
        Object.keys(SCHEMAS[record].shape).sort(),
      );
    },
  );

  it("passes no withheld text of an inspection, AD, deferral or component", () => {
    const s = boardState();
    const marked = (key: string) => `MARK-${key}`;
    s.inspections = s.inspections.map((i) => ({
      ...i,
      calendarExemptReason: marked("calendarExemptReason"),
      calendarExemptChangedBy: marked("calendarExemptChangedBy"),
      materials: marked("materials"),
    }));
    const ad = s.airworthiness![0];
    s.airworthiness = [
      {
        ...ad,
        reason: marked("reason"),
        source: { ...ad.source, sourceNotes: marked("sourceNotes") },
        tasks: ad.tasks.map((t) => ({ ...t, description: marked("task") })),
        history: ad.history.map((h) => ({
          ...h,
          method: marked("method"),
          serviceBulletin: marked("serviceBulletin"),
          terminatedBy: marked("terminatedBy"),
          correctionReason: marked("correctionReason"),
        })),
      },
    ];
    s.discrepancies = s.discrepancies.map((d) => ({
      ...d,
      deferral: {
        type: "mel",
        melItem: marked("melItem"),
        category: "C",
        placard: marked("placard"),
        deferredOn: TODAY,
        deferredAt: 1,
        deferredBy: marked("deferredBy"),
        deferredByName: marked("deferredByName"),
      },
    }));
    const view = boardSnapshot(scopedSnapshot(s), TODAY);
    expect(JSON.stringify(view).match(/MARK-[A-Za-z]+/g) ?? []).toEqual([]);
    expect(view.airworthiness![0].history.length).toBeGreaterThan(0);
    expect(view.discrepancies.every((d) => d.deferral)).toBe(true);
  });
});
