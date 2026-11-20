/**
 * Responsibility: Switching the user's active Flight Program, with the
 *   change-log row both adapters write for it.
 * Layer: Domain. A pure applier on a working snapshot; no I/O, no React.
 * Dependencies: ./changeLog, ./model (types), ./programs.
 */
import { auditEntry } from "./changeLog";
import type { AuditEntry, Snapshot } from "./model";
import { assertProgramSelectable } from "./programs";

/**
 * Makes a Flight Program the user's active one, or "" the unassigned
 * records, which only a system administrator sees.
 *
 * @param s - The working snapshot; its user's active program is set.
 * @param programUuid - The program to activate, or "".
 * @returns The "program.selected" entry, naming the program, or
 *   "unassigned" and no program for "".
 * @throws {Rejection} "Flight Program access denied." (as
 *   assertProgramSelectable), before anything changes.
 */
export function selectProgram(s: Snapshot, programUuid: string): AuditEntry {
  assertProgramSelectable(s, programUuid);
  s.user.activeProgramUuid = programUuid;
  return auditEntry(s, {
    action: "program.selected",
    entityUuid: programUuid || "unassigned",
    programUuid: programUuid || undefined,
  });
}
