/**
 * Responsibility: The error classes for a refusal written for the user: the
 *   general Rejection and the stale save, refused when a record changed since
 *   the form loaded it.
 * Layer: Domain. No I/O, no React.
 * Dependencies: none.
 *
 * Convex production deployments show any error that is not a ConvexError as
 * "Server Error". The server rethrows a Rejection as a ConvexError, so the
 * class, not each mutation, decides that the message reaches the user.
 */

/**
 * A command refused by a domain rule (a stale record, a broken limit), with a
 * message the user can act on. Errors of any other class are treated as faults
 * and stay hidden in production.
 */
export class Rejection extends Error {}

/**
 * The one message every stale save shows, so a screen can recognise it
 * (`isStaleSave` in src/data/errors.ts) and open the review dialog instead
 * of printing it.
 */
export const STALE_RECORD_MESSAGE =
  "This record was changed by someone else. Review the differences.";

/**
 * A save refused because the record's version is not the one the form
 * loaded: someone else saved in between (GLOSSARY "Stale save"). The record
 * is never overwritten; the user reviews the differences and decides.
 *
 * @param recordKind - The record's kind, for diagnosis (never shown).
 * @param currentVersion - The version stored now, to re-submit against.
 */
export class StaleRecordRejection extends Rejection {
  readonly recordKind: string;
  readonly currentVersion: number;
  constructor(recordKind: string, currentVersion: number) {
    super(STALE_RECORD_MESSAGE);
    this.recordKind = recordKind;
    this.currentVersion = currentVersion;
  }
}
