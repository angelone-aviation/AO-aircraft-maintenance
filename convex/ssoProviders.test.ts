/**
 * Responsibility: Pins how Microsoft's discovery document is corrected for the
 *   sign-in library.
 * Layer: Test. Vitest, no Convex backend.
 * Dependencies: convex/ssoProviders, src/domain/signInMethods.
 */
import { expect, it } from "vitest";
import { EXPECTED_ISSUER, microsoftMetadata } from "./ssoProviders";
import { MICROSOFT_PERSONAL_TENANT } from "../src/domain/signInMethods";

const DISCOVERY =
  "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration";

type IssuerCheck = (result: { claims: Record<string, unknown> }) => string;

async function corrected(
  metadata: Record<string, unknown>,
  input: string | Request = DISCOVERY,
) {
  const response = await microsoftMetadata(Response.json(metadata), input);
  return (await response.json()) as Record<string | symbol, unknown>;
}

it("returns other fetches and failed discovery responses unchanged", async () => {
  const token = Response.json({ access_token: "x" });
  expect(
    await microsoftMetadata(token, "https://login.microsoftonline.com/token"),
  ).toBe(token);
  const failed = new Response("down", { status: 503 });
  expect(await microsoftMetadata(failed, DISCOVERY)).toBe(failed);
});

it("adds S256 to the listed PKCE methods once", async () => {
  const issuer = "https://login.microsoftonline.com/common/v2.0";
  expect(
    (await corrected({ issuer })).code_challenge_methods_supported,
  ).toEqual(["S256"]);
  expect(
    (
      await corrected(
        { issuer, code_challenge_methods_supported: ["plain", "S256"] },
        new Request(DISCOVERY),
      )
    ).code_challenge_methods_supported,
  ).toEqual(["plain", "S256"]);
});

it("expects a multi-tenant token's own tenant issuer, or else the metadata's", async () => {
  for (const tenant of ["common", "organizations"]) {
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    const check = (await corrected({ issuer }))[
      EXPECTED_ISSUER as symbol
    ] as IssuerCheck;
    expect(check({ claims: { tid: MICROSOFT_PERSONAL_TENANT } })).toBe(
      `https://login.microsoftonline.com/${MICROSOFT_PERSONAL_TENANT}/v2.0`,
    );
    expect(check({ claims: { tid: "../evil" } })).toBe(issuer);
  }
});

it("leaves a single-tenant issuer to the library's own check", async () => {
  const metadata = await corrected({
    issuer: `https://login.microsoftonline.com/${MICROSOFT_PERSONAL_TENANT}/v2.0`,
  });
  expect(metadata[EXPECTED_ISSUER as symbol]).toBeUndefined();
});
