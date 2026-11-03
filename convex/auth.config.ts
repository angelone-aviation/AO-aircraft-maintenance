/**
 * Responsibility: Tells Convex which sign-in tokens to trust: those this
 *   deployment's own Convex Auth issues.
 * Layer: Config. Read by the Convex deployment; no runtime logic.
 * Dependencies: none. CONVEX_SITE_URL is set by Convex itself.
 */

/** Trusts tokens issued at this deployment's site URL for audience "convex". */
export default {
  providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: "convex" }],
};
