import type { Group, Snapshot } from "./model";
import type { ManagedRecord } from "./management";
import type { WorkOrder } from "./workOrders";
import { activeProgram } from "./programs";
import { adAircraftUuid } from "./adOwnership";

/** Owner groups are explicit (`owner: true`) and always read-only. */
export function validateOwnerGroup(
  g: Pick<Group, "owner" | "programAdmin" | "permissions">,
) {
  if (g.owner && (g.programAdmin || g.permissions.some((p) => p !== "read")))
    throw new Error(
      "Aircraft owner groups are read-only: remove administrator and write permissions.",
    );
}

/** The owner portal applies when every group the user holds in the active
 * program is an owner group. Mixed roles keep the full workspace. */
export function isOwnerView(s: Pick<Snapshot, "user" | "groups" | "programs">) {
  if (!s.user.active || s.user.isAdmin) return false;
  const program = activeProgram(s);
  const mine = s.groups.filter(
    (g) =>
      s.user.groupIds.includes(g.id) &&
      g.programUuid === program &&
      g.permissions.includes("read"),
  );
  return mine.length > 0 && mine.every((g) => g.owner);
}

function ownerRecord(components: Set<string>) {
  return (r: ManagedRecord): ManagedRecord[] => {
    if (r.kind === "component" && components.has(r.uuid)) {
      const {
        incomingTag: _tag,
        outForRepair: _repair,
        locationUuid: _location,
        partsLocation: _parts,
        ...c
      } = r;
      return [{ ...c, notes: "" }];
    }
    if (r.kind === "componentRequirement" && components.has(r.componentUuid)) {
      const { requiredParts: _parts, ...q } = r;
      return [{ ...q, notes: "" }];
    }
    return [];
  };
}

// Whitelist: only identity, totals and the completion summary leave the server.
function ownerWorkOrder(w: WorkOrder): WorkOrder {
  return {
    uuid: w.uuid,
    version: w.version,
    recordedAt: w.recordedAt,
    number: w.number,
    aircraftUuid: w.aircraftUuid,
    aircraft: w.aircraft,
    dateOpened: w.dateOpened,
    completionDate: w.completionDate,
    status: w.status,
    priority: w.priority,
    scope: w.scope,
    supervisor: "",
    releaseOutcome: "",
    finalReview: "",
    createdBy: "",
    componentReadings: [],
    tasks: [],
  };
}

/** Reduces an already program/aircraft-scoped snapshot to what an aircraft
 * owner may see. Built as a whitelist so new snapshot fields stay hidden. */
export function ownerSnapshot(s: Snapshot): Snapshot {
  const ids = new Set(s.aircraft.map((a) => a.uuid));
  const components = new Set(
    (s.management ?? [])
      .filter((r) => r.kind === "component" && ids.has(r.aircraftUuid))
      .map((r) => r.uuid),
  );
  return {
    programScopeVersion: s.programScopeVersion,
    activeProgramUuid: s.activeProgramUuid,
    programs: s.programs,
    user: s.user,
    authenticatedAt: s.authenticatedAt,
    syncedAt: s.syncedAt,
    groups: s.groups.filter((g) => s.user.groupIds.includes(g.id)),
    members: s.members.filter((m) => m.id === s.user.id),
    aircraft: s.aircraft,
    flights: [],
    audit: [],
    discrepancies: s.discrepancies
      .filter((d) => d.status === "open" && ids.has(d.aircraftUuid))
      .map((d) => ({
        uuid: d.uuid,
        aircraftUuid: d.aircraftUuid,
        description: d.description,
        status: d.status,
        createdAt: d.createdAt,
        authorId: "",
        // Needed for the owner's airworthy / grounded status.
        grounding: d.grounding,
        deferral: d.deferral,
      })),
    inspections: s.inspections
      .filter((i) => !i.archived && ids.has(i.aircraftUuid))
      .map(({ requiredParts: _parts, materials: _materials, ...i }) => i),
    airworthiness: (s.airworthiness ?? []).filter((r) =>
      ids.has(adAircraftUuid(s, r)),
    ),
    management: (s.management ?? []).flatMap(ownerRecord(components)),
    workOrders: (s.workOrders ?? [])
      .filter((w) => w.status === "completed" && ids.has(w.aircraftUuid))
      .map(ownerWorkOrder),
    // Form 337 copies are status records kept for the owner (91.417(a)(2)(vi)).
    aircraftFiles: (s.aircraftFiles ?? []).filter((f) =>
      ids.has(f.aircraftUuid),
    ),
  };
}
