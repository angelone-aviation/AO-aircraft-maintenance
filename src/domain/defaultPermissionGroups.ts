/**
 * Responsibility: The permission groups a Flight Program starts with, and
 *   which of them a program still lacks.
 * Layer: Domain. Pure data and functions; no I/O, no React.
 * Dependencies: ./model (types).
 */
import type { Group } from "./model";

/**
 * The starter groups: observers, pilots, maintenance technicians, program
 * managers (program administrators), aircraft owners and the board. All but
 * owners cover every aircraft; an owner group covers none until its aircraft
 * are assigned. A new program gets them all (ensureDefaultGroups); a program
 * created before a group was added gets it when a system administrator runs
 * the default-group backfill (convex/defaultGroups.ts `initialize`).
 */
export const defaultPermissionGroups: Omit<Group, "id" | "programUuid">[] = [
  {
    name: "Observers",
    programAdmin: false,
    aircraftIds: [],
    permissions: ["read"],
  },
  {
    name: "Pilots",
    programAdmin: false,
    aircraftIds: [],
    permissions: ["read", "flight", "discrepancy"],
  },
  {
    name: "Maintenance technicians",
    programAdmin: false,
    aircraftIds: [],
    permissions: ["read", "discrepancy", "resolve", "maintenance"],
  },
  {
    name: "Program managers",
    programAdmin: true,
    aircraftIds: [],
    permissions: ["read", "flight", "discrepancy", "resolve", "maintenance"],
  },
  {
    // Read-only owner portal; assign the owned aircraft before adding users.
    name: "Aircraft owners",
    programAdmin: false,
    owner: true,
    aircraftIds: [],
    permissions: ["read"],
  },
  {
    // Read-only board view of the whole fleet (GLOSSARY "Board view").
    name: "Board (read-only)",
    programAdmin: false,
    board: true,
    aircraftIds: [],
    permissions: ["read"],
  },
];

/**
 * Lists the starter groups a program lacks, matching by name, ignoring case
 * and surrounding spaces.
 *
 * @param existing - The program's groups.
 * @returns The missing starter groups, in starter order.
 */
export function missingDefaultGroups(existing: { name: string }[]) {
  const names = new Set(existing.map((g) => g.name.trim().toLowerCase()));
  return defaultPermissionGroups.filter(
    (g) => !names.has(g.name.toLowerCase()),
  );
}
