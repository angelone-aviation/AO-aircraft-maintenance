/**
 * Responsibility: The ATA chapter catalog that maintenance records are filed
 *   under, and how a chapter is labelled.
 * Layer: Domain. Pure data, zod schema and function; no I/O, no React.
 * Dependencies: zod. No internal imports.
 *
 * The owner's chapter list, not the full ATA index. Stored payloads and
 * convex/schema.ts validate against these codes, so a code can be added but
 * not removed or renamed while a record uses it.
 */
import { z } from "zod";

/**
 * The chapters offered for selection, grouped as the chapter picker shows them.
 * Codes are strings so leading zeros survive ("05", not 5).
 */
export const ATA_GROUPS = [
  {
    label: "Aircraft General (00–18)",
    chapters: [
      ["00", "General"],
      ["01", "Maintenance Policy"],
      ["02", "Operations"],
      ["03", "Support"],
      ["04", "Airworthiness Limitations"],
      ["05", "Time Limits / Maintenance Checks"],
      ["06", "Dimensions and Areas"],
      ["07", "Lifting and Shoring"],
      ["08", "Leveling and Weighing"],
      ["09", "Towing and Taxiing"],
      ["10", "Parking, Mooring, Storage and Return to Service"],
      ["11", "Placards and Markings"],
      ["12", "Servicing"],
      ["13", "Hardware and General Tools"],
      ["14", "Reserved"],
      ["15", "Aircrew Information"],
      ["16", "Change of Role"],
      ["18", "Vibration and Noise Analysis (Helicopter Only)"],
    ],
  },
  {
    label: "Aircraft Systems (20–49)",
    chapters: [
      ["20", "Standard Practices – Airframe"],
      ["21", "Air Conditioning"],
      ["22", "Auto Flight"],
      ["23", "Communications"],
      ["24", "Electrical Power"],
      ["25", "Equipment / Furnishings"],
      ["26", "Fire Protection"],
      ["27", "Flight Controls"],
      ["28", "Fuel"],
      ["29", "Hydraulic Power"],
      ["30", "Ice and Rain Protection"],
      ["31", "Indicating / Recording Systems"],
      ["32", "Landing Gear"],
      ["33", "Lights"],
      ["34", "Navigation"],
      ["35", "Oxygen"],
      ["36", "Pneumatic"],
      ["37", "Vacuum"],
      ["38", "Water / Waste"],
      ["39", "Electrical / Electronic Panels"],
      ["40", "Multisystem or Reserved"],
      ["41", "Water Ballast"],
      ["42", "Integrated Avionics"],
      ["44", "Cabin Systems"],
      ["45", "Central Maintenance System (OMS)"],
      ["46", "Information Systems"],
      ["47", "Inert Gas System"],
      ["48", "Fuel Dispensing System"],
      ["49", "Auxiliary Power Unit (APU)"],
    ],
  },
  {
    label: "Structures (50–57)",
    chapters: [
      ["50", "Cargo and Baggage Compartments"],
      ["51", "Standard Practices and Structures – General"],
      ["52", "Doors"],
      ["53", "Fuselage"],
      ["54", "Nacelles / Pylons"],
      ["55", "Stabilizers"],
      ["56", "Windows"],
      ["57", "Wings"],
    ],
  },
  {
    label: "Propeller / Rotor (60–67)",
    chapters: [
      ["60", "Standard Practices – Propeller / Rotor"],
      ["61", "Propellers"],
      ["62", "Main Rotors"],
      ["63", "Main Rotor Drives"],
      ["64", "Tail Rotor"],
      ["65", "Tail Rotor Drive"],
      ["66", "Folding Blades and Pylons"],
      ["67", "Rotor Flight Controls"],
    ],
  },
  {
    label: "Power Plant (70–84)",
    chapters: [
      ["70", "Standard Practices – Engine"],
      ["71", "Power Plant – General"],
      ["72", "Engine – Turbine / Reciprocating"],
      ["73", "Engine Fuel and Control"],
      ["74", "Ignition"],
      ["75", "Bleed Air"],
      ["76", "Engine Controls"],
      ["77", "Engine Indicating"],
      ["78", "Exhaust"],
      ["79", "Oil"],
      ["80", "Starting"],
      ["81", "Turbines (Reciprocating Engines)"],
      ["82", "Water Injection"],
      ["83", "Accessory Gearboxes"],
      ["84", "Propulsion Augmentation"],
    ],
  },
] as const;

/** Every `[code, title]` pair of {@link ATA_GROUPS}, in group order. */
export const ATA_CHAPTERS = ATA_GROUPS.flatMap((group) => [...group.chapters]);

/**
 * A chapter code as stored on a record.
 *
 * @throws {z.ZodError} From `parse()` on a code outside the catalog.
 */
export const ataChapterSchema = z.enum(ATA_CHAPTERS.map(([code]) => code));

/** A catalog chapter code, such as "05". */
export type AtaChapter = z.infer<typeof ataChapterSchema>;

/**
 * Names a record's chapter for display.
 *
 * @param code - The record's chapter, if it has one.
 * @returns "ATA <code>: <title>", or "Unassigned" when there is no chapter.
 */
export function ataLabel(code?: AtaChapter): string {
  const chapter = ATA_CHAPTERS.find(([value]) => value === code);
  return chapter ? `ATA ${chapter[0]}: ${chapter[1]}` : "Unassigned";
}
