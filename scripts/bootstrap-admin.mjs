/**
 * Responsibility: Command-line entry for `npm run setup:admin`.
 * Layer: Script. A launcher only: the setup lives in scripts/bootstrapAdmin.ts.
 * Dependencies: esbuild (installed with convex), scripts/bootstrapAdmin.ts.
 *
 * That module shares the app's password rule, TypeScript with extensionless
 * imports that Node cannot load, so it is bundled in memory on every run. The
 * bundle imports only Node built-ins, which a data: URL module may import, so
 * nothing is written to disk. Run `npm ci` first.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./bootstrapAdmin.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  write: false,
  logLevel: "silent",
});
const source = Buffer.from(bundle.outputFiles[0].contents).toString("base64");
const { main } = await import(`data:text/javascript;base64,${source}`);
process.exitCode = await main(process.argv.slice(2));
