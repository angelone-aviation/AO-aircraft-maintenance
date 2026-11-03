import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "convex/**/*.test.ts",
      "scripts/backup/*.test.ts",
    ],
    environment: "edge-runtime",
  },
});
