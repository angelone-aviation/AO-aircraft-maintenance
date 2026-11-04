/**
 * Responsibility: Pins that the retired managementRequests table stays
 *   declared while no server module reads or writes it.
 * Layer: Test. Vitest suite over the schema and the convex/ sources; never
 *   shipped in the build.
 * Dependencies: convex/schema.ts, convex/*.ts (as raw text).
 */
import { expect, it } from "vitest";
import schema from "./schema";

const SERVER_SOURCES = import.meta.glob<string>(
  ["./*.ts", "!./*.test.ts", "!./schema.ts"],
  { query: "?raw", import: "default", eager: true },
);

it("keeps managementRequests declared, so a deploy over its old rows succeeds", () => {
  expect(Object.keys(schema.tables)).toContain("managementRequests");
});

it("leaves managementRequests unread and unwritten by every server module", () => {
  expect(SERVER_SOURCES).toHaveProperty("./runCommand.ts");
  const mentions = Object.entries(SERVER_SOURCES)
    .filter(([, source]) => source.includes("managementRequests"))
    .map(([path]) => path);
  expect(mentions).toEqual([]);
});
