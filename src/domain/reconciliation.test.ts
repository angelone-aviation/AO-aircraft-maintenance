/**
 * Responsibility: Pins the paper check: which flights and work orders a month
 *   lists and in what order, the readings, oil, status and photo columns,
 *   the totals over accepted flights, the empty month, and the CSV records.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/reconciliation.ts, src/data/demo.ts, src/domain
 *   (model, aircraftFiles, workOrders types), tests/fixtures/workOrders.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Flight, Snapshot } from "./model";
import type { AircraftFile } from "./aircraftFiles";
import type { WorkOrder } from "./workOrders";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import {
  formatOilAdded,
  paperCheck,
  paperCheckRecords,
  PAPER_CHECK_FLIGHT_COLUMNS,
  PAPER_CHECK_WORK_COLUMNS,
} from "./reconciliation";
import { Rejection } from "./rejection";

const HOUR = 3600;

function flight(aircraftUuid: string, over: Partial<Flight>): Flight {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid,
    authorId: "demo-pilot",
    pilotId: "demo-pilot",
    submittedAt: 1,
    status: "accepted",
    startTime: "2026-03-04T10:00:00-07:00",
    hobbsOff: 100 * HOUR,
    hobbsOn: 101 * HOUR,
    landings: 2,
    cycles: 2,
    origin: "A",
    destination: "B",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
    ...over,
  };
}

function photoOf(linkedKind: "flight" | "work-order", linkedUuid: string) {
  return {
    uuid: `photo-${linkedUuid}`,
    aircraftUuid: "demo-206",
    category: "logbook-page",
    linkedKind,
    linkedUuid,
    name: "page.jpg",
    type: "image/jpeg",
    size: 1,
    uploadedAt: 1,
    url: "",
  } satisfies AircraftFile;
}

function completedOrder(over: Partial<WorkOrder>): WorkOrder {
  const command = workOrderCommand();
  return {
    ...command.fields,
    uuid: command.uuid,
    version: 1,
    recordedAt: 1,
    tasks: [],
    componentUuids: [],
    status: "completed",
    completionDate: "2026-03-20",
    number: "WO-2026-0007",
    ...over,
  } as WorkOrder;
}

function month(): Snapshot {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  expect(a.meter).toBe("hobbs");
  const late = flight(a.uuid, {
    uuid: "late",
    startTime: "2026-03-28T09:00:00-07:00",
    hobbsOff: 101 * HOUR,
    hobbsOn: 102.5 * HOUR,
    landings: 1,
    oil: [{ engine: "single", unit: "US qt", added: 1.5 }],
  });
  const early = flight(a.uuid, {
    uuid: "early",
    startTime: "2026-03-04T10:00:00-07:00",
  });
  const held = flight(a.uuid, {
    uuid: "held",
    status: "review",
    startTime: "2026-03-10T10:00:00-07:00",
    hobbsOff: undefined,
    landings: 5,
  });
  const rejected = flight(a.uuid, {
    uuid: "rejected",
    status: "rejected",
    startTime: "2026-03-12T10:00:00-07:00",
    landings: 7,
  });
  // Started in March UTC but on 31 March local time: on March's paper page.
  const edge = flight(a.uuid, {
    uuid: "edge",
    startTime: "2026-03-31T23:30:00-07:00",
    hobbsOff: 102.5 * HOUR,
    hobbsOn: 103 * HOUR,
    landings: 1,
  });
  const april = flight(a.uuid, {
    uuid: "april",
    startTime: "2026-04-01T08:00:00-07:00",
  });
  const other = flight(s.aircraft[1].uuid, { uuid: "other" });
  s.flights = [late, april, early, other, held, rejected, edge];
  s.workOrders = [
    completedOrder({
      uuid: "w-late",
      completionDate: "2026-03-25",
      number: "WO-2026-0009",
    }),
    completedOrder({
      uuid: "w-early",
      completionDate: "2026-03-20",
      closeout: {
        completedBy: {
          userId: "u",
          name: "Casey Tech",
          licenseNumber: "1",
          certificateType: "A&P",
        },
      } as WorkOrder["closeout"],
    }),
    completedOrder({ uuid: "w-open", status: "open", completionDate: "" }),
    completedOrder({ uuid: "w-feb", completionDate: "2026-02-28" }),
    completedOrder({ uuid: "w-other", aircraftUuid: s.aircraft[1].uuid }),
  ];
  s.aircraftFiles = [
    photoOf("flight", "late"),
    photoOf("work-order", "w-early"),
    { ...photoOf("flight", "early"), archivedAt: 5 },
  ];
  return s;
}

it("lists the month's flights earliest first with the paper line's readings, oil, status and photo", () => {
  const s = month();
  const check = paperCheck(s, s.aircraft[0].uuid, "2026-03");
  expect(check.header).toEqual({
    registration: s.aircraft[0].registration,
    makeModel: `${s.aircraft[0].make} ${s.aircraft[0].model}`,
    serial: s.aircraft[0].serial,
    month: "March 2026",
    yearMonth: "2026-03",
    meter: "Hobbs",
  });
  expect(check.flights.map((r) => r.date)).toEqual([
    "2026-03-04",
    "2026-03-10",
    "2026-03-12",
    "2026-03-28",
    "2026-03-31",
  ]);
  expect(check.flights[0]).toEqual({
    date: "2026-03-04",
    pilot: "Jordan Lee",
    meterStart: "100.0",
    meterEnd: "101.0",
    hours: "1.0",
    landings: "2",
    oilAdded: "",
    status: "Accepted",
    photo: "No",
    checked: "",
  });
  expect(check.flights[1]).toMatchObject({
    meterStart: "",
    hours: "",
    status: "Needs review",
  });
  expect(check.flights[2].status).toBe("Rejected");
  expect(check.flights[3]).toMatchObject({
    hours: "1.5",
    oilAdded: "1.5 US qt",
    photo: "Yes",
  });
  // Held and rejected flights change no totals.
  expect(check.totals).toEqual({ flights: 3, hours: "3.0", landings: 4 });
});

it("lists the month's completed work orders by completion date with who signed and the page photo", () => {
  const s = month();
  const check = paperCheck(s, s.aircraft[0].uuid, "2026-03");
  expect(check.work).toEqual([
    {
      date: "2026-03-20",
      summary: "WO-2026-0007: Annual maintenance",
      signedBy: "Casey Tech",
      photo: "Yes",
      checked: "",
    },
    {
      date: "2026-03-25",
      summary: "WO-2026-0009: Annual maintenance",
      signedBy: "Supervisor",
      photo: "No",
      checked: "",
    },
  ]);
});

it("gives a month with no flights or work empty rows and zero totals", () => {
  const s = demoSnapshot();
  const check = paperCheck(s, s.aircraft[0].uuid, "2026-01");
  expect(check.flights).toEqual([]);
  expect(check.work).toEqual([]);
  expect(check.totals).toEqual({ flights: 0, hours: "0.0", landings: 0 });
  expect(check.header.month).toBe("January 2026");
  expect(paperCheckRecords(check)).toEqual([
    { Section: "Totals", Hours: "0.0", Landings: "0", Flights: "0" },
  ]);
});

it("refuses an unknown aircraft or a malformed month with a Rejection", () => {
  const s = demoSnapshot();
  expect(() => paperCheck(s, "missing", "2026-03")).toThrow(Rejection);
  expect(() => paperCheck(s, "missing", "2026-03")).toThrow(
    "Aircraft not found.",
  );
  for (const bad of ["2026-13", "2026-3", "March 2026", "2026-03-01", ""])
    expect(() => paperCheck(s, s.aircraft[0].uuid, bad)).toThrow(
      Error("Choose a month as YYYY-MM."),
    );
});

it("flattens the check into CSV records: flights, then work, then totals", () => {
  const s = month();
  const records = paperCheckRecords(
    paperCheck(s, s.aircraft[0].uuid, "2026-03"),
  );
  expect(records.map((r) => r.Section)).toEqual([
    "Flight",
    "Flight",
    "Flight",
    "Flight",
    "Flight",
    "Work order",
    "Work order",
    "Totals",
  ]);
  expect(Object.keys(records[0])).toEqual([
    "Section",
    "Date",
    "Pilot",
    "Hobbs start",
    "Hobbs end",
    "Hours",
    "Landings",
    "Oil added",
    "Status",
    "Photo",
    "Checked",
  ]);
  expect(records[5]).toEqual({
    Section: "Work order",
    Date: "2026-03-20",
    "Work order": "WO-2026-0007: Annual maintenance",
    "Signed by": "Casey Tech",
    Photo: "Yes",
    Checked: "",
  });
  expect(records[7]).toEqual({
    Section: "Totals",
    Hours: "3.0",
    Landings: "4",
    Flights: "3",
  });
  expect(PAPER_CHECK_FLIGHT_COLUMNS).toHaveLength(10);
  expect(PAPER_CHECK_WORK_COLUMNS).toHaveLength(5);
});

it("sums the oil added per unit and ignores readings without an addition", () => {
  expect(formatOilAdded(undefined)).toBe("");
  expect(
    formatOilAdded([
      { engine: "left", unit: "US qt", added: 1 },
      { engine: "right", unit: "range", addedUnit: "US qt", added: 0.5 },
    ]),
  ).toBe("1.5 US qt");
  expect(
    formatOilAdded([
      { engine: "left", unit: "US qt", start: 6 },
      { engine: "right", unit: "L", added: 2 },
    ]),
  ).toBe("2 L");
});
