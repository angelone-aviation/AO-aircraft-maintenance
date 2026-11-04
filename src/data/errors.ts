/**
 * Responsibility: The text a user sees for a failed command, load or sync.
 * Layer: Data. Pure function over a thrown value; no I/O, no React.
 * Dependencies: convex/values.
 *
 * Production puts only "Server Error" in a plain server Error, behind the
 * Convex client's "[CONVEX …]" wrapper; a refusal travels in ConvexError data.
 */
import { ConvexError } from "convex/values";

/**
 * How the Convex client's message for a failed function starts, as in
 * "[CONVEX M(workOrders:save)] [Request ID: 1a2b] Server Error".
 */
export const CONVEX_FAILURE_PREFIX = "[CONVEX ";
const DEFAULT_ERROR_TEXT =
  "Something went wrong. Try again, and tell an administrator if it keeps happening.";

/**
 * The text to show a user for a failed command, load or sync: the server's
 * refusal, never the Convex client's "[CONVEX …]" wrapper around it.
 *
 * @param fallback - Shown when the error has no text a user should read.
 * @returns A ConvexError's `data` when it is a string, or `data.message` when
 *   that is; otherwise the fallback for a "[CONVEX …]" message or a value that
 *   is not an Error; otherwise the Error's own message.
 */
export function errorText(
  error: unknown,
  fallback = DEFAULT_ERROR_TEXT,
): string {
  const refusal = refusalText(error);
  if (refusal !== undefined) return refusal;
  if (!(error instanceof Error)) return fallback;
  return error.message.startsWith(CONVEX_FAILURE_PREFIX)
    ? fallback
    : error.message;
}

function refusalText(error: unknown): string | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data: unknown = error.data;
  if (typeof data === "string") return data;
  if (typeof data !== "object" || data === null || !("message" in data))
    return undefined;
  return typeof data.message === "string" ? data.message : undefined;
}
