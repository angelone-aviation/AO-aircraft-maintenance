/**
 * Responsibility: Shows a domain Rejection or a zod refusal to the user from
 *   a server function that does not run through runCommand.
 * Layer: Server. A helper for Convex functions; it decides no rule itself.
 * Dependencies: convex/values, zod, src/domain (rejection, validationText).
 *
 * Production shows any error but a ConvexError as "Server Error", and a
 * Rejection does not keep its class across a nested runQuery or runMutation,
 * so wrap the call where the domain check runs.
 */
import { ConvexError } from "convex/values";
import { ZodError } from "zod";
import { Rejection } from "../src/domain/rejection";
import { validationText } from "../src/domain/validationText";

/**
 * Runs a domain check, or awaits domain work, showing its refusal to the user.
 *
 * @param work - A function to run (awaited if it returns a promise), or a
 *   promise to await.
 * @returns What `work` returns or resolves to.
 * @throws {ConvexError} A Rejection's message, or a ZodError's
 *   {@link validationText} (the text the browser shows for it), as its data.
 *   Any other error passes through unchanged, so production keeps it hidden.
 */
export function exposeRejections<T>(work: Promise<T>): Promise<T>;
export function exposeRejections<T>(work: () => T): T;
export function exposeRejections<T>(work: Promise<T> | (() => T)) {
  try {
    const result = typeof work === "function" ? work() : work;
    return result instanceof Promise ? result.catch(rethrowExposed) : result;
  } catch (error) {
    return rethrowExposed(error);
  }
}

function rethrowExposed(error: unknown): never {
  const message = refusalText(error);
  throw message === undefined ? error : new ConvexError(message);
}

function refusalText(error: unknown) {
  if (error instanceof Rejection) return error.message;
  if (error instanceof ZodError) return validationText(error) || undefined;
  return undefined;
}
