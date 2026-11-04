/**
 * Responsibility: Pins how an ICAO flight-plan page is recognized and how its
 *   times, durations, rules and counts read or are left out.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/pdf/icao.ts, ../rejection,
 *   tests/fixtures/icao-text.json.
 */
import { expect, it } from "vitest";
import items from "../../../tests/fixtures/icao-text.json";
import { Rejection } from "../rejection";
import { parseIcao, type PdfText } from "./icao";

const replaced = (from: string, to: string): PdfText[] =>
  items.map((i) => (i.str === from ? { ...i, str: to } : i));

it("refuses a page without both the title and the total EET label", () => {
  const untitled = replaced("ICAO FLIGHT PLAN", "FLIGHT PLAN");
  expect(() => parseIcao(untitled)).toThrow(Rejection);
  expect(() => parseIcao(replaced("TOTAL EET", "EET"))).toThrow(
    "This is not the supported ICAO flight-plan PDF. Upload the original text PDF from your planning app.",
  );
});

it("drops template glyphs but keeps spaces in text fields", () => {
  const plan = parseIcao(items);
  expect(plan.equipment).toBe("SGR / CB1");
  expect(plan.otherInformation).toMatch(/^PBN\/B2C2D2 DOF\/260930 EET\//);
});

it("leaves the departure out without a date of flight or a valid time", () => {
  expect(parseIcao(replaced("DOF/260930", "")).departureAt).toBe("");
  expect(parseIcao(replaced("2 2 0 5", "2 4 0 5")).departureAt).toBe("");
});

it("leaves durations, rules and counts out when they do not read", () => {
  expect(parseIcao(replaced("0 4 5 3", "0 2 6 0")).durationMinutes).toBe(
    undefined,
  );
  expect(parseIcao(replaced("0 5 3 6", "536")).enduranceMinutes).toBe(
    undefined,
  );
  expect(parseIcao(replaced("I", "X")).flightRules).toBe(undefined);
  const crowded = [
    ...items.filter((i) => !(i.y > 297 && i.y < 308 && i.x > 216)),
    { str: "1000", x: 221, y: 301 },
  ];
  expect(parseIcao(crowded).personsOnBoard).toBe(undefined);
});
