/**
 * Responsibility: The text a user sees for a failed command, load or sync.
 * Layer: Data. Pure function over a thrown value; no I/O, no React.
 * Dependencies: convex/values, zod, src/domain/validationText.ts,
 *   src/domain/rejection.ts.
 *
 * Production puts only "Server Error" in a plain server Error, behind the
 * Convex client's "[CONVEX …]" wrapper; a refusal travels in ConvexError data.
 * A ZodError's message is its issue list as JSON, so its issues are read.
 */
import { ConvexError } from "convex/values";
import { ZodError } from "zod";
import { validationText } from "../domain/validationText";
import { STALE_RECORD_MESSAGE } from "../domain/rejection";

/**
 * How the Convex client's message for a failed function starts, as in
 * "[CONVEX M(workOrders:save)] [Request ID: 1a2b] Server Error".
 */
export const CONVEX_FAILURE_PREFIX = "[CONVEX ";
const DEFAULT_ERROR_TEXT =
  "Something went wrong. Try again, and tell an administrator if it keeps happening.";

/**
 * The text to show a user for a failed command, load or sync: the refusal or
 * validation messages, never the Convex client's wrapper or zod's JSON.
 *
 * @param fallback - Shown when the error has no text a user should read.
 * @returns A ConvexError's `data` when it is a string, or `data.message` when
 *   that is; a ZodError's {@link validationText};
 *   otherwise the fallback for a "[CONVEX …]" message, a ZodError without
 *   issues or a value that is not an Error; otherwise the Error's own message.
 */
export function errorText(
  error: unknown,
  fallback = DEFAULT_ERROR_TEXT,
): string {
  const refusal = refusalText(error);
  if (refusal !== undefined) return refusal;
  // The browser build resolves "zod" to src/cspSafeZod.ts, which re-exports
  // the same zod/v4 ZodError; its instanceof checks zod's traits, not a class.
  if (error instanceof ZodError) return validationText(error) || fallback;
  if (!(error instanceof Error)) return fallback;
  return error.message.startsWith(CONVEX_FAILURE_PREFIX)
    ? fallback
    : error.message;
}

/**
 * Whether a failed save was refused because the record changed since the
 * form loaded it: the domain's StaleRecordRejection in the demo, or the
 * server's ConvexError carrying the same message.
 *
 * @param error - The failure from a Backend command.
 * @returns True for a stale save, which a screen reviews instead of printing.
 */
export function isStaleSave(error: unknown) {
  return errorText(error) === STALE_RECORD_MESSAGE;
}

function refusalText(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data: unknown = error.data;
  if (typeof data === "string") return data;
  if (typeof data !== "object" || data === null || !("message" in data))
    return undefined;
  return typeof data.message === "string" ? data.message : undefined;
}
