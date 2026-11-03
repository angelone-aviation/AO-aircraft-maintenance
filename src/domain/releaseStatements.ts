import { z } from "zod";

export const releaseStatementsSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(10000),
    }),
  )
  .max(100)
  .refine(
    (items) =>
      new Set(items.map((item) => item.label.toLowerCase())).size ===
      items.length,
    "Use a unique name for each release statement.",
  );
export type ReleaseStatement = z.infer<typeof releaseStatementsSchema>[number];
export const defaultReleaseStatements: ReleaseStatement[] = [
  {
    label: "Manufacturer’s inspection program — return to service",
    text: "I certify that this aircraft has been inspected in accordance with the manufacturer's inspection program and is approved for return to service.",
  },
  {
    label: "Maintenance — return to service",
    text: "I certify that the maintenance listed above was performed in accordance with current Federal Aviation Regulations and is approved for return to service.",
  },
  {
    label: "100-hour inspection — airworthy",
    text: "I certify that this aircraft has been inspected in accordance with a 100-hour inspection and was determined to be in airworthy condition.",
  },
  {
    label: "Annual inspection — discrepancies provided",
    text: "I certify that this aircraft has been inspected in accordance with an annual inspection and a list of discrepancies and unairworthy items dated October 2, 2026, has been provided for the aircraft owner or operator.",
  },
  {
    label: "Alteration / repair — return to service",
    text: "I certify that the data altered or repaired conforms to the Federal Aviation Regulations and is approved for return to service.",
  },
];
