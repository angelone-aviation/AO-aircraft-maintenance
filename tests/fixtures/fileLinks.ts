/**
 * Responsibility: Asks the server for a file link in convex-test suites, as
 *   a screen does: in the caller's active Flight Program.
 * Layer: Test. Fixture for convex-test suites; never shipped in the build.
 * Dependencies: convex-test (types), vitest, convex/server, convex/schema
 *   (types), convex/_generated/api, src/domain/fileLinks (types).
 */
import type { TestConvex } from "convex-test";
import { vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type schema from "../../convex/schema";
import { api } from "../../convex/_generated/api";
import type { FileLink, FileRef } from "../../src/domain/fileLinks";

type Client = ReturnType<TestConvex<typeof schema>["withIdentity"]>;
// 32 test bytes: links are signed with a key derived from the credential key.
const TEST_CREDENTIAL_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

/**
 * fileLinks.links by name, until convex/_generated is next regenerated
 * against a deployment.
 */
export const FILE_LINKS = makeFunctionReference<
  "mutation",
  { programUuid?: string; files: FileRef[] },
  (FileLink | null)[]
>("fileLinks:links");

/**
 * The link the server gives a caller for one file, in their active program.
 * Sets the credential key and site URL a link needs when the suite has not.
 *
 * @param client - The signed-in caller.
 * @param file - The file.
 * @param programUuid - The caller's active program; read from their snapshot
 *   when omitted.
 * @returns The link, or null when the caller may not open it or it is gone.
 * @throws What fileLinks.links throws.
 */
export async function openFile(
  client: Client,
  file: FileRef,
  programUuid?: string,
): Promise<FileLink | null> {
  if (!process.env.CREDENTIALS_ENCRYPTION_KEY)
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", TEST_CREDENTIAL_KEY);
  if (!process.env.CONVEX_SITE_URL)
    vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
  const program =
    programUuid ??
    (await client.query(api.operations.snapshot, {}))?.activeProgramUuid;
  const [link] = await client.mutation(FILE_LINKS, {
    programUuid: program,
    files: [file],
  });
  return link;
}
