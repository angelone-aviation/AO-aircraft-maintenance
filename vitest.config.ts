/**
 * Responsibility: Selects the unit and server test files and their environment.
 * Layer: Config. Test runner only; the app and its build never load it.
 * Dependencies: vitest/config.
 *
 * Edge-runtime matches the Convex runtime; tests that need Node built-ins opt
 * out with an `@vitest-environment node` docblock.
 */
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "convex/**/*.test.ts",
      "scripts/*.test.ts",
      "scripts/backup/*.test.ts",
    ],
    environment: "edge-runtime",
  },
});
