import { z } from "zod";
import { can, isLocalToday, type Discrepancy, type Snapshot } from "./model";

// MEL repair intervals in calendar days, excluding the day of discovery.
// Category A intervals come from the MEL item itself.
export const MEL_CATEGORY_DAYS = { B: 3, C: 10, D: 120 } as const;
const placard = z
  .string()
  .trim()
  .min(1, "Enter the placard text.")
  .max(500, "Keep the placard text under 500 characters.");
export const deferralInputSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("mel"),
      melItem: z
        .string()
        .trim()
        .min(1, "Enter the MEL item number.")
        .max(50, "Keep the MEL item number under 50 characters."),
      category: z.enum(["A", "B", "C", "D"]),
      days: z
        .number()
        .int("Enter whole days.")
        .min(1, "Enter at least 1 day.")
        .max(365, "Category A deferrals are limited to 365 days.")
        .optional(),
      placard,
    }),
    z.strictObject({
      type: z.literal("91.213d"),
      placard,
      notHazard: z.literal(true, {
        message:
          "Confirm the inoperative equipment was determined not to be a hazard.",
      }),
    }),
  ])
  .refine(
    (d) => d.type !== "mel" || (d.category === "A") === (d.days !== undefined),
    {
      message:
        "Category A requires the number of days from the MEL; categories B, C and D use fixed intervals.",
      path: ["days"],
    },
  );
export type DeferralInput = z.infer<typeof deferralInputSchema>;
export type Deferral = DeferralInput & {
  deferredOn: string;
  deferredAt: number;
  deferredBy: string;
  deferredByName: string;
  expiresOn?: string;
};
export const deferCommandSchema = z.strictObject({
  uuid: z.string().min(1),
  deferredOn: z.iso.date(),
  deferral: deferralInputSchema,
});
export type DeferCommand = z.infer<typeof deferCommandSchema>;

const dayMs = 86400000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + "T00:00:00Z") + days * dayMs)
    .toISOString()
    .slice(0, 10);
export function deferralExpiry(
  input: DeferralInput,
  deferredOn: string,
): string | undefined {
  if (input.type !== "mel") return undefined;
  return addDays(
    deferredOn,
    input.category === "A" ? input.days! : MEL_CATEGORY_DAYS[input.category],
  );
}
/** Days left including today; 0 on the last valid day, negative once expired. */
export function deferralDaysRemaining(
  d: Pick<Deferral, "expiresOn">,
  today: string,
): number | undefined {
  return d.expiresOn === undefined
    ? undefined
    : Math.round(
        (Date.parse(d.expiresOn + "T00:00:00Z") -
          Date.parse(today + "T00:00:00Z")) /
          dayMs,
      );
}
export const deferralExpired = (
  d: Pick<Deferral, "expiresOn">,
  today: string,
) => (deferralDaysRemaining(d, today) ?? 0) < 0;
export function deferralLabel(d: Deferral) {
  return d.type === "mel"
    ? `MEL ${d.melItem} (Category ${d.category})`
    : "14 CFR 91.213(d) inoperative equipment";
}

/** Returns the deferred discrepancy; callers persist and audit it. */
export function deferDiscrepancy(
  s: Snapshot,
  raw: unknown,
  now = Date.now(),
): Discrepancy {
  const command = deferCommandSchema.parse(raw);
  const d = s.discrepancies.find((d) => d.uuid === command.uuid);
  if (!d) throw new Error("Report not found.");
  if (!can(s, d.aircraftUuid, "resolve"))
    throw new Error("You do not have permission for this aircraft.");
  if (d.status !== "open")
    throw new Error("Only open discrepancies can be deferred.");
  if (d.deferral) throw new Error("This discrepancy is already deferred.");
  if (!isLocalToday(command.deferredOn, now))
    throw new Error("The deferral date must be today.");
  return {
    ...d,
    deferral: {
      ...command.deferral,
      deferredOn: command.deferredOn,
      deferredAt: now,
      deferredBy: s.user.id,
      deferredByName: s.user.name,
      expiresOn: deferralExpiry(command.deferral, command.deferredOn),
    },
  };
}
