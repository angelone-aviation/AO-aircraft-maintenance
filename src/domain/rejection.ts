/**
 * Responsibility: The one error class for a refusal written for the user.
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
