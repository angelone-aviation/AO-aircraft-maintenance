/**
 * Responsibility: Pins conflict review: who may review, every refusal in the
 *   server's order and class, and what an accepted or rejected review stores.
 * Layer: Test. Vitest suite on the demo fleet; never shipped in the build.
 * Dependencies: ./airworthiness, ./flightReview, ./flights, ./flightPlans,
 *   ./model, ./rejection, src/data/demo.ts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { demoSnapshot } from "../data/demo";
import { blankAD } from "./airworthiness";
import { applyFlight } from "./flights";
import { flightPlanSchema, type FlightPlan } from "./flightPlans";
import type { Flight, FlightInput, Member, Snapshot } from "./model";
import { Rejection } from "./rejection";
import {
  assertReviewer,
  heldFlightComparison,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_REASON_MIN_LENGTH,
  reviewFlight,
  type FlightReview,
  type ReviewChanges,
} from "./flightReview";

const h = (hours: number) => Math.round(hours * 3600);
const PLAN = "5f0c7f39-6c55-4d2b-9a43-1f0d6a2c8e11";
const REASON = "Checked against the paper log";

// N206MA flew at 11:00 (accepted); a flight at 09:00 came in later and is
// held for review, with the starting readings it was submitted against.
function fixture() {
  const s = demoSnapshot();
  const opening = s.aircraft[0];
  const input: FlightInput = {
    aircraftUuid: opening.uuid,
    pilotId: "demo-pilot",
    startTime: "2026-10-03T09:00:00Z",
    hobbsOn: opening.currentHobbs + h(1),
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
  const flight = (changes: Partial<Flight>): Flight => ({
    ...input,
    uuid: crypto.randomUUID(),
    authorId: "demo-pilot",
    submittedAt: 0,
    status: "accepted",
    hobbsOff: opening.currentHobbs,
    tachOff: opening.currentTach,
    ...changes,
  });
  const later = flight({
    startTime: "2026-10-03T11:00:00Z",
    hobbsOn: opening.currentHobbs + h(2),
  });
  s.aircraft[0] = applyFlight(opening, later);
  const held = flight({
    status: "review",
    reviewReason: "Aircraft totals changed after this entry was started.",
    hobbsOff: later.hobbsOn,
  });
  s.flights = [later, held];
  return { s, opening, later, held, input };
}

const pilot = (s: Snapshot): Member => s.members.find((m) => !m.isAdmin)!;

function refusal(s: Snapshot, review: FlightReview) {
  try {
    reviewFlight(s, review);
  } catch (error) {
    return error;
  }
  throw new Error("The review was not refused.");
}

describe("reviewFlight refusals", () => {
  it("checks the reviewer, the reason, the flight, its links, the crew, then the flight and totals", () => {
    const { s, held, input } = fixture();
    // Every fault at once; each step clears the one reported before it.
    const flight: Flight = {
      ...held,
      status: "rejected",
      aircraftUuid: "demo-208",
      flightPlanUuid: PLAN,
    };
    s.flights = [s.flights[0], flight];
    s.user = pilot(s);
    const outsider = { ...pilot(s), id: "outsider", groupIds: [] };
    s.members.push(outsider);
    const inspection = { ...s.inspections[0], lastSeconds: h(1_000_000) };
    const corrected: FlightInput = {
      ...input,
      aircraftUuid: "nowhere",
      checklistRun: checklistRun(),
      oil: [inventoryOil()],
      flightPlanUuid: undefined,
      discrepancy: "Loose cowling",
      pilotId: "ghost",
      copilotId: "ghost",
      hobbsOn: undefined,
    };
    const review: Omit<FlightReview, "input"> = {
      uuid: "missing",
      decision: "accept",
      reason: "ok",
    };
    const steps: [() => unknown, string][] = [
      [() => {}, "Flight Program administrator required."],
      [
        () => (s.user = s.members.find((m) => m.isAdmin)!),
        "You do not have permission for this aircraft.",
      ],
      [
        () => (corrected.aircraftUuid = held.aircraftUuid),
        "Provide a meaningful review explanation.",
      ],
      [() => (review.reason = REASON), "Flight not found."],
      [
        () => (review.uuid = held.uuid),
        "A review cannot change the recorded checklist run.",
      ],
      [
        () => (corrected.checklistRun = undefined),
        "A flight review cannot change posted oil inventory usage. Correct stock through an inventory adjustment.",
      ],
      [
        () => (corrected.oil = undefined),
        "A review cannot change the linked flight plan.",
      ],
      [
        () => (corrected.flightPlanUuid = PLAN),
        "Flight plan is unavailable for this aircraft.",
      ],
      [
        () => (s.flightPlans = [plan()]),
        "A correction cannot change aircraft.",
      ],
      [
        () => (flight.aircraftUuid = held.aircraftUuid),
        "Use the discrepancy workflow to update problem reports.",
      ],
      [() => (corrected.discrepancy = ""), "Pilot not found."],
      [() => (corrected.pilotId = held.pilotId), "Copilot not found."],
      [
        () => (corrected.copilotId = outsider.id),
        "Pilot must belong to this Flight Program.",
      ],
      [
        () => (corrected.copilotId = undefined),
        "The hobbs reading is required for this aircraft.",
      ],
      [
        () => (corrected.hobbsOn = held.hobbsOn! + h(2)),
        "Cannot accept this chronology: Hobbs reading is lower than the current counter.",
      ],
      [
        () => {
          corrected.hobbsOn = held.hobbsOn;
          s.inspections.push(inspection);
        },
        "Correction would move usage before recorded inspection compliance.",
      ],
    ];
    for (const [clear, message] of steps) {
      clear();
      const error = refusal(s, { ...review, input: corrected });
      expect(error).toBeInstanceOf(Rejection);
      expect(error).toMatchObject({ message });
    }
    s.inspections.pop();
    expect(() =>
      reviewFlight(s, { ...review, input: corrected }),
    ).not.toThrow();
  });

  it("refuses totals that would fall before an aircraft AD's compliance", () => {
    const { s, held, input } = fixture();
    const ad = blankAD(held.aircraftUuid);
    ad.source = { ...ad.source, number: "2026-05-05" };
    ad.history = [
      {
        uuid: "done",
        taskUuid: "task",
        date: "2026-01-01",
        hours: 1_000_000,
        cycles: null,
        method: "Inspected",
        serviceBulletin: "",
        terminatedBy: "",
        workOrderUuid: "",
        mechanic: "A Mechanic",
        certificate: "",
        evidence: "",
        recordedAt: 0,
        recordedBy: "",
      },
    ];
    s.airworthiness = [ad];
    const review = {
      uuid: held.uuid,
      decision: "accept" as const,
      reason: REASON,
    };
    expect(refusal(s, { ...review, input })).toMatchObject({
      message:
        "Correction would move usage before the recorded compliance of AD 2026-05-05.",
    });
  });

  // Roadmap leftover (LO-3): an administrator saw the data-integrity text
  // "Inspection component not found." and could not tell what to fix.
  it("names the inspection whose component is no longer on the aircraft", () => {
    const { s, held, input } = fixture();
    const inspection = s.inspections.find(
      (i) => i.aircraftUuid === held.aircraftUuid,
    )!;
    inspection.componentUuid = "component-moved-away";
    const registration = s.aircraft[0].registration;
    const error = refusal(s, {
      uuid: held.uuid,
      decision: "accept",
      reason: REASON,
      input,
    });
    expect(error).toBeInstanceOf(Rejection);
    expect(error).toMatchObject({
      message: `The inspection "${inspection.reference}" on ${registration} is linked to a component that is not installed on it. Correct the inspection under Inspections, then review this flight again.`,
    });
  });

  it("takes 5 trimmed characters and up to 5000 as entered", () => {
    const { s, held, input } = fixture();
    const review = (reason: string) => () =>
      reviewFlight(s, { uuid: held.uuid, decision: "accept", reason, input });
    expect(review(" abcd ")).toThrow(
      "Provide a meaningful review explanation.",
    );
    expect(review(` ${"x".repeat(4999)} `)).toThrow(
      "Provide a meaningful review explanation.",
    );
    expect(review(" abcde ")).not.toThrow();
    expect(review("x".repeat(5000))).not.toThrow();
  });

  it("exports the reason limits it enforces", () => {
    const { s, held, input } = fixture();
    const review = (reason: string) => () =>
      reviewFlight(s, { uuid: held.uuid, decision: "accept", reason, input });
    const short = "x".repeat(REVIEW_REASON_MIN_LENGTH - 1);
    expect(review(short)).toThrow("Provide a meaningful review explanation.");
    expect(review(`${short}x`)).not.toThrow();
    const long = "x".repeat(REVIEW_REASON_MAX_LENGTH);
    expect(review(`${long}x`)).toThrow(
      "Provide a meaningful review explanation.",
    );
    expect(review(long)).not.toThrow();
  });

  it("refuses an aircraft outside the active Flight Program", () => {
    const { s, opening, held, input } = fixture();
    s.aircraft.push({ ...opening, uuid: "other", programUuid: "elsewhere" });
    held.aircraftUuid = "other";
    expect(() =>
      reviewFlight(s, {
        uuid: held.uuid,
        decision: "accept",
        reason: REASON,
        input: { ...input, aircraftUuid: "other" },
      }),
    ).toThrow("You do not have permission for this aircraft.");
  });

  it("checks the plan only when accepting a rejected flight", () => {
    const { s, held, input } = fixture();
    Object.assign(held, { status: "rejected", flightPlanUuid: PLAN });
    const review = (decision: FlightReview["decision"]) => () =>
      reviewFlight(s, {
        uuid: held.uuid,
        decision,
        reason: REASON,
        input: { ...input, flightPlanUuid: PLAN },
      });
    expect(review("accept")).toThrow(
      "Flight plan is unavailable for this aircraft.",
    );
    expect(review("reject")).not.toThrow();
  });

  it("keeps crew already on the flight, wherever they belong now", () => {
    const { s, held, input } = fixture();
    held.copilotId = "outsider";
    s.members.push({ ...pilot(s), id: "outsider", groupIds: [] });
    const review = {
      uuid: held.uuid,
      decision: "accept" as const,
      reason: REASON,
    };
    expect(() =>
      reviewFlight(s, {
        ...review,
        input: { ...input, copilotId: "outsider" },
      }),
    ).not.toThrow();
  });

  it("leaves a parse error unwrapped", () => {
    const { s, held, input } = fixture();
    const error = refusal(s, {
      uuid: held.uuid,
      decision: "accept",
      reason: REASON,
      input: { ...input, hobbsOn: held.hobbsOn! + h(0.05) },
    });
    expect(error).toBeInstanceOf(z.ZodError);
    expect(error).not.toBeInstanceOf(Rejection);
  });
});

describe("heldFlightComparison", () => {
  it("lists the readings, counts and time that differ, the flight's beside the aircraft's", () => {
    const { s, held } = fixture();
    const aircraft = {
      ...s.aircraft[0],
      latestFlightAt: "2026-10-03T11:00:00Z",
    };
    expect(heldFlightComparison(held, aircraft)).toEqual([
      {
        key: "hobbs",
        label: "Hobbs (hours)",
        mine: "2,342.2",
        theirs: "2,343.2",
      },
      { key: "landings", label: "Landings", mine: "1", theirs: "2,195" },
      { key: "cycles", label: "Cycles", mine: "1", theirs: "1,895" },
      {
        key: "startTime",
        label: "Flight time (UTC)",
        mine: "2026-10-03 09:00",
        theirs: "2026-10-03 11:00",
      },
    ]);
  });

  it("leaves out a meter neither side records and lists nothing for a matching entry", () => {
    const { s, held } = fixture();
    const aircraft = s.aircraft[0];
    expect(
      heldFlightComparison(held, aircraft).map((d) => d.key),
    ).not.toContain("tach");
    const matching = {
      ...held,
      hobbsOn: aircraft.currentHobbs,
      landings: aircraft.landings,
      cycles: aircraft.cycles,
      startTime: aircraft.latestFlightAt!,
    };
    expect(heldFlightComparison(matching, aircraft)).toEqual([]);
  });
});

describe("assertReviewer", () => {
  it("passes a system or program administrator and refuses other members", () => {
    const s = demoSnapshot();
    expect(() => assertReviewer(s)).not.toThrow();
    s.user = pilot(s);
    expect(() => assertReviewer(s)).toThrow(
      new Rejection("Flight Program administrator required."),
    );
    s.groups.push({
      id: "admins",
      name: "Administrators",
      programUuid: "demo-program",
      programAdmin: true,
      aircraftIds: [],
      permissions: ["read"],
    });
    s.user = { ...s.user, groupIds: [...s.user.groupIds, "admins"] };
    expect(() => assertReviewer(s)).not.toThrow();
  });
});

describe("reviewFlight changes", () => {
  it("accepts a held flight: replays the aircraft, recalculates starts and audits each move", () => {
    const { s, opening, later, held, input } = fixture();
    const unchanged = structuredClone(s);
    const changes = reviewFlight(s, {
      uuid: held.uuid,
      decision: "accept",
      reason: REASON,
      input,
    });
    expect(s).toEqual(unchanged);
    const starts = {
      hobbsOff: opening.currentHobbs,
      tachOff: opening.currentTach,
    };
    expect(changes.reviewed).toEqual({
      ...input,
      status: "accepted",
      reviewReason: REASON,
      ...starts,
      cyclicHobbsOff: undefined,
      flightTimeLogOff: undefined,
    });
    const reviewed = { ...held, ...changes.reviewed };
    expect(changes.flights).toEqual([
      reviewed,
      { ...later, hobbsOff: held.hobbsOn },
    ]);
    expect(changes.aircraft).toMatchObject({
      currentHobbs: later.hobbsOn,
      currentTach: opening.currentTach,
      landings: opening.landings + 2,
      cycles: opening.cycles + 2,
      latestFlightAt: later.startTime,
      version: 2,
    });
    const stamp = {
      uuid: expect.any(String),
      programUuid: opening.programUuid,
      actorId: s.user.id,
      at: expect.any(Number),
    };
    expect(changes.audit).toEqual([
      {
        ...stamp,
        action: "flight.reviewed",
        entityUuid: held.uuid,
        aircraftUuid: opening.uuid,
        reason: REASON,
        before: JSON.stringify(held),
        after: JSON.stringify(reviewed),
      },
      {
        ...stamp,
        action: "flight.resequenced",
        entityUuid: later.uuid,
        aircraftUuid: opening.uuid,
        reason:
          "Starting readings recalculated after the flight of 2026-10-03 09:00 UTC was accepted.",
        before: JSON.stringify({ hobbsOff: opening.currentHobbs }),
        after: JSON.stringify({ hobbsOff: held.hobbsOn }),
      },
    ]);
  });

  it("rejects an accepted flight: the replay leaves it out and it keeps its starts", () => {
    const { s, opening, later, held, input } = fixture();
    held.status = "accepted";
    held.hobbsOff = opening.currentHobbs;
    s.flights = [held, { ...later, hobbsOff: held.hobbsOn }];
    const changes = reviewFlight(s, {
      uuid: held.uuid,
      decision: "reject",
      reason: REASON,
      input,
    });
    expect(changes.reviewed).toMatchObject({
      status: "rejected",
      hobbsOff: opening.currentHobbs,
      tachOff: opening.currentTach,
    });
    expect(changes.flights.map((f) => f.uuid)).toEqual([later.uuid]);
    expect(changes.aircraft).toMatchObject({
      currentHobbs: later.hobbsOn,
      landings: opening.landings + 1,
    });
    const moved = changes.audit[1];
    expect(moved).toMatchObject({
      entityUuid: later.uuid,
      reason: expect.stringMatching(/was rejected\.$/),
    });
    expect(JSON.parse(moved.before!)).toMatchObject({ hobbsOff: held.hobbsOn });
    expect(JSON.parse(moved.after!)).toMatchObject({
      hobbsOff: opening.currentHobbs,
    });
  });

  // The entries FlightForm can send undefined over a stored value.
  it.each<[keyof FlightInput, FlightInput[keyof FlightInput]]>([
    ["copilotId", "demo-admin"],
    ["tachOn", h(2262.2)],
    ["cyclicHobbsOn", h(100)],
    ["flightTimeLogOn", h(100)],
    ["landingSurface", null],
    ["engineStarts", []],
  ])(
    "clears %s when the input leaves it out, the same as undefined",
    (key, value) => {
      const { s, held, input } = fixture();
      s.flights[1] = { ...held, [key]: value };
      const review = (corrected: FlightInput) =>
        reviewFlight(s, {
          uuid: held.uuid,
          decision: "accept",
          reason: REASON,
          input: corrected,
        });
      // The server receives the form's cleared field absent.
      const absent = review(input);
      expect(unstamped(absent)).toStrictEqual(
        unstamped(review({ ...input, [key]: undefined })),
      );
      expect(Object.keys(absent.reviewed)).toContain(key);
      expect(JSON.parse(absent.audit[0].after!)).not.toHaveProperty(key);
    },
  );
});

// Changes with each entry's random id and time blanked, for comparing reviews.
function unstamped(changes: ReviewChanges) {
  return {
    ...changes,
    audit: changes.audit.map((e) => ({ ...e, uuid: "", at: 0 })),
  };
}

function checklistRun() {
  return {
    sessionUuid: crypto.randomUUID(),
    checklistUuid: crypto.randomUUID(),
    checklistVersion: 1,
    checklistName: "Preflight",
    startedAt: "2026-10-03T08:30:00.000Z",
    metersVerifiedAt: "2026-10-03T08:40:00.000Z",
    preflight: { hobbs: h(2341.2), tach: h(2261.2) },
    checked: [],
    skipped: [],
    totalChecks: 0,
  };
}

function inventoryOil() {
  return {
    engine: "single" as const,
    unit: "US qt" as const,
    added: 1,
    inventory: { stockUuid: "oil-stock", locationUuid: "shelf", quantity: 1 },
  };
}

function plan(): FlightPlan {
  return flightPlanSchema.parse({
    uuid: PLAN,
    version: 1,
    aircraftUuid: "demo-206",
    registration: "N206MA",
    departureAt: "2026-10-03T09:00:00Z",
    origin: "AAA",
    destination: "BBB",
    alternate: "",
    durationMinutes: 60,
    cycles: 1,
    landings: 1,
    flightRules: "V",
    aircraftType: "C206",
    flightType: "G",
    speed: "",
    level: "",
    route: "DCT",
    pilotText: "",
    equipment: "",
    otherInformation: "",
    sourceName: "plan.pdf",
    sourceHash: "a".repeat(64),
    status: "proposed",
    createdAt: 0,
  });
}
