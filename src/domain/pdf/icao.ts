export interface PdfText {
  str: string;
  x: number;
  y: number;
}
// Coordinates are normalized to the supplied app's A4 ICAO template.
// Box boundaries deliberately exclude adjacent labels and form delimiters.
export function parseIcao(items: PdfText[]) {
  const clean = (s: string) => s.replace(/[─⇒☰<>]/g, "").trim();
  function box(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    compact = false,
  ) {
    const rows = items
      .filter((i) => i.x >= x1 && i.x < x2 && i.y >= y1 && i.y <= y2)
      .sort((a, b) => (Math.abs(a.y - b.y) > 4 ? b.y - a.y : a.x - b.x));
    const result = clean(rows.map((i) => i.str).join(" ")).replace(/\s+/g, " ");
    return compact ? result.replace(/\s/g, "") : result;
  }
  if (
    !items.some((i) => i.str.includes("ICAO FLIGHT PLAN")) ||
    !items.some((i) => i.str.includes("TOTAL EET"))
  )
    throw new Error(
      "This is not the supported ICAO flight-plan PDF. Upload the original text PDF from your planning app.",
    );
  const otherInformation = box(30, 365, 550, 406);
  const date = /\bDOF\/(\d{2})(\d{2})(\d{2})\b/.exec(otherInformation);
  const time = box(230, 549, 305, 561, true);
  const hhmm = (s: string) =>
    /^\d{4}$/.test(s) && Number(s.slice(2)) < 60
      ? Number(s.slice(0, 2)) * 60 + Number(s.slice(2))
      : undefined;
  const departureAt =
    date && /^([01]\d|2[0-3])[0-5]\d$/.test(time)
      ? `20${date[1]}-${date[2]}-${date[3]}T${time.slice(0, 2)}:${time.slice(2)}:00Z`
      : "";
  const rawRules = box(406, 612, 437, 623, true);
  const flightRules = ["I", "V", "Y", "Z"].find((r) => r === rawRules) as
    "I" | "V" | "Y" | "Z" | undefined;
  const persons = box(216, 297, 275, 308, true);
  return {
    registration: box(189, 612, 310, 623, true),
    aircraftType: box(148, 578, 235, 590, true),
    flightType: box(496, 612, 525, 623, true),
    flightRules,
    departureAt,
    origin: box(85, 549, 218, 561, true),
    destination: box(95, 425, 220, 437, true),
    alternate: box(350, 425, 425, 437, true),
    durationMinutes: hhmm(box(233, 425, 311, 437, true)),
    speed: box(59, 522, 136, 534, true),
    level: box(141, 522, 210, 534, true),
    route: [box(232, 522, 550, 535), box(30, 479, 550, 519)]
      .filter(Boolean)
      .join(" "),
    enduranceMinutes: hhmm(box(88, 297, 162, 308, true)),
    personsOnBoard: /^\d{1,3}$/.test(persons) ? Number(persons) : undefined,
    pilotText: box(88, 138, 345, 151),
    equipment: box(367, 578, 525, 590),
    otherInformation,
  };
}
export type ParsedPlan = ReturnType<typeof parseIcao>;
