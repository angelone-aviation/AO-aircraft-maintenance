/**
 * Responsibility: Builds the Google and Microsoft sign-in providers that the
 *   deployment's environment configures (ADR-0009).
 * Layer: Server. Auth configuration for convexAuth(); no Convex functions.
 * Dependencies: @auth/core, oauth4webapi, src/domain/signInMethods.
 *
 * A provider exists only once all its credentials are set, so the app runs
 * password-only until the organization creates them. Setup:
 * docs/runbooks/accounts.md#google-and-microsoft-sign-in.
 */
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

type DiscoveryDocument = Record<string, unknown> & {
  issuer: string;
  code_challenge_methods_supported?: string[];
};

// Auth.js reads the client id and secret from these same variables.
const GOOGLE_CREDENTIALS = ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"];
const MICROSOFT_CREDENTIALS = [
  "AUTH_MICROSOFT_ENTRA_ID_ID",
  "AUTH_MICROSOFT_ENTRA_ID_SECRET",
  "AUTH_MICROSOFT_ENTRA_ID_ISSUER",
];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MULTI_TENANT_ISSUER = /\/(common|organizations)\/v2\.0\/?$/;

/**
 * Lists the sign-in providers whose credentials are all set and not blank.
 *
 * @param env - Environment variables; defaults to the deployment's.
 * @returns Google, then Microsoft, each only when configured.
 */
export function enabledSsoProviders(env: Env = process.env): SsoProvider[] {
  const enabled: SsoProvider[] = [];
  if (isConfigured(env, GOOGLE_CREDENTIALS)) enabled.push(GOOGLE);
  if (isConfigured(env, MICROSOFT_CREDENTIALS)) enabled.push(MICROSOFT);
  return enabled;
}

/**
 * Builds the {@link enabledSsoProviders} for convexAuth(), with the app's
 * profile mapping and Microsoft's discovery fix ({@link microsoftMetadata}).
 *
 * @param env - Environment variables; defaults to the deployment's.
 * @returns One Auth.js provider per enabled sign-in method.
 */
export function ssoProviders(env: Env = process.env) {
  return enabledSsoProviders(env).map((id) =>
    id === GOOGLE
      ? Google({ profile: (claims) => googleProfile(claims) })
      : buildMicrosoft(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER!.trim()),
  );
}

/**
 * oauth4webapi's hook that checks an ID token's issuer when server metadata
 * carries it. It is not in the library's types, so a test fails if a
 * dependency update removes it.
 */
export const EXPECTED_ISSUER = (
  oauth as unknown as { _expectedIssuer?: symbol }
)._expectedIssuer;

/**
 * Names the issuer a Microsoft ID token must carry: its own tenant's.
 *
 * @param claims - The ID token's claims.
 * @returns `https://login.microsoftonline.com/<tid>/v2.0`, or undefined when
 *   `tid` is not a GUID, so a crafted tenant cannot change the URL's path.
 */
export function microsoftTenantIssuer(
  claims: Record<string, unknown>,
): string | undefined {
  return typeof claims.tid === "string" && GUID.test(claims.tid)
    ? `https://login.microsoftonline.com/${claims.tid}/v2.0`
    : undefined;
}

/**
 * Corrects Microsoft's discovery document for the sign-in library. It adds
 * S256, which Microsoft supports but does not list (else the library sends a
 * placeholder verifier Microsoft rejects, convex-auth #457). For a
 * multi-tenant issuer, where each token names its own tenant, it expects the
 * issuer of the token's `tid` as Microsoft advises, or else the metadata's.
 *
 * @param response - The response the library fetched.
 * @param input - The URL it fetched.
 * @returns `response` unchanged unless it is a successful
 *   `/.well-known/openid-configuration` fetch; else a corrected copy.
 */
export async function microsoftMetadata(
  response: Response,
  input: Parameters<typeof fetch>[0],
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.pathname.endsWith("/.well-known/openid-configuration"))
    return response;
  if (!response.ok) return response;
  const metadata = (await response.json()) as DiscoveryDocument;
  const server: Record<string | symbol, unknown> = {
    ...metadata,
    code_challenge_methods_supported: [
      ...new Set([
        ...(metadata.code_challenge_methods_supported ?? []),
        "S256",
      ]),
    ],
  };
  if (MULTI_TENANT_ISSUER.test(metadata.issuer) && EXPECTED_ISSUER)
    server[EXPECTED_ISSUER] = (result: { claims: Record<string, unknown> }) =>
      microsoftTenantIssuer(result.claims) ?? metadata.issuer;
  const corrected = Response.json(server);
  // oauth4webapi keeps the object response.json() returns as the server
  // metadata; JSON cannot carry the issuer check.
  Object.defineProperty(corrected, "json", { value: async () => server });
  return corrected;
}

function isConfigured(env: Env, names: string[]): boolean {
  return names.every((name) => !!env[name]?.trim());
}

function buildMicrosoft(issuer: string) {
  const provider = MicrosoftEntraID({
    issuer,
    // No Microsoft Graph scope: profile() reads only the ID token's claims.
    authorization: { params: { scope: "openid profile email" } },
    checks: ["pkce", "nonce"],
    profile: (claims) =>
      microsoftProfile(claims as unknown as Record<string, unknown>),
  });
  // Auth.js fetches the discovery document through this hook.
  const discover = provider[customFetch]!;
  provider[customFetch] = (async (...args: Parameters<typeof fetch>) =>
    microsoftMetadata(await discover(...args), args[0])) as typeof fetch;
  return provider;
}
