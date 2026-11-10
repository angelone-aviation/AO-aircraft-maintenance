/**
 * Responsibility: Flight Program access: the programs a user belongs to, the
 *   active one, their permissions in it, and the snapshot they may read.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts, management.ts and expiringItems.ts
 *   (types), adOwnership.ts, ownerView.ts, boardView.ts, partsRequests.ts,
 *   requiredParts.ts, rejection.ts.
 *
 * The snapshot query and the demo adapter both send scopedSnapshot(), so what
 * it strips never reaches the browser.
 */
import { requestPurchases } from "./partsRequests";
import { adAircraftUuid } from "./adOwnership";
import { partsInventory } from "./requiredParts";
import type {
  Aircraft,
  AuditEntry,
  Snapshot,
  Member,
  Group,
  Permission,
} from "./model";
import type { ManagedRecord } from "./management";
import type { ExpiringItem } from "./expiringItems";
import { isOwnerView, ownerSnapshot } from "./ownerView";
import { boardSnapshot, isBoardView } from "./boardView";
import { Rejection } from "./rejection";

// Inventory records are administrator data: they hold costs, vendors and
// invoices.
const INVENTORY_KINDS: readonly string[] = ["stock", "location", "vendor"];
const INVENTORY_AUDIT_ACTION = /^(stock|location|vendor|inventory)\./;

type CostRecord = NonNullable<Snapshot["costs"]>[number];
/** Finds a managed record by kind and uuid: the first, as `find` would. */
type FindRecord = (kind: string, uuid: string) => ManagedRecord | undefined;
type PurchaseOrder = NonNullable<Snapshot["purchaseOrders"]>[number];
type LineEvents = { lines: { lineUuid: string; quantity: number }[] }[];

/** What the user may see in the active program, before it is assembled. */
interface VisibleScope {
  active: string | undefined;
  admin: boolean;
  aircraft: Aircraft[];
  ids: Set<string>;
  management: ManagedRecord[];
  checklists: NonNullable<Snapshot["checklists"]>;
  costs: CostRecord[];
  componentTemplates: NonNullable<Snapshot["componentTemplates"]>;
  componentSetups: NonNullable<Snapshot["componentSetups"]>;
  inspectionTemplates: NonNullable<Snapshot["inspectionTemplates"]>;
  partsRequests: NonNullable<Snapshot["partsRequests"]>;
  purchaseOrders: PurchaseOrder[];
  expiringItems: ExpiringItem[];
  canSeeAudit: (a: AuditEntry) => boolean;
}

/**
 * Tells whether a permission group reaches an aircraft. An empty aircraft list
 * means every aircraft, except for owner groups, which must name theirs;
 * program-administrator groups reach every aircraft.
 *
 * @param g - The group; its program is not checked here.
 * @param aircraftUuid - The aircraft.
 * @returns True when the group's permissions apply to the aircraft.
 */
export function groupCoversAircraft(g: Group, aircraftUuid: string) {
  return (
    !!g.programAdmin ||
    g.aircraftIds.includes(aircraftUuid) ||
    (!g.owner && !g.aircraftIds.length)
  );
}

/**
 * Lists the Flight Programs a member can read, through their groups with
 * `read`.
 *
 * @param user - The member.
 * @param groups - All groups; only the member's count.
 * @returns Program uuids, each once, in group order.
 */
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

/**
 * The user's groups with read access in the active Flight Program: the groups
 * that decide whether they get a reduced view (owner portal, board view).
 *
 * @param s - The user, the groups and the programs.
 * @returns Those groups, in group order; none for an inactive user or a
 *   system administrator, whose access does not come from groups.
 */
export function readGroupsInActiveProgram(
  s: Pick<Snapshot, "user" | "groups" | "programs">,
): Group[] {
  if (!s.user.active || s.user.isAdmin) return [];
  const program = activeProgram(s);
  return s.groups.filter(
    (g) =>
      s.user.groupIds.includes(g.id) &&
      g.programUuid === program &&
      g.permissions.includes("read"),
  );
}

/**
 * Picks the Flight Program the user is working in: the one they chose if they
 * may read it, else the first they may. A system administrator may read every
 * program, and choosing "" leaves them in none.
 *
 * @param s - The user, the groups and the programs.
 * @returns The program uuid, or undefined when there is none.
 */
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

/**
 * Refuses to make a Flight Program the user's active one unless it exists and
 * they may read it. "" selects the unassigned records, which only a system
 * administrator sees.
 *
 * @param s - The user, the groups and the programs.
 * @param programUuid - The program to activate, or "".
 * @throws {Rejection} "Flight Program access denied."
 */
export function assertProgramSelectable(
  s: Pick<Snapshot, "user" | "groups" | "programs">,
  programUuid: string,
): void {
  const selectable = programUuid
    ? (s.programs ?? []).some((p) => p.uuid === programUuid) &&
      (s.user.isAdmin || programIds(s.user, s.groups).includes(programUuid))
    : s.user.isAdmin;
  if (!selectable) throw new Rejection("Flight Program access denied.");
}

/**
 * Tells whether the user holds a permission in a Flight Program. A group
 * counts only with `read`; a program-administrator group grants everything.
 *
 * @param s - The snapshot, for its user and groups.
 * @param permission - A group permission, or "admin" for program administrator.
 * @param program - The program; the active one by default.
 * @returns False for an inactive user; true for an active system
 *   administrator, even with no program; otherwise false without a program.
 */
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

/**
 * Tells whether a record's program is the active one and the user belongs to
 * it.
 *
 * @param s - The snapshot.
 * @param program - The record's program. A record without one passes only for
 *   a system administrator working in no program.
 * @returns True when the record is in the active program's scope.
 */
export function ownsActive(s: Snapshot, program?: string) {
  return (
    program === activeProgram(s) &&
    (s.user.isAdmin ||
      (!!program && programIds(s.user, s.groups).includes(program)))
  );
}

/**
 * Finds the Flight Program a managed record belongs to: its own tag, else its
 * location's (stock), its component's (requirements and movements), or its
 * aircraft's.
 *
 * @param s - The snapshot holding the related records.
 * @param r - The record.
 * @returns The program uuid, or undefined when nothing ties it to one.
 */
export function recordProgram(
  s: Snapshot,
  r: ManagedRecord,
): string | undefined {
  return programOfRecord(s, r, (kind, uuid) =>
    s.management?.find((x) => x.kind === kind && x.uuid === uuid),
  );
}

/**
 * Tells whether the user may see an expiring date: a system administrator for
 * a system-wide one (no program), a program administrator for the active
 * program's.
 *
 * @param s - The snapshot, for its user and groups.
 * @param item - The expiring date's program, if any.
 * @returns True when the user may see it.
 */
export function canSeeExpiringItem(
  s: Snapshot,
  item: Pick<ExpiringItem, "programUuid">,
): boolean {
  if (item.programUuid === undefined) return s.user.isAdmin && s.user.active;
  return item.programUuid === activeProgram(s) && programPermission(s, "admin");
}

/** Which snapshot a user receives in the active program. */
export type SnapshotView = "workspace" | "owner" | "board";

/**
 * Decides which snapshot the user receives: the owner portal (isOwnerView),
 * else the board view (isBoardView), else the workspace. The snapshot query
 * decides with it what to read, and scopedSnapshot which whitelist to apply,
 * so the two cannot disagree.
 *
 * @param s - The user, the groups and the programs.
 * @returns The view; "workspace" for a system administrator.
 */
export function snapshotView(
  s: Pick<Snapshot, "user" | "groups" | "programs">,
): SnapshotView {
  if (isOwnerView(s)) return "owner";
  return isBoardView(s) ? "board" : "workspace";
}

/**
 * The change-log filter scopedSnapshot applies, for history read page by
 * page.
 *
 * @param s - The full snapshot.
 * @returns A predicate, true for each audit entry the user may read.
 */
export const auditVisible = (s: Snapshot) => visibleScope(s).canSeeAudit;

/**
 * Cuts a full snapshot down to what the user may read in the active program:
 * its aircraft and their records, inventory, purchasing and costs as their
 * permissions allow, and other members reduced to what working with them
 * needs. An aircraft owner gets the owner view instead, and a board member
 * the board view.
 *
 * @param s - The full snapshot; it is not changed.
 * @returns The scoped snapshot, with `activeProgramUuid` and
 *   `programScopeVersion` set.
 */
export function scopedSnapshot(s: Snapshot): Snapshot {
  const scope = visibleScope(s);
  // The spread order sets the key order of fields the full snapshot lacks.
  const scoped: Snapshot = {
    ...s,
    ...scopeAccountData(s, scope),
    ...scopeAircraftRecords(s, scope),
    ...scopePurchasing(s, scope),
    ...scopeMaintenance(s, scope),
    ...scopePeople(s, scope),
  };
  const view = snapshotView(scoped);
  if (view === "owner") return ownerSnapshot(scoped);
  return view === "board" ? boardSnapshot(scoped) : scoped;
}

// Shared by the snapshot and the paginated history so both apply the same
// audit rules.
function visibleScope(s: Snapshot): VisibleScope {
  const active = activeProgram(s);
  const admin = programPermission(s, "admin");
  const findRecord = indexRecords(s.management);
  // Board members get the cost records only so that boardSnapshot can total
  // them; the whitelist then leaves the records themselves out.
  const money = admin || isBoardView(s);
  const aircraft = s.aircraft.filter((a) => canReadAircraft(s, active, a));
  const ids = new Set(aircraft.map((a) => a.uuid));
  const scope = {
    active,
    admin,
    aircraft,
    ids,
    management: (s.management ?? []).filter((r) =>
      canSeeManagedRecord(s, findRecord, ids, admin, r),
    ),
    checklists: keepActiveProgram(s, s.checklists).filter(
      (c) => !c.aircraftUuid || ids.has(c.aircraftUuid),
    ),
    costs: (s.costs ?? []).flatMap((r) => scopeCost(r, active, ids, money)),
    componentTemplates: keepActiveProgram(s, s.componentTemplates),
    componentSetups: keepActiveProgram(s, s.componentSetups).filter((t) =>
      ids.has(t.aircraftUuid),
    ),
    inspectionTemplates: keepActiveProgram(s, s.inspectionTemplates),
    partsRequests: keepActiveProgram(s, s.partsRequests).filter((r) =>
      canSeeRequest(r, ids, admin),
    ),
    purchaseOrders: admin ? keepActiveProgram(s, s.purchaseOrders) : [],
    expiringItems: (s.expiringItems ?? []).filter((i) =>
      canSeeExpiringItem(s, i),
    ),
  };
  return { ...scope, canSeeAudit: buildAuditFilter(s, scope) };
}

function canReadAircraft(
  s: Snapshot,
  active: string | undefined,
  a: Aircraft,
): boolean {
  if (!ownsActive(s, a.programUuid)) return false;
  return (
    s.user.isAdmin ||
    s.groups.some(
      (g) =>
        s.user.groupIds.includes(g.id) &&
        g.programUuid === active &&
        g.permissions.includes("read") &&
        groupCoversAircraft(g, a.uuid),
    )
  );
}

// The rules of recordProgram, over any lookup: scoping a whole snapshot
// passes an index, so it is not a scan per record.
function programOfRecord(
  s: Snapshot,
  r: ManagedRecord,
  findRecord: FindRecord,
): string | undefined {
  if (r.programUuid) return r.programUuid;
  if (r.kind === "stock")
    return findRecord("location", r.locationUuid)?.programUuid;
  if (r.kind === "componentRequirement" || r.kind === "componentMovement") {
    const component = findRecord("component", r.componentUuid);
    return component ? programOfRecord(s, component, findRecord) : undefined;
  }
  return "aircraftUuid" in r
    ? s.aircraft.find((a) => a.uuid === r.aircraftUuid)?.programUuid
    : undefined;
}

// Keeps the first record of each kind and uuid, so lookups match `find`.
function indexRecords(records: ManagedRecord[] = []): FindRecord {
  const index = new Map<string, ManagedRecord>();
  for (const r of records) {
    const key = `${r.kind}:${r.uuid}`;
    if (!index.has(key)) index.set(key, r);
  }
  return (kind, uuid) => index.get(`${kind}:${uuid}`);
}

function canSeeManagedRecord(
  s: Snapshot,
  findRecord: FindRecord,
  ids: Set<string>,
  admin: boolean,
  r: ManagedRecord,
): boolean {
  if (!ownsActive(s, programOfRecord(s, r, findRecord))) return false;
  if (INVENTORY_KINDS.includes(r.kind) && !admin) return false;
  // Requirements and movements go with their component's aircraft.
  const owner =
    ("componentUuid" in r && findRecord("component", r.componentUuid)) || r;
  return (
    !("aircraftUuid" in owner) ||
    !owner.aircraftUuid ||
    ids.has(owner.aircraftUuid)
  );
}

function keepActiveProgram<T extends { programUuid?: string }>(
  s: Snapshot,
  records: T[] | undefined,
): T[] {
  return (records ?? []).filter((r) => ownsActive(s, r.programUuid));
}

function canSeeRequest(
  r: { aircraftUuid?: string },
  ids: Set<string>,
  admin: boolean,
): boolean {
  return r.aircraftUuid ? ids.has(r.aircraftUuid) : admin;
}

// Cost records are administrator data; maintenance users only see labor
// hours (no rates) so they can record their time on a work order.
function scopeCost(
  r: CostRecord,
  active: string | undefined,
  ids: Set<string>,
  money: boolean,
): CostRecord[] {
  if (r.kind === "settings")
    return r.programUuid === active && money ? [r] : [];
  if (!ids.has(r.aircraftUuid)) return [];
  if (money) return [r];
  if (r.kind !== "workOrder") return [];
  return [
    {
      ...r,
      labor: r.labor.map(({ rateCents: _rate, ...e }) => e),
      other: [],
      partUnitCosts: [],
    },
  ];
}

function buildAuditFilter(
  s: Snapshot,
  scope: Omit<VisibleScope, "canSeeAudit">,
): (a: AuditEntry) => boolean {
  const { active, admin, ids } = scope;
  const entities = collectVisibleEntities(s, scope);
  // Older change-log rows about inventory records hold the full record. Rows
  // are never rewritten (ADR-0005), so hide them from everyone without
  // program-admin permission, even when they carry an aircraft tag. The
  // action prefix covers rows whose record is not loaded.
  const inventoryRecords = new Set(
    (s.management ?? [])
      .filter((r) => INVENTORY_KINDS.includes(r.kind))
      .map((r) => r.uuid),
  );
  return (a) => {
    if (
      !admin &&
      (inventoryRecords.has(a.entityUuid) ||
        INVENTORY_AUDIT_ACTION.test(a.action))
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
}

function collectVisibleEntities(
  s: Snapshot,
  scope: Omit<VisibleScope, "canSeeAudit">,
): Set<string> {
  const records: { uuid: string }[] = [
    ...(scope.admin ? scope.costs : []),
    ...scope.partsRequests,
    ...scope.purchaseOrders,
    ...scope.checklists,
    ...scope.componentTemplates,
    ...scope.componentSetups,
    ...scope.inspectionTemplates,
    ...scope.management,
    ...scope.expiringItems,
    ...(s.programs?.filter((p) => p.uuid === scope.active) ?? []),
  ];
  return new Set(records.map((r) => r.uuid));
}

function scopeAccountData(s: Snapshot, scope: VisibleScope): Partial<Snapshot> {
  return {
    certificationFiles: s.certificationFiles?.filter(
      (f) => s.user.isAdmin || f.userId === s.user.id,
    ),
    savedAddresses: (s.savedAddresses ?? []).filter(
      (a) => a.programUuid === scope.active,
    ),
    partsInventory: partsInventory({ ...s, partsInventory: undefined }),
    programScopeVersion: 1,
    activeProgramUuid: scope.active,
    programs: scopePrograms(s, scope.active),
    aircraft: scope.aircraft,
    expiringItems: scope.expiringItems,
  };
}

// Only system administrators see other programs' contact details.
function scopePrograms(
  s: Snapshot,
  active: string | undefined,
): Snapshot["programs"] {
  return (s.programs ?? [])
    .filter(
      (p) => s.user.isAdmin || programIds(s.user, s.groups).includes(p.uuid),
    )
    .map((p) =>
      s.user.isAdmin || p.uuid === active
        ? p
        : { ...p, address: "", email: "", contactName: "", website: "" },
    );
}

function scopeAircraftRecords(
  s: Snapshot,
  scope: VisibleScope,
): Partial<Snapshot> {
  const onAircraft = matchesAircraft(scope.ids);
  const visibleCards = uuidsOf(
    [...(s.taskCards ?? []), ...(s.archivedTaskCards ?? [])].filter(onAircraft),
  );
  return {
    componentTemplates: scope.componentTemplates,
    componentSetups: scope.componentSetups,
    inspectionTemplates: scope.inspectionTemplates,
    manuals: (s.manuals ?? []).filter(onAircraft),
    aircraftFiles: (s.aircraftFiles ?? []).filter(onAircraft),
    taskCards: (s.taskCards ?? []).filter(onAircraft),
    archivedTaskCards: (s.archivedTaskCards ?? []).filter(onAircraft),
    taskEvidence: (s.taskEvidence ?? []).filter((f) =>
      visibleCards.has(f.taskCardUuid),
    ),
    faaMonitors: (s.faaMonitors ?? []).filter(onAircraft),
    airworthiness: (s.airworthiness ?? []).filter((r) =>
      scope.ids.has(adAircraftUuid(s, r)),
    ),
  };
}

function scopePurchasing(s: Snapshot, scope: VisibleScope): Partial<Snapshot> {
  const { ids, admin } = scope;
  const orders = keepActiveProgram(s, s.purchaseOrders);
  const orderUuids = uuidsOf(orders);
  const visibleRequests = uuidsOf(
    (s.partsRequests ?? []).filter((r) => canSeeRequest(r, ids, admin)),
  );
  return {
    partsOnOrder: orders
      .filter((p) => p.phase === "issued")
      .flatMap(listPartsOnOrder),
    purchaseOrderFiles: (s.purchaseOrderFiles ?? []).filter(
      (f) => orderUuids.has(f.poUuid) && admin,
    ),
    partsRequests: scope.partsRequests,
    partsRequestPurchases: requestPurchases(orders).filter((a) =>
      visibleRequests.has(a.requestUuid),
    ),
    purchaseOrders: scope.purchaseOrders,
  };
}

function listPartsOnOrder(
  order: PurchaseOrder,
): NonNullable<Snapshot["partsOnOrder"]> {
  return order.lines
    .filter((l) => l.stockUuid)
    .map((l) => {
      const received = sumLineQuantity(order.receipts, l.uuid);
      return {
        stockUuid: l.stockUuid,
        quantity: Math.max(0, l.quantity - l.cancelled - received),
        shipped: Math.max(
          0,
          sumLineQuantity(order.shipments, l.uuid) - received,
        ),
      };
    });
}

function sumLineQuantity(events: LineEvents, lineUuid: string): number {
  return events
    .flatMap((e) => e.lines)
    .filter((l) => l.lineUuid === lineUuid)
    .reduce((n, l) => n + l.quantity, 0);
}

function scopeMaintenance(s: Snapshot, scope: VisibleScope): Partial<Snapshot> {
  const { admin, management } = scope;
  const onAircraft = matchesAircraft(scope.ids);
  const filed = uuidsOf(
    management.filter((r) => r.kind === "stock" || r.kind === "component"),
  );
  const visibleOrders = uuidsOf((s.workOrders ?? []).filter(onAircraft));
  return {
    checklists: scope.checklists,
    costs: scope.costs,
    workOrders: (s.workOrders ?? []).filter(onAircraft),
    inventoryAttachments: (s.inventoryAttachments ?? []).filter(
      (f) => admin && filed.has(f.stockUuid),
    ),
    workOrderAttachments: (s.workOrderAttachments ?? []).filter((f) =>
      visibleOrders.has(f.workOrderUuid),
    ),
    flightPlans: (s.flightPlans ?? []).filter(onAircraft),
    flights: s.flights.filter(onAircraft),
    discrepancies: s.discrepancies.filter(onAircraft),
    inspections: s.inspections.filter(onAircraft),
    management,
    audit: s.audit.filter(scope.canSeeAudit),
  };
}

function uuidsOf(records: { uuid: string }[]): Set<string> {
  return new Set(records.map((r) => r.uuid));
}

function matchesAircraft(ids: Set<string>) {
  return (record: { aircraftUuid: string }) => ids.has(record.aircraftUuid);
}

function scopePeople(s: Snapshot, scope: VisibleScope): Partial<Snapshot> {
  const { active, admin, ids } = scope;
  const historicalPilots = new Set(
    s.flights
      .filter((f) => ids.has(f.aircraftUuid))
      .flatMap((f) => [f.pilotId, f.copilotId]),
  );
  return {
    groups: s.groups.filter(
      (g) =>
        s.user.isAdmin ||
        s.user.groupIds.includes(g.id) ||
        (g.programUuid === active && admin),
    ),
    members: s.members
      .filter(
        (m) =>
          s.user.isAdmin ||
          m.id === s.user.id ||
          historicalPilots.has(m.id) ||
          (m.active && programIds(m, s.groups).includes(active ?? "")),
      )
      .map((m) => redactMember(s, scope, m)),
  };
}

// Other members keep their name, status and pilot availability; their email
// and program groups show only to program administrators.
function redactMember(s: Snapshot, scope: VisibleScope, m: Member): Member {
  const inProgram = programIds(m, s.groups).includes(scope.active ?? "");
  const availableAsPilot = m.active && (m.isAdmin || inProgram);
  if (s.user.isAdmin || m.id === s.user.id) return { ...m, availableAsPilot };
  return {
    id: m.id,
    name: m.name,
    email: scope.admin && inProgram ? m.email : "",
    availableAsPilot,
    active: m.active,
    isAdmin: false,
    groupIds: scope.admin
      ? m.groupIds.filter((id) =>
          s.groups.some((g) => g.id === id && g.programUuid === scope.active),
        )
      : [],
  };
}
