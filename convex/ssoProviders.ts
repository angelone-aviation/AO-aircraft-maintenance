// Google and Microsoft sign-in providers (ADR-0009). Each is configured only
// when its sign-in client's credentials are set on the deployment, so the app
// runs unchanged, password only, until the organization creates them. Setup:
// docs/runbooks/accounts.md#google-and-microsoft-sign-in. No Convex functions.
import Google from "@auth/core/providers/google";
import MicrosoftEntraID from "@auth/core/providers/microsoft-entra-id";
import { customFetch } from "@auth/core";
import * as oauth from "oauth4webapi";
import {
  GOOGLE,
  MICROSOFT,
  googleProfile,
  microsoftProfile,
  type SsoProvider,
} from "../src/domain/signInMethods";

type Env = Record<string, string | undefined>;
const configured = (env: Env, ...names: string[]) =>
  names.every((name) => !!env[name]?.trim());

export function enabledSsoProviders(env: Env = process.env): SsoProvider[] {
  return [
    ...(configured(env, "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET")
      ? [GOOGLE as SsoProvider]
      : []),
    ...(configured(
      env,
      "AUTH_MICROSOFT_ENTRA_ID_ID",
      "AUTH_MICROSOFT_ENTRA_ID_SECRET",
      "AUTH_MICROSOFT_ENTRA_ID_ISSUER",
    )
      ? [MICROSOFT as SsoProvider]
      : []),
  ];
}

/** The configured providers, for convexAuth(). The client id and secret are
 * read from the same variables by the library. */
export function ssoProviders(env: Env = process.env) {
  return enabledSsoProviders(env).map((id) =>
    id === GOOGLE
      ? Google({ profile: (claims) => googleProfile(claims) })
      : microsoft(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER!.trim()),
  );
}

function microsoft(issuer: string) {
  const provider = MicrosoftEntraID({
    issuer,
    // No Microsoft Graph scope: profile() reads only the ID token's claims.
    authorization: { params: { scope: "openid profile email" } },
    checks: ["pkce", "nonce"],
    profile: (claims) =>
      microsoftProfile(claims as unknown as Record<string, unknown>),
  });
  const discover = provider[customFetch]!;
  provider[customFetch] = (async (...args: Parameters<typeof fetch>) =>
    microsoftMetadata(await discover(...args), args[0])) as typeof fetch;
  return provider;
}

// oauth4webapi checks an ID token's issuer against this function when the
// server metadata has it. Not in its type declarations; a test fails if a
// dependency update removes it.
export const EXPECTED_ISSUER = (
  oauth as unknown as { _expectedIssuer?: symbol }
)._expectedIssuer;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The issuer a Microsoft ID token must name: its own tenant's. */
export function microsoftTenantIssuer(claims: Record<string, unknown>) {
  return typeof claims.tid === "string" && GUID.test(claims.tid)
    ? `https://login.microsoftonline.com/${claims.tid}/v2.0`
    : undefined;
}

/** Corrects Microsoft's discovery document for the sign-in library:
 * - Microsoft supports PKCE but does not list it, and the library otherwise
 *   sends a placeholder code verifier Microsoft rejects (convex-auth #457);
 * - with the multi-tenant issuer (`/common/v2.0`) every token names its own
 *   tenant as issuer, which the library would refuse; Microsoft's guidance for
 *   multi-tenant apps is to expect the issuer of the token's `tid`. */
export async function microsoftMetadata(
  response: Response,
  input: Parameters<typeof fetch>[0],
) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.pathname.endsWith("/.well-known/openid-configuration"))
    return response;
  if (!response.ok) return response;
  const metadata = (await response.json()) as Record<string, unknown> & {
    issuer: string;
    code_challenge_methods_supported?: string[];
  };
  const multiTenant = /\/(common|organizations)\/v2\.0\/?$/.test(
    metadata.issuer,
  );
  const server: Record<string | symbol, unknown> = {
    ...metadata,
    code_challenge_methods_supported: [
      ...new Set([
        ...(metadata.code_challenge_methods_supported ?? []),
        "S256",
      ]),
    ],
  };
  if (multiTenant && EXPECTED_ISSUER)
    server[EXPECTED_ISSUER] = (result: { claims: Record<string, unknown> }) =>
      microsoftTenantIssuer(result.claims) ?? metadata.issuer;
  const corrected = Response.json(server);
  // oauth4webapi keeps the object response.json() returns as the server
  // metadata; JSON cannot carry the issuer check.
  Object.defineProperty(corrected, "json", { value: async () => server });
  return corrected;
}
