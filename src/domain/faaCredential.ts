import { z } from "zod";
import { localDate } from "./model";
export const faaCredentialInput = z.object({
  key: z
    .string()
    .trim()
    .min(16)
    .max(512)
    .regex(/^[A-Za-z0-9._-]+$/, "Enter the FAA API key without spaces."),
  expiresOn: z.iso.date(),
  version: z.number().int().nonnegative(),
});
export interface FaaCredentialStatus {
  configured: boolean;
  expiresOn: string;
  version: number;
}
export function faaRenewal(
  status: FaaCredentialStatus | undefined,
  today = localDate(),
) {
  if (!status?.configured)
    return { warning: true, message: "FAA API key is not configured." };
  if (!status.expiresOn)
    return {
      warning: true,
      message: "FAA API key renewal date is not recorded.",
    };
  const days = Math.ceil(
    (Date.parse(status.expiresOn) - Date.parse(today)) / 86400000,
  );
  return {
    warning: days <= 60,
    message:
      days < 0
        ? `FAA API key expired on ${status.expiresOn}. Renew it to continue AD checks.`
        : days === 0
          ? "FAA API key expires today. Renew it to continue AD checks."
          : `FAA API key expires on ${status.expiresOn} (${days} days remaining).${days <= 60 ? " Renew it before AD monitoring is interrupted." : ""}`,
  };
}
