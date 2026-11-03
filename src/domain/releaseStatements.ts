/**
 * Responsibility: A user's release statements: the named return-to-service
 *   wordings offered at work-order close-out, and the starter set.
 * Layer: Domain. Pure zod schema and data; no I/O, no React.
 * Dependencies: zod. No internal imports.
 */
import { z } from "zod";

/**
 * A user's release statements, as saved to their account. Trims each label
 * and text.
 *
 * @throws {z.ZodError} From `parse()` on a blank label or text, a label over
 *   200 or a text over 10,000 characters, more than 100 statements, or two
 *   labels that match ignoring case ("Use a unique name for each release
 *   statement.").
 */
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

/** One named release statement. */
export type ReleaseStatement = z.infer<typeof releaseStatementsSchema>[number];

/**
 * The starter statements shown until a user saves their own. The annual
 * inspection text keeps a fixed date, October 2, 2026, for the user to edit.
 */
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
