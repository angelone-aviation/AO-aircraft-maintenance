import { adAircraftUuid } from "./adOwnership";
import { effectiveCompliance, lastCompliance } from "./adCompliance";
export { adAircraftUuid } from "./adOwnership";
export { effectiveCompliance, lastCompliance } from "./adCompliance";
import { z } from "zod";
import {
  can,
  latestLocalDate,
  localDate,
  totalSeconds,
  type Snapshot,
} from "./model";
import { activeProgram, programPermission } from "./programs";
import { componentTotals } from "./components";
const text = z.string().trim().max(20000);
const date = z.union([z.iso.date(), z.literal("")]);
const amount = z.number().finite().nonnegative().nullable();
export const adSourceSchema = z.object({
  number: z.string().trim().min(1).max(100),
  faaModified: z.string().optional(),
  amendment: text,
  issued: text,
  effective: text,
  subject: text,
  recurring: z.enum(["Yes", "No", "Unknown"]),
  supersededBy: text,
  url: z.string().max(2000),
  source: text,
  section: z.enum(["Airframe", "Engine", "Propeller", "Appliance"]),
  make: text,
  model: text,
  sourceNotes: text,
});
export const adTaskSchema = z.object({
  uuid: z.string().uuid(),
  description: z.string().trim().min(1).max(20000),
  dueDate: date,
  dueHours: amount,
  dueCycles: amount,
  dueLandings: z.number().int().nonnegative().nullable().optional(),
  intervalLandings: z.number().int().positive().nullable().optional(),
  intervalDays: z.number().int().positive().max(365000).nullable(),
  intervalHours: z.number().positive().finite().nullable(),
  intervalCycles: z.number().int().positive().nullable(),
  recurrence: z.enum(["Unknown", "One-time", "Recurring"]).default("Unknown"),
  workOrderUuid: z.string(),
});
export const adComplianceSchema = z.object({
  uuid: z.string().uuid(),
  taskUuid: z.string().uuid(),
  date: z.iso.date(),
  hours: amount,
  cycles: amount,
  landings: z.number().int().nonnegative().nullable().optional(),
  method: z.string().trim().min(1).max(20000),
  serviceBulletin: text,
  terminatedBy: text,
  workOrderUuid: z.string(),
  mechanic: z.string().trim().min(1).max(200),
  certificate: text,
  evidence: text,
  recordedAt: z.number(),
  recordedBy: z.string(),
  // A correction is appended as a new entry naming the entry it replaces;
  // the original stays in the history (ADR-0005).
  corrects: z.string().uuid().optional(),
  correctionReason: z.string().max(1500).optional(),
});
// What a command may send for an entry: the correction link is set only by
// the correction command, so a forged one on new compliance is dropped.
const complianceInputSchema = adComplianceSchema.omit({
  corrects: true,
  correctionReason: true,
});
const correctionReason = z.string().trim().min(1).max(1500);
export const adSchema = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  programUuid: z.string().optional(),
  aircraftUuid: z.string().min(1),
  componentUuid: z.string(),
  source: adSourceSchema,
  applicability: z.enum([
    "Needs review",
    "Applicable",
    "Not applicable",
    "Superseded",
    "Previously Complied With (PCW)",
  ]),
  priorCompliance: z
    .object({
      date: z.iso.date(),
      aircraftHours: amount,
      componentHours: amount,
    })
    .optional(),
  reason: text,
  tasks: z.array(adTaskSchema).max(100),
  history: z.array(adComplianceSchema).max(1000),
  sourceHistory: z
    .array(z.object({ at: z.number(), source: adSourceSchema }))
    .max(200),
  reviewRequired: z.boolean(),
  updatedAt: z.number(),
});
export type ADSource = z.infer<typeof adSourceSchema>;
// Stored records keep parsing; new saves and imports must link over http(s).
const writableSourceSchema = adSourceSchema.extend({
  url: z
    .string()
    .max(2000)
    .regex(
      /^(?:https?:\/\/.+)?$/is,
      "AD source link must start with http:// or https://.",
    ),
});
export type AD = z.infer<typeof adSchema>;
export type ADTask = z.infer<typeof adTaskSchema>;
export type ADCompliance = z.infer<typeof adComplianceSchema>;
export const adCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("save"),
    record: adSchema.extend({ source: writableSourceSchema }),
    // Required when the save corrects a decided AD (adSaveIsCorrection).
    reason: z.string().trim().max(1500).optional(),
  }),
  z.object({
    kind: z.literal("import"),
    aircraftUuid: z.string(),
    entries: z
      .array(
        z.object({ source: writableSourceSchema, componentUuid: z.string() }),
      )
      .min(1)
      .max(500),
  }),
  z.object({
    kind: z.literal("comply"),
    uuid: z.string(),
    version: z.number(),
    entry: complianceInputSchema,
  }),
  // Flight Program administrators only: appends a replacement for one
  // recorded compliance entry.
  z.object({
    kind: z.literal("correct"),
    uuid: z.string(),
    version: z.number(),
    corrects: z.string().uuid(),
    reason: correctionReason,
    entry: complianceInputSchema,
  }),
]);
export type ADCommand = z.infer<typeof adCommandSchema>;
export const adNumber = (s: string) => s.toUpperCase().replace(/\s+/g, "");
export function blankAD(
  aircraftUuid: string,
  section: ADSource["section"] = "Airframe",
): AD {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    aircraftUuid,
    componentUuid: "",
    source: {
      number: "",
      amendment: "",
      issued: "",
      effective: "",
      subject: "",
      recurring: "Unknown",
      supersededBy: "",
      url: "",
      source: "Manual entry",
      section,
      make: "",
      model: "",
      sourceNotes: "",
    },
    applicability: "Needs review",
    reason: "",
    tasks: [],
    history: [],
    sourceHistory: [],
    reviewRequired: true,
    updatedAt: 0,
  };
}
export function blankADTask(): ADTask {
  return {
    uuid: crypto.randomUUID(),
    description: "",
    dueDate: "",
    dueHours: null,
    dueCycles: null,
    intervalDays: null,
    intervalHours: null,
    intervalCycles: null,
    recurrence: "Unknown",
    workOrderUuid: "",
  };
}
function owner(s: Snapshot, r: AD) {
  if (!can(s, adAircraftUuid(s, r), "maintenance"))
    throw Error("Aircraft maintenance permission required.");
  if (r.componentUuid) {
    const c = s.management?.find(
      (c) => c.kind === "component" && c.uuid === r.componentUuid,
    );
    if (
      !c ||
      c.kind !== "component" ||
      ((r.version === 0 || c.installed) &&
        c.aircraftUuid !==
          (r.version === 0 ? r.aircraftUuid : adAircraftUuid(s, r)))
    )
      throw Error("Select a component belonging to this aircraft.");
  } else if (r.source.section !== "Airframe")
    throw Error("Select the specific component for this AD.");
}
function validateWorkOrder(
  s: Snapshot,
  id: string,
  aircraftUuid: string,
  open = false,
) {
  if (!id) return;
  const w = s.workOrders?.find(
    (w) => w.uuid === id && w.aircraftUuid === aircraftUuid,
  );
  if (
    !w ||
    w.status === "cancelled" ||
    (open && ["closed", "completed"].includes(w.status))
  )
    throw Error("Select an appropriate work order for this aircraft.");
}
const hasInterval = (t: ADTask) =>
  !!(
    t.intervalDays ||
    t.intervalHours ||
    t.intervalCycles ||
    t.intervalLandings
  );
/** Whether saving over this stored AD corrects a record. Once its
 * applicability is decided or compliance is recorded, every change needs a
 * reason (ADR-0005); the first review of an imported AD does not. */
export function adSaveIsCorrection(old: AD | undefined) {
  return (
    !!old && (old.applicability !== "Needs review" || old.history.length > 0)
  );
}
const complianceValues = (h: ADCompliance) =>
  JSON.stringify([
    h.date,
    h.hours,
    h.cycles,
    h.landings ?? null,
    h.method,
    h.serviceBulletin,
    h.terminatedBy,
    h.workOrderUuid,
    h.mechanic,
    h.certificate,
    h.evidence,
  ]);
// Checks a completion against the action's neighbouring entries (the last
// one for new compliance; both for a correction) and the current totals.
function checkEntry(
  s: Snapshot,
  r: AD,
  t: ADTask,
  entry: ADCompliance,
  now: number,
  prev?: ADCompliance,
  next?: ADCompliance,
) {
  validateWorkOrder(s, entry.workOrderUuid, adAircraftUuid(s, r));
  if (entry.date > latestLocalDate(now))
    throw Error("Completion date cannot be in the future.");
  if (prev && entry.date < prev.date)
    throw Error("Completion date precedes the last compliance entry.");
  if (next && entry.date > next.date)
    throw Error("Completion date is after the next compliance entry.");
  if (
    (t.intervalHours && entry.hours === null) ||
    (t.intervalCycles && entry.cycles === null) ||
    (t.intervalLandings && entry.landings == null)
  )
    throw Error("Record the counter needed to calculate the next due.");
  const below = (a?: number | null, b?: number | null) =>
    a != null && b != null && a < b;
  if (
    prev &&
    (below(entry.hours, prev.hours) || below(entry.cycles, prev.cycles))
  )
    throw Error("Completion counters precede the last compliance entry.");
  if (
    next &&
    (below(next.hours, entry.hours) ||
      below(next.cycles, entry.cycles) ||
      below(next.landings, entry.landings))
  )
    throw Error("Completion counters are after the next compliance entry.");
  const aircraftLandings = s.aircraft.find(
    (a) => a.uuid === adAircraftUuid(s, r),
  )?.landings;
  if (
    entry.landings != null &&
    (aircraftLandings === undefined ||
      entry.landings > aircraftLandings ||
      entry.landings < (prev?.landings ?? 0))
  )
    throw Error(
      "Completion landings must be between last compliance and the aircraft total.",
    );
  const counters = adCounters(s, r);
  const component = s.management?.find(
    (c) => c.kind === "component" && c.uuid === r.componentUuid,
  );
  const tracked = (dimension: "trackTime" | "trackCycles") =>
    component?.kind !== "component" || component[dimension];
  if (
    counters &&
    ((entry.hours !== null &&
      tracked("trackTime") &&
      // Allow the 0.1 h rounding shown for current totals.
      entry.hours > counters.hours + 0.05) ||
      (entry.cycles !== null &&
        tracked("trackCycles") &&
        entry.cycles > counters.cycles))
  )
    throw Error(
      "Completion hours and cycles cannot exceed the current totals.",
    );
}
// Repeating limits advance from the completion; an initial limit without a
// repeat interval is satisfied by it, as on inspections.
function advanceDue(t: ADTask, entry: ADCompliance) {
  if (entry.terminatedBy || !hasInterval(t)) return;
  let dueDate = "";
  if (t.intervalDays) {
    const d = new Date(entry.date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + t.intervalDays);
    dueDate = d.toISOString().slice(0, 10);
  }
  t.dueDate = dueDate;
  t.dueHours = t.intervalHours ? entry.hours! + t.intervalHours : null;
  t.dueCycles = t.intervalCycles ? entry.cycles! + t.intervalCycles : null;
  t.dueLandings = t.intervalLandings
    ? entry.landings! + t.intervalLandings
    : null;
}
export function applyADCommand(
  s: Snapshot,
  raw: ADCommand,
  now = Date.now(),
): AD[] {
  const cmd = adCommandSchema.parse(raw);
  const all = [...(s.airworthiness ?? [])];
  const changed: AD[] = [];
  const put = (r: AD) => {
    const i = all.findIndex((x) => x.uuid === r.uuid);
    if (i < 0) all.push(r);
    else all[i] = r;
    changed.push(r);
  };
  if (cmd.kind === "import") {
    if (!can(s, cmd.aircraftUuid, "maintenance"))
      throw Error("Aircraft maintenance permission required.");
    const seen = new Set<string>();
    for (const e of cmd.entries) {
      const key = adNumber(e.source.number) + "|" + e.componentUuid;
      if (seen.has(key)) throw Error("Duplicate AD and component in import.");
      seen.add(key);
      const old = all.find(
        (r) =>
          adAircraftUuid(s, r) === cmd.aircraftUuid &&
          r.componentUuid === e.componentUuid &&
          adNumber(r.source.number) === adNumber(e.source.number),
      );
      const r = old
        ? structuredClone(old)
        : blankAD(cmd.aircraftUuid, e.source.section);
      r.componentUuid = e.componentUuid;
      owner(s, r);
      if (old && JSON.stringify(old.source) === JSON.stringify(e.source))
        continue;
      if (old) r.sourceHistory.push({ at: now, source: old.source });
      r.source = e.source;
      r.reviewRequired = true;
      r.version++;
      r.programUuid = activeProgram(s);
      r.updatedAt = now;
      put(adSchema.parse(r));
    }
  } else {
    const old = all.find(
      (r) => r.uuid === (cmd.kind === "save" ? cmd.record.uuid : cmd.uuid),
    );
    if (cmd.kind !== "save" && !old) throw Error("AD not found.");
    const r = structuredClone(cmd.kind === "save" ? cmd.record : old!);
    owner(s, r);
    if ((old?.version ?? 0) !== (cmd.kind === "save" ? r.version : cmd.version))
      throw Error("AD changed. Reload before saving.");
    if (
      old &&
      (old.aircraftUuid !== r.aircraftUuid ||
        old.componentUuid !== r.componentUuid)
    )
      throw Error("An existing AD cannot be reassigned to another asset.");
    if (cmd.kind === "save") {
      if (adSaveIsCorrection(old) && !cmd.reason)
        throw Error("Record the reason for changing this AD.");
      r.history = old?.history ?? [];
      r.sourceHistory = old?.sourceHistory ?? [];
      if (old && JSON.stringify(old.source) !== JSON.stringify(r.source))
        r.sourceHistory = [...r.sourceHistory, { at: now, source: old.source }];
      if (r.applicability === "Superseded" && !r.source.supersededBy)
        throw Error("Enter the superseding AD in Superseded by.");
      if (r.applicability === "Not applicable" && !r.reason)
        throw Error("Record the reason this AD is not applicable.");
      if (r.applicability === "Previously Complied With (PCW)") {
        const pcw = r.priorCompliance;
        if (!pcw || pcw.date > latestLocalDate(now))
          throw Error(
            "Record a previous compliance date that is not in the future.",
          );
        if (
          pcw.aircraftHours === null &&
          (!r.componentUuid || pcw.componentHours === null)
        )
          throw Error(
            "Record aircraft total time or, for a component AD, component total time.",
          );
        if (!r.componentUuid && pcw.componentHours !== null)
          throw Error(
            "Component total time is only available for component ADs.",
          );
      }
      if (r.applicability === "Applicable" && !r.tasks.length)
        throw Error("Add at least one required action.");
      if (new Set(r.tasks.map((t) => t.uuid)).size !== r.tasks.length)
        throw Error("Duplicate action identifiers.");
      if (old?.history.some((h) => !r.tasks.some((t) => t.uuid === h.taskUuid)))
        throw Error("Actions with compliance history cannot be removed.");
      for (const t of r.tasks) {
        validateWorkOrder(s, t.workOrderUuid, adAircraftUuid(s, r));
        if (
          t.recurrence === "One-time" &&
          (t.intervalDays ||
            t.intervalHours ||
            t.intervalCycles ||
            t.intervalLandings)
        )
          throw Error("One-time actions cannot have repeating intervals.");
      }
      if (
        all.some(
          (x) =>
            x.uuid !== r.uuid &&
            adAircraftUuid(s, x) === adAircraftUuid(s, r) &&
            x.componentUuid === r.componentUuid &&
            adNumber(x.source.number) === adNumber(r.source.number),
        )
      )
        throw Error("This AD already exists for the selected asset.");
    } else if (cmd.kind === "comply") {
      if (
        !["Applicable", "Previously Complied With (PCW)"].includes(
          r.applicability,
        ) ||
        r.reviewRequired
      )
        throw Error("Review applicability before recording compliance.");
      const t = r.tasks.find((t) => t.uuid === cmd.entry.taskUuid);
      if (!t) throw Error("Required action not found.");
      const entry = { ...cmd.entry, recordedAt: now, recordedBy: s.user.id };
      if (r.history.some((h) => h.uuid === entry.uuid))
        throw Error("Compliance entry already recorded.");
      checkEntry(s, r, t, entry, now, lastCompliance(r, t.uuid));
      r.history.push(entry);
      advanceDue(t, entry);
    } else {
      const program = s.aircraft.find(
        (a) => a.uuid === adAircraftUuid(s, r),
      )?.programUuid;
      if (!programPermission(s, "admin", program))
        throw Error(
          "Flight Program administrator permission is required to correct a compliance record.",
        );
      const target = r.history.find((h) => h.uuid === cmd.corrects);
      if (!target) throw Error("Compliance entry not found.");
      // Every correction names the original entry, so the latest wins.
      const root = target.corrects ?? target.uuid;
      const t = r.tasks.find((t) => t.uuid === target.taskUuid);
      if (!t) throw Error("Required action not found.");
      if (cmd.entry.taskUuid !== t.uuid)
        throw Error("A correction must be for the same required action.");
      const entry: ADCompliance = {
        ...cmd.entry,
        recordedAt: now,
        recordedBy: s.user.id,
        corrects: root,
        correctionReason: cmd.reason,
      };
      if (r.history.some((h) => h.uuid === entry.uuid))
        throw Error("Compliance entry already recorded.");
      const entries = effectiveCompliance(r).filter(
        (h) => h.taskUuid === t.uuid,
      );
      const i = entries.findIndex((h) => (h.corrects ?? h.uuid) === root);
      if (i < 0) throw Error("Compliance entry not found.");
      if (complianceValues(entries[i]) === complianceValues(entry))
        throw Error("Change at least one field before saving a correction.");
      checkEntry(s, r, t, entry, now, entries[i - 1], entries[i + 1]);
      r.history.push(entry);
      // The latest entry sets the next due, so correcting it recalculates it.
      if (i === entries.length - 1) advanceDue(t, entry);
    }
    r.programUuid = activeProgram(s);
    r.version = (old?.version ?? 0) + 1;
    r.updatedAt = now;
    put(adSchema.parse(r));
  }
  s.airworthiness = all;
  return changed;
}
/** The reason an AD command's audit entries record: a correction's, or the
 * one given for an AD change. */
export function adCommandReason(cmd: ADCommand) {
  return (cmd.kind === "save" || cmd.kind === "correct") && cmd.reason
    ? cmd.reason.trim()
    : undefined;
}
/** An AD as an audit entry records it: everything that can change, including
 * applicability, review state and every action's due limits. The append-only
 * compliance history and prior source versions stay on the record (they can
 * be large); the entry keeps their counts and the latest compliance entry. */
export function adAuditRecord(r: AD) {
  const { history, sourceHistory, ...record } = r;
  return {
    ...record,
    complianceEntries: history.length,
    latestCompliance: history.at(-1),
    priorSourceVersions: sourceHistory.length,
  };
}
export function adCounters(s: Snapshot, r: AD) {
  const a = s.aircraft.find((a) => a.uuid === adAircraftUuid(s, r));
  if (!a) return null;
  if (r.componentUuid) {
    const c = s.management?.find(
      (c) => c.kind === "component" && c.uuid === r.componentUuid,
    );
    if (!c || c.kind !== "component") return null;
    let t;
    try {
      t = componentTotals(c, a);
    } catch {
      return null;
    }
    return {
      hours: t.timeSinceNew / 3600,
      cycles: t.cyclesSinceNew,
      landings: a.landings,
    };
  }
  return {
    hours: totalSeconds(a) / 3600,
    cycles: a.cycles,
    landings: a.landings,
  };
}
export function adTaskStatus(
  s: Snapshot,
  r: AD,
  t: ADTask,
  today = localDate(),
) {
  const last = lastCompliance(r, t.uuid);
  if (
    last &&
    (last.terminatedBy ||
      t.recurrence === "One-time" ||
      (!t.intervalDays &&
        !t.intervalHours &&
        !t.intervalCycles &&
        !t.intervalLandings &&
        t.recurrence !== "Recurring" &&
        r.source.recurring === "No"))
  )
    return "Complied";
  if (
    last &&
    !t.intervalDays &&
    !t.intervalHours &&
    !t.intervalCycles &&
    !t.intervalLandings
  )
    return "Due not set";
  // A passed due date is overdue even when a usage counter is unavailable.
  if (t.dueDate && t.dueDate < today) return "Overdue";
  const c = adCounters(s, r);
  const component = s.management?.find(
    (c) => c.kind === "component" && c.uuid === r.componentUuid,
  );
  if (
    (t.dueHours !== null || t.dueCycles !== null) &&
    (!c ||
      (component?.kind === "component" &&
        ((t.dueHours !== null && !component.trackTime) ||
          (t.dueCycles !== null && !component.trackCycles))))
  )
    return "Counter unavailable";
  if (t.dueLandings != null && !c) return "Counter unavailable";
  // One rule for every maintenance limit (GLOSSARY "Overdue"): a usage limit
  // is reached at 0 remaining, because the next flight would exceed it; a
  // calendar limit stays valid through its due date. Hours compare in whole
  // seconds, as inspections do, so floating-point noise cannot hide a 0.
  const days = t.dueDate
    ? [(Date.parse(t.dueDate) - Date.parse(today)) / 86400000]
    : [];
  const usage = [
    ...(c && t.dueHours !== null
      ? [Math.round((t.dueHours - c.hours) * 3600) / 3600]
      : []),
    ...(c && t.dueCycles !== null ? [t.dueCycles - c.cycles] : []),
    ...(c && t.dueLandings != null ? [t.dueLandings - c.landings] : []),
  ];
  if (days.some((n) => n < 0) || usage.some((n) => n <= 0)) return "Overdue";
  const remaining = [...days, ...usage];
  if (remaining.some((n) => n <= 30)) return "Due soon";
  return remaining.length ? "Scheduled" : "Due not set";
}
export function adStatus(s: Snapshot, r: AD) {
  const c = s.management?.find(
    (c) => c.kind === "component" && c.uuid === r.componentUuid,
  );
  if (c?.kind === "component" && !c.installed) return "Removed component";
  if (r.reviewRequired || r.applicability === "Needs review")
    return "Needs review";
  if (r.applicability === "Not applicable") return "Not applicable";
  if (r.applicability === "Superseded") return "Superseded";
  if (
    r.applicability === "Previously Complied With (PCW)" &&
    !r.tasks.length &&
    r.source.recurring === "No"
  )
    return "Previously Complied With (PCW)";
  const statuses: string[] = r.tasks.map((t) => adTaskStatus(s, r, t));
  // An overdue action makes the AD overdue even if another cannot be computed.
  return (
    [
      "Overdue",
      "Counter unavailable",
      "Due soon",
      "Due not set",
      "Scheduled",
      "Complied",
    ].find((x) => statuses.includes(x)) ?? "Due not set"
  );
}
export type InitialLimit = "dueDate" | "dueHours" | "dueCycles" | "dueLandings";
const limitInterval = {
  dueDate: "intervalDays",
  dueHours: "intervalHours",
  dueCycles: "intervalCycles",
  dueLandings: "intervalLandings",
} as const;
export type StaleInitialLimit = {
  taskUuid: string;
  limits: InitialLimit[];
  /** The latest compliance on the action, which would now have cleared them. */
  complianceDate: string;
};
/** One-time limits (a due date, hours, cycles or landings without its own
 * repeat interval) left on a repeating action after compliance. Compliance
 * recorded before the #42 fix kept them, which can keep the AD Overdue.
 * They are flagged for review, never cleared automatically: a stored record
 * cannot tell a stale limit from one entered after compliance on purpose. */
export function staleInitialLimits(r: AD): StaleInitialLimit[] {
  if (
    !["Applicable", "Previously Complied With (PCW)"].includes(r.applicability)
  )
    return [];
  return r.tasks.flatMap((t) => {
    const last = lastCompliance(r, t.uuid);
    if (!last || last.terminatedBy || !hasInterval(t)) return [];
    const limits = (Object.keys(limitInterval) as InitialLimit[]).filter(
      (k) =>
        (k === "dueDate" ? !!t.dueDate : t[k] != null) && !t[limitInterval[k]],
    );
    return limits.length
      ? [{ taskUuid: t.uuid, limits, complianceDate: last.date }]
      : [];
  });
}
/** A copy of the AD with one action's stale initial limits cleared, to save
 * through the normal AD save (audited, with a reason). */
export function clearInitialLimits(r: AD, taskUuid: string): AD {
  const next = structuredClone(r);
  const t = next.tasks.find((t) => t.uuid === taskUuid);
  const stale = staleInitialLimits(r).find((x) => x.taskUuid === taskUuid);
  if (t && stale)
    for (const k of stale.limits)
      if (k === "dueDate") t.dueDate = "";
      else t[k] = null;
  return next;
}
export function initialLimitLabel(t: ADTask, k: InitialLimit) {
  return k === "dueDate"
    ? `due date ${t.dueDate}`
    : k === "dueHours"
      ? `${t.dueHours} hours`
      : k === "dueCycles"
        ? `${t.dueCycles} cycles`
        : `${t.dueLandings} landings`;
}
const staleLabels = (r: AD, stale: StaleInitialLimit) => {
  const t = r.tasks.find((t) => t.uuid === stale.taskUuid);
  return {
    description: t?.description ?? "",
    limits: t
      ? stale.limits.map((k) => initialLimitLabel(t, k)).join(", ")
      : "",
  };
};
/** What the register shows for a stale initial limit. */
export function staleInitialLimitNotice(r: AD, stale: StaleInitialLimit) {
  return `This one-time limit (${staleLabels(r, stale).limits}) was not cleared when compliance was recorded on ${stale.complianceDate}. If compliance satisfied it, clear it.`;
}
/** The reason prefilled when a stale initial limit is cleared. */
export function initialLimitClearReason(r: AD, stale: StaleInitialLimit) {
  const { description, limits } = staleLabels(r, stale);
  return `One-time initial limit (${limits}) on "${description}" cleared: satisfied by the compliance recorded on ${stale.complianceDate}, which did not clear it when it was recorded.`;
}
