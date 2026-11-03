import type { Manual, ManualApplicability, ManualReference } from "./manuals";
import type { Aircraft } from "./model";
import type { Component, ComponentRequirement } from "./components";

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
const normalized = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
export function manualApplicability(
  manual: Manual,
  aircraft?: Aircraft,
): ManualApplicability | undefined {
  return (
    manual.applicability ??
    (aircraft?.model
      ? {
          kind: "aircraft",
          model: aircraft.model,
          manufacturer: aircraft.make,
          partNumber: "",
        }
      : undefined)
  );
}
export function matchesAircraft(a: Aircraft, scope: ManualApplicability) {
  return (
    scope.kind === "aircraft" &&
    normalized(a.model) === normalized(scope.model) &&
    (!scope.manufacturer ||
      normalized(a.make) === normalized(scope.manufacturer))
  );
}
export function matchesComponent(c: Component, scope: ManualApplicability) {
  return (
    scope.kind === "component" &&
    normalized(c.model ?? "") === normalized(scope.model) &&
    (!scope.manufacturer ||
      normalized(c.manufacturer) === normalized(scope.manufacturer)) &&
    (!scope.partNumber ||
      normalized(c.partNumber) === normalized(scope.partNumber))
  );
}

// Extract suggestions, never authoritative schedules. Ambiguous numbers stay in source text.
export function suggestedIntervals(text: string) {
  const warnings: string[] = [];
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
    const k = unit.startsWith("h")
      ? "hours"
      : unit.startsWith("c")
        ? "cycles"
        : "months";
    values[k].add(unit.startsWith("y") ? n * 12 : n);
  }
  const complex =
    /\b(initial|first\s+\d|thereafter|shelf|manufactur(?:e|ed)|storage|whichever (?:occurs )?later|on condition|after .*(?:landing|overhaul)|serial|unless|except|not exceed|percent|cumulative|overhaul.*whichever|whichever.*overhaul|or (?:engine )?overhaul|tolerance|plus or minus)\b/i.test(
      text,
    );
  const range =
    /\d\s*[-–]\s*\d+\s*(?:hours?|hrs?|cycles?|months?|years?)\b/i.test(text);
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
  if (Object.values(values).some((v) => v.size > 1))
    warnings.push(
      "Multiple limits found for the same unit; intervals were not prefilled.",
    );
  const ambiguous =
    complex || range || Object.values(values).some((v) => v.size > 1);
  const single = (v: Set<number>) =>
    !ambiguous && v.size === 1 && [...v][0] > 0 ? [...v][0] : undefined;
  return {
    hours: single(values.hours),
    cycles: single(values.cycles),
    months: single(values.months),
    warnings,
  };
}
const itemStart = /^(?:\(\d+\)|\d{1,2}[.)]|[A-Z]\d{5,}|[-•])\s*/;
const relevant =
  /\b(inspect\w*|phase\s+[\dA-Z]+|overhaul|replace\w*|life[ -]limit\w*|time limits?|retirement|lubricat\w*|service interval)\b/i;
const component =
  /\b(life[ -]limit\w*|overhaul|replace\w*|retirement|shelf life)\b/i;
function fingerprint(s: string) {
  let hash = 2166136261;
  for (const c of s) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
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
  const reference = {
    manualUuid,
    pdfPage,
    section: footer?.[1] ?? "",
    printedPage: footer?.[2] ?? "",
  };
  const phase = clean.match(/\bINSPECTION PHASE\s+([\dA-Z]+)\b/i);
  const description = clean.match(
    /(?:[A-Z]\.\s*)?Phase\s+[\dA-Z]+\s+consists\b[^\n]*(?:\n(?![A-Z]\.)(?!\d+\.\s)[^\n]*)*/i,
  )?.[0];
  if (phase && description) {
    const intervals = suggestedIntervals(description);
    return [
      {
        sourceKey: `${manualUuid}:${pdfPage}:phase-${phase[1]}`,
        name: `Phase ${phase[1]} inspection`,
        kind: "inspection",
        text: clean,
        scheduleText: description,
        ...intervals,
        warnings: [
          ...intervals.warnings,
          "Confirm the selected inspection program, phase sequencing and all checklist pages.",
        ],
        reference,
      },
    ];
  }
  // Preserve whole numbered entries, including wrapped lines and notes. Unnumbered
  // pages fall back to individual matching lines with neighboring context.
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (itemStart.test(line) || /^[A-Z]\.\s/.test(line)) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  const componentPage =
    /(?:component time limits|life[ -]limited components|overhaul or replacement schedule)/i.test(
      clean,
    );
  const hasLimit = (t: string) =>
    /\d[\d,]*\s*[-–]?\s*(?:hours?|hrs?|cycles?|months?|years?)\b/i.test(t);
  const isRelevant = (t: string) =>
    relevant.test(t) || (componentPage && hasLimit(t));
  const candidates = blocks.length > 1 ? blocks : lines.filter(isRelevant);
  const seen = new Set<string>();
  return candidates
    .filter((t) => isRelevant(t) && t.length > 12)
    .flatMap((t) => {
      // Contents/index entries are navigation, not maintenance requirements.
      if (
        /\.{3,}/.test(t) ||
        /^\s*(?:table of contents|list of effective pages)/i.test(t)
      )
        return [];
      const first = t.split("\n")[0].replace(itemStart, "");
      if (!relevant.test(first) && !hasLimit(t)) return [];
      if (
        /^(?:component time limits|life[ -]limited components|overhaul or replacement schedule|inspection time limits)$/i.test(
          first,
        )
      )
        return [];
      const name = first.slice(0, 200);
      if (seen.has(name)) return [];
      seen.add(name);
      const intervals = suggestedIntervals(t);
      return [
        {
          sourceKey: `${manualUuid}:${pdfPage}:${fingerprint(normalized(t))}`,
          name,
          kind:
            componentPage || component.test(t)
              ? ("component" as const)
              : ("inspection" as const),
          text: t,
          scheduleText: t,
          ...intervals,
          warnings: [
            ...intervals.warnings,
            "Verify table columns, notes, applicability and continuation pages against the PDF.",
          ],
          reference,
        },
      ];
    });
}
