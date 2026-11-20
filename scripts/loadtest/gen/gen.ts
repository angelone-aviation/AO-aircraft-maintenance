/**
 * Responsibility: Generates the size test's records history: one 20-year
 *   timeline per aircraft, written as per-table JSONL import files shaped
 *   exactly as the app stores rows (zod-parsed, encoded by convex/collections).
 * Layer: Script. Load test only; bundled and run by gen/run.sh. It writes
 *   local files and calls no backend.
 * Dependencies: src/domain (airworthiness, costs, management, purchaseOrders,
 *   partsRequests, flightPlans, taskCards, workOrders), convex/collections,
 *   node:crypto, node:fs.
 *
 * Under $LOADTEST_DIR/data: fixed/<table>.jsonl (loaded once), yNN/<table>
 * .jsonl (one year of history, y01 newest), yNN/airworthiness.full.jsonl
 * (the whole AD table as of yNN loaded), state.json (each aircraft's end
 * state and where a held flight fits per slice) and counts.json. Ids and
 * choices come from hashes of fixed seeds; only the end time moves with now.
 */
import { createHash } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { adSchema } from "../../../src/domain/airworthiness";
import { costRecordSchema } from "../../../src/domain/costs";
import {
  inspectionSchema,
  recordSchema,
} from "../../../src/domain/management";
import { poSchema } from "../../../src/domain/purchaseOrders";
import { partsRequestSchema } from "../../../src/domain/partsRequests";
import { flightPlanSchema } from "../../../src/domain/flightPlans";
import {
  taskCardDefaults,
  taskCardSchema,
} from "../../../src/domain/taskCards";
import { workOrderSchema } from "../../../src/domain/workOrders";
import { encode, flightColumns } from "../../../convex/collections";

interface Person {
  id: string;
  name: string;
  role: string;
}
interface Plane {
  uuid: string;
  registration: string;
  make: string;
  model: string;
  serial: string;
  start: { hobbs: number; tach: number; cycles: number; landings: number };
}
interface Accounts {
  programUuid: string;
  users: Person[];
  aircraft: Plane[];
}
interface Profile {
  yearsGenerated: number;
  perAircraftPerYear: Record<
    | "flights"
    | "workOrders"
    | "jobCardsPerWorkOrder"
    | "partsRequests"
    | "purchaseOrders"
    | "componentMovements"
    | "recurringAdCompliances",
    number
  >;
  fixedPerAircraft: { components: number; inspections: number; ads: number };
  fixedPerProgram: { stockRecords: number; locations: number; vendors: number };
}
interface FlightPoint {
  t: number;
  hobbsOn: number;
  tachOn: number;
  cycles: number;
  landings: number;
  uuid: string;
}
interface Leg {
  plane: Plane;
  i: number;
  point: FlightPoint;
  hobbsOff: number;
  durationSeconds: number;
  landings: number;
  tachOffset: number;
  pilot: Person;
  submittedAt: number;
  planUuid: string;
  origin: string;
  destination: string;
  squawk: string;
}
interface Order {
  plane: Plane;
  index: number;
  w: number;
  uuid: string;
  opened: number;
  closed: number;
  isOpen: boolean;
  year: number;
}
interface AdEvent {
  at: number;
  ad: number;
  wo: string;
}
interface AuditFields {
  aircraftUuid?: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}
type Task = ReturnType<typeof buildTasks>[number];
type StockItem = (typeof STOCK)[number];

const DATA_DIR = readDataDir();
const accounts = readJsonFile<Accounts>(`${DATA_DIR}/accounts.json`);
const profile = readJsonFile<Profile>(`${DATA_DIR}/profile.json`);
const RATE = profile.perAircraftPerYear;
const YEARS = profile.yearsGenerated;
const PROGRAM = accounts.programUuid;
const HOUR = 3600;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
// The newest generated flight is at least 30 hours old, so a real flight
// recorded "now" is later than every stored one.
const END = roundToMinute(Date.now() - 30 * HOUR_MS);
// Fixed records predate the history.
const FIX = END - YEARS * YEAR - 10 * DAY;
// Aircraft and record kinds are staggered so no two share a start minute.
const FLIGHT_STAGGER_MS = 37 * MINUTE_MS;
const SPREAD_STAGGER_MS = 90 * MINUTE_MS;
// Flights last 0.8 to 2.0 hours, to the tenth; a fifth land twice.
const MIN_FLIGHT_HOURS = 0.8;
const FLIGHT_HOURS_RANGE = 1.2;
const TENTH_HOUR_SECONDS = 360;
const TWO_LANDING_SHARE = 0.2;
// Every Nth flight carries each feature.
const EVERY = { squawk: 10, plan: 5, copilot: 7, ifr: 4, remark: 3, oil: 6 };
// The newest three problem reports per aircraft stay open.
const OPEN_REPORT_FLIGHTS = 30;
// ADs 0 to 4 recur; the rest were complied with at manufacture.
const RECURRING_ADS = 5;
// A held flight fits just after each slice's 6th flight.
const HELD_SLOT_FLIGHT = 5;

const NF = RATE.flights * YEARS;
const STEP = YEAR / RATE.flights;
const PILOTS = ["pilot", "pilot2", "pilot3"].map(user);
const MECH = user("mechanic");
const INSPECTOR = user("mechanic2");

const streams = new Map<string, ReturnType<typeof createWriteStream>>();
const counts: Record<string, Record<string, number>> = {};
const bytes: Record<string, Record<string, number>> = {};
const state: { end: number; aircraft: Record<string, unknown> } = {
  end: END,
  aircraft: {},
};

const AIRPORTS = ["KCHA", "KAVL", "KTYS", "KMEM", "KBNA", "KHSV", "KATL", "KGSP", "KCLT", "KLEX", "KSDF", "KBHM"];
const SQUAWKS = [
  "Left landing light flickers on taxi.",
  "Pilot seat rail latch stiff; needs two attempts to lock.",
  "Right fuel cap gasket worn; cap does not seal fully.",
  "Cabin reading light inoperative at seat 3.",
  "Nose gear shimmy noted on rollout above 40 knots.",
  "Standby attitude indicator slow to erect after start.",
  "Cargo door seal torn along lower edge, about 10 cm.",
  "COM 2 transmit weak and scratchy on 121.5.",
  "Oil streak on lower cowl aft of the breather line.",
  "Left main tire worn to wear indicators.",
];
const FIXES = [
  "Replaced lamp and cleaned socket contacts. Ops check good.",
  "Cleaned and lubricated seat rail and latch pin IAW the maintenance manual. Latch engages positively at all detents.",
  "Replaced gasket. Cap seals; no leaks found on run-up.",
  "Replaced tire and tube, balanced wheel, torqued axle nut and safetied. Leak check good.",
  "Re-terminated antenna coax connector and bonded ground. Radio check loud and clear.",
  "Serviced shimmy damper and replaced torque link bushings. Taxi check satisfactory.",
];
const JOBS: [string, string, string[]][] = [
  ["Engine compartment inspection", "Inspect engine compartment for leaks, chafing, security and condition of all lines, hoses, baffles and wiring.", ["Remove upper and lower cowlings and inspect for cracks and missing fasteners.", "Inspect fuel, oil and bleed lines for leaks, chafing and security.", "Inspect engine mounts and mount bolts for cracks and corrosion.", "Inspect exhaust stubs and attaching hardware for cracks.", "Reinstall cowlings and verify fastener security."]],
  ["Oil and filter service", "Drain engine oil, replace oil filter, inspect filter element for metal, and refill with approved oil.", ["Drain oil and take spectrometric oil sample.", "Remove, cut open and inspect oil filter element for contamination.", "Install new filter, torque and safety wire.", "Refill with approved oil to the correct level and leak check on ground run."]],
  ["Propeller inspection", "Inspect propeller blades, spinner and hub for nicks, cracks, leaks and security.", ["Remove spinner and inspect bulkhead for cracks.", "Inspect blades for nicks, erosion and leading-edge damage; dress as required.", "Check hub for grease or oil leakage.", "Reinstall spinner and check track."]],
  ["Landing gear inspection", "Inspect main and nose landing gear, wheels, tires and brakes for wear, leaks and security.", ["Jack aircraft and inspect gear attach fittings.", "Inspect tires for wear and correct inflation.", "Measure brake lining thickness and record.", "Inspect brake lines for leaks and chafing.", "Lubricate gear pivot points IAW the lubrication chart."]],
  ["Flight control rigging check", "Check flight control cables, pulleys, bellcranks and travel limits.", ["Inspect cables for fraying and correct tension; record tension.", "Inspect pulleys and guards for wear and security.", "Check control surface travel against the type certificate data sheet.", "Check trim system operation and indicator agreement."]],
  ["Fuel system inspection", "Inspect fuel tanks, vents, drains, selector and filters.", ["Drain sumps and check for water and contamination.", "Inspect and clean fuel strainer and filter.", "Inspect tank vents for obstruction.", "Check fuel selector for freedom of movement and detent engagement."]],
  ["Avionics and electrical check", "Inspect battery, wiring, circuit protection and antennas; functional check of avionics.", ["Inspect battery for electrolyte level, corrosion and security; record voltage.", "Inspect wiring bundles for chafing and security.", "Functional check of COM, NAV, transponder and ELT.", "Inspect antennas and static wicks for condition."]],
  ["Cabin and emergency equipment", "Inspect seats, belts, doors, windows, placards and emergency equipment.", ["Inspect seats, rails and stops for cracks and security.", "Inspect seat belts and harnesses for fraying and latch operation.", "Check fire extinguisher weight and inspection date.", "Verify required placards are installed and legible."]],
];
const REFS = ["Maintenance manual chapter 5-10-01", "Maintenance manual chapter 12-10-00", "Maintenance manual chapter 32-40-00", "AC 43.13-1B chapter 7", "Maintenance manual chapter 61-10-00", "Maintenance manual chapter 27-00-00"];

const LOC = Array.from({ length: profile.fixedPerProgram.locations }, (_, i) => uuid(`loc:${i}`));
const VENDORS = Array.from({ length: profile.fixedPerProgram.vendors }, (_, i) => `Example Aviation Supply ${i + 1}`);
const STOCK = Array.from({ length: profile.fixedPerProgram.stockRecords }, (_, i) => ({
  uuid: uuid(`stock:${i}`),
  partNumber: `LT-${String(4000 + i)}-${(i % 7) + 1}`,
  description: pick(`sd:${i}`, ["Oil filter", "Spark igniter", "Brake lining", "O-ring", "Fuel filter element", "Tire 6.00-6", "Landing light lamp", "Seal kit", "Hose assembly", "Safety wire .032"]),
  locationUuid: LOC[i % LOC.length],
}));

writeProgramRecords();
for (const [index, plane] of accounts.aircraft.entries()) generateAircraft(index, plane);
await Promise.all([...streams.values()].map((s) => new Promise((done) => s.end(done))));
writeFileSync(`${DATA_DIR}/data/state.json`, JSON.stringify(state, null, 1));
writeFileSync(`${DATA_DIR}/data/counts.json`, JSON.stringify({ counts, bytes }, null, 1));
const total = (o: Record<string, number>) => Object.values(o).reduce((x, y) => x + y, 0);
for (const folder of Object.keys(counts).sort())
  console.log(folder, "rows", total(counts[folder]), "MB", (total(bytes[folder]) / 1e6).toFixed(1), JSON.stringify(counts[folder]));

function readDataDir(): string {
  const folder = process.env.LOADTEST_DIR;
  if (!folder) throw new Error("Set LOADTEST_DIR to the folder for the load test's data and results.");
  return folder;
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function user(role: string): Person {
  const found = accounts.users.find((u) => u.role === role);
  if (!found) throw new Error(`accounts.json has no ${role}; run seed.mjs first.`);
  return found;
}

function hash(seed: string) {
  return createHash("sha256").update(seed).digest();
}

// A version 4 UUID (RFC 9562 version and variant bits) from a seed.
function uuid(seed: string) {
  const b = hash(seed);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Deterministic 0..1 from a seed string.
function rnd(seed: string) {
  return hash(seed).readUInt32BE(0) / 2 ** 32;
}

function pick<T>(seed: string, list: T[]): T {
  return list[Math.floor(rnd(seed) * list.length)];
}

function iso(ms: number) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function date(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function yy(k: number) {
  return "y" + String(k).padStart(2, "0");
}

function roundToMinute(ms: number) {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

function sliceOf(ms: number) {
  return Math.min(YEARS, Math.max(1, Math.floor((END - ms) / YEAR) + 1));
}

function out(folder: string, table: string, at: number, doc: object) {
  const key = `${folder}/${table}`;
  let stream = streams.get(key);
  if (!stream) {
    mkdirSync(`${DATA_DIR}/data/${folder}`, { recursive: true });
    stream = createWriteStream(`${DATA_DIR}/data/${key}.jsonl`);
    streams.set(key, stream);
  }
  const line = JSON.stringify({ _creationTime: at, ...doc });
  stream.write(line + "\n");
  (counts[folder] ??= {})[table] = (counts[folder][table] ?? 0) + 1;
  (bytes[folder] ??= {})[table] = (bytes[folder][table] ?? 0) + line.length;
}

// One change-log row per write the app would have made, shaped like its own.
function audit(at: number, actorId: string, action: string, entityUuid: string, f: AuditFields = {}) {
  out(yy(sliceOf(at)), "audit", at, {
    uuid: uuid(`audit:${action}:${entityUuid}:${at}`),
    actorId,
    at,
    action,
    entityUuid,
    programUuid: PROGRAM,
    ...(f.aircraftUuid ? { aircraftUuid: f.aircraftUuid } : {}),
    ...(f.reason ? { reason: f.reason } : {}),
    ...(f.before === undefined ? {} : { before: JSON.stringify(f.before) }),
    ...(f.after === undefined ? {} : { after: JSON.stringify(f.after) }),
  });
}

function managed(folder: string, at: number, raw: unknown) {
  const record = recordSchema.parse(raw);
  out(folder, "management", at, encode("management", record));
  return record;
}

function writeProgramRecords() {
  LOC.forEach((id, i) =>
    managed("fixed", FIX, { uuid: id, version: 1, programUuid: PROGRAM, kind: "location", name: `Stores bay ${i + 1}`, address: `Hangar 4, bay ${i + 1}, Test Field`, contact: "stores@example.test" }),
  );
  VENDORS.forEach((name, i) =>
    managed("fixed", FIX, { uuid: uuid(`vendor:${i}`), version: 1, programUuid: PROGRAM, kind: "vendor", name, website: `https://supply${i + 1}.example.test`, accountNumber: `LT-ACCT-${1000 + i}`, paymentTerms: "Net 30", notes: "" }),
  );
  STOCK.forEach((s, i) =>
    managed("fixed", FIX, { version: 1 + (i % 9), kind: "stock", alternates: "", condition: "new", minimum: 2, ...s, programUuid: PROGRAM, category: i % 4 === 0 ? "supply" : "part", quantity: 2 + (i % 11), vendor: VENDORS[i % VENDORS.length], invoiceNumber: `INV-${88000 + i}`, cost: 12.5 + (i % 40) * 3 }),
  );
  out("fixed", "costs", FIX, encode("costs", costRecordSchema.parse({ version: 1, uuid: uuid("cost:settings"), programUuid: PROGRAM, kind: "settings", laborRateCents: 9500 })));
}

function generateAircraft(index: number, plane: Plane) {
  const points = generateFlights(index, plane);
  const inspections = writeInspections(plane, points[NF - 1]);
  const components = writeComponents(index, plane);
  const adEvents = generateWorkOrders(index, plane, points, inspections);
  spread(index, RATE.partsRequests, (n, t) => writePartsRequest(index, plane, n, t));
  spread(index, RATE.purchaseOrders, (n, t) => writePurchaseOrder(index, plane, n, t));
  spread(index, RATE.componentMovements, (n, t) => writeMovement(plane, components, n, t));
  for (let k = 1; k <= YEARS; k++) writeAdTable(plane, points, adEvents, k);
  for (const e of adEvents)
    audit(e.at, MECH.id, "ad.comply", uuid(`ad:${plane.uuid}:${e.ad}`), { aircraftUuid: plane.uuid, reason: "Recurring inspection complied with.", after: { date: date(e.at), workOrderUuid: e.wo, mechanic: MECH.name } });
  state.aircraft[plane.uuid] = endState(plane, points);
}

// The timeline of flights, oldest first.
function generateFlights(index: number, plane: Plane): FlightPoint[] {
  const A = plane.uuid;
  const tachOffset = plane.start.hobbs - plane.start.tach;
  const points: FlightPoint[] = [];
  let hobbs = plane.start.hobbs;
  let cycles = plane.start.cycles;
  let landings = plane.start.landings;
  for (let i = 0; i < NF; i++) {
    const t = END - (NF - 1 - i) * STEP - index * FLIGHT_STAGGER_MS;
    const durationSeconds = Math.round((MIN_FLIGHT_HOURS + rnd(`dur:${A}:${i}`) * FLIGHT_HOURS_RANGE) * 10) * TENTH_HOUR_SECONDS;
    const land = rnd(`land:${A}:${i}`) < TWO_LANDING_SHARE ? 2 : 1;
    const hobbsOff = hobbs;
    hobbs += durationSeconds;
    cycles += 1;
    landings += land;
    const point = { t: roundToMinute(t), hobbsOn: hobbs, tachOn: hobbs - tachOffset, cycles, landings, uuid: uuid(`flight:${A}:${i}`) };
    points.push(point);
    writeLeg(planLeg(plane, i, point, { hobbsOff, durationSeconds, landings: land, tachOffset }));
  }
  return points;
}

function planLeg(plane: Plane, i: number, point: FlightPoint, meters: Pick<Leg, "hobbsOff" | "durationSeconds" | "landings" | "tachOffset">): Leg {
  return {
    plane, i, point, ...meters,
    pilot: PILOTS[i % PILOTS.length],
    submittedAt: point.t + meters.durationSeconds * 1000 + 20 * MINUTE_MS,
    planUuid: uuid(`plan:${plane.uuid}:${i}`),
    origin: AIRPORTS[i % AIRPORTS.length],
    destination: AIRPORTS[(i + 1 + (i % 3)) % AIRPORTS.length],
    squawk: i % EVERY.squawk === 3 ? pick(`sq:${plane.uuid}:${i}`, SQUAWKS) : "",
  };
}

function writeLeg(leg: Leg) {
  const flight = buildFlight(leg);
  out(yy(sliceOf(leg.point.t)), "flights", leg.submittedAt, { ...flight, ...flightColumns(flight) });
  audit(leg.submittedAt, leg.pilot.id, "flight.created", leg.point.uuid, { aircraftUuid: leg.plane.uuid, after: flight });
  if (leg.i % EVERY.plan === 0) writeFlightPlan(leg);
  if (leg.squawk) writeProblemReport(leg);
}

function buildFlight(leg: Leg) {
  const { plane, i, point, hobbsOff, tachOffset, pilot } = leg;
  return {
    uuid: point.uuid, aircraftUuid: plane.uuid, authorId: pilot.id, pilotId: pilot.id,
    ...(i % EVERY.copilot === 0 ? { copilotId: PILOTS[(i + 1) % PILOTS.length].id } : {}),
    ...(i % EVERY.plan === 0 ? { flightPlanUuid: leg.planUuid } : {}),
    startTime: iso(point.t), submittedAt: leg.submittedAt, status: "accepted",
    hobbsOff, hobbsOn: point.hobbsOn, tachOff: hobbsOff - tachOffset, tachOn: point.hobbsOn - tachOffset,
    landings: leg.landings, cycles: 1, origin: leg.origin, destination: leg.destination,
    operation: pick(`op:${plane.uuid}:${i}`, ["Mission", "Mission medical", "Mission", "Private", "Gov medical"]),
    flightRules: i % EVERY.ifr === 0 ? "IFR" : "VFR",
    remarks: i % EVERY.remark === 0 ? "Patient transfer with one attendant. Fuel topped off on arrival." : "",
    discrepancy: leg.squawk,
    fuel: { unit: "lb", start: 1800, added: i % 2 ? 600 : 0, end: 1100 },
    oil: [{ engine: "single", unit: "US qt", start: 12, added: i % EVERY.oil === 0 ? 1 : 0 }],
  };
}

function icaoType(model: string) {
  if (model.startsWith("208")) return "C208";
  return model.startsWith("206") ? "C206" : "KODI";
}

function writeFlightPlan(leg: Leg) {
  const { plane, i, point } = leg;
  const plan = flightPlanSchema.parse({
    uuid: leg.planUuid, version: 1, aircraftUuid: plane.uuid, registration: plane.registration,
    departureAt: iso(point.t), origin: leg.origin, destination: leg.destination, alternate: AIRPORTS[(i + 5) % AIRPORTS.length],
    durationMinutes: Math.round(leg.durationSeconds / 60), cycles: 1, landings: leg.landings, flightRules: i % EVERY.ifr === 0 ? "I" : "V",
    aircraftType: icaoType(plane.model),
    flightType: "G", speed: "N0160", level: "A080", route: "DCT", enduranceMinutes: 300, personsOnBoard: 4,
    pilotText: leg.pilot.name, equipment: "SDFGR/S", otherInformation: "RMK/MEDEVAC", sourceName: "",
    sourceHash: hash(`plan:${leg.planUuid}`).toString("hex"), status: "proposed", createdAt: point.t - DAY,
  });
  out(yy(sliceOf(point.t)), "flightPlans", point.t - DAY, encode("flightPlans", plan));
}

function writeProblemReport(leg: Leg) {
  const { plane, i, point, submittedAt } = leg;
  const A = plane.uuid;
  const reportUuid = point.uuid + "-discrepancy";
  const report = { uuid: reportUuid, aircraftUuid: A, flightUuid: point.uuid, description: leg.squawk, status: "open", authorId: leg.pilot.id, createdAt: submittedAt };
  const open = i >= NF - OPEN_REPORT_FLIGHTS;
  const resolvedAt = submittedAt + 3 * DAY;
  const resolved = { ...report, status: "resolved", resolution: pick(`fix:${A}:${i}`, FIXES), resolvedBy: MECH.id, resolvedAt };
  out(yy(sliceOf(point.t)), "discrepancies", submittedAt, open ? report : resolved);
  audit(submittedAt, leg.pilot.id, "discrepancy.created", reportUuid, { aircraftUuid: A, after: report });
  if (!open) audit(resolvedAt, MECH.id, "discrepancy.resolved", reportUuid, { aircraftUuid: A, before: report, after: resolved });
}

// The flight point in effect at a time, clamped to the timeline.
function pointAt(points: FlightPoint[], ms: number) {
  return points[Math.max(0, Math.min(NF - 1, Math.floor((ms - points[0].t) / STEP)))];
}

// Current state only: the app keeps one row per requirement.
function writeInspections(plane: Plane, last: FlightPoint) {
  const ids = Array.from({ length: profile.fixedPerAircraft.inspections }, (_, i) => uuid(`insp:${plane.uuid}:${i}`));
  ids.forEach((id, i) => {
    const hourly = i % 2 === 0;
    const interval = [100, 200, 400, 800][i % 4] * HOUR;
    const doc = inspectionSchema.parse({
      version: 2 + (i % 5), materials: "", archived: false, uuid: id, programUuid: PROGRAM, aircraftUuid: plane.uuid,
      reference: hourly ? `${interval / HOUR}-hour inspection item ${i + 1}` : `Calendar inspection item ${i + 1}`,
      description: pick(`insd:${i}`, JOBS)[1],
      ...(hourly
        ? { intervalSeconds: interval, lastSeconds: last.hobbsOn - 20 * HOUR, lastDate: date(END - 12 * DAY), dueSeconds: last.hobbsOn - 20 * HOUR + interval }
        : { intervalMonths: 12, lastDate: date(END - 90 * DAY), dueDate: date(END + 270 * DAY) }),
    });
    out("fixed", "inspections", FIX, doc);
  });
  return ids;
}

// Every fifth component carries a life limit.
function writeComponents(index: number, plane: Plane) {
  const A = plane.uuid;
  const ids = Array.from({ length: profile.fixedPerAircraft.components }, (_, i) => uuid(`comp:${A}:${i}`));
  ids.forEach((id, i) => {
    managed("fixed", FIX, {
      version: 1 + (i % 4), kind: "component", notes: "", trackCycles: false, trackCalendar: i % 3 === 0,
      installedCycles: 0, timeSinceRepair: null, cyclesSinceNew: 0, serviceDaysBase: 0,
      uuid: id, programUuid: PROGRAM, aircraftUuid: A,
      componentType: pick(`ct:${i}`, ["Engine", "Propeller", "Starter generator", "Fuel control unit", "ELT battery", "Fire extinguisher", "Magneto", "Vacuum pump", "Fuel nozzle", "Oil cooler"]),
      manufacturer: pick(`cm:${i}`, ["Pratt & Whitney Canada", "Hartzell", "McCauley", "Artex", "Slick", "Parker"]),
      model: `M-${100 + i}`, partNumber: `PN-${3000 + i}`, serial: `SN-${index + 1}${String(i).padStart(4, "0")}`,
      trackTime: i % 3 !== 0, installed: true, installedDate: date(FIX), installPosition: i === 0 ? "MAIN" : undefined,
      installedSeconds: plane.start.hobbs, timeSinceNew: (300 + i * 7) * HOUR, timeSinceOverhaul: i % 5 === 0 ? 0 : null,
    });
    if (i % 5 === 0) writeLifeLimit(A, id, i);
  });
  return ids;
}

function writeLifeLimit(aircraftUuid: string, componentUuid: string, i: number) {
  managed("fixed", FIX, {
    version: 1, kind: "componentRequirement", notes: "", calendarIntervalUnit: "MONTHS", timeBasis: "TSN", timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE", warningCalendarMonths: 1, warningSeconds: 25 * HOUR, warningCycles: 10,
    uuid: uuid(`req:${aircraftUuid}:${i}`), programUuid: PROGRAM, componentUuid, aircraftUuid,
    requirementType: "Life Limits", description: "Replace at life limit", dueDate: date(END + (200 + i * 9) * DAY),
  });
}

// One work order every 365.25/12 days; the newest is still open.
function generateWorkOrders(index: number, plane: Plane, points: FlightPoint[], inspections: string[]) {
  const count = RATE.workOrders * YEARS;
  const spacing = YEAR / RATE.workOrders;
  const adEvents: AdEvent[] = [];
  for (let w = 0; w < count; w++) {
    const opened = roundToMinute(END - (count - 1 - w) * spacing - 6 * DAY - index * HOUR_MS);
    const order: Order = { plane, index, w, uuid: uuid(`wo:${plane.uuid}:${w}`), opened, closed: opened + 5 * DAY, isOpen: w === count - 1, year: new Date(opened).getUTCFullYear() };
    adEvents.push(...writeWorkOrder(order, points, inspections));
  }
  return adEvents;
}

function writeWorkOrder(order: Order, points: FlightPoint[], inspections: string[]): AdEvent[] {
  const { plane, w, uuid: W, opened, closed, isOpen } = order;
  const tasks = buildTasks(order, inspections);
  const { openOrder, working, done } = buildOrderStates(order, tasks, pointAt(points, opened), pointAt(points, closed));
  out(yy(sliceOf(opened)), "workOrders", opened, encode("workOrders", isOpen ? working : done));
  audit(opened, MECH.id, "workOrder.save", W, { aircraftUuid: plane.uuid, after: openOrder });
  audit(opened + DAY, MECH.id, "workOrder.save", W, { aircraftUuid: plane.uuid, before: openOrder, after: working });
  if (!isOpen) audit(closed, INSPECTOR.id, "workOrder.save", W, { aircraftUuid: plane.uuid, before: working, after: done });
  tasks.forEach((task, j) => writeJobCard(order, task, j));
  writeOrderCost(order);
  if (isOpen) return [];
  const perOrder = RATE.recurringAdCompliances / RATE.workOrders;
  const events: AdEvent[] = [];
  for (let n = 0; n < perOrder; n++) events.push({ at: closed, ad: (w + n * 3) % RECURRING_ADS, wo: W });
  return events;
}

function buildTasks(order: Order, inspections: string[]) {
  const { w, isOpen, uuid: W } = order;
  return Array.from({ length: RATE.jobCardsPerWorkOrder }, (_, j) => {
    const [title] = JOBS[(w + j) % JOBS.length];
    const task = uuid(`task:${W}:${j}`);
    // Manual work is keyed by its own task, as the work order screen keys it:
    // a save refuses two tasks with the same source.
    return {
      uuid: task,
      source: j === 0 ? { kind: "inspection" as const, uuid: inspections[(w * 2) % inspections.length] } : { kind: "manual" as const, uuid: task },
      description: j === 0 ? "100-hour inspection" : title,
      status: isOpen ? openTaskStatus(j) : "completed",
      notes: j % 4 === 0 ? "No defects beyond those recorded on the job card." : "",
      partsDelay: "", includeInLogbook: true, logbookPhrase: j % 3 === 0 ? "Inspected" : "Performed",
      maintenanceReference: REFS[(w + j) % REFS.length],
    };
  });
}

// The open order is part way through: 6 tasks done, 4 under way, the rest
// waiting.
function openTaskStatus(j: number) {
  if (j < 6) return "completed";
  return j < 10 ? "in-progress" : "requested";
}

function reading(plane: Plane, p: FlightPoint) {
  return { registration: plane.registration, make: plane.make, model: plane.model, serial: plane.serial, totalSeconds: p.hobbsOn, hobbs: p.hobbsOn, tach: p.tachOn, cycles: p.cycles, landings: p.landings };
}

function buildOrderStates(order: Order, tasks: Task[], o: FlightPoint, c: FlightPoint) {
  const { plane, index, w, uuid: W, opened, closed, year } = order;
  const base = {
    uuid: W, number: `WO-${year}-${String(index + 1)}${String(w % 1000).padStart(3, "0")}`, aircraftUuid: plane.uuid, dateOpened: date(opened), supervisor: MECH.name,
    scope: "100-hour inspection, routine servicing and rectification of reported discrepancies.",
    priority: w % 9 === 0 ? "high" : "routine", recordedAt: opened, createdBy: MECH.id,
    aircraft: { ...reading(plane, o), meter: "hobbs" as const }, componentReadings: [],
  };
  const openOrder = workOrderSchema.parse({ ...base, version: 1, status: "open", completionDate: "", releaseOutcome: "", tasks: tasks.map((t) => ({ ...t, status: "requested", notes: "" })) });
  const working = workOrderSchema.parse({ ...openOrder, version: 4, status: "in-progress", tasks });
  const done = workOrderSchema.parse({
    ...working, version: 6, status: "completed", completionDate: date(closed),
    releaseOutcome: "Aircraft approved for return to service.",
    closeout: {
      recordedAt: closed,
      aircraft: reading(plane, c),
      completedBy: { userId: INSPECTOR.id, name: INSPECTOR.name, licenseNumber: "LT-CERT-9876543", certificateType: "IA" },
      workPerformed: tasks.map((t, j) => `Task #${j + 1} ${t.description}: ${t.logbookPhrase.toLowerCase()} IAW ${t.maintenanceReference}.`).join("\n"),
      performers: [{ userId: MECH.id, name: MECH.name }],
      components: [],
      compliance: [{ uuid: tasks[0].source.uuid, kind: "inspection", description: "100-hour inspection", date: date(closed), seconds: c.hobbsOn, dueSeconds: c.hobbsOn + 100 * HOUR }],
    },
  });
  return { openOrder, working, done };
}

// Job cards, as the app leaves them once the order is closed.
function writeJobCard(order: Order, task: Task, j: number) {
  const { plane, w, uuid: W, opened, closed, year } = order;
  const cardUuid = uuid(`card:${W}:${j}`);
  const draft = buildDraftCard(order, task, j, cardUuid);
  const signedAt = closed - DAY + j * 10 * MINUTE_MS;
  const [, description] = JOBS[(w + j) % JOBS.length];
  const stock = STOCK[(w + j) % STOCK.length];
  const worked = taskCardSchema.parse({
    ...draft, version: 3, updatedAt: signedAt, status: "completed", completionDate: date(signedAt),
    steps: draft.steps.map((s) => ({ ...s, result: "Satisfactory; no defects found.", measurement: s.measurementRequired ? 4.1 : null })),
    findings: j % 5 === 2 ? "Minor chafing on wiring bundle at firewall grommet." : "",
    actualWork: `${description} Completed IAW ${task.maintenanceReference}. ${j % 5 === 2 ? "Re-secured bundle and installed anti-chafe sleeve." : "No discrepancies noted."}`,
    actualLabor: 1.5 + (j % 4) * 0.5,
    partsUsed: j % 4 === 1 ? [{ uuid: uuid(`part:${cardUuid}`), source: "stock", stockUuid: stock.uuid, locationUuid: stock.locationUuid, partNumber: stock.partNumber, description: stock.description, quantity: 1, serialLot: `LOT ${year}-${w}`, removedComponent: "", installedComponent: "" }] : [],
  });
  const signed = taskCardSchema.parse({
    ...worked, version: j === 0 ? 5 : 4, updatedAt: signedAt + MINUTE_MS,
    technicianSignoff: { userId: MECH.id, name: MECH.name, at: signedAt + MINUTE_MS },
    inspectionSignoff: j === 0 ? { userId: INSPECTOR.id, name: INSPECTOR.name, at: signedAt + HOUR_MS } : null,
  });
  const finished = task.status === "completed";
  out(yy(sliceOf(opened)), "taskCards", opened, encode("taskCards", finished ? signed : draft));
  audit(opened + MINUTE_MS, MECH.id, "taskCard.save", cardUuid, { aircraftUuid: plane.uuid, after: draft });
  if (!finished) return;
  audit(signedAt, MECH.id, "taskCard.save", cardUuid, { aircraftUuid: plane.uuid, before: draft, after: worked });
  audit(signedAt + MINUTE_MS, MECH.id, "taskCard.sign", cardUuid, { aircraftUuid: plane.uuid, before: worked, after: signed });
}

function buildDraftCard(order: Order, task: Task, j: number, cardUuid: string) {
  const { plane, index, w, uuid: W, opened, year } = order;
  const [title, description, steps] = JOBS[(w + j) % JOBS.length];
  const measured = (n: number) => n === 2 && j % 3 === 0;
  return taskCardSchema.parse({
    ...taskCardDefaults(plane.uuid), uuid: cardUuid, version: 1, createdBy: MECH.id, createdAt: opened, updatedAt: opened,
    cardNumber: `JC-${year}-${index + 1}${String(w % 1000).padStart(3, "0")}-${String(j + 1).padStart(2, "0")}`,
    title: j === 0 ? "100-hour inspection" : title, workOrderUuid: W, workTaskUuid: task.uuid,
    inspectionUuid: j === 0 ? task.source.uuid : "", description, includeInLogbook: true, logbookPhrase: task.logbookPhrase,
    maintenanceReference: task.maintenanceReference, referenceRevision: "Rev 32", referenceDate: "2019-07-01",
    applicability: `${plane.make} ${plane.model}`,
    steps: steps.map((instruction, n) => ({
      uuid: uuid(`step:${cardUuid}:${n}`), instruction, requiredResult: "No defects; within limits.", result: "",
      measurementRequired: measured(n), measurement: null, units: measured(n) ? "mm" : "",
      lowerLimit: measured(n) ? 2.5 : null, upperLimit: null, signoffRequired: false,
    })),
    assignedTechnician: MECH.name, estimatedLabor: 1.5 + (j % 4) * 0.5, requiredTools: "Standard hand tools, torque wrench, inspection mirror.",
    inspectionSignoffRequired: j === 0, status: "ready", technicianSignoff: null, inspectionSignoff: null, stepSignoffs: {},
  });
}

function writeOrderCost(order: Order) {
  const { plane, uuid: W, opened } = order;
  const cost = costRecordSchema.parse({
    version: 2, uuid: uuid(`cost:${W}`), programUuid: PROGRAM, kind: "workOrder", aircraftUuid: plane.uuid, workOrderUuid: W,
    labor: [
      { uuid: uuid(`labor:${W}:a`), date: date(opened + DAY), technician: MECH.name, minutes: 780, seconds: 13 * HOUR, rateCents: 9500, createdBy: MECH.id, createdAt: opened + DAY },
      { uuid: uuid(`labor:${W}:b`), date: date(opened + 4 * DAY), technician: INSPECTOR.name, minutes: 120, seconds: 2 * HOUR, rateCents: 11000, createdBy: INSPECTOR.id, createdAt: opened + 4 * DAY },
    ],
    other: [{ uuid: uuid(`other:${W}`), date: date(opened + 4 * DAY), description: "Shop supplies", amountCents: 4250, createdBy: MECH.id, createdAt: opened + 4 * DAY }],
    partUnitCosts: [],
  });
  out(yy(sliceOf(opened)), "costs", opened + DAY, encode("costs", cost));
  audit(opened + 4 * DAY, MECH.id, "cost.save", cost.uuid, { aircraftUuid: plane.uuid, after: cost });
}

// `perYear` records evenly spread over the timeline, oldest first.
function spread(index: number, perYear: number, each: (n: number, t: number) => void) {
  const count = perYear * YEARS;
  for (let n = 0; n < count; n++) each(n, roundToMinute(END - (count - n) * (YEAR / perYear) - index * SPREAD_STAGGER_MS));
}

// The newest two requests and orders per aircraft are still open.
function stillOpen(n: number, perYear: number) {
  return n >= perYear * YEARS - 2;
}

function writePartsRequest(index: number, plane: Plane, n: number, t: number) {
  const s: StockItem = STOCK[(n * 7 + index) % STOCK.length];
  const open = stillOpen(n, RATE.partsRequests);
  const R = uuid(`pr:${plane.uuid}:${n}`);
  const line = uuid(`pr-line:${plane.uuid}:${n}`);
  const quantity = 1 + (n % 3);
  const req = partsRequestSchema.parse({
    uuid: R, version: open ? 1 : 3, source: { kind: "stock", uuid: s.uuid, workOrderUuid: "" }, mode: "parts", date: date(t),
    engineer: MECH.name, base: "Test Field", priority: n % 11 === 0 ? "P1 AOG" : "P2 Routine", requiredBy: date(t + 7 * DAY),
    timeframe: "", vendor: VENDORS[n % VENDORS.length], vendorAddress: "1 Supply Road, Example City", currency: "USD",
    shipTo: "Hangar 4, Test Field", billTo: "Load test fleet, Hangar 4, Test Field", shipFrom: "", aircraftYear: "2006",
    notes: "", shippingInstructions: "Ground", returnInstructions: "",
    lines: [{ uuid: line, partNumber: s.partNumber, description: s.description, quantity, quotedCents: 2495 + (n % 40) * 100 }],
    programUuid: PROGRAM, aircraftUuid: plane.uuid, sourceLabel: s.partNumber, aircraftRegistration: plane.registration, aircraftSerial: plane.serial,
    aircraftModel: plane.model, number: `PR-${new Date(t).getUTCFullYear()}-${index + 1}${String(n % 10000).padStart(4, "0")}`,
    requesterId: MECH.id, createdAt: t, updatedAt: open ? t : t + 6 * DAY, cancelled: false, reservations: [],
    issues: open ? [] : [{ lineUuid: line, stockUuid: s.uuid, quantity, at: t + 6 * DAY, actorId: MECH.id }],
    history: [{ requestUuid: uuid(`prh:${R}:0`), at: t, actorId: MECH.id, action: "Created", detail: "" }, ...(open ? [] : [{ requestUuid: uuid(`prh:${R}:1`), at: t + 6 * DAY, actorId: MECH.id, action: "Issued", detail: `${quantity} × ${s.partNumber}` }])],
  });
  out(yy(sliceOf(t)), "partsRequests", t, encode("partsRequests", req));
  audit(t, MECH.id, "partsRequest.save", R, { aircraftUuid: plane.uuid, after: req });
  if (!open) audit(t + 6 * DAY, MECH.id, "partsRequest.issue", R, { aircraftUuid: plane.uuid, before: { version: 2 }, after: req });
}

function writePurchaseOrder(index: number, plane: Plane, n: number, t: number) {
  const s: StockItem = STOCK[(n * 11 + index) % STOCK.length];
  const open = stillOpen(n, RATE.purchaseOrders);
  const O = uuid(`po:${plane.uuid}:${n}`);
  const line = uuid(`po-line:${plane.uuid}:${n}`);
  const po = poSchema.parse({
    version: open ? 2 : 4, vendor: VENDORS[n % VENDORS.length], vendorContact: "orders@supply.example.test",
    shipTo: "Hangar 4, Test Field", currency: "USD", shippingCents: 1500, notes: "", revision: 0, shipments: [], history: [],
    uuid: O, programUuid: PROGRAM, number: `PO-${new Date(t).getUTCFullYear()}-${index + 1}${String(n % 10000).padStart(4, "0")}`,
    phase: open ? "issued" : "closed", expectedDate: date(t + 10 * DAY), createdAt: t, updatedAt: open ? t + DAY : t + 9 * DAY, issuedAt: t + DAY,
    lines: [{ uuid: line, stockUuid: s.uuid, locationUuid: s.locationUuid, partNumber: s.partNumber, description: s.description, quantity: 4, unitCents: 2495, kind: "part", aircraftUuid: plane.uuid }],
    receipts: open ? [] : [{ uuid: uuid(`receipt:${O}`), date: date(t + 9 * DAY), invoice: `INV-${90000 + n}`, notes: "", actorId: MECH.id, lines: [{ lineUuid: line, quantity: 4, condition: "new", itemUuids: [], serials: [] }] }],
  });
  out(yy(sliceOf(t)), "purchaseOrders", t, encode("purchaseOrders", po));
  audit(t, MECH.id, "po.save", O, { after: po });
  if (!open) audit(t + 9 * DAY, MECH.id, "po.receive", O, { before: { phase: "issued" }, after: po });
}

function writeMovement(plane: Plane, components: string[], n: number, t: number) {
  const movement = managed(yy(sliceOf(t)), t, {
    uuid: uuid(`move:${plane.uuid}:${n}`), version: 1, programUuid: PROGRAM, kind: "componentMovement", componentUuid: components[(n * 13) % components.length], aircraftUuid: plane.uuid,
    action: "BASELINE", date: date(t), timeSinceNew: (300 + n * 3) * HOUR, timeSinceOverhaul: null, timeSinceRepair: null,
    cycles: 0, serviceDays: 0, note: "Component times re-baselined from the logbook at inspection.", actorId: MECH.id, at: t,
  });
  audit(t, MECH.id, "component.baseline", movement.uuid, { aircraftUuid: plane.uuid, after: movement });
}

// ADs keep one row each, and a recurring AD's compliance history grows with
// time, so the whole table is written once per step ("as of yNN loaded").
function writeAdTable(plane: Plane, points: FlightPoint[], adEvents: AdEvent[], k: number) {
  for (let d = 0; d < profile.fixedPerAircraft.ads; d++)
    out(yy(k), "airworthiness.full", FIX, encode("airworthiness", buildAd(plane, points, adEvents, k, d)));
}

function adHistory(plane: Plane, points: FlightPoint[], adEvents: AdEvent[], k: number, d: number, task: string) {
  const from = END - k * YEAR;
  return adEvents.filter((e) => e.ad === d && e.at >= from).map((e, n) => ({
    uuid: uuid(`ad-comp:${plane.uuid}:${d}:${e.at}:${n}`), taskUuid: task, date: date(e.at), hours: Math.round(pointAt(points, e.at).hobbsOn / 360) / 10, cycles: null,
    method: "Visual and 10x magnifier inspection per the service bulletin; no cracks found.", serviceBulletin: `SB-LT-${50 + d}`,
    terminatedBy: "", workOrderUuid: e.wo, mechanic: MECH.name, certificate: "A&P LT-3456789", evidence: "", recordedAt: e.at, recordedBy: MECH.id,
  }));
}

function buildAd(plane: Plane, points: FlightPoint[], adEvents: AdEvent[], k: number, d: number) {
  const recurring = d < RECURRING_ADS;
  const task = uuid(`ad-task:${plane.uuid}:${d}`);
  const history = recurring ? adHistory(plane, points, adEvents, k, d, task) : [];
  return adSchema.parse({
    version: 2 + history.length, componentUuid: "", reason: recurring ? "" : "Complied with at manufacture per the aircraft records.",
    history, sourceHistory: [], reviewRequired: false, updatedAt: history.at(-1)?.recordedAt ?? FIX,
    uuid: uuid(`ad:${plane.uuid}:${d}`), programUuid: PROGRAM, aircraftUuid: plane.uuid,
    applicability: recurring ? "Applicable" : "Previously Complied With (PCW)",
    source: {
      amendment: "", issued: "", effective: "", supersededBy: "", url: "", source: "Load test entry (not an FAA directive)", section: "Airframe",
      make: plane.make, model: plane.model, sourceNotes: "", recurring: recurring ? "Yes" : "No",
      number: `20${10 + (d % 15)}-LT-${String(d + 1).padStart(2, "0")}`, subject: pick(`ads:${d}`, ["Horizontal stabilizer attach bracket inspection", "Seat rail and stop inspection", "Fuel quantity indication check", "Aileron control cable pulley inspection", "Engine mount truss inspection"]),
    },
    tasks: recurring
      ? [{ uuid: task, description: "Inspect for cracks; repeat every 100 hours.", dueDate: "", dueHours: Math.round(points[NF - 1].hobbsOn / HOUR) + 60 + d * 5, dueCycles: null, intervalDays: null, intervalHours: 100, intervalCycles: null, recurrence: "Recurring", workOrderUuid: "" }]
      : [],
  });
}

function endState(plane: Plane, points: FlightPoint[]) {
  const last = points[NF - 1];
  const slots: Record<string, unknown> = {};
  for (let k = 1; k <= YEARS; k++) {
    const p = points[points.findIndex((x) => sliceOf(x.t) === k) + HELD_SLOT_FLIGHT];
    slots[yy(k)] = { startTime: iso(p.t + 2 * HOUR_MS), hobbsOn: p.hobbsOn, tachOn: p.tachOn };
  }
  return {
    registration: plane.registration,
    final: { currentHobbs: last.hobbsOn, currentTach: last.tachOn, cycles: last.cycles, landings: last.landings, version: NF, latestFlightAt: iso(last.t) },
    slots,
  };
}
