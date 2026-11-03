import { requestPurchases } from "./partsRequests";
import { adAircraftUuid } from "./adOwnership";
import { partsInventory } from "./requiredParts";
import type { AuditEntry, Snapshot, Member, Group, Permission } from "./model";
import type { ManagedRecord } from "./management";
import { isOwnerView, ownerSnapshot } from "./ownerView";
// Empty aircraftIds means every program aircraft, except for owner groups,
// which must name their aircraft explicitly.
export function groupCoversAircraft(g: Group, aircraftUuid: string) {
  return (
    !!g.programAdmin ||
    g.aircraftIds.includes(aircraftUuid) ||
    (!g.owner && !g.aircraftIds.length)
  );
}
export function programIds(user: Member, groups: Group[]) {
  return [
    ...new Set(
      groups
        .filter(
          (g) =>
            user.groupIds.includes(g.id) &&
            g.permissions.includes("read") &&
            g.programUuid,
        )
        .map((g) => g.programUuid!),
    ),
  ];
}
export function activeProgram(
  s: Pick<Snapshot, "user" | "groups" | "programs">,
) {
  const allowed = s.user.isAdmin
    ? (s.programs ?? []).map((p) => p.uuid)
    : programIds(s.user, s.groups);
  if (s.user.activeProgramUuid === "")
    return s.user.isAdmin ? undefined : allowed[0];
  return s.user.activeProgramUuid && allowed.includes(s.user.activeProgramUuid)
    ? s.user.activeProgramUuid
    : allowed[0];
}
export function programPermission(
  s: Snapshot,
  permission: Permission | "admin",
  program = activeProgram(s),
) {
  if (!s.user.active) return false;
  if (s.user.isAdmin) return true;
  if (!program) return false;
  return s.groups.some(
    (g) =>
      s.user.groupIds.includes(g.id) &&
      g.programUuid === program &&
      g.permissions.includes("read") &&
      (g.programAdmin ||
        (permission !== "admin" && g.permissions.includes(permission))),
  );
}
export function ownsActive(s: Snapshot, program?: string) {
  return (
    program === activeProgram(s) &&
    (s.user.isAdmin ||
      (!!program && programIds(s.user, s.groups).includes(program)))
  );
}
export function recordProgram(
  s: Snapshot,
  r: ManagedRecord,
): string | undefined {
  if (r.programUuid) return r.programUuid;
  if (r.kind === "stock") {
    const location = s.management?.find(
      (x) => x.kind === "location" && x.uuid === r.locationUuid,
    );
    return location?.programUuid;
  }
  if (r.kind === "componentRequirement" || r.kind === "componentMovement") {
    const component = s.management?.find(
      (x) => x.kind === "component" && x.uuid === r.componentUuid,
    );
    return component ? recordProgram(s, component) : undefined;
  }
  return "aircraftUuid" in r
    ? s.aircraft.find((a) => a.uuid === r.aircraftUuid)?.programUuid
    : undefined;
}
// What the caller may see in the active program; shared by the snapshot and
// the paginated history so both apply the same audit rules.
function visibleScope(s: Snapshot) {
  const active = activeProgram(s);
  const aircraft = s.aircraft.filter(
    (a) =>
      ownsActive(s, a.programUuid) &&
      (s.user.isAdmin ||
        s.groups.some(
          (g) =>
            s.user.groupIds.includes(g.id) &&
            g.programUuid === active &&
            g.permissions.includes("read") &&
            groupCoversAircraft(g, a.uuid),
        )),
  );
  const ids = new Set(aircraft.map((a) => a.uuid));
  const management = (s.management ?? []).filter(
    (r) =>
      ownsActive(s, recordProgram(s, r)) &&
      (!["stock", "location", "vendor"].includes(r.kind) ||
        programPermission(s, "admin")) &&
      (() => {
        const owner =
          "componentUuid" in r
            ? (s.management?.find(
                (c) => c.kind === "component" && c.uuid === r.componentUuid,
              ) ?? r)
            : r;
        return (
          !("aircraftUuid" in owner) ||
          !owner.aircraftUuid ||
          ids.has(owner.aircraftUuid)
        );
      })(),
  );
  const checklists = (s.checklists ?? []).filter(
    (c) =>
      ownsActive(s, c.programUuid) &&
      (!c.aircraftUuid || ids.has(c.aircraftUuid)),
  );
  // Cost records are administrator data; maintenance users only see labor
  // hours (no rates) so they can record their time on a work order.
  const costs = (s.costs ?? []).flatMap((r): NonNullable<Snapshot["costs"]> => {
    if (r.kind === "settings")
      return r.programUuid === active && programPermission(s, "admin")
        ? [r]
        : [];
    if (!ids.has(r.aircraftUuid)) return [];
    if (programPermission(s, "admin")) return [r];
    return r.kind === "workOrder"
      ? [
          {
            ...r,
            labor: r.labor.map(({ rateCents: _rate, ...e }) => e),
            other: [],
            partUnitCosts: [],
          },
        ]
      : [];
  });
  const entities = new Set([
    ...(programPermission(s, "admin") ? costs.map((r) => r.uuid) : []),
    ...(s.partsRequests ?? [])
      .filter(
        (r) =>
          ownsActive(s, r.programUuid) &&
          (r.aircraftUuid
            ? ids.has(r.aircraftUuid)
            : programPermission(s, "admin")),
      )
      .map((r) => r.uuid),
    ...(s.purchaseOrders ?? [])
      .filter(
        (p) => ownsActive(s, p.programUuid) && programPermission(s, "admin"),
      )
      .map((p) => p.uuid),
    ...checklists.map((c) => c.uuid),
    ...(s.componentTemplates ?? [])
      .filter((t) => ownsActive(s, t.programUuid))
      .map((t) => t.uuid),
    ...(s.componentSetups ?? [])
      .filter((t) => ownsActive(s, t.programUuid) && ids.has(t.aircraftUuid))
      .map((t) => t.uuid),
    ...(s.inspectionTemplates ?? [])
      .filter((t) => ownsActive(s, t.programUuid))
      .map((t) => t.uuid),
    ...management.map((r) => r.uuid),
    ...(s.programs?.filter((p) => p.uuid === active).map((p) => p.uuid) ?? []),
  ]);
  // Stock, location and vendor records are administrator data, and older
  // change-log rows about them hold the full record (cost, vendor, invoice).
  // Rows are never rewritten (ADR-0005), so hide them from everyone without
  // program-admin permission, even when they carry an aircraft tag. The
  // action prefix covers rows whose record is not loaded.
  const inventoryRecords = new Set(
    (s.management ?? [])
      .filter((r) => ["stock", "location", "vendor"].includes(r.kind))
      .map((r) => r.uuid),
  );
  const inventoryAdmin = programPermission(s, "admin");
  const canSeeAudit = (a: AuditEntry) => {
    if (
      !inventoryAdmin &&
      (inventoryRecords.has(a.entityUuid) ||
        /^(stock|location|vendor|inventory)\./.test(a.action))
    )
      return false;
    // A row's program tag records where it was written, not who may read it:
    // transfers never re-tag rows (ADR-0005), so a row follows the current
    // owner of its record or aircraft, like rows without a tag already do.
    if (a.programUuid)
      return (
        entities.has(a.entityUuid) ||
        (!!a.aircraftUuid && ids.has(a.aircraftUuid))
      );
    if (a.aircraftUuid) return ids.has(a.aircraftUuid);
    return entities.has(a.entityUuid) || (s.user.isAdmin && !active);
  };
  return {
    active,
    aircraft,
    ids,
    management,
    checklists,
    costs,
    canSeeAudit,
  };
}
export const auditVisible = (s: Snapshot) => visibleScope(s).canSeeAudit;
export function scopedSnapshot(s: Snapshot): Snapshot {
  const { active, aircraft, ids, management, checklists, costs, canSeeAudit } =
    visibleScope(s);
  const historicalPilots = new Set(
    s.flights
      .filter((f) => ids.has(f.aircraftUuid))
      .flatMap((f) => [f.pilotId, f.copilotId]),
  );
  const scoped: Snapshot = {
    ...s,
    certificationFiles: s.certificationFiles?.filter(
      (f) => s.user.isAdmin || f.userId === s.user.id,
    ),
    savedAddresses: (s.savedAddresses ?? []).filter(
      (a) => a.programUuid === active,
    ),
    partsInventory: partsInventory({ ...s, partsInventory: undefined }),
    programScopeVersion: 1,
    activeProgramUuid: active,
    programs: (s.programs ?? [])
      .filter(
        (p) => s.user.isAdmin || programIds(s.user, s.groups).includes(p.uuid),
      )
      .map((p) =>
        s.user.isAdmin || p.uuid === active
          ? p
          : { ...p, address: "", email: "", contactName: "", website: "" },
      ),
    aircraft,
    componentTemplates: (s.componentTemplates ?? []).filter((t) =>
      ownsActive(s, t.programUuid),
    ),
    componentSetups: (s.componentSetups ?? []).filter(
      (t) => ownsActive(s, t.programUuid) && ids.has(t.aircraftUuid),
    ),
    inspectionTemplates: (s.inspectionTemplates ?? []).filter((t) =>
      ownsActive(s, t.programUuid),
    ),
    manuals: (s.manuals ?? []).filter((m) => ids.has(m.aircraftUuid)),
    taskCards: (s.taskCards ?? []).filter((t) => ids.has(t.aircraftUuid)),
    archivedTaskCards: (s.archivedTaskCards ?? []).filter((t) =>
      ids.has(t.aircraftUuid),
    ),
    taskEvidence: (s.taskEvidence ?? []).filter((f) =>
      [...(s.taskCards ?? []), ...(s.archivedTaskCards ?? [])].some(
        (t) => t.uuid === f.taskCardUuid && ids.has(t.aircraftUuid),
      ),
    ),
    faaMonitors: (s.faaMonitors ?? []).filter((r) => ids.has(r.aircraftUuid)),
    airworthiness: (s.airworthiness ?? []).filter((r) =>
      ids.has(adAircraftUuid(s, r)),
    ),
    partsOnOrder: (s.purchaseOrders ?? [])
      .filter((p) => ownsActive(s, p.programUuid) && p.phase === "issued")
      .flatMap((p) =>
        p.lines
          .filter((l) => l.stockUuid)
          .map((l) => ({
            stockUuid: l.stockUuid,
            quantity: Math.max(
              0,
              l.quantity -
                l.cancelled -
                p.receipts
                  .flatMap((r) => r.lines)
                  .filter((r) => r.lineUuid === l.uuid)
                  .reduce((n, r) => n + r.quantity, 0),
            ),
            shipped: Math.max(
              0,
              p.shipments
                .flatMap((r) => r.lines)
                .filter((r) => r.lineUuid === l.uuid)
                .reduce((n, r) => n + r.quantity, 0) -
                p.receipts
                  .flatMap((r) => r.lines)
                  .filter((r) => r.lineUuid === l.uuid)
                  .reduce((n, r) => n + r.quantity, 0),
            ),
          })),
      ),
    purchaseOrderFiles: (s.purchaseOrderFiles ?? []).filter(
      (f) =>
        (s.purchaseOrders ?? []).some(
          (p) => p.uuid === f.poUuid && ownsActive(s, p.programUuid),
        ) && programPermission(s, "admin"),
    ),
    partsRequests: (s.partsRequests ?? []).filter(
      (r) =>
        ownsActive(s, r.programUuid) &&
        (r.aircraftUuid
          ? ids.has(r.aircraftUuid)
          : programPermission(s, "admin")),
    ),
    partsRequestPurchases: requestPurchases(
      (s.purchaseOrders ?? []).filter((p) => ownsActive(s, p.programUuid)),
    ).filter((a) =>
      (s.partsRequests ?? []).some(
        (r) =>
          r.uuid === a.requestUuid &&
          (r.aircraftUuid
            ? ids.has(r.aircraftUuid)
            : programPermission(s, "admin")),
      ),
    ),
    purchaseOrders: (s.purchaseOrders ?? []).filter(
      (p) => ownsActive(s, p.programUuid) && programPermission(s, "admin"),
    ),
    checklists,
    costs,
    workOrders: (s.workOrders ?? []).filter((w) => ids.has(w.aircraftUuid)),
    inventoryAttachments: (s.inventoryAttachments ?? []).filter(
      (f) =>
        programPermission(s, "admin") &&
        management.some(
          (r) =>
            (r.kind === "stock" || r.kind === "component") &&
            r.uuid === f.stockUuid,
        ),
    ),
    workOrderAttachments: (s.workOrderAttachments ?? []).filter((f) =>
      (s.workOrders ?? []).some(
        (w) => w.uuid === f.workOrderUuid && ids.has(w.aircraftUuid),
      ),
    ),
    flightPlans: (s.flightPlans ?? []).filter((p) => ids.has(p.aircraftUuid)),
    flights: s.flights.filter((f) => ids.has(f.aircraftUuid)),
    discrepancies: s.discrepancies.filter((d) => ids.has(d.aircraftUuid)),
    inspections: s.inspections.filter((i) => ids.has(i.aircraftUuid)),
    management,
    audit: s.audit.filter(canSeeAudit),
    groups: s.groups.filter(
      (g) =>
        s.user.isAdmin ||
        s.user.groupIds.includes(g.id) ||
        (g.programUuid === active && programPermission(s, "admin")),
    ),
    members: s.members
      .filter(
        (m) =>
          s.user.isAdmin ||
          m.id === s.user.id ||
          historicalPilots.has(m.id) ||
          (m.active && programIds(m, s.groups).includes(active ?? "")),
      )
      .map((m) =>
        s.user.isAdmin || m.id === s.user.id
          ? {
              ...m,
              availableAsPilot:
                m.active &&
                (m.isAdmin || programIds(m, s.groups).includes(active ?? "")),
            }
          : {
              id: m.id,
              name: m.name,
              email:
                programPermission(s, "admin") &&
                programIds(m, s.groups).includes(active ?? "")
                  ? m.email
                  : "",
              availableAsPilot:
                m.active &&
                (m.isAdmin || programIds(m, s.groups).includes(active ?? "")),
              active: m.active,
              isAdmin: false,
              groupIds: programPermission(s, "admin")
                ? m.groupIds.filter((id) =>
                    s.groups.some(
                      (g) => g.id === id && g.programUuid === active,
                    ),
                  )
                : [],
            },
      ),
  };
  return isOwnerView(scoped) ? ownerSnapshot(scoped) : scoped;
}
