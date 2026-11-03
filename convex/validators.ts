import { v } from "convex/values";
export const permission = v.union(
  v.literal("read"),
  v.literal("flight"),
  v.literal("discrepancy"),
  v.literal("resolve"),
  v.literal("maintenance"),
);
export const aircraftFields = {
  twin: v.optional(v.boolean()),
  turbine: v.optional(v.boolean()),
  amphibious: v.optional(v.boolean()),
  helicopter: v.optional(v.boolean()),
  flightTimeLog: v.optional(v.boolean()),
  uuid: v.string(),
  registration: v.string(),
  make: v.string(),
  model: v.string(),
  faaSearchModel: v.optional(v.string()),
  serial: v.string(),
  program: v.string(),
  programUuid: v.optional(v.string()),
  baselineMeter: v.optional(
    v.union(
      v.literal("hobbs"),
      v.literal("tach"),
      v.literal("cyclic"),
      v.literal("flightTimeLog"),
    ),
  ),
  baselineAdjustmentSeconds: v.optional(v.number()),
  counterEvents: v.optional(
    v.array(
      v.object({
        at: v.string(),
        meter: v.union(
          v.literal("hobbs"),
          v.literal("tach"),
          v.literal("cyclic"),
          v.literal("flightTimeLog"),
        ),
        adjustmentSeconds: v.number(),
        currentHobbs: v.number(),
        currentTach: v.number(),
        currentCyclicHobbs: v.optional(v.number()),
        currentFlightTimeLog: v.optional(v.number()),
        cycles: v.number(),
        landings: v.number(),
        // What the administrator changed (absent on events before 2026-11-03).
        changed: v.optional(
          v.array(
            v.union(
              v.literal("meter"),
              v.literal("adjustmentSeconds"),
              v.literal("currentHobbs"),
              v.literal("currentTach"),
              v.literal("currentCyclicHobbs"),
              v.literal("currentFlightTimeLog"),
              v.literal("cycles"),
              v.literal("landings"),
            ),
          ),
        ),
        previous: v.optional(
          v.object({
            meter: v.optional(
              v.union(
                v.literal("hobbs"),
                v.literal("tach"),
                v.literal("cyclic"),
                v.literal("flightTimeLog"),
              ),
            ),
            adjustmentSeconds: v.optional(v.number()),
            currentHobbs: v.optional(v.number()),
            currentTach: v.optional(v.number()),
            currentCyclicHobbs: v.optional(v.number()),
            currentFlightTimeLog: v.optional(v.number()),
            cycles: v.optional(v.number()),
            landings: v.optional(v.number()),
          }),
        ),
      }),
    ),
  ),
  meter: v.union(
    v.literal("hobbs"),
    v.literal("tach"),
    v.literal("cyclic"),
    v.literal("flightTimeLog"),
  ),
  adjustmentSeconds: v.number(),
  baselineHobbs: v.number(),
  baselineTach: v.number(),
  baselineCyclicHobbs: v.optional(v.number()),
  baselineFlightTimeLog: v.optional(v.number()),
  baselineCycles: v.number(),
  baselineLandings: v.number(),
  currentHobbs: v.number(),
  currentTach: v.number(),
  currentCyclicHobbs: v.optional(v.number()),
  currentFlightTimeLog: v.optional(v.number()),
  cycles: v.number(),
  landings: v.number(),
  version: v.number(),
  latestFlightAt: v.optional(v.string()),
  operationalStatus: v.union(
    v.literal("unknown"),
    v.literal("airworthy"),
    v.literal("maintenance"),
    v.literal("grounded"),
  ),
};
const fluidValues = {
  start: v.optional(v.number()),
  added: v.optional(v.number()),
  end: v.optional(v.number()),
};
export const flightFields = {
  fuel: v.optional(
    v.object({
      unit: v.union(
        v.literal("US gal"),
        v.literal("L"),
        v.literal("lb"),
        v.literal("kg"),
      ),
      ...fluidValues,
    }),
  ),
  oil: v.optional(
    v.array(
      v.object({
        engine: v.union(
          v.literal("single"),
          v.literal("left"),
          v.literal("right"),
        ),
        unit: v.union(v.literal("US qt"), v.literal("L"), v.literal("range")),
        addedUnit: v.optional(v.union(v.literal("US qt"), v.literal("L"))),
        inventory: v.optional(
          v.object({
            locationUuid: v.string(),
            stockUuid: v.string(),
            quantity: v.number(),
          }),
        ),
        ...fluidValues,
      }),
    ),
  ),
  checklistRun: v.optional(
    v.object({
      sessionUuid: v.string(),
      checklistUuid: v.string(),
      checklistVersion: v.number(),
      checklistName: v.string(),
      startedAt: v.string(),
      metersVerifiedAt: v.string(),
      preflight: v.object({
        hobbs: v.number(),
        tach: v.number(),
        cyclic: v.optional(v.number()),
        flightTimeLog: v.optional(v.number()),
      }),
      checked: v.array(v.string()),
      skipped: v.array(v.string()),
      totalChecks: v.number(),
    }),
  ),
  engineStarts: v.optional(
    v.array(
      v.object({
        engine: v.union(
          v.literal("single"),
          v.literal("left"),
          v.literal("right"),
        ),
        durationSeconds: v.optional(v.number()),
        maxEgtC: v.optional(v.number()),
      }),
    ),
  ),
  landingSurface: v.optional(
    v.union(v.literal("sea"), v.literal("land"), v.null()),
  ),
  flightPlanUuid: v.optional(v.string()),
  aircraftUuid: v.string(),
  pilotId: v.string(),
  copilotId: v.optional(v.string()),
  startTime: v.string(),
  hobbsOn: v.optional(v.number()),
  tachOn: v.optional(v.number()),
  cyclicHobbsOn: v.optional(v.number()),
  flightTimeLogOn: v.optional(v.number()),
  landings: v.number(),
  cycles: v.number(),
  origin: v.string(),
  destination: v.string(),
  operation: v.union(
    v.literal("Gov medical"),
    v.literal("Mission medical"),
    v.literal("Mission"),
    v.literal("Commercial"),
    v.literal("Private"),
  ),
  flightRules: v.union(v.literal("VFR"), v.literal("IFR")),
  remarks: v.string(),
  discrepancy: v.string(),
};
export const operationValidator = v.union(
  v.object({
    programUuid: v.optional(v.string()),
    kind: v.literal("flight"),
    uuid: v.string(),
    authorId: v.string(),
    baseVersion: v.number(),
    input: v.object(flightFields),
    dispatchOverrideReason: v.optional(v.string()),
  }),
  v.object({
    programUuid: v.optional(v.string()),
    kind: v.literal("discrepancy"),
    uuid: v.string(),
    authorId: v.string(),
    aircraftUuid: v.string(),
    flightUuid: v.optional(v.string()),
    description: v.string(),
    grounding: v.optional(v.boolean()),
  }),
);
export const dispatchOverrideValidator = v.object({
  by: v.string(),
  name: v.string(),
  reason: v.string(),
  at: v.number(),
});
const placard = v.string();
export const deferralValidator = v.union(
  v.object({
    type: v.literal("mel"),
    melItem: v.string(),
    category: v.union(
      v.literal("A"),
      v.literal("B"),
      v.literal("C"),
      v.literal("D"),
    ),
    days: v.optional(v.number()),
    placard,
    deferredOn: v.string(),
    deferredAt: v.number(),
    deferredBy: v.string(),
    deferredByName: v.string(),
    expiresOn: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("91.213d"),
    placard,
    notHazard: v.literal(true),
    deferredOn: v.string(),
    deferredAt: v.number(),
    deferredBy: v.string(),
    deferredByName: v.string(),
    expiresOn: v.optional(v.string()),
  }),
);
