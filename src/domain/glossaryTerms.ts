/**
 * Responsibility: The plain-language glossary behind the term tips and the
 *   Glossary page: every aviation and records term a lay reader meets.
 * Layer: Domain. Static data and pure lookups; no I/O, no React.
 * Dependencies: none.
 *
 * Written for board members, owners and office staff, so each definition
 * avoids jargon. It follows GLOSSARY.md's meanings; a definition links another
 * entry as `[shown text](term-id)`.
 */

/** One entry as written below, before its id is attached. */
type EntryText = {
  term: string;
  longForm?: string;
  definition: string;
};

const ENTRIES = {
  "100-hour": {
    term: "100-hour inspection",
    definition:
      "A full [inspection](inspection) required every 100 flight hours on an aircraft that carries people for hire or gives flight instruction for hire. It covers the same ground as the [annual](annual).",
  },
  "a-and-p": {
    term: "A&P",
    longForm: "Airframe and Powerplant mechanic",
    definition:
      "A mechanic licensed by the [FAA](faa) to maintain and repair both the body of an aircraft and its engines. Most maintenance work is signed by an A&P.",
  },
  ad: {
    term: "AD",
    longForm: "Airworthiness directive",
    definition:
      "A mandatory safety order from the [FAA](faa) telling owners to inspect, fix or replace something on a type of aircraft or part. Angel One tracks which ADs apply to each aircraft and when each was done.",
  },
  "administrator-program": {
    term: "Flight Program administrator",
    definition:
      "A person who manages one [Flight Program](flight-program): its people, their access, its aircraft and its settings.",
  },
  "administrator-system": {
    term: "System administrator",
    definition:
      "A person who manages every [Flight Program](flight-program), user and access group in Angel One.",
  },
  airworthy: {
    term: "Airworthy",
    definition:
      "The aircraft's recorded maintenance is up to date and nothing on record stops it from flying. The pilot still checks the aircraft before every flight.",
  },
  alert: {
    term: "Alert",
    definition:
      "A message in Angel One about maintenance coming due, a date about to expire or a document to review. Alerts show under the bell and can also arrive by email.",
  },
  annual: {
    term: "Annual inspection",
    definition:
      "The full [inspection](inspection) every aircraft must pass once every 12 calendar months to keep flying. It must be signed off by an [IA](ia).",
  },
  aog: {
    term: "AOG",
    longForm: "Aircraft on ground",
    definition:
      "The aircraft cannot fly until a part arrives. A parts request marked AOG is the most urgent kind.",
  },
  ata: {
    term: "ATA chapter",
    definition:
      "A standard number for each system of an aircraft, such as 32 for landing gear or 79 for engine oil. It sorts maintenance work and manuals the same way across every aircraft.",
  },
  "audit-entry": {
    term: "Change history",
    definition:
      "The permanent record of who changed what in Angel One, when, and why. Entries are never edited or removed.",
  },
  "board-member": {
    term: "Board member",
    definition:
      "A person who sees the [board view](board-view) only: a read-only summary of the fleet, costs and backups.",
  },
  "board-view": {
    term: "Board view",
    definition:
      "A read-only summary of a [Flight Program](flight-program)'s fleet for its board: aircraft status, maintenance coming due, open problems and costs against budget.",
  },
  cfr: {
    term: "CFR",
    longForm: "Code of Federal Regulations",
    definition:
      'The written US federal rules. "14 CFR" is the part about aviation; for example, 14 CFR 91.417 lists the maintenance records an operator must keep.',
  },
  checklist: {
    term: "Checklist",
    definition:
      "The step-by-step list a pilot follows for normal, abnormal and emergency situations in a particular aircraft.",
  },
  cht: {
    term: "CHT",
    longForm: "Cylinder head temperature",
    definition:
      "How hot the top of each engine cylinder runs. Pilots and mechanics watch it to spot engine trouble early.",
  },
  "close-out": {
    term: "Close-out",
    definition:
      "Finishing a [work order](work-order): the work is recorded, part changes are applied and the aircraft's readings are frozen on the record.",
  },
  component: {
    term: "Component",
    definition:
      "A tracked part with its own serial number, such as an engine, propeller or magneto. Angel One follows its hours and limits wherever it is installed or stored.",
  },
  correction: {
    term: "Correction",
    definition:
      "A change to a finished record that keeps the original and records who changed it and why. Records are corrected, never quietly edited.",
  },
  cycle: {
    term: "Cycle",
    definition:
      "One start-to-stop use of an aircraft or part, such as one engine start or one takeoff and landing. Some parts wear out by cycles rather than hours.",
  },
  deferral: {
    term: "Deferral",
    definition:
      "Putting off the repair of a [discrepancy](discrepancy) for a limited time when the rules allow the aircraft to fly safely without the item, usually under the [MEL](mel). The item is labelled with a placard and must be fixed by a deadline.",
  },
  "demo-mode": {
    term: "Demo mode",
    definition:
      "A practice copy of Angel One with made-up aircraft, kept only in your browser. Nothing in it touches real records.",
  },
  discrepancy: {
    term: "Discrepancy",
    definition:
      "A problem found with an aircraft, reported by a pilot or mechanic. It stays open until it is fixed or formally put off as a [deferral](deferral).",
  },
  "dispatch-gate": {
    term: "Dispatch gate",
    definition:
      "The check that stops a flight being logged on a [grounded](grounded) aircraft. Flying anyway needs a written reason, which is kept with the flight.",
  },
  "due-soon": {
    term: "Due soon",
    definition:
      "Some maintenance is close to its limit in hours, landings or days. The aircraft can still fly, but the work should be planned now.",
  },
  egt: {
    term: "EGT",
    longForm: "Exhaust gas temperature",
    definition:
      "How hot the gases leaving the engine are. It shows how well the engine is running and is recorded on some flights.",
  },
  elt: {
    term: "ELT",
    longForm: "Emergency locator transmitter",
    definition:
      "A radio beacon that turns on by itself after a crash to help rescuers find the aircraft. Its battery has to be replaced on a set schedule.",
  },
  faa: {
    term: "FAA",
    longForm: "Federal Aviation Administration",
    definition:
      "The US government agency that makes and enforces the rules for aircraft, pilots and mechanics.",
  },
  flight: {
    term: "Flight",
    definition:
      "One logged flight, with the aircraft's meter readings at the start and end. Each flight adds to the aircraft's hours and landings.",
  },
  "flight-program": {
    term: "Flight Program",
    definition:
      "The organization that owns a group of aircraft and the people who fly and maintain them. Each record in Angel One belongs to one Flight Program.",
  },
  "form-337": {
    term: "Form 337",
    definition:
      "The FAA form that records a major repair or a major change to an aircraft. A copy stays with the aircraft's records for life.",
  },
  grounded: {
    term: "Grounded",
    definition:
      "The aircraft must not fly: something required is [overdue](overdue) or an open problem stops it. It stays grounded until the work is done and recorded.",
  },
  "held-for-review": {
    term: "Held for review",
    definition:
      "A flight whose meter readings do not match the aircraft's current totals. An administrator checks it before the aircraft's hours change.",
  },
  hobbs: {
    term: "Hobbs",
    longForm: "Hobbs meter",
    definition:
      "A clock in the aircraft that counts hours while the engine runs, in tenths of an hour. Pilots read it at the start and end of each [flight](flight).",
  },
  ia: {
    term: "IA",
    longForm: "Inspection Authorization",
    definition:
      "An extra FAA approval held by an experienced [A&P](a-and-p) mechanic. Only an IA may sign off an [annual inspection](annual) or approve a major repair.",
  },
  ifr: {
    term: "IFR",
    longForm: "Instrument flight rules",
    definition:
      "Flying by the aircraft's instruments and air traffic control, which allows flight in clouds. It needs extra equipment checks.",
  },
  inspection: {
    term: "Inspection",
    definition:
      "A required check of an aircraft or one of its parts, due after a number of hours, landings or months.",
  },
  "logbook-entry": {
    term: "Logbook entry",
    definition:
      "The written record of maintenance work in the aircraft's paper logbook, signed by the mechanic. Angel One prepares the wording; the signed logbook is the official record.",
  },
  mel: {
    term: "MEL",
    longForm: "Minimum Equipment List",
    definition:
      "An FAA-approved list, specific to an aircraft, of equipment that may be broken for a limited time while the aircraft still flies safely. It sets how long each item may wait for repair.",
  },
  overdue: {
    term: "Overdue",
    definition:
      "Maintenance has passed its limit. An overdue [inspection](inspection), part limit or [AD](ad) makes the aircraft [grounded](grounded).",
  },
  overhaul: {
    term: "Overhaul",
    definition:
      "Taking a part such as an engine apart, inspecting and repairing it, and putting it back together to a like-new standard.",
  },
  owner: {
    term: "Owner",
    definition:
      "The aircraft's owner, who sees the [owner portal](owner-portal) only: its status and the maintenance coming due.",
  },
  "owner-portal": {
    term: "Owner portal",
    definition:
      "A read-only page for an aircraft's owner showing its status and the maintenance coming due.",
  },
  "pending-entry": {
    term: "Pending entry",
    definition:
      "A flight or problem report saved on this device without a connection. It is sent automatically once the device is back online.",
  },
  "permission-group": {
    term: "Permission group",
    definition:
      "A named set of things people may do, such as log flights or sign off maintenance, on some or all aircraft of a [Flight Program](flight-program).",
  },
  pilot: {
    term: "Pilot",
    definition:
      "A person who flies the aircraft. Pilots log flights and report problems; they see the screens they need for flying.",
  },
  placard: {
    term: "Placard",
    definition:
      'A label placed in the aircraft, such as "INOP", to show that a piece of equipment is out of service.',
  },
  "records-package": {
    term: "Records package",
    definition:
      "A download of everything Angel One holds for one aircraft, for an FAA inspector, a buyer or an insurer.",
  },
  "return-to-service": {
    term: "Return to service",
    definition:
      "The signed statement that an aircraft is fit to fly again after maintenance.",
  },
  sb: {
    term: "SB",
    longForm: "Service bulletin",
    definition:
      "A recommendation from the aircraft or part maker to inspect or improve something. Unlike an [AD](ad), it is usually not mandatory.",
  },
  signoff: {
    term: "Signoff",
    definition:
      "A named person's record that they completed or checked a required step of maintenance work.",
  },
  "status-record": {
    term: "Status record",
    definition:
      "One of the six permanent records the [FAA](faa) requires for each aircraft, such as its total time, inspection status and [AD](ad) status. They pass to the next owner with the aircraft.",
  },
  tach: {
    term: "Tach",
    longForm: "Tachometer time",
    definition:
      "Engine time counted by the tachometer. It runs slower than the [Hobbs](hobbs) at low power, so the two meters show different hours.",
  },
  "task-card": {
    term: "Job card",
    definition:
      "The step-by-step card for one maintenance job, where the mechanic records findings, parts used and signoffs.",
  },
  "total-time": {
    term: "Total time",
    definition:
      "All the hours an aircraft has flown since it was built, taken from its [Hobbs](hobbs) or [tach](tach) meter plus any earlier hours.",
  },
  tsn: {
    term: "TSN",
    longForm: "Time since new",
    definition: "The hours a part has run since it was made.",
  },
  tso: {
    term: "TSO",
    longForm: "Time since overhaul",
    definition:
      "The hours a part, usually an engine or propeller, has run since its last [overhaul](overhaul). Elsewhere TSO can also mean an FAA parts standard (Technical Standard Order); in Angel One it always means time since overhaul.",
  },
  tsr: {
    term: "TSR",
    longForm: "Time since repair",
    definition: "The hours a part has run since it was last repaired.",
  },
  vfr: {
    term: "VFR",
    longForm: "Visual flight rules",
    definition:
      "Flying by looking outside, in weather clear enough to see the ground and other aircraft.",
  },
  "work-order": {
    term: "Work order",
    definition:
      "A numbered list of maintenance work to be done on one aircraft, from opening to [close-out](close-out).",
  },
} as const satisfies Record<string, EntryText>;

/** The id of a glossary entry; a term tip takes one. */
export type TermId = keyof typeof ENTRIES;

/** One glossary entry. */
export type GlossaryEntry = EntryText & { id: TermId };

/** A run of definition text, linked to another entry when `link` is set. */
export type DefinitionPart = { text: string; link?: TermId };

/** A letter heading on the Glossary page and its entries. */
export type LetterGroup = { letter: string; entries: GlossaryEntry[] };

/** Every entry, A to Z by term (numbers first). */
export const GLOSSARY: readonly GlossaryEntry[] = (
  Object.entries(ENTRIES) as [TermId, EntryText][]
)
  .map(([id, entry]) => ({ id, ...entry }))
  .sort((a, b) => compareTerms(a.term, b.term));

/**
 * The entry for a term tip or link.
 *
 * @param id - A term id; the type allows only ids that exist.
 * @returns The entry.
 */
export function glossaryEntry(id: TermId): GlossaryEntry {
  return { id, ...ENTRIES[id] };
}

/**
 * The element id of an entry on the Glossary page, so a link can open the
 * page at that term.
 *
 * @param id - The term id.
 * @returns "term-" followed by the id, such as "term-mel".
 */
export function glossaryAnchor(id: TermId): string {
  return ANCHOR_PREFIX + id;
}

/**
 * The term an element id or address hash names, the reverse of
 * {@link glossaryAnchor}.
 *
 * @param anchor - Such as "term-mel", without the "#".
 * @returns The term id, or undefined for any other text or an unknown term.
 */
export function termFromAnchor(anchor: string): TermId | undefined {
  if (!anchor.startsWith(ANCHOR_PREFIX)) return undefined;
  const id = anchor.slice(ANCHOR_PREFIX.length);
  return isTermId(id) ? id : undefined;
}

/**
 * Splits a definition into plain runs and links to other entries.
 *
 * @param definition - Text that may hold `[shown text](term-id)` links.
 * @returns The runs in order; a link to an unknown id stays plain text.
 */
export function definitionParts(definition: string): DefinitionPart[] {
  const parts: DefinitionPart[] = [];
  let rest = definition;
  for (let match = rest.match(LINK); match; match = rest.match(LINK)) {
    const [whole, text, id] = match;
    if (match.index) parts.push({ text: rest.slice(0, match.index) });
    parts.push(isTermId(id) ? { text, link: id } : { text });
    rest = rest.slice((match.index ?? 0) + whole.length);
  }
  if (rest) parts.push({ text: rest });
  return parts;
}

/**
 * A definition as plain text, for a term tip and for search.
 *
 * @param definition - Text that may hold links.
 * @returns The text with each link replaced by its shown text.
 */
export function plainDefinition(definition: string): string {
  return definitionParts(definition)
    .map((p) => p.text)
    .join("");
}

/**
 * The entries whose term, long form or definition contain the query.
 *
 * @param query - Typed text; case and surrounding spaces are ignored, and an
 *   empty query matches every entry.
 * @returns The matches, in glossary order.
 */
export function searchGlossary(query: string): GlossaryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...GLOSSARY];
  return GLOSSARY.filter((e) =>
    [e.term, e.longForm ?? "", plainDefinition(e.definition)].some((text) =>
      text.toLowerCase().includes(q),
    ),
  );
}

/**
 * Groups entries under their first letter for the A to Z list.
 *
 * @param entries - Entries in glossary order.
 * @returns One group per letter present, in order; terms that start with a
 *   digit group under "#", first.
 */
export function groupByLetter(entries: readonly GlossaryEntry[]) {
  const groups: LetterGroup[] = [];
  for (const entry of entries) {
    const letter = letterOf(entry.term);
    const last = groups.at(-1);
    if (last?.letter === letter) last.entries.push(entry);
    else groups.push({ letter, entries: [entry] });
  }
  return groups;
}

const ANCHOR_PREFIX = "term-";
// Not global: String.match with a g-flag regex would drop the capture groups.
const LINK = /\[([^\]]+)\]\(([a-z0-9-]+)\)/;

function isTermId(id: string): id is TermId {
  return Object.hasOwn(ENTRIES, id);
}

function letterOf(term: string) {
  const first = term[0].toUpperCase();
  return /[A-Z]/.test(first) ? first : "#";
}

// Numbers before letters, then alphabetical ignoring case.
function compareTerms(a: string, b: string) {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}
