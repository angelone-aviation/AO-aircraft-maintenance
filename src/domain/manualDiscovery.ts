/**
 * Responsibility: Suggests inspections and component limits from the text of
 *   a maintenance-manual page, and matches a manual to aircraft and components.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/manuals.ts, model.ts, components.ts (types only).
 *
 * Suggestions, never authoritative schedules: a person reviews each one
 * against the PDF, and ambiguous numbers stay in the source text.
 */
import type { Manual, ManualApplicability, ManualReference } from "./manuals";
import type { Aircraft } from "./model";
import type { Component, ComponentRequirement } from "./components";

const MONTHS_PER_YEAR = 12;
const NAME_MAX_LENGTH = 200;
const FRAGMENT_MAX_LENGTH = 12;

// FNV-1a, 32-bit. Stored source keys hold this hash, so changing it would
// offer already-imported items again.
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

const ITEM_START = /^(?:\(\d+\)|\d{1,2}[.)]|[A-Z]\d{5,}|[-•])\s*/;
const RELEVANT_TEXT =
  /\b(inspect\w*|phase\s+[\dA-Z]+|overhaul|replace\w*|life[ -]limit\w*|time limits?|retirement|lubricat\w*|service interval)\b/i;
const COMPONENT_TEXT =
  /\b(life[ -]limit\w*|overhaul|replace\w*|retirement|shelf life)\b/i;
const COMPONENT_PAGE =
  /(?:component time limits|life[ -]limited components|overhaul or replacement schedule)/i;
const SECTION_HEADING =
  /^(?:component time limits|life[ -]limited components|overhaul or replacement schedule|inspection time limits)$/i;
const LIMIT_TEXT =
  /\d[\d,]*\s*[-–]?\s*(?:hours?|hrs?|cycles?|months?|years?)\b/i;
const COMPLEX_RULE =
  /\b(initial|first\s+\d|thereafter|shelf|manufactur(?:e|ed)|storage|whichever (?:occurs )?later|on condition|after .*(?:landing|overhaul)|serial|unless|except|not exceed|percent|cumulative|overhaul.*whichever|whichever.*overhaul|or (?:engine )?overhaul|tolerance|plus or minus)\b/i;

/**
 * An inspection or component limit suggested from a manual page, for a person
 * to review, with the page it came from.
 */
export interface ManualCandidate {
  importId?: string;
  initialHours?: number;
  initialCycles?: number;
  componentDefaults?: Partial<Component>;
  requirementDefaults?: Partial<ComponentRequirement>;
  sourceKey: string;
  name: string;
  kind: "inspection" | "component";
  text: string;
  scheduleText: string;
  hours?: number;
  cycles?: number;
  months?: number;
  warnings: string[];
  reference: ManualReference;
}

/**
 * What a manual applies to: its own applicability, else the model of the
 * aircraft it is filed under.
 *
 * @param manual - The manual.
 * @param aircraft - The aircraft it is filed under, if known.
 * @returns The applicability; undefined when neither is known.
 */
export function manualApplicability(
  manual: Manual,
  aircraft?: Aircraft,
): ManualApplicability | undefined {
  if (manual.applicability) return manual.applicability;
  if (!aircraft?.model) return undefined;
  return {
    kind: "aircraft",
    model: aircraft.model,
    manufacturer: aircraft.make,
    partNumber: "",
  };
}

/**
 * Tells whether an aircraft-model manual applies to an aircraft. Text is
 * compared ignoring case and runs of white space.
 *
 * @param a - The aircraft.
 * @param scope - The manual's applicability.
 * @returns True when the models match and, if the manual names one, the
 *   manufacturer matches the aircraft's make.
 */
export function matchesAircraft(a: Aircraft, scope: ManualApplicability) {
  return (
    scope.kind === "aircraft" &&
    normalize(a.model) === normalize(scope.model) &&
    (!scope.manufacturer || normalize(a.make) === normalize(scope.manufacturer))
  );
}

/**
 * Tells whether a component-model manual applies to a component, compared as
 * {@link matchesAircraft} compares.
 *
 * @param c - The component.
 * @param scope - The manual's applicability.
 * @returns True when the models match and so do the manufacturer and part
 *   number the manual names.
 */
export function matchesComponent(c: Component, scope: ManualApplicability) {
  return (
    scope.kind === "component" &&
    normalize(c.model ?? "") === normalize(scope.model) &&
    (!scope.manufacturer ||
      normalize(c.manufacturer) === normalize(scope.manufacturer)) &&
    (!scope.partNumber ||
      normalize(c.partNumber) === normalize(scope.partNumber))
  );
}

/**
 * Reads hour, cycle and month intervals from a requirement's text. Years
 * count as 12 months. A unit is prefilled only when the text holds exactly
 * one positive value for it and nothing makes the rule ambiguous (a range,
 * several values for one unit, or initial, conditional or age-based wording).
 *
 * @param text - The requirement as printed.
 * @returns Each unit's interval, or undefined; and warnings, in order: one
 *   per day-based value, then range, conditional, cross-reference and
 *   several-values warnings.
 */
export function suggestedIntervals(text: string) {
  const warnings: string[] = [];
  const values = collectIntervals(text, warnings);
  const complex = COMPLEX_RULE.test(text);
  const range =
    /\d\s*[-–]\s*\d+\s*(?:hours?|hrs?|cycles?|months?|years?)\b/i.test(text);
  const repeated = Object.values(values).some((v) => v.size > 1);
  if (range)
    warnings.push(
      "A range of limits was found; select the applicable value manually.",
    );
  if (complex)
    warnings.push(
      "Conditional, initial, or age-based limits need manual interpretation; intervals were not prefilled.",
    );
  if (/\b(refer to|see .*manual|service bulletin)\b/i.test(text))
    warnings.push("Includes a reference to another section or publication.");
  if (repeated)
    warnings.push(
      "Multiple limits found for the same unit; intervals were not prefilled.",
    );
  const ambiguous = complex || range || repeated;
  const single = (v: Set<number>) =>
    !ambiguous && v.size === 1 && [...v][0] > 0 ? [...v][0] : undefined;
  return {
    hours: single(values.hours),
    cycles: single(values.cycles),
    months: single(values.months),
    warnings,
  };
}

/**
 * Suggests the inspections and component limits on one manual page. A phase
 * inspection page ("INSPECTION PHASE n" with "Phase n consists …") yields one
 * phase inspection. Otherwise each numbered entry (with its wrapped lines and
 * notes) or, on an unnumbered page, each matching line that mentions
 * inspection, overhaul, replacement, life limits or lubrication yields one
 * suggestion; on a component time-limits page, any entry with a limit does.
 * Contents entries, section headings and repeated names are skipped.
 *
 * @param manualUuid - The manual.
 * @param pdfPage - The page's number in the PDF.
 * @param text - The page's extracted text.
 * @returns The suggestions in page order, each citing the section and printed
 *   page from the page footer ("5-12-02 Page 1"), with a source key stable
 *   for the same text.
 */
export function discoverPage(
  manualUuid: string,
  pdfPage: number,
  text: string,
): ManualCandidate[] {
  const lines = text
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const clean = lines.join("\n");
  const footer = [
    ...clean.matchAll(/\b(\d{1,2}-\d{2}-\d{2})\s+Page\s+(\S+)/gi),
  ].at(-1);
  const page: Page = {
    manualUuid,
    pdfPage,
    lines,
    clean,
    reference: {
      manualUuid,
      pdfPage,
      section: footer?.[1] ?? "",
      printedPage: footer?.[2] ?? "",
    },
  };
  const phase = discoverPhase(page);
  return phase ? [phase] : discoverEntries(page);
}

interface Page {
  manualUuid: string;
  pdfPage: number;
  lines: string[];
  clean: string;
  reference: ManualReference;
}

function normalize(s: string) {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectIntervals(text: string, warnings: string[]) {
  const values = {
    hours: new Set<number>(),
    cycles: new Set<number>(),
    months: new Set<number>(),
  };
  for (const m of text.matchAll(
    /\b(\d[\d,]*(?:\.\d+)?)\s*[-–]?\s*(?:calendar\s+)?(hours?|hrs?|cycles?|months?|years?|days?)\b/gi,
  )) {
    const n = Number(m[1].replaceAll(",", ""));
    const unit = m[2].toLowerCase();
    if (unit.startsWith("day")) {
      warnings.push("Day-based rule: enter the appropriate schedule manually.");
      continue;
    }
    values[intervalUnit(unit)].add(
      unit.startsWith("y") ? n * MONTHS_PER_YEAR : n,
    );
  }
  return values;
}

function intervalUnit(unit: string): "hours" | "cycles" | "months" {
  if (unit.startsWith("h")) return "hours";
  return unit.startsWith("c") ? "cycles" : "months";
}

function discoverPhase(page: Page): ManualCandidate | undefined {
  const phase = page.clean.match(/\bINSPECTION PHASE\s+([\dA-Z]+)\b/i);
  const description = page.clean.match(
    /(?:[A-Z]\.\s*)?Phase\s+[\dA-Z]+\s+consists\b[^\n]*(?:\n(?![A-Z]\.)(?!\d+\.\s)[^\n]*)*/i,
  )?.[0];
  if (!phase || !description) return undefined;
  const intervals = suggestedIntervals(description);
  return {
    sourceKey: `${page.manualUuid}:${page.pdfPage}:phase-${phase[1]}`,
    name: `Phase ${phase[1]} inspection`,
    kind: "inspection",
    text: page.clean,
    scheduleText: description,
    ...intervals,
    warnings: [
      ...intervals.warnings,
      "Confirm the selected inspection program, phase sequencing and all checklist pages.",
    ],
    reference: page.reference,
  };
}

function discoverEntries(page: Page): ManualCandidate[] {
  const componentPage = COMPONENT_PAGE.test(page.clean);
  const isRelevant = (t: string) =>
    RELEVANT_TEXT.test(t) || (componentPage && LIMIT_TEXT.test(t));
  const blocks = splitEntries(page.lines);
  const candidates = blocks.length > 1 ? blocks : page.lines.filter(isRelevant);
  const seen = new Set<string>();
  return candidates
    .filter((t) => isRelevant(t) && t.length > FRAGMENT_MAX_LENGTH)
    .flatMap((t) => {
      const name = entryName(t);
      if (name === undefined || seen.has(name)) return [];
      seen.add(name);
      const intervals = suggestedIntervals(t);
      return [
        {
          sourceKey: `${page.manualUuid}:${page.pdfPage}:${fingerprint(normalize(t))}`,
          name,
          kind:
            componentPage || COMPONENT_TEXT.test(t)
              ? ("component" as const)
              : ("inspection" as const),
          text: t,
          scheduleText: t,
          ...intervals,
          warnings: [
            ...intervals.warnings,
            "Verify table columns, notes, applicability and continuation pages against the PDF.",
          ],
          reference: page.reference,
        },
      ];
    });
}

// Whole numbered entries keep their wrapped lines and notes together.
function splitEntries(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const starts = ITEM_START.test(line) || /^[A-Z]\.\s/.test(line);
    if (starts && current.length) blocks.push(current.join("\n"));
    if (starts) current = [];
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

// The entry's name, or undefined for contents and index entries (navigation,
// not requirements), section headings, and entries with nothing to schedule.
function entryName(t: string): string | undefined {
  if (
    /\.{3,}/.test(t) ||
    /^\s*(?:table of contents|list of effective pages)/i.test(t)
  )
    return undefined;
  const first = t.split("\n")[0].replace(ITEM_START, "");
  if (!RELEVANT_TEXT.test(first) && !LIMIT_TEXT.test(t)) return undefined;
  if (SECTION_HEADING.test(first)) return undefined;
  return first.slice(0, NAME_MAX_LENGTH);
}

function fingerprint(s: string) {
  let hash = FNV_OFFSET_BASIS;
  for (const c of s) hash = Math.imul(hash ^ c.charCodeAt(0), FNV_PRIME);
  return (hash >>> 0).toString(16);
}
