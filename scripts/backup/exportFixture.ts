/**
 * Responsibility: A realistic Convex export ZIP of the demo program, for the
 *   backup tests and the sample records workbook.
 * Layer: Test. Fixture builder for scripts/backup tests; never shipped.
 * Dependencies: node:crypto, fflate, src/data/demo, convex/collections
 *   (encoding), src/domain stored-record schemas.
 *
 * Mission operations with N206MA, N208MA and N182MA (later transferred to a
 * second program): its people, flights, discrepancies, work orders, ADs,
 * components, stock and change history. Every document is shaped like its
 * convex/schema.ts table; payloads are checked against the app's own schemas
 * and their rows encoded as the app stores them. It also holds the data the
 * workbook must never show (sign-in tables, credentials, stored files), listed
 * in `forbidden`. All people and records are fictional.
 */
import { createHash } from "node:crypto";
import { zipSync, strToU8, type Zippable } from "fflate";
import { demoSnapshot } from "../../src/data/demo";
import { adSchema, type AD } from "../../src/domain/airworthiness";
import { costRecordSchema } from "../../src/domain/costs";
import { inspectionSchema, recordSchema } from "../../src/domain/management";
import { poSchema } from "../../src/domain/purchaseOrders";
import { taskCardDefaults, taskCardSchema } from "../../src/domain/taskCards";
import { workOrderSchema } from "../../src/domain/workOrders";
import { encode } from "../../convex/collections";

const hash = (seed: string) => createHash("sha256").update(seed).digest();
/**
 * A stable version-4 UUID for a fixture record.
 *
 * @param seed - Names the record; the same seed gives the same UUID.
 */
export function uuid(seed: string) {
  const b = hash(seed);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
/**
 * A stable Convex document ID.
 *
 * @param seed - Names the document; the same seed gives the same ID.
 */
export function convexId(seed: string) {
  return [...hash(`id:${seed}`)]
    .slice(0, 32)
    .map((x) => BASE32[x % 32])
    .join("");
}
const h = (hours: number) => Math.round(hours * 3600);

/**
 * Builds the fixture export.
 *
 * @param now - When the export is taken; record dates are relative to it.
 * @returns `zip`, the export's bytes; `forbidden`, text the workbook must
 *   never show; and `ids` of the programs, aircraft, users, groups, work
 *   orders, inspections and components.
 */
export function fixtureExport(now = Date.now()) {
  const demo = demoSnapshot();
  const dayMs = 86_400_000;
  const at = (days: number, hour = 15) =>
    Math.floor((now + days * dayMs) / dayMs) * dayMs + hour * 3_600_000;
  const date = (days: number) => new Date(at(days)).toISOString().slice(0, 10);
  const iso = (days: number, hour = 15) =>
    new Date(at(days, hour)).toISOString();
  const tables: Record<string, Record<string, unknown>[]> = {};
  const add = <T extends Record<string, unknown>>(
    table: string,
    doc: T,
    seed?: string,
  ) => {
    const row = {
      _id: convexId(`${table}:${seed ?? JSON.stringify(doc).slice(0, 200)}`),
      _creationTime: now - 90 * dayMs + (tables[table]?.length ?? 0) * 1000,
      ...doc,
    };
    (tables[table] ??= []).push(row);
    return row;
  };

  // Programs. N182MA moved from Mission operations to Coastal outreach.
  const P1 = uuid("program:mission"),
    P2 = uuid("program:coastal");
  const programName = demo.programs![0].name;
  add("programs", {
    uuid: P1,
    version: 3,
    name: programName,
    address: "Demo airfield",
    email: "operations@example.test",
    contactName: "Demo coordinator",
    website: "https://example.test",
  });
  add("programs", {
    uuid: P2,
    version: 1,
    name: "Coastal outreach",
    address: "Coastal base (fictional)",
    email: "coastal@example.test",
    contactName: "Coastal coordinator",
    website: "",
  });

  // Aircraft from the demo fleet, with flights leading to their totals.
  const A = Object.fromEntries(
    demo.aircraft.map((a) => [a.registration, uuid(`aircraft:${a.uuid}`)]),
  ) as Record<"N206MA" | "N208MA" | "N182MA", string>;

  // People (demo admin, pilot and owner, plus maintenance staff).
  const group = (seed: string) => convexId(`groups:${seed}`);
  const G = {
    admins: group("admins"),
    pilots: group("pilots"),
    maintenance: group("maintenance"),
    owners: group("owners"),
    coastalAdmins: group("coastal-admins"),
    coastalPilots: group("coastal-pilots"),
  };
  const user = (
    key: string,
    name: string,
    email: string,
    groupIds: string[],
    extra: Record<string, unknown> = {},
  ) =>
    add(
      "users",
      {
        name,
        email,
        active: true,
        isAdmin: false,
        groupIds,
        emailVerificationTime: now - 80 * dayMs,
        image: `https://lh3.googleusercontent.com/a/FIXTURE-AVATAR-${key}`,
        ...extra,
      },
      key,
    )._id as string;
  const U = {
    alex: user("alex", demo.user.name, demo.user.email, [G.admins], {
      isAdmin: true,
      activeProgramUuid: P1,
    }),
    jordan: user("jordan", demo.members[1].name, demo.members[1].email, [
      G.pilots,
    ]),
    sam: user("sam", "Sam Rivera", "sam@example.test", [G.owners]),
    casey: user(
      "casey",
      "Casey Nguyen",
      "casey@example.test",
      [G.maintenance],
      {
        licenseNumber: "FIXTURE-LICENSE-3456789",
        certificateType: "A&P",
        phone: "+1 555 0100",
      },
    ),
    riley: user("riley", "Riley Chen", "riley@example.test", [G.maintenance], {
      certifications: [
        {
          kind: "mechanic",
          number: "FIXTURE-CERT-9876543",
          issuedOn: "2014-05-02",
          airframe: true,
          powerplant: true,
          ia: true,
          renewalDate: date(140),
        },
      ],
    }),
    morgan: user("morgan", "Morgan Patel", "morgan@example.test", [G.pilots], {
      active: false,
    }),
    taylor: user("taylor", "Taylor Brooks", "taylor@example.test", [
      G.coastalAdmins,
      G.coastalPilots,
    ]),
  };
  const groupDoc = (id: string, doc: Record<string, unknown>) =>
    (tables.groups ??= []).push({
      _id: id,
      _creationTime: now - 85 * dayMs,
      ...doc,
    });
  groupDoc(G.admins, {
    programUuid: P1,
    programAdmin: true,
    name: "Program administrators",
    aircraftIds: [],
    permissions: ["read", "flight", "discrepancy", "resolve", "maintenance"],
  });
  groupDoc(G.pilots, {
    programUuid: P1,
    name: "Pilots",
    aircraftIds: [],
    permissions: ["read", "flight", "discrepancy"],
  });
  groupDoc(G.maintenance, {
    programUuid: P1,
    name: "Maintenance",
    aircraftIds: [],
    permissions: ["read", "discrepancy", "resolve", "maintenance"],
  });
  groupDoc(G.owners, {
    programUuid: P1,
    owner: true,
    name: "Aircraft owners",
    aircraftIds: [A.N206MA],
    permissions: ["read"],
  });
  groupDoc(G.coastalAdmins, {
    programUuid: P2,
    programAdmin: true,
    name: "Coastal administrators",
    aircraftIds: [],
    permissions: ["read", "flight", "discrepancy", "resolve", "maintenance"],
  });
  groupDoc(G.coastalPilots, {
    programUuid: P2,
    name: "Coastal pilots",
    aircraftIds: [A.N182MA],
    permissions: ["read", "flight", "discrepancy"],
  });
  for (const [userId, groupId] of [
    [U.alex, G.admins],
    [U.jordan, G.pilots],
    [U.casey, G.maintenance],
  ])
    add("memberships", { userId, groupId, programUuid: P1 });

  // Flights: three accepted per aircraft ending at the demo totals, one held
  // for review and one rejected.
  const legs: Record<string, [string, string][]> = {
    N206MA: [
      ["KCHA", "KAVL"],
      ["KAVL", "KTYS"],
      ["KTYS", "KCHA"],
    ],
    N208MA: [
      ["KCHA", "KMEM"],
      ["KMEM", "KBNA"],
      ["KBNA", "KCHA"],
    ],
    N182MA: [
      ["KSAV", "KCHS"],
      ["KCHS", "KMYR"],
      ["KMYR", "KSAV"],
    ],
  };
  const durations = [1.4, 1.5, 1.3];
  for (const d of demo.aircraft) {
    const id = A[d.registration as keyof typeof A];
    const total = d.currentHobbs / 3600;
    const flown = durations.reduce((a, b) => a + b, 0);
    let hobbs = h(total - flown);
    const tachOffset = h(80);
    const program = d.registration === "N182MA" ? P2 : P1;
    const pilot = d.registration === "N182MA" ? U.taylor : U.jordan;
    let latest = "";
    durations.forEach((hours, i) => {
      const start = iso(-12 + i * 4, 13 + i);
      const [origin, destination] = legs[d.registration][i];
      add(
        "flights",
        {
          uuid: uuid(`flight:${d.registration}:${i}`),
          aircraftUuid: id,
          authorId: pilot,
          pilotId: pilot,
          ...(i === 1 ? { copilotId: U.alex } : {}),
          startTime: start,
          submittedAt: Date.parse(start) + 2 * 3_600_000,
          status: "accepted",
          hobbsOff: hobbs,
          hobbsOn: hobbs + h(hours),
          tachOff: hobbs - tachOffset,
          tachOn: hobbs + h(hours) - tachOffset,
          landings: 1,
          cycles: 1,
          origin,
          destination,
          operation: "Mission",
          flightRules: "VFR",
          remarks: i === 2 ? "Smooth flight. Fuel topped off on arrival." : "",
          discrepancy: "",
          fuel: { unit: "US gal", start: 60, added: 0, end: 38 },
          oil: [
            {
              engine: "single",
              unit: "US qt",
              start: 7,
              added: i === 0 ? 1 : 0,
            },
          ],
        },
        `${d.registration}:${i}`,
      );
      hobbs += h(hours);
      latest = start;
    });
    add("aircraft", {
      uuid: id,
      registration: d.registration,
      make: d.make,
      model: d.model,
      serial:
        d.registration === "N206MA"
          ? "U20605512"
          : d.registration === "N208MA"
            ? "20800377"
            : "18265844",
      ...(d.registration === "N208MA" ? { turbine: true } : {}),
      program: d.registration === "N182MA" ? "Coastal outreach" : programName,
      programUuid: program,
      meter: "hobbs",
      adjustmentSeconds: 0,
      baselineHobbs: h(total - flown),
      baselineTach: h(total - flown) - tachOffset,
      baselineCycles: d.cycles - 3,
      baselineLandings: d.landings - 3,
      currentHobbs: d.currentHobbs,
      currentTach: d.currentHobbs - tachOffset,
      cycles: d.cycles,
      landings: d.landings,
      version: 4,
      latestFlightAt: latest,
      operationalStatus: "unknown",
    });
  }
  const held = add("flights", {
    uuid: uuid("flight:N208MA:held"),
    aircraftUuid: A.N208MA,
    authorId: U.jordan,
    pilotId: U.jordan,
    startTime: iso(-1, 9),
    submittedAt: at(-1, 12),
    status: "review",
    reviewReason:
      "Backdated or duplicate-time flight requires a chronology review.",
    hobbsOff: demo.aircraft[1].currentHobbs,
    hobbsOn: demo.aircraft[1].currentHobbs + h(1.5),
    tachOff: demo.aircraft[1].currentHobbs - h(80),
    tachOn: demo.aircraft[1].currentHobbs + h(1.5) - h(80),
    landings: 1,
    cycles: 1,
    origin: "KCHA",
    destination: "KHSV",
    operation: "Mission medical",
    flightRules: "IFR",
    remarks: "Patient transfer.",
    discrepancy: "Left landing light flickers on taxi.",
  });
  add("flights", {
    uuid: uuid("flight:N182MA:rejected"),
    aircraftUuid: A.N182MA,
    authorId: U.taylor,
    pilotId: U.taylor,
    startTime: iso(-4, 14),
    submittedAt: at(-4, 18),
    status: "rejected",
    reviewReason: "Entered twice; the accepted entry for this flight stands.",
    hobbsOff: demo.aircraft[2].currentHobbs - h(1.3),
    hobbsOn: demo.aircraft[2].currentHobbs,
    landings: 1,
    cycles: 1,
    origin: "KMYR",
    destination: "KSAV",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  });

  // Discrepancies.
  const D = {
    landingLight: uuid("discrepancy:landing-light"),
    noseGear: uuid("discrepancy:nose-gear"),
    fuelCap: uuid("discrepancy:fuel-cap"),
    readingLight: uuid("discrepancy:reading-light"),
    pitotHeat: uuid("discrepancy:pitot-heat"),
  };
  add("discrepancies", {
    uuid: D.landingLight,
    aircraftUuid: A.N208MA,
    flightUuid: held.uuid,
    description: demo.discrepancies[0].description,
    status: "open",
    authorId: U.jordan,
    createdAt: at(-1, 12),
  });
  add("discrepancies", {
    uuid: D.noseGear,
    aircraftUuid: A.N208MA,
    description: "Nose gear shimmy damper leaking hydraulic fluid.",
    status: "open",
    authorId: U.casey,
    createdAt: at(-2, 10),
    grounding: true,
  });
  add("discrepancies", {
    uuid: D.fuelCap,
    aircraftUuid: A.N208MA,
    description: "Right fuel cap gasket worn; cap does not seal fully.",
    status: "resolved",
    authorId: U.jordan,
    createdAt: at(-9, 16),
    resolution: "Replaced gasket P/N S2160-1. Cap seals; no leaks on run-up.",
    resolvedBy: U.casey,
    resolvedAt: at(-5, 11),
  });
  add("discrepancies", {
    uuid: D.readingLight,
    aircraftUuid: A.N182MA,
    description: "Cabin reading light inoperative.",
    status: "open",
    authorId: U.taylor,
    createdAt: at(-2, 9),
    deferral: {
      type: "mel",
      melItem: "33-20-01",
      category: "C",
      placard: "INOP — cabin reading light",
      deferredOn: date(-2),
      deferredAt: at(-2, 10),
      deferredBy: U.taylor,
      deferredByName: "Taylor Brooks",
      expiresOn: date(8),
    },
  });
  add("discrepancies", {
    uuid: D.pitotHeat,
    aircraftUuid: A.N206MA,
    description: "Pitot heat ammeter reads low.",
    status: "open",
    authorId: U.jordan,
    createdAt: at(-8, 9),
    deferral: {
      type: "91.213d",
      placard: "INOP — pitot heat indication",
      notHazard: true,
      deferredOn: date(-8),
      deferredAt: at(-8, 10),
      deferredBy: U.casey,
      deferredByName: "Casey Nguyen",
      expiresOn: date(2),
    },
  });

  // Inspections.
  const I = {
    hundred206: uuid("inspection:206-100"),
    annual206: uuid("inspection:206-annual"),
    hundred208: uuid("inspection:208-100"),
    pitot208: uuid("inspection:208-pitot"),
    annual182: uuid("inspection:182-annual"),
  };
  const inspection = (doc: Record<string, unknown>) =>
    add("inspections", {
      ...inspectionSchema.parse({
        version: 2,
        materials: "",
        archived: false,
        ...doc,
      }),
    });
  inspection({
    uuid: I.hundred206,
    programUuid: P1,
    aircraftUuid: A.N206MA,
    reference: "100-hour inspection",
    description: "Airframe and engine inspection",
    intervalSeconds: h(100),
    lastSeconds: h(2250),
    lastDate: date(-60),
    dueSeconds: h(2350),
  });
  inspection({
    uuid: I.annual206,
    programUuid: P1,
    aircraftUuid: A.N206MA,
    reference: "Annual inspection",
    description: "Calendar inspection",
    dueDate: date(84),
  });
  inspection({
    uuid: I.hundred208,
    programUuid: P1,
    aircraftUuid: A.N208MA,
    reference: "100-hour inspection",
    description: "Airframe and engine inspection",
    intervalSeconds: h(100),
    lastSeconds: h(4150),
    dueSeconds: h(4250),
  });
  inspection({
    uuid: I.pitot208,
    programUuid: P1,
    aircraftUuid: A.N208MA,
    reference: "Altimeter, static and transponder checks (91.411, 91.413)",
    description: "24-calendar-month checks",
    dueDate: date(-6),
  });
  inspection({
    uuid: I.annual182,
    programUuid: P2,
    aircraftUuid: A.N182MA,
    reference: "Annual inspection",
    description: "Calendar inspection",
    dueDate: date(60),
  });

  // Locations, vendors, stock and components.
  const managed = (raw: unknown) => {
    const r = recordSchema.parse(raw);
    add("management", encode("management", r));
    return r;
  };
  const L1 = uuid("location:main"),
    L2 = uuid("location:coastal");
  managed({
    uuid: L1,
    version: 1,
    programUuid: P1,
    kind: "location",
    name: "Main hangar stores",
    address: "Demo airfield, hangar 2",
    contact: "stores@example.test",
  });
  managed({
    uuid: L2,
    version: 1,
    programUuid: P2,
    kind: "location",
    name: "Coastal base shelf",
    address: "Coastal base",
    contact: "",
  });
  managed({
    uuid: uuid("vendor:supply"),
    version: 1,
    programUuid: P1,
    kind: "vendor",
    name: "Example Aviation Supply",
    website: "https://supply.example.test",
    accountNumber: "FIXTURE-ACCOUNT-0042",
    paymentTerms: "Net 30",
    notes: "",
  });
  const S = {
    filter: uuid("stock:filter"),
    oil: uuid("stock:oil"),
    sealant: uuid("stock:sealant"),
    loctite: uuid("stock:loctite"),
    plug: uuid("stock:plug"),
  };
  const stock = (doc: Record<string, unknown>) =>
    managed({
      version: 1,
      kind: "stock",
      alternates: "",
      condition: "new",
      minimum: 2,
      ...doc,
    });
  stock({
    uuid: S.filter,
    programUuid: P1,
    partNumber: "CH48110-1",
    description: "Oil filter",
    category: "part",
    locationUuid: L1,
    quantity: 6,
    minimum: 4,
    vendor: "Example Aviation Supply",
    invoiceNumber: "INV-88123",
    cost: 24.95,
  });
  stock({
    uuid: S.oil,
    programUuid: P1,
    partNumber: "AEROSHELL-W100",
    description: "Engine oil, 1 US quart",
    category: "supply",
    oil: true,
    locationUuid: L1,
    quantity: 18,
    minimum: 12,
    cost: 11.5,
  });
  stock({
    uuid: S.sealant,
    programUuid: P1,
    partNumber: "PR-1422-B2",
    description: "Fuel tank sealant, 3.5 oz",
    category: "supply",
    locationUuid: L1,
    quantity: 2,
    expirationDate: date(-15),
    cost: 68,
    poRef: "PO-2026-0009",
  });
  stock({
    uuid: S.loctite,
    programUuid: P2,
    partNumber: "LOCTITE-242",
    description: "Threadlocker, medium strength",
    category: "supply",
    locationUuid: L2,
    quantity: 3,
    expirationDate: date(20),
    cost: 9.75,
  });
  stock({
    uuid: S.plug,
    programUuid: P1,
    partNumber: "REM40E",
    description: "Spark plug",
    category: "part",
    locationUuid: L1,
    quantity: 8,
    minimum: 6,
    cost: 32,
  });
  const C = {
    engine: uuid("component:engine-206"),
    elt: uuid("component:elt-208"),
    prop: uuid("component:prop-182"),
    magneto: uuid("component:magneto-spare"),
  };
  const component = (doc: Record<string, unknown>) =>
    managed({
      version: 1,
      kind: "component",
      notes: "",
      manufacturer: "",
      trackCycles: false,
      trackCalendar: false,
      installedCycles: 0,
      timeSinceRepair: null,
      cyclesSinceNew: 0,
      serviceDaysBase: 0,
      ...doc,
    });
  component({
    uuid: C.engine,
    programUuid: P1,
    aircraftUuid: A.N206MA,
    componentType: "Engine",
    manufacturer: "Continental",
    model: "IO-520-F",
    partNumber: "655410",
    serial: "286541-R",
    trackTime: true,
    installed: true,
    installedDate: date(-400),
    installPosition: "MAIN",
    installedSeconds: h(2000),
    timeSinceNew: h(3100),
    timeSinceOverhaul: h(1000),
  });
  component({
    uuid: C.elt,
    programUuid: P1,
    aircraftUuid: A.N208MA,
    componentType: "ELT battery",
    manufacturer: "Artex",
    partNumber: "452-0133",
    serial: "EB-20231",
    trackTime: false,
    trackCalendar: true,
    installed: true,
    installedDate: date(-700),
    installedSeconds: h(3900),
    timeSinceNew: 0,
    timeSinceOverhaul: null,
  });
  component({
    uuid: C.prop,
    programUuid: P2,
    aircraftUuid: A.N182MA,
    componentType: "Propeller",
    manufacturer: "McCauley",
    partNumber: "2A34C203",
    serial: "798812",
    trackTime: true,
    installed: true,
    installedDate: date(-300),
    installPosition: "MAIN",
    installedSeconds: h(1400),
    timeSinceNew: h(1900),
    timeSinceOverhaul: h(200),
  });
  component({
    uuid: C.magneto,
    programUuid: P1,
    aircraftUuid: "",
    componentType: "Magneto",
    manufacturer: "Slick",
    partNumber: "4371",
    serial: "21045678",
    trackTime: true,
    installed: false,
    locationUuid: L1,
    installedSeconds: 0,
    timeSinceNew: h(820),
    timeSinceOverhaul: 0,
  });
  const requirement = (doc: Record<string, unknown>) =>
    managed({
      version: 1,
      kind: "componentRequirement",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      warningCalendarMonths: 1,
      warningSeconds: h(25),
      warningCycles: 10,
      ...doc,
    });
  requirement({
    uuid: uuid("requirement:engine-tbo"),
    programUuid: P1,
    componentUuid: C.engine,
    aircraftUuid: A.N206MA,
    requirementType: "Overhaul Requirement",
    description: "Time between overhauls (TBO) 1,700 h",
    timeBasis: "TSO",
    dueSeconds: h(1700),
  });
  requirement({
    uuid: uuid("requirement:elt-life"),
    programUuid: P1,
    componentUuid: C.elt,
    aircraftUuid: A.N208MA,
    requirementType: "Life Limits",
    description: "Replace ELT battery (91.207(c))",
    dueDate: date(-3),
  });
  requirement({
    uuid: uuid("requirement:prop-tbo"),
    programUuid: P2,
    componentUuid: C.prop,
    aircraftUuid: A.N182MA,
    requirementType: "Overhaul Requirement",
    description: "Propeller overhaul 2,000 h or 72 months",
    timeBasis: "TSO",
    dueSeconds: h(2000),
    dueDate: date(900),
  });
  managed({
    uuid: uuid("movement:engine-baseline"),
    version: 1,
    programUuid: P1,
    kind: "componentMovement",
    componentUuid: C.engine,
    aircraftUuid: A.N206MA,
    action: "BASELINE",
    date: date(-400),
    timeSinceNew: h(3100),
    timeSinceOverhaul: h(1000),
    timeSinceRepair: null,
    cycles: 0,
    serviceDays: 0,
    note: "Initial setup baseline from the engine logbook.",
    actorId: U.casey,
    at: at(-400),
  });

  // Airworthiness directives (fictional numbers).
  const ad = (
    raw: Omit<Partial<AD>, "source"> & { source: Partial<AD["source"]> },
  ) => {
    const r = adSchema.parse({
      version: 2,
      componentUuid: "",
      reason: "",
      history: [],
      sourceHistory: [],
      reviewRequired: false,
      updatedAt: at(-30),
      ...raw,
      source: {
        amendment: "",
        issued: "",
        effective: "",
        supersededBy: "",
        url: "https://drs.faa.gov/browse/excelExternalWindow/FIXTURE.0001",
        source: "Demo entry (not an FAA directive)",
        section: "Airframe",
        make: "Cessna",
        model: "",
        sourceNotes: "",
        recurring: "Unknown",
        ...raw.source,
      },
    });
    add("airworthiness", encode("airworthiness", r));
    return r;
  };
  const task = uuid("ad-task:stabilizer");
  const adStabilizer = ad({
    uuid: uuid("ad:stabilizer"),
    programUuid: P1,
    aircraftUuid: A.N206MA,
    applicability: "Applicable",
    source: {
      number: "2024-DEMO-03",
      subject: "Horizontal stabilizer attach bracket inspection",
      recurring: "Yes",
      model: "206",
    },
    tasks: [
      {
        uuid: task,
        description: "Inspect attach brackets for cracks; repeat every 100 h.",
        dueDate: "",
        dueHours: 2400,
        dueCycles: null,
        intervalDays: null,
        intervalHours: 100,
        intervalCycles: null,
        recurrence: "Recurring",
        workOrderUuid: "",
      },
    ],
    history: [
      {
        uuid: uuid("ad-compliance:stabilizer-1"),
        taskUuid: task,
        date: date(-40),
        hours: 2300,
        cycles: null,
        method:
          "Visual and 10x magnifier inspection per service bulletin; no cracks found.",
        serviceBulletin: "SEB-DEMO-55",
        terminatedBy: "",
        workOrderUuid: "",
        mechanic: "Casey Nguyen",
        certificate: "A&P 3456789",
        evidence: "",
        recordedAt: at(-40),
        recordedBy: U.casey,
      },
    ],
  });
  ad({
    uuid: uuid("ad:seat-rail"),
    programUuid: P1,
    aircraftUuid: A.N206MA,
    applicability: "Applicable",
    source: {
      number: "2025-DEMO-12",
      subject: "Seat rail and stop inspection",
      recurring: "No",
      model: "206",
    },
    tasks: [
      {
        uuid: uuid("ad-task:seat-rail"),
        description: "Inspect seat rails and install secondary seat stops.",
        dueDate: date(20),
        dueHours: null,
        dueCycles: null,
        intervalDays: null,
        intervalHours: null,
        intervalCycles: null,
        recurrence: "One-time",
        workOrderUuid: "",
      },
    ],
  });
  ad({
    uuid: uuid("ad:fuel-quantity"),
    programUuid: P1,
    aircraftUuid: A.N208MA,
    applicability: "Previously Complied With (PCW)",
    reason: "Complied with at manufacture per the aircraft records.",
    source: {
      number: "2023-DEMO-11",
      subject: "Fuel quantity indication check",
      recurring: "No",
      model: "208",
    },
    tasks: [],
  });
  ad({
    uuid: uuid("ad:control-cable"),
    programUuid: P2,
    aircraftUuid: A.N182MA,
    applicability: "Applicable",
    source: {
      number: "2025-DEMO-07",
      subject: "Aileron control cable pulley inspection",
      recurring: "No",
      model: "182",
    },
    tasks: [
      {
        uuid: uuid("ad-task:control-cable"),
        description: "Inspect pulleys and cable guards.",
        dueDate: date(45),
        dueHours: null,
        dueCycles: null,
        intervalDays: null,
        intervalHours: null,
        intervalCycles: null,
        recurrence: "One-time",
        workOrderUuid: "",
      },
    ],
  });

  // Work orders, job cards and costs.
  const W = {
    hundred: uuid("work-order:206-100"),
    pitot: uuid("work-order:208-pitot"),
  };
  const aircraftSnapshot = (reg: "N206MA" | "N208MA", hours: number) => {
    const d = demo.aircraft.find((a) => a.registration === reg)!;
    return {
      registration: reg,
      make: d.make,
      model: d.model,
      serial: reg === "N206MA" ? "U20605512" : "20800377",
      totalSeconds: h(hours),
      hobbs: h(hours),
      tach: h(hours - 80),
      meter: "hobbs" as const,
      cycles: d.cycles - 3,
      landings: d.landings - 3,
    };
  };
  const hundredTasks = [
    {
      uuid: uuid("wo-task:206-100"),
      source: { kind: "inspection" as const, uuid: I.hundred206 },
      description: "100-hour inspection",
      status: "completed" as const,
      notes: "",
      partsDelay: "",
    },
    {
      uuid: uuid("wo-task:206-plugs"),
      source: { kind: "manual" as const, uuid: "manual" },
      description: "Rotate and gap spark plugs",
      status: "completed" as const,
      notes: "",
      partsDelay: "",
    },
  ];
  const hundred = workOrderSchema.parse({
    uuid: W.hundred,
    version: 6,
    number: "WO-2026-0007",
    aircraftUuid: A.N206MA,
    dateOpened: date(-75),
    supervisor: "Casey Nguyen",
    scope: "100-hour inspection and spark plug rotation.",
    priority: "routine",
    status: "completed",
    completionDate: date(-60),
    releaseOutcome: "Aircraft approved for return to service.",
    finalReview: "Records reviewed by Riley Chen (IA).",
    recordedAt: at(-75),
    createdBy: U.casey,
    aircraft: aircraftSnapshot("N206MA", 2249.6),
    componentReadings: [],
    tasks: hundredTasks,
    closeout: {
      recordedAt: at(-60),
      aircraft: {
        ...aircraftSnapshot("N206MA", 2250),
        totalSeconds: h(2250),
      },
      completedBy: {
        userId: U.riley,
        name: "Riley Chen",
        licenseNumber: "FIXTURE-CERT-9876543",
        certificateType: "IA",
      },
      workPerformed:
        "Task #1 100-hour inspection: performed IAW the Cessna 206 service manual.",
      performers: [{ userId: U.casey, name: "Casey Nguyen" }],
      components: [],
      compliance: [
        {
          uuid: I.hundred206,
          kind: "inspection",
          description: "100-hour inspection",
          date: date(-60),
          seconds: h(2250),
          dueSeconds: h(2350),
        },
      ],
    },
  });
  const pitot = workOrderSchema.parse({
    uuid: W.pitot,
    version: 2,
    number: "WO-2026-0011",
    aircraftUuid: A.N208MA,
    dateOpened: date(-3),
    supervisor: "Casey Nguyen",
    scope: "Overdue altimeter and transponder checks; nose gear shimmy damper.",
    priority: "high",
    status: "parts-delay",
    completionDate: "",
    releaseOutcome: "",
    finalReview: "",
    recordedAt: at(-3),
    createdBy: U.casey,
    aircraft: aircraftSnapshot("N208MA", 4218.6),
    componentReadings: [],
    tasks: [
      {
        uuid: uuid("wo-task:208-pitot"),
        source: { kind: "inspection", uuid: I.pitot208 },
        description: "Altimeter, static and transponder checks",
        status: "in-progress",
        notes: "Test set booked with the avionics shop.",
        partsDelay: "",
      },
      {
        uuid: uuid("wo-task:208-shimmy"),
        source: { kind: "discrepancy", uuid: D.noseGear },
        description: "Nose gear shimmy damper leaking",
        status: "parts-delay",
        notes: "",
        partsDelay: "Seal kit on order.",
      },
    ],
  });
  for (const w of [hundred, pitot]) add("workOrders", encode("workOrders", w));
  const card = (raw: Record<string, unknown>) => {
    const c = taskCardSchema.parse({
      ...taskCardDefaults(String(raw.aircraftUuid)),
      version: 3,
      createdBy: U.casey,
      stepSignoffs: {},
      technicianSignoff: null,
      inspectionSignoff: null,
      ...raw,
    });
    add("taskCards", encode("taskCards", c));
    return c;
  };
  card({
    uuid: uuid("card:206-100"),
    aircraftUuid: A.N206MA,
    cardNumber: "TC-2026-0031",
    title: "100-hour inspection",
    workOrderUuid: W.hundred,
    workTaskUuid: hundredTasks[0].uuid,
    inspectionUuid: I.hundred206,
    status: "completed",
    completionDate: date(-60),
    actualWork:
      "Inspection completed per checklist; no defects beyond those recorded.",
    actualLabor: 6.5,
    inspectionSignoffRequired: true,
    partsUsed: [
      {
        uuid: uuid("part:filter"),
        source: "stock",
        stockUuid: S.filter,
        locationUuid: L1,
        partNumber: "CH48110-1",
        description: "Oil filter",
        quantity: 1,
        serialLot: "",
        removedComponent: "",
        installedComponent: "",
      },
      {
        uuid: uuid("part:oil"),
        source: "stock",
        stockUuid: S.oil,
        locationUuid: L1,
        partNumber: "AEROSHELL-W100",
        description: "Engine oil, 1 US quart",
        quantity: 10,
        serialLot: "LOT 24-118",
        removedComponent: "",
        installedComponent: "",
      },
    ],
    createdAt: at(-75),
    updatedAt: at(-60),
    technicianSignoff: {
      userId: U.casey,
      name: "Casey Nguyen",
      at: at(-60, 14),
    },
    inspectionSignoff: { userId: U.riley, name: "Riley Chen", at: at(-60, 16) },
  });
  card({
    uuid: uuid("card:206-plugs"),
    aircraftUuid: A.N206MA,
    cardNumber: "TC-2026-0032",
    title: "Rotate and gap spark plugs",
    workOrderUuid: W.hundred,
    workTaskUuid: hundredTasks[1].uuid,
    status: "completed",
    completionDate: date(-60),
    actualWork: "Plugs cleaned, gapped and rotated.",
    actualLabor: 1,
    createdAt: at(-75),
    updatedAt: at(-60),
    technicianSignoff: {
      userId: U.casey,
      name: "Casey Nguyen",
      at: at(-60, 12),
    },
  });
  card({
    uuid: uuid("card:208-pitot"),
    aircraftUuid: A.N208MA,
    cardNumber: "TC-2026-0040",
    title: "Altimeter, static and transponder checks",
    workOrderUuid: W.pitot,
    workTaskUuid: pitot.tasks[0].uuid,
    inspectionUuid: I.pitot208,
    status: "in-progress",
    inspectionSignoffRequired: true,
    createdAt: at(-3),
    updatedAt: at(-2),
  });
  const cost = (raw: Record<string, unknown>) => {
    const c = costRecordSchema.parse({ version: 1, ...raw });
    add("costs", encode("costs", c));
  };
  cost({
    uuid: uuid("cost:206-100"),
    programUuid: P1,
    kind: "workOrder",
    aircraftUuid: A.N206MA,
    workOrderUuid: W.hundred,
    labor: [
      {
        uuid: uuid("labor:206-100-a"),
        date: date(-61),
        technician: "Casey Nguyen",
        minutes: 390,
        seconds: h(6.5),
        rateCents: 9500,
        createdBy: U.casey,
        createdAt: at(-61),
      },
      {
        uuid: uuid("labor:206-100-b"),
        date: date(-60),
        technician: "Riley Chen",
        minutes: 60,
        seconds: h(1),
        rateCents: 11000,
        createdBy: U.riley,
        createdAt: at(-60),
      },
    ],
    other: [
      {
        uuid: uuid("other:206-100"),
        date: date(-60),
        description: "Shop supplies",
        amountCents: 4250,
        createdBy: U.casey,
        createdAt: at(-60),
      },
    ],
    partUnitCosts: [],
  });
  cost({
    uuid: uuid("cost:208-pitot"),
    programUuid: P1,
    kind: "workOrder",
    aircraftUuid: A.N208MA,
    workOrderUuid: W.pitot,
    labor: [
      {
        uuid: uuid("labor:208-pitot"),
        date: date(-2),
        technician: "Casey Nguyen",
        minutes: 120,
        seconds: h(2),
        rateCents: 9500,
        createdBy: U.casey,
        createdAt: at(-2),
      },
    ],
    other: [],
    partUnitCosts: [],
  });
  cost({
    uuid: uuid("cost:settings"),
    programUuid: P1,
    kind: "settings",
    laborRateCents: 9500,
  });

  // Purchase orders.
  const po = (raw: Record<string, unknown>) => {
    const p = poSchema.parse({
      version: 1,
      vendor: "Example Aviation Supply",
      vendorContact: "orders@supply.example.test",
      shipTo: "Main hangar stores, Demo airfield",
      currency: "USD",
      shippingCents: 0,
      notes: "",
      revision: 0,
      shipments: [],
      receipts: [],
      history: [],
      ...raw,
    });
    add("purchaseOrders", encode("purchaseOrders", p));
    return p;
  };
  const filterLine = uuid("po-line:filter");
  po({
    uuid: uuid("po:filters"),
    programUuid: P1,
    number: "PO-2026-0005",
    phase: "issued",
    expectedDate: date(-20),
    shippingCents: 1500,
    createdAt: at(-30),
    updatedAt: at(-18),
    issuedAt: at(-29),
    lines: [
      {
        uuid: filterLine,
        stockUuid: S.filter,
        locationUuid: L1,
        partNumber: "CH48110-1",
        description: "Oil filter",
        quantity: 6,
        unitCents: 2495,
        kind: "part",
      },
    ],
    receipts: [
      {
        uuid: uuid("receipt:filters"),
        date: date(-18),
        invoice: "INV-88123",
        notes: "",
        actorId: U.casey,
        lines: [
          {
            lineUuid: filterLine,
            quantity: 6,
            condition: "new",
            itemUuids: [],
            serials: [],
          },
        ],
      },
    ],
  });
  po({
    uuid: uuid("po:sealant"),
    programUuid: P1,
    number: "PO-2026-0009",
    phase: "issued",
    expectedDate: date(5),
    createdAt: at(-4),
    updatedAt: at(-4),
    issuedAt: at(-4),
    lines: [
      {
        uuid: uuid("po-line:sealant"),
        stockUuid: S.sealant,
        locationUuid: L1,
        partNumber: "PR-1422-B2",
        description: "Fuel tank sealant, 3.5 oz",
        quantity: 2,
        unitCents: 6800,
        kind: "supply",
        aircraftUuid: A.N208MA,
        workOrderUuid: W.pitot,
      },
    ],
  });
  po({
    uuid: uuid("po:plugs"),
    programUuid: P1,
    number: "PO-2026-0010",
    phase: "draft",
    expectedDate: "",
    createdAt: at(-1),
    updatedAt: at(-1),
    lines: [
      {
        uuid: uuid("po-line:plugs"),
        stockUuid: S.plug,
        locationUuid: L1,
        partNumber: "REM40E",
        description: "Spark plug",
        quantity: 12,
        unitCents: 3200,
        kind: "part",
      },
    ],
  });

  // Data the workbook must never show.
  const storage = (seed: string) =>
    add(
      "_storage",
      {
        sha256: createHash("sha256").update(seed).digest("base64"),
        size: 1024,
        contentType: "application/pdf",
      },
      seed,
    )._id as string;
  const photo = storage("photo-206");
  const manualFile = storage("manual-206");
  const catalog = storage("spruce-catalog");
  const MANUAL = uuid("manual:206");
  const forbidden = [
    "$argon2id$v=19$m=19456,t=2,p=1$FIXTURESALT$FIXTUREPASSWORDHASH",
    "enc:v1:FIXTURE-FAA-KEY",
    "enc:v1:FIXTURE-SPRUCE-PASSWORD",
    "enc:v1:FIXTURE-SPRUCE-APIKEY",
    "enc:v1:FIXTURE-GEOAPIFY-KEY",
    "enc:v1:FIXTURE-AUDIT-SECRET",
    "enc:v1:FIXTURE-ENC-IN-NOTES",
    "FIXTURE-REFRESH-TOKEN",
    "FIXTURE-VERIFY-CODE",
    "FIXTURE-VERIFIER",
    "FIXTURE-RATE-LIMIT",
    "FIXTURE-REQUEST-PAYLOAD",
    "FIXTURE-UPLOAD",
    "FIXTURE-AVATAR",
    "FIXTURE-LICENSE",
    "FIXTURE-CERT",
    "FIXTURE-ACCOUNT",
    "googleusercontent",
    "convex.cloud",
    "/api/storage/",
    "drs.faa.gov",
    photo,
    manualFile,
    catalog,
  ];
  add("authAccounts", {
    userId: U.alex,
    provider: "password",
    providerAccountId: "alex@example.test",
    secret: forbidden[0],
  });
  const session = add("authSessions", {
    userId: U.alex,
    expirationTime: now + 30 * dayMs,
  });
  add("authRefreshTokens", {
    sessionId: session._id,
    expirationTime: now + 30 * dayMs,
    firstUsedTime: now,
    parentRefreshTokenId: "FIXTURE-REFRESH-TOKEN",
  });
  add("authVerificationCodes", {
    accountId: convexId("account"),
    provider: "password",
    code: "FIXTURE-VERIFY-CODE-1234",
    expirationTime: now + 600_000,
  });
  add("authVerifiers", { signature: "FIXTURE-VERIFIER-SIGNATURE" });
  add("authRateLimits", {
    identifier: "FIXTURE-RATE-LIMIT-ID",
    lastAttemptTime: now,
    attemptsLeft: 4,
  });
  add("rateLimits", {
    key: "FIXTURE-RATE-LIMIT-KEY",
    windowStart: now,
    count: 2,
  });
  add("faaCredentials", {
    key: "enc:v1:FIXTURE-FAA-KEY",
    expiresOn: date(300),
    version: 2,
    updatedAt: at(-50),
  });
  add("addressVerificationSettings", {
    key: "enc:v1:FIXTURE-GEOAPIFY-KEY",
    version: 1,
    day: date(0),
    used: 3,
    lastLookupAt: at(0, 8),
  });
  add("spruceAccounts", {
    programUuid: P1,
    version: 1,
    credentials: {
      userid: "spruce-user",
      password: "enc:v1:FIXTURE-SPRUCE-PASSWORD",
      apikey: "enc:v1:FIXTURE-SPRUCE-APIKEY",
      currency: "USD",
    },
    catalogId: catalog,
    catalogAt: at(-15),
    catalogCount: 120,
  });
  add("commandRequests", {
    uuid: uuid("request:1"),
    actorId: U.casey,
    payload: JSON.stringify({ requestUuid: "FIXTURE-REQUEST-PAYLOAD" }),
  });
  add("manualUploads", {
    payload: "FIXTURE-UPLOAD-PAYLOAD",
    userId: U.casey,
    createdAt: at(-14),
  });
  add("aircraftPhotos", { aircraftUuid: A.N206MA, storageId: photo });
  add("manuals", {
    uuid: MANUAL,
    aircraftUuid: A.N206MA,
    title: "Model 206 service manual",
    documentNumber: "D2060-13",
    revision: "13",
    revisionDate: "2019-07-01",
    filename: "206-service-manual.pdf",
    size: 1024,
    pageCount: 812,
    storageId: manualFile,
    uploadedAt: at(-14),
    uploadedBy: U.casey,
  });

  // Change history: the rows the app wrote for the records above.
  const audit = (
    days: number,
    actorId: string,
    action: string,
    entityUuid: string,
    fields: {
      programUuid?: string;
      aircraftUuid?: string;
      reason?: string;
      before?: unknown;
      after?: unknown;
    } = {},
    hour = 15,
  ) =>
    add(
      "audit",
      {
        uuid: uuid(`audit:${action}:${entityUuid}:${days}:${hour}`),
        actorId,
        at: at(days, hour),
        action,
        entityUuid,
        programUuid: fields.programUuid,
        aircraftUuid: fields.aircraftUuid,
        reason: fields.reason,
        before:
          fields.before === undefined
            ? undefined
            : JSON.stringify(fields.before),
        after:
          fields.after === undefined ? undefined : JSON.stringify(fields.after),
      },
      `${action}:${entityUuid}:${days}:${hour}`,
    );
  audit(-80, U.alex, "aircraft.created", A.N182MA, {
    programUuid: P1,
    aircraftUuid: A.N182MA,
    after: {
      registration: "N182MA",
      make: "Cessna",
      model: "182 Skylane",
      programUuid: P1,
    },
  });
  audit(-79, U.alex, "user.created", U.casey, {
    programUuid: P1,
    after: {
      name: "Casey Nguyen",
      email: "casey@example.test",
      groupIds: [G.maintenance],
    },
  });
  const beforeTransfer = audit(-45, U.casey, "inspection.save", I.annual182, {
    programUuid: P1,
    aircraftUuid: A.N182MA,
    reason: "Annual completed; next due recorded.",
    before: { dueDate: date(-50), version: 1 },
    after: { dueDate: date(60), version: 2 },
  });
  audit(-40, U.casey, "ad.comply", adStabilizer.uuid, {
    programUuid: P1,
    aircraftUuid: A.N206MA,
    reason: "Recurring inspection complied with.",
    after: {
      taskUuid: task,
      date: date(-40),
      hours: 2300,
      mechanic: "Casey Nguyen",
    },
  });
  audit(-24, U.alex, "user.permissions_changed", U.morgan, {
    reason: "Left the program.",
    before: { active: true, groupIds: [G.pilots] },
    after: { active: false, groupIds: [G.pilots] },
  });
  audit(-23, U.alex, "user.password_reset", U.morgan, {
    reason: "Account closed.",
  });
  audit(-20, U.alex, "program.transferred", A.N182MA, {
    programUuid: P2,
    aircraftUuid: A.N182MA,
    reason: "Aircraft moved to Coastal outreach.",
    before: { programUuid: P1 },
    after: { programUuid: P2 },
  });
  add("transferredAudit", {
    programUuid: P2,
    auditId: beforeTransfer._id,
    auditCreationTime: beforeTransfer._creationTime,
  });
  audit(-15, U.alex, "spruce.account.linked", P1, {
    programUuid: P1,
    after: {
      credentials: {
        userid: "spruce-user",
        password: "enc:v1:FIXTURE-AUDIT-SECRET",
      },
      catalogId: catalog,
      notes: "enc:v1:FIXTURE-ENC-IN-NOTES",
    },
  });
  audit(-14, U.casey, "manual.upload", MANUAL, {
    programUuid: P1,
    aircraftUuid: A.N206MA,
    after: {
      title: "Model 206 service manual",
      storageId: manualFile,
      file: manualFile,
      photoUrl: `https://fixture.convex.cloud/api/storage/${photo}`,
      link: `https://fixture.convex.cloud/api/storage/${photo}`,
    },
  });
  audit(-60, U.casey, "workOrder.save", W.hundred, {
    programUuid: P1,
    aircraftUuid: A.N206MA,
    reason: "Close-out",
    before: { status: "in-progress", completionDate: "" },
    after: {
      status: "completed",
      completionDate: date(-60),
      performers: [U.casey],
    },
  });
  audit(
    -60,
    U.riley,
    "taskCard.sign",
    uuid("card:206-100"),
    {
      programUuid: P1,
      aircraftUuid: A.N206MA,
      after: { kind: "inspection", at: at(-60, 16) },
    },
    16,
  );
  audit(-8, U.casey, "discrepancy.deferred", D.pitotHeat, {
    programUuid: P1,
    aircraftUuid: A.N206MA,
    reason: "Deferred under 91.213(d) pending parts.",
    after: { type: "91.213d", expiresOn: date(2) },
  });
  audit(-6, U.casey, "stock.move", S.filter, {
    programUuid: P1,
    reason: "Issued to WO-2026-0007",
    before: { quantity: 7 },
    after: { quantity: 6 },
  });
  audit(-5, U.casey, "discrepancy.resolved", D.fuelCap, {
    programUuid: P1,
    aircraftUuid: A.N208MA,
    reason: "Gasket replaced.",
    before: { status: "open" },
    after: {
      status: "resolved",
      resolution: "Replaced gasket P/N S2160-1.",
      resolvedBy: U.casey,
      resolvedAt: at(-5, 11),
    },
  });
  audit(-4, "system", "flight.resequenced", uuid("flight:N206MA:2"), {
    programUuid: P1,
    aircraftUuid: A.N206MA,
    reason: "Counters recalculated after a backdated flight.",
    before: { hobbsOff: h(2339.8) },
    after: { hobbsOff: h(2339.9) },
  });
  audit(-3, U.casey, "workOrder.save", W.pitot, {
    programUuid: P1,
    aircraftUuid: A.N208MA,
    after: { number: "WO-2026-0011", status: "open", aircraftUuid: A.N208MA },
  });
  audit(-2, U.taylor, "discrepancy.deferred", D.readingLight, {
    programUuid: P2,
    aircraftUuid: A.N182MA,
    reason: "MEL 33-20-01 category C.",
    after: {
      type: "mel",
      melItem: "33-20-01",
      category: "C",
      expiresOn: date(8),
    },
  });
  audit(
    -2,
    U.casey,
    "discrepancy.created",
    D.noseGear,
    {
      programUuid: P1,
      aircraftUuid: A.N208MA,
      after: {
        description: "Nose gear shimmy damper leaking hydraulic fluid.",
        grounding: true,
      },
    },
    10,
  );
  audit(
    -1,
    U.jordan,
    "discrepancy.created",
    D.landingLight,
    {
      programUuid: P1,
      aircraftUuid: A.N208MA,
      after: { description: demo.discrepancies[0].description },
    },
    12,
  );
  audit(
    -1,
    U.jordan,
    "flight.submitted",
    held.uuid as string,
    {
      programUuid: P1,
      aircraftUuid: A.N208MA,
      reason: "Held for review: backdated or duplicate-time flight.",
    },
    12,
  );
  audit(-30, U.alex, "record.save", uuid("deleted:old-record"), {
    programUuid: P1,
    reason: "Removed a duplicate location.",
  });

  // A component table and the export's own index, which the reader skips.
  const files: Zippable = {
    "README.md": strToU8("Convex snapshot export (fixture)\n"),
    "_tables/documents.jsonl": strToU8(
      Object.keys(tables)
        .map((name) =>
          JSON.stringify({ name, id: Object.keys(tables).indexOf(name) }),
        )
        .join("\n") + "\n",
    ),
    "_components/workpool/runs/documents.jsonl": strToU8(
      JSON.stringify({
        _id: convexId("run"),
        secret: "FIXTURE-REQUEST-PAYLOAD-COMPONENT",
      }) + "\n",
    ),
  };
  for (const [table, docs] of Object.entries(tables)) {
    const jsonl = docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
    // Some entries stored, most deflated, as real exports may mix both.
    files[`${table}/documents.jsonl`] =
      table === "programs" ? [strToU8(jsonl), { level: 0 }] : strToU8(jsonl);
    if (table !== "_storage")
      files[`${table}/generated_schema.jsonl`] = strToU8(`"${table}"\n`);
  }
  for (const d of tables._storage ?? [])
    files[`_storage/${d._id}`] = strToU8(`%PDF-1.4 fixture ${d._id}`);
  return {
    zip: zipSync(files),
    forbidden,
    ids: {
      programs: [P1, P2],
      aircraft: Object.values(A),
      users: Object.values(U),
      groups: Object.values(G),
      workOrders: Object.values(W),
      inspections: Object.values(I),
      components: Object.values(C),
    },
  };
}
