/**
 * Responsibility: A member's FAA certificates (pilot, mechanic with ratings),
 *   the certificate cited on a logbook entry, and the license-copy file rules.
 * Layer: Domain. Pure zod schemas and functions; no I/O, no React.
 * Dependencies: zod, src/domain/model.ts, src/domain/rejection.ts.
 *
 * Airframe, powerplant and IA were once separate records; they are now
 * ratings on the one mechanic certificate, and old rows are folded into it.
 */
import { z } from "zod";
import { localDate, type Member } from "./model";
import { Rejection } from "./rejection";

const RATING_KINDS = ["airframe", "powerplant", "ia"] as const;
type RatingKind = (typeof RATING_KINDS)[number];

const LICENSE_COPY_NAME_MAX_LENGTH = 200;
// 5 MiB, although the refusal says "5 MB".
const LICENSE_COPY_MAX_BYTES = 5 * 1024 * 1024;
const LICENSE_COPY_EXTENSIONS: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
};

/** Certificate kinds a member may record, the legacy ratings included. */
export const certificationKinds = [
  "pilot",
  "mechanic",
  ...RATING_KINDS,
] as const;

/** The name of each certificate kind on forms and alerts. */
export const certificationLabels = {
  pilot: "Pilot",
  mechanic: "Certified mechanic",
  airframe: "Airframe",
  powerplant: "Powerplant",
  ia: "Inspection Authorization (IA)",
};

/** The certificate type each kind is cited as on a logbook entry. */
export const certificateTypes = {
  pilot: "Pilot",
  mechanic: "Mechanic",
  airframe: "Airframe (A)",
  powerplant: "Powerplant (P)",
  ia: "IA",
};

/**
 * One of {@link certificationKinds}.
 *
 * @throws {z.ZodError} From `parse()` on any other value.
 */
export const certificationKindSchema = z.enum(certificationKinds);

const date = z.union([z.iso.date(), z.literal("")]);
const legacyQualificationSchema = z.object({
  kind: z.enum(RATING_KINDS),
  number: z.string(),
  issuedOn: date,
  expiresOn: date.optional(),
  renewalDate: date.optional(),
});

/**
 * One certificate. Dates are ISO dates or "".
 *
 * @throws {z.ZodError} From `parse()` on an invalid field, or "Renewal date
 *   must be on or after the issue date."
 */
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

/**
 * A member's certificates, at most five and one of each kind, folded by
 * {@link normalizeCertifications} on parse.
 *
 * @throws {z.ZodError} From `parse()` on an invalid certificate, or "Each
 *   certification may be selected only once."
 */
export const certificationsSchema = z
  .array(certificationSchema)
  .max(5)
  .refine(
    (rows) => new Set(rows.map((r) => r.kind)).size === rows.length,
    "Each certification may be selected only once.",
  )
  .transform(normalizeCertifications);

/** A parsed {@link certificationSchema} certificate. */
export type Certification = z.infer<typeof certificationSchema>;
/** One of {@link certificationKinds}. */
export type CertificationKind = Certification["kind"];

/**
 * Folds legacy airframe, powerplant and IA rows into one mechanic
 * certificate, keeping each row's own details in `legacyQualifications`.
 *
 * @param rows - Certificates as stored.
 * @returns `rows` itself when it has no legacy row. Otherwise the pilot rows,
 *   then one mechanic certificate built on the mechanic row: every rating any
 *   row holds, the IA row's renewal date if it has none, and, if it has no
 *   number, the number (and, lacking its own, the issue date) of the first
 *   legacy row with a number.
 */
export function normalizeCertifications(
  rows: Certification[],
): Certification[] {
  const ratings = rows.filter(isRating);
  if (!ratings.length) return rows;
  const parent = rows.find((c) => c.kind === "mechanic");
  const source = parent?.number
    ? parent
    : (ratings.find((c) => c.number) ?? parent ?? ratings[0]);
  const mechanic: Certification = {
    ...parent,
    kind: "mechanic",
    number: source.number,
    issuedOn: parent?.issuedOn || source.issuedOn,
    airframe: parent?.airframe || ratings.some((c) => c.kind === "airframe"),
    powerplant:
      parent?.powerplant || ratings.some((c) => c.kind === "powerplant"),
    ia: parent?.ia || ratings.some((c) => c.kind === "ia"),
    renewalDate:
      parent?.renewalDate || ratings.find((c) => c.kind === "ia")?.renewalDate,
    legacyQualifications: [
      ...(parent?.legacyQualifications ?? []),
      ...ratings.map((c) => ({
        kind: c.kind,
        number: c.number,
        issuedOn: c.issuedOn,
        expiresOn: c.expiresOn,
        renewalDate: c.renewalDate,
      })),
    ],
  };
  return [...rows.filter((c) => c.kind === "pilot"), mechanic];
}

/** A stored copy of a member's license, without its contents. */
export interface CertificationFile {
  id: string;
  userId: string;
  kind: CertificationKind;
  name: string;
  type: string;
  size: number;
  uploadedAt: number;
}

/**
 * The certificates a member can cite on an entry dated `asOf`: those with a
 * number, issued on or before it or with no issue date. Expiry dates are not
 * applied.
 *
 * @param user - The member; their certificates are folded first.
 * @param asOf - The entry's local date; today by default.
 * @returns One option per certificate in folded order, keyed by kind. A
 *   mechanic is cited as "A&P", "Airframe (A)", "Powerplant (P)" or
 *   "Mechanic", with " IA" added for that rating.
 */
export function certificateOptions(
  user: Pick<Member, "certifications">,
  asOf = localDate(),
) {
  return normalizeCertifications(user.certifications ?? [])
    .filter((c) => c.number && (!c.issuedOn || c.issuedOn <= asOf))
    .map((c) => ({
      key: c.kind as string,
      licenseNumber: c.number,
      certificateType:
        c.kind === "mechanic"
          ? mechanicCertificateType(c)
          : certificateTypes[c.kind],
    }));
}

/**
 * The certificate printed on a member's entries: the mechanic certificate,
 * else the pilot certificate, as {@link certificateOptions} offers them.
 *
 * @param user - The member; one who has never saved certificates keeps the
 *   license number and type recorded before certificates existed.
 * @param asOf - The entry's local date; today by default.
 * @returns The license number and certificate type, each "" when none.
 */
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
  const chosen =
    options.find((o) => o.key === "mechanic") ??
    options.find((o) => o.key === "pilot");
  return {
    licenseNumber: chosen?.licenseNumber ?? "",
    certificateType: chosen?.certificateType ?? "",
  };
}

/**
 * Checks a license copy before upload: a PDF, JPEG, PNG, WebP, HEIC or HEIF
 * whose extension matches its type, with a name of at most 200 characters.
 *
 * @param name - The file name.
 * @param type - The file's MIME type.
 * @param size - The file size in bytes.
 * @throws {Rejection} "Upload a PDF, JPEG, PNG, WebP, HEIC or HEIF license
 *   copy." for any other file; "License copies must be between 1 byte and 5
 *   MB." outside 1 byte to 5 MiB.
 */
export function validateCertificationFile(
  name: string,
  type: string,
  size: number,
) {
  const extension = name.split(".").at(-1)!.toLowerCase();
  if (
    !name ||
    name.length > LICENSE_COPY_NAME_MAX_LENGTH ||
    !LICENSE_COPY_EXTENSIONS[type]?.includes(extension)
  )
    throw new Rejection(
      "Upload a PDF, JPEG, PNG, WebP, HEIC or HEIF license copy.",
    );
  if (!Number.isSafeInteger(size) || size <= 0 || size > LICENSE_COPY_MAX_BYTES)
    throw new Rejection("License copies must be between 1 byte and 5 MB.");
}

function isRating(c: Certification): c is Certification & { kind: RatingKind } {
  return (RATING_KINDS as readonly string[]).includes(c.kind);
}

function mechanicCertificateType(c: Certification): string {
  const ia = c.ia ? " IA" : "";
  if (c.airframe && c.powerplant) return `A&P${ia}`;
  if (c.airframe) return certificateTypes.airframe + ia;
  if (c.powerplant) return certificateTypes.powerplant + ia;
  return certificateTypes.mechanic + ia;
}
