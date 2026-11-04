/**
 * Responsibility: The text a user reads for a refused zod validation.
 * Layer: Domain. Pure function; no I/O, no React.
 * Dependencies: zod (types).
 *
 * A ZodError's own message is its issue list as JSON, never fit to show, so
 * the browser (errorText) and the domain read its issues through this rule.
 */
import type { ZodError } from "zod";

/**
 * The text of a refused validation: each issue message once, in issue order,
 * one per line.
 *
 * @param error - The refusal a schema's `parse()` threw.
 * @returns That text; "" for an error without issues.
 */
export function validationText(error: ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.message))].join("\n");
}
