/**
 * Responsibility: The owner portal: who gets it, the read-only rule for owner
 *   groups, and the snapshot an aircraft owner may read.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./management, ./workOrders, ./programs, ./adOwnership,
 *   ./aircraftFiles, ./rejection.
 *
 * The owner snapshot is built as a whitelist, so a field added to the snapshot
 * stays hidden from owners until someone decides they may see it.
 */
import type { Aircraft, Discrepancy, Group, Snapshot } from "./model";
import type { ManagedRecord } from "./management";
import type { WorkOrder } from "./workOrders";
import { groupCoversAircraft, reducedViewGroups } from "./programs";
import { adAircraftUuid } from "./adOwnership";
import { isCurrentAircraftFile, type AircraftFile } from "./aircraftFiles";
import { Rejection } from "./rejection";

/**
 * Refuses an owner group (`owner: true`) that could write or administer:
 * owner groups are always read-only.
 *
 * @param g - The group being saved.
 * @throws {Rejection} "Aircraft owner groups are read-only: remove
 *   administrator and write permissions."
 */
export function validateOwnerGroup(
  g: Pick<Group, "owner" | "programAdmin" | "permissions">,
) {
  if (g.owner && (g.programAdmin || g.permissions.some((p) => p !== "read")))
    throw new Rejection(
      "Aircraft owner groups are read-only: remove administrator and write permissions.",
    );
}

/**
 * Tells whether the user gets the owner portal: they hold an owner group
 * with read access in the active program, and every other such group is an
 * owner or board group. A user who also holds a board group gets the board
 * view beside it; one ordinary group gives the workspace instead.
 *
 * @param s - The user, the groups and the programs.
 * @returns False for an inactive user or a system administrator.
 */
export function isOwnerView(s: Pick<Snapshot, "user" | "groups" | "programs">) {
  return reducedViewGroups(s).some((g) => g.owner);
}

/**
 * The aircraft the owner portal covers: those the user's owner groups name.
 * A board group they also hold adds none.
 *
 * @param s - A snapshot scoped to the program, for a user in an owner view.
 * @returns Those aircraft, in snapshot order.
 */
export function ownerPortalAircraft(
  s: Pick<Snapshot, "user" | "groups" | "programs" | "aircraft">,
): Aircraft[] {
  const owned = reducedViewGroups(s).filter((g) => g.owner);
  return s.aircraft.filter((a) =>
    owned.some((g) => groupCoversAircraft(g, a.uuid)),
  );
}

/**
 * Reduces a snapshot already scoped to the program and the owner's aircraft
 * to what an aircraft owner may see. Internal notes, people and shop detail
 * are cleared; flights and the change log are left out.
 *
 * @param s - A program- and aircraft-scoped snapshot.
 * @returns The user's own member record and groups; open discrepancies,
 *   unarchived inspections, ADs, components on the aircraft with their
 *   requirements, completed work-order summaries and current Form 337 copies
 *   (no logbook page photos).
 */
export function ownerSnapshot(s: Snapshot): Snapshot {
  const ids = new Set(s.aircraft.map((a) => a.uuid));
  const components = findAircraftComponents(s, ids);
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
      .map(toOwnerDiscrepancy),
    inspections: s.inspections
      .filter((i) => !i.archived && ids.has(i.aircraftUuid))
      .map(({ requiredParts: _parts, materials: _materials, ...i }) => i),
    airworthiness: (s.airworthiness ?? []).filter((r) =>
      ids.has(adAircraftUuid(s, r)),
    ),
    management: (s.management ?? []).flatMap((r) =>
      toOwnerRecords(r, components),
    ),
    workOrders: (s.workOrders ?? [])
      .filter((w) => w.status === "completed" && ids.has(w.aircraftUuid))
      .map(toOwnerWorkOrder),
    aircraftFiles: ownerPortalFiles(s.aircraftFiles ?? [], s.aircraft),
  };
}

/**
 * The documents an owner may open, from a list of aircraft files: the
 * current Form 337 copies, status records kept for the owner
 * (91.417(a)(2)(vi)). Logbook page photos stay with the workspace: they show
 * flights and signed work the owner portal leaves out.
 *
 * @param files - Aircraft files, with their links.
 * @param aircraft - The aircraft the owner portal covers.
 * @returns Each current copy on those aircraft, in list order, with its
 *   name, type, size, upload time and link only.
 */
export function ownerPortalFiles(
  files: AircraftFile[],
  aircraft: { uuid: string }[],
): AircraftFile[] {
  const ids = new Set(aircraft.map((a) => a.uuid));
  return files
    .filter(
      (f) =>
        f.category === "form-337" &&
        ids.has(f.aircraftUuid) &&
        isCurrentAircraftFile(f),
    )
    .map((f) => ({
      uuid: f.uuid,
      aircraftUuid: f.aircraftUuid,
      category: f.category,
      name: f.name,
      type: f.type,
      size: f.size,
      uploadedAt: f.uploadedAt,
      url: f.url,
    }));
}

function findAircraftComponents(s: Snapshot, aircraft: Set<string>) {
  return new Set(
    (s.management ?? [])
      .filter((r) => r.kind === "component" && aircraft.has(r.aircraftUuid))
      .map((r) => r.uuid),
  );
}

// Grounding and deferral stay: the owner's airworthy or grounded status
// depends on them.
function toOwnerDiscrepancy(d: Discrepancy): Discrepancy {
  return {
    uuid: d.uuid,
    aircraftUuid: d.aircraftUuid,
    description: d.description,
    status: d.status,
    createdAt: d.createdAt,
    authorId: "",
    grounding: d.grounding,
    deferral: d.deferral,
  };
}

function toOwnerRecords(
  r: ManagedRecord,
  components: Set<string>,
): ManagedRecord[] {
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
}

// Only identity, totals and the completion summary leave the server.
function toOwnerWorkOrder(w: WorkOrder): WorkOrder {
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
