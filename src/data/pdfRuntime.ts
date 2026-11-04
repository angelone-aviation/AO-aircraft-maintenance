/**
 * Responsibility: Loads PDF.js with its compatibility shim and points it at
 *   the worker build served for this PDF.js version.
 * Layer: Data. Browser-only side-effect module; no React.
 * Dependencies: src/data/pdfCompatibility.js, pdfjs-dist.
 *
 * Keep the file name: vite.config.ts matches its chunk (pdfRuntime-*.js) to
 * cache it on first use rather than at install.
 */
import "./pdfCompatibility.js";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { version as pdfVersion } from "pdfjs-dist/package.json";

GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdfjs/${pdfVersion}/pdf.worker.compat.mjs`;

/** PDF.js's document loader, ready to use once this module has loaded. */
export { getDocument };
