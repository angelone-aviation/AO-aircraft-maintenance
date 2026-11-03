import type { Group } from "./model";
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
];
export function missingDefaultGroups(existing: { name: string }[]) {
  const names = new Set(existing.map((g) => g.name.trim().toLowerCase()));
  return defaultPermissionGroups.filter(
    (g) => !names.has(g.name.toLowerCase()),
  );
}
