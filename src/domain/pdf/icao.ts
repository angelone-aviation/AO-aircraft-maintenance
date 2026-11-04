/**
 * Responsibility: Reads the fields of an ICAO flight-plan form from the
 *   positioned text of its PDF page.
 * Layer: Domain. Pure function; reading the PDF itself is in src/data.
 * Dependencies: ../flightPlans (flight rules), ../rejection.
 *
 * Coordinates are normalized to the supported planning app's A4 ICAO template.
 * Box boundaries deliberately exclude adjacent labels and form delimiters.
 */
import { FLIGHT_RULE_OPTIONS } from "../flightPlans";
import { Rejection } from "../rejection";

/** One text item of the page, in A4 points up from the bottom-left corner. */
export interface PdfText {
  str: string;
  x: number;
  y: number;
}

// [left, bottom, right, top] in template points.
type Box = readonly [number, number, number, number];

const BOXES = {
  registration: [189, 612, 310, 623],
  flightRules: [406, 612, 437, 623],
  flightType: [496, 612, 525, 623],
  aircraftType: [148, 578, 235, 590],
  equipment: [367, 578, 525, 590],
  origin: [85, 549, 218, 561],
  departureTime: [230, 549, 305, 561],
  speed: [59, 522, 136, 534],
  level: [141, 522, 210, 534],
  routeFirstLine: [232, 522, 550, 535],
  routeContinued: [30, 479, 550, 519],
  destination: [95, 425, 220, 437],
  totalEet: [233, 425, 311, 437],
  alternate: [350, 425, 425, 437],
  otherInformation: [30, 365, 550, 406],
  endurance: [88, 297, 162, 308],
  personsOnBoard: [216, 297, 275, 308],
  pilot: [88, 138, 345, 151],
} as const satisfies Record<string, Box>;

const FLIGHT_RULES = FLIGHT_RULE_OPTIONS.map(([rule]) => rule);

// Items whose baselines differ by this many points or less share a line.
const SAME_LINE_POINTS = 4;

/**
 * Reads an ICAO flight plan from its page text. Code fields such as the
 * registration lose their spaces, since the PDF splits their characters.
 *
 * @param items - The page's text items, normalized to the A4 template.
 * @returns The fields: "" for an empty box; undefined for flight rules or a
 *   number that does not read; departureAt "" without DOF/ and a valid time.
 * @throws {Rejection} "This is not the supported ICAO flight-plan PDF. Upload
 *   the original text PDF from your planning app." when the page lacks the
 *   "ICAO FLIGHT PLAN" title or the "TOTAL EET" label.
 */
export function parseIcao(items: PdfText[]) {
  assertIcaoPlan(items);
  const text = (box: Box) => readBox(items, box);
  const code = (box: Box) => readBox(items, box).replace(/\s/g, "");
  const otherInformation = text(BOXES.otherInformation);
  const rules = code(BOXES.flightRules);
  const persons = code(BOXES.personsOnBoard);
  return {
    registration: code(BOXES.registration),
    aircraftType: code(BOXES.aircraftType),
    flightType: code(BOXES.flightType),
    flightRules: FLIGHT_RULES.find((r) => r === rules),
    departureAt: readDepartureAt(otherInformation, code(BOXES.departureTime)),
    origin: code(BOXES.origin),
    destination: code(BOXES.destination),
    alternate: code(BOXES.alternate),
    durationMinutes: readMinutes(code(BOXES.totalEet)),
    speed: code(BOXES.speed),
    level: code(BOXES.level),
    route: [text(BOXES.routeFirstLine), text(BOXES.routeContinued)]
      .filter(Boolean)
      .join(" "),
    enduranceMinutes: readMinutes(code(BOXES.endurance)),
    personsOnBoard: /^\d{1,3}$/.test(persons) ? Number(persons) : undefined,
    pilotText: text(BOXES.pilot),
    equipment: text(BOXES.equipment),
    otherInformation,
  };
}

/** The fields {@link parseIcao} reads from an ICAO flight-plan PDF. */
export type ParsedPlan = ReturnType<typeof parseIcao>;

function assertIcaoPlan(items: PdfText[]) {
  if (
    !items.some((i) => i.str.includes("ICAO FLIGHT PLAN")) ||
    !items.some((i) => i.str.includes("TOTAL EET"))
  )
    throw new Rejection(
      "This is not the supported ICAO flight-plan PDF. Upload the original text PDF from your planning app.",
    );
}

function readBox(items: PdfText[], [left, bottom, right, top]: Box) {
  const text = items
    .filter((i) => i.x >= left && i.x < right && i.y >= bottom && i.y <= top)
    .sort(byReadingOrder)
    .map((i) => i.str)
    .join(" ");
  // Drops the template's rule, arrow and delimiter glyphs.
  return text
    .replace(/[─⇒☰<>]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

// PDF y grows upward, so higher lines come first.
function byReadingOrder(a: PdfText, b: PdfText) {
  return Math.abs(a.y - b.y) > SAME_LINE_POINTS ? b.y - a.y : a.x - b.x;
}

// Item 18 gives the date of flight as DOF/YYMMDD; Item 13 time is UTC.
function readDepartureAt(otherInformation: string, time: string) {
  const date = /\bDOF\/(\d{2})(\d{2})(\d{2})\b/.exec(otherInformation);
  if (!date || !/^([01]\d|2[0-3])[0-5]\d$/.test(time)) return "";
  return `20${date[1]}-${date[2]}-${date[3]}T${time.slice(0, 2)}:${time.slice(2)}:00Z`;
}

// HHMM, as Items 16 (total EET) and 19 (endurance) write durations.
function readMinutes(hhmm: string) {
  if (!/^\d{4}$/.test(hhmm) || Number(hhmm.slice(2)) >= 60) return undefined;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
}
