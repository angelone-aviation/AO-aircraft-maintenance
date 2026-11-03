import { z } from "zod";
import { localDate, type Member } from "./model";
export const certificationKinds = [
  "pilot",
  "mechanic",
  "airframe",
  "powerplant",
  "ia",
] as const;
export const certificationLabels = {
  pilot: "Pilot",
  mechanic: "Certified mechanic",
  airframe: "Airframe",
  powerplant: "Powerplant",
  ia: "Inspection Authorization (IA)",
};
export const certificateTypes = {
  pilot: "Pilot",
  mechanic: "Mechanic",
  airframe: "Airframe (A)",
  powerplant: "Powerplant (P)",
  ia: "IA",
};
export const certificationKindSchema = z.enum(certificationKinds);
const date = z.union([z.iso.date(), z.literal("")]);
const legacyQualificationSchema = z.object({
  kind: z.enum(["airframe", "powerplant", "ia"]),
  number: z.string(),
  issuedOn: date,
  expiresOn: date.optional(),
  renewalDate: date.optional(),
});
export const certificationSchema = z
  .object({
    kind: certificationKindSchema,
    number: z.string().trim().max(100),
    issuedOn: date,
    expiresOn: date.optional(),
    renewalDate: date.optional(),
    airframe: z.boolean().optional(),
    powerplant: z.boolean().optional(),
    ia: z.boolean().optional(),
    legacyQualifications: z.array(legacyQualificationSchema).optional(),
  })
  .refine((c) => !c.issuedOn || !c.renewalDate || c.renewalDate >= c.issuedOn, {
    message: "Renewal date must be on or after the issue date.",
  });
export const certificationsSchema = z
  .array(certificationSchema)
  .max(5)
  .refine(
    (rows) => new Set(rows.map((r) => r.kind)).size === rows.length,
    "Each certification may be selected only once.",
  )
  .transform(normalizeCertifications);
export type Certification = z.infer<typeof certificationSchema>;
export type CertificationKind = Certification["kind"];
// Fold the earlier separate rating records into a single mechanic license.
// Preserve original values as historical details when older records disagree.
export function normalizeCertifications(
  rows: Certification[],
): Certification[] {
  const children = rows.filter(
    (c) => c.kind === "airframe" || c.kind === "powerplant" || c.kind === "ia",
  );
  if (!children.length) return rows;
  const parent = rows.find((c) => c.kind === "mechanic");
  const source = parent?.number
    ? parent
    : (children.find((c) => c.number) ?? parent ?? children[0]);
  const mechanic: Certification = {
    ...parent,
    kind: "mechanic",
    number: source.number,
    issuedOn: parent?.issuedOn || source.issuedOn,
    airframe: parent?.airframe || children.some((c) => c.kind === "airframe"),
    powerplant:
      parent?.powerplant || children.some((c) => c.kind === "powerplant"),
    ia: parent?.ia || children.some((c) => c.kind === "ia"),
    renewalDate:
      parent?.renewalDate || children.find((c) => c.kind === "ia")?.renewalDate,
    legacyQualifications: [
      ...(parent?.legacyQualifications ?? []),
      ...children.map((c) => ({
        kind: c.kind as "airframe" | "powerplant" | "ia",
        number: c.number,
        issuedOn: c.issuedOn,
        expiresOn: c.expiresOn,
        renewalDate: c.renewalDate,
      })),
    ],
  };
  return [...rows.filter((c) => c.kind === "pilot"), mechanic];
}
export interface CertificationFile {
  id: string;
  userId: string;
  kind: CertificationKind;
  name: string;
  type: string;
  size: number;
  uploadedAt: number;
}
export function certificateOptions(
  user: Pick<Member, "certifications">,
  asOf = localDate(),
) {
  return normalizeCertifications(user.certifications ?? [])
    .filter((c) => c.number && (!c.issuedOn || c.issuedOn <= asOf))
    .map((c) => {
      let certificateType = certificateTypes[c.kind];
      if (c.kind === "mechanic") {
        certificateType =
          c.airframe && c.powerplant
            ? "A&P"
            : c.airframe
              ? "Airframe (A)"
              : c.powerplant
                ? "Powerplant (P)"
                : "Mechanic";
        if (c.ia) certificateType += " IA";
      }
      return {
        key: c.kind as string,
        licenseNumber: c.number,
        certificateType,
      };
    });
}

export function memberLicense(
  user: Pick<Member, "certifications" | "licenseNumber" | "certificateType">,
  asOf?: string,
) {
  if (user.certifications === undefined)
    return {
      licenseNumber: user.licenseNumber ?? "",
      certificateType: user.certificateType ?? "",
    };
  const options = certificateOptions(user, asOf);
  const chosen = [
    "ap-ia",
    "ap",
    "mechanic",
    "airframe",
    "powerplant",
    "ia",
    "pilot",
  ]
    .map((key) => options.find((o) => o.key === key))
    .find(Boolean);
  return {
    licenseNumber: chosen?.licenseNumber ?? "",
    certificateType: chosen?.certificateType ?? "",
  };
}
export function validateCertificationFile(
  name: string,
  type: string,
  size: number,
) {
  const extensions: Record<string, string[]> = {
    "application/pdf": ["pdf"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "image/heic": ["heic"],
    "image/heif": ["heif"],
  };
  if (
    !name ||
    name.length > 200 ||
    !extensions[type]?.includes(name.split(".").at(-1)!.toLowerCase())
  )
    throw Error("Upload a PDF, JPEG, PNG, WebP, HEIC or HEIF license copy.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > 5 * 1024 * 1024)
    throw Error("License copies must be between 1 byte and 5 MB.");
}
