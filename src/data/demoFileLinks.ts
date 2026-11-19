/**
 * Responsibility: The demo adapter's file links: the copy the demo keeps of
 *   each file the demo user's own view lists, mirroring convex/fileLinks.ts.
 * Layer: Data. Demo adapter helper; the fictional files stay in this browser.
 * Dependencies: src/domain (model, ownerView, boardView, fileLinks,
 *   rejection).
 */
import type { Snapshot } from "../domain/model";
import { isOwnerView } from "../domain/ownerView";
import { isBoardView } from "../domain/boardView";
import {
  FILE_LINK_TTL_MS,
  NO_FILES_IN_BOARD_VIEW,
  type FileLink,
  type FileRef,
} from "../domain/fileLinks";
import { Rejection } from "../domain/rejection";

/**
 * Links to the demo's stored copies (data URLs) of the files the demo user's
 * scoped view lists, so screens open demo files the way they open live ones.
 *
 * @param s - The scoped snapshot the demo user sees.
 * @param refs - The files asked for.
 * @param now - The clock, in epoch ms.
 * @returns One entry per reference, in order: the copy with a five-minute
 *   expiry, or null for a file the view does not list.
 * @throws {Rejection} "Files are not available in the board view." for a
 *   board preview that is not also an owner's.
 */
export function demoFileLinks(
  s: Snapshot,
  refs: FileRef[],
  now: number,
): (FileLink | null)[] {
  if (isBoardView(s) && !isOwnerView(s))
    throw new Rejection(NO_FILES_IN_BOARD_VIEW);
  return refs.map((ref) => {
    const url = storedCopy(s, ref);
    return url ? { url, expiresAt: now + FILE_LINK_TTL_MS } : null;
  });
}

function storedCopy(s: Snapshot, { kind, id }: FileRef): string | undefined {
  const inList = (files?: { uuid: string; url?: string }[]) =>
    files?.find((f) => f.uuid === id)?.url;
  if (kind === "aircraftPhoto")
    return s.aircraft.find((a) => a.uuid === id)?.photoUrl;
  if (kind === "aircraftFile") return inList(s.aircraftFiles);
  if (kind === "workOrderFile") return inList(s.workOrderAttachments);
  if (kind === "taskEvidence") return inList(s.taskEvidence);
  return inList(s.inventoryAttachments);
}
