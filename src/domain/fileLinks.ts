/**
 * Responsibility: The contract for opening a stored file through a
 *   short-lived link: which files can be asked for, and what comes back.
 * Layer: Domain. Types and limits shared by the browser and Convex; no I/O.
 * Dependencies: none.
 *
 * Storage URLs never expire, so files reach the browser only through links
 * that the server issues on request and that stop working after a few
 * minutes (docs/file-links.md).
 */

/** How long a file link works after it is issued. */
export const FILE_LINK_TTL_MS = 5 * 60 * 1000;

/** The most links one request asks for: a screen of thumbnails. */
export const MAX_FILE_LINKS = 50;

/** The refusal for a member who is only on a board: their view has no file. */
export const NO_FILES_IN_BOARD_VIEW =
  "Files are not available in the board view.";

/** The kinds of stored file a link opens. */
export const FILE_KINDS = [
  "aircraftFile",
  "aircraftPhoto",
  "workOrderFile",
  "taskEvidence",
  "inventoryFile",
] as const;

/**
 * A stored file to open: its kind and the `uuid` the snapshot gives it. An
 * aircraft photo is named by its aircraft's uuid, since each has at most one.
 */
export interface FileRef {
  kind: (typeof FILE_KINDS)[number];
  id: string;
}

/** A link to one stored file, and when it stops working (epoch ms). */
export interface FileLink {
  url: string;
  expiresAt: number;
}
