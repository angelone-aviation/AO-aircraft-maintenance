/**
 * Responsibility: Refuses a production build inside Cloudflare's Git builder
 *   (Workers Builds), so that builder can never publish the site.
 * Layer: Script. Read by vite.config.ts at build time; nothing here ships.
 * Dependencies: none.
 *
 * On 20 Nov 2026 Workers Builds built `main` without VITE_CONVEX_URL and
 * published it, and production showed "Configuration error" for about 30
 * minutes until the Deploy workflow replaced it (docs/runbooks/release.md).
 */

/**
 * Set to "1" in every Workers Builds build ("Default variables",
 * https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
 */
export const WORKERS_BUILDS_VARIABLE = "WORKERS_CI";

/** Why a build in Cloudflare's Git builder is refused. */
export const CLOUDFLARE_BUILD_REFUSAL =
  "This site is published only by the GitHub Deploy workflow (docs/runbooks/release.md); Cloudflare's Git build must stay disconnected.";

/**
 * Stops a build that runs inside Cloudflare's Git builder.
 *
 * @param env - The build's environment variables.
 * @throws {Error} {@link CLOUDFLARE_BUILD_REFUSAL} when
 *   {@link WORKERS_BUILDS_VARIABLE} is set to any non-empty value.
 */
export function assertNotCloudflareGitBuild(
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env[WORKERS_BUILDS_VARIABLE]) throw new Error(CLOUDFLARE_BUILD_REFUSAL);
}
