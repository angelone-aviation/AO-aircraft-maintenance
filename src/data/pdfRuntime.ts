import "./pdfCompatibility.js";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { version as pdfVersion } from "pdfjs-dist/package.json";

GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdfjs/${pdfVersion}/pdf.worker.compat.mjs`;
export { getDocument };
