/**
 * Responsibility: Certificate approval: a certificate a member files or
 *   changes waits until an administrator approves it, who may approve whose,
 *   and the change-log entries each change writes.
 * Layer: Domain. Pure functions shared by the server and the demo adapter.
 * Dependencies: ./certifications, ./model (types), ./programs, ./rejection.
 *
 * Certificates printed on sign-offs and the one that unlocks the inspection
 * signoff were the holder's word alone (security review S20, A5). Nobody
 * approves their own certificate, administrators included, so every
 * approved certificate has had a second person look at it.
 */
import { normalizeCertifications, type Certification } from "./certifications";
import type { Member, Snapshot } from "./model";
import { activeProgram, programIds, programPermission } from "./programs";
import { Rejection } from "./rejection";

/** The refusal for anyone {@link mayApproveCertificates} turns away. */
export const CERTIFICATE_APPROVERS_ONLY =
  "Only a system administrator, or a Flight Program administrator of the member's program, may approve their certificates, and nobody their own.";

/** A change-log action a certificate change writes. */
export type CertificationAction =
  | "user.certification_filed"
  | "user.certification_edited"
  | "user.certification_removed"
  | "user.certification_approved";

/** One certificate's change, as its change-log entry records it. */
export interface CertificationChange {
  action: CertificationAction;
  /** The certificate before the change; null when it was filed. */
  before: Certification | null;
  /** The certificate after the change; null when it was removed. */
  after: Certification | null;
}

/** One certificate waiting for approval, as an approver reviews it. */
export interface CertificateApproval {
  userId: string;
  name: string;
  /** The certificate as filed, without its pending flag. */
  certificate: Certification;
}

/**
 * The certificates to store after a member's save: one that is new, or
 * differs from the one of its kind on file, is pending; an unchanged one
 * keeps the state it had. A `pending` flag the save sends is ignored.
 *
 * @param before - The certificates on file; undefined when none were saved.
 * @param submitted - The certificates as saved.
 * @returns The certificates folded, each marked pending or not.
 */
export function fileCertifications(
  before: Certification[] | undefined,
  submitted: Certification[],
): Certification[] {
  const onFile = normalizeCertifications(before ?? []);
  return normalizeCertifications(submitted).map((row) => {
    const { pending: _sent, ...filed } = row;
    const prior = onFile.find((c) => c.kind === row.kind);
    if (prior && sameCertificate(prior, filed))
      return { ...filed, ...flag(prior) };
    return { ...filed, pending: true };
  });
}

/**
 * The change-log entries a save writes: each certificate removed or edited,
 * in the order they were on file, then each one filed.
 *
 * @param before - The certificates on file; undefined when none were saved.
 * @param after - The certificates stored, as {@link fileCertifications}
 *   returns them.
 * @returns One change per certificate that differs; none when nothing did.
 */
export function certificationChanges(
  before: Certification[] | undefined,
  after: Certification[],
): CertificationChange[] {
  const onFile = normalizeCertifications(before ?? []);
  const changed = onFile.flatMap((prior): CertificationChange[] => {
    const next = after.find((c) => c.kind === prior.kind);
    if (!next)
      return [
        { action: "user.certification_removed", before: prior, after: null },
      ];
    if (sameCertificate(prior, next) && !!prior.pending === !!next.pending)
      return [];
    return [
      { action: "user.certification_edited", before: prior, after: next },
    ];
  });
  const filed = after
    .filter((c) => !onFile.some((prior) => prior.kind === c.kind))
    .map((c): CertificationChange => ({
      action: "user.certification_filed",
      before: null,
      after: c,
    }));
  return [...changed, ...filed];
}

/**
 * Approves one pending certificate exactly as the approver reviewed it.
 *
 * @param certifications - The holder's certificates on file.
 * @param reviewed - The certificate the approver saw; its `pending` flag is
 *   ignored.
 * @returns The certificates with that one approved.
 * @throws {Rejection} "This certificate is not waiting for approval." when
 *   the holder has no pending certificate of that kind; "This certificate
 *   changed since you opened it. Review it again." when it differs from what
 *   the approver saw.
 */
export function approveCertification(
  certifications: Certification[],
  reviewed: Certification,
): Certification[] {
  const onFile = normalizeCertifications(certifications);
  const waiting = onFile.find((c) => c.kind === reviewed.kind && c.pending);
  if (!waiting)
    throw new Rejection("This certificate is not waiting for approval.");
  if (!sameCertificate(waiting, reviewed))
    throw new Rejection(
      "This certificate changed since you opened it. Review it again.",
    );
  return onFile.map((c) => (c === waiting ? withoutFlag(c) : c));
}

/**
 * Whether the signed-in user may approve `holder`'s certificates: never
 * their own; a system administrator anyone else's; a Flight Program
 * administrator those of a member holding a group in the active program.
 *
 * @param s - The approver's snapshot or program context.
 * @param holder - The member whose certificates wait.
 */
export function mayApproveCertificates(s: Snapshot, holder: Member): boolean {
  if (holder.id === s.user.id || !s.user.active) return false;
  if (s.user.isAdmin) return true;
  const program = activeProgram(s);
  if (!program || !programPermission(s, "admin", program)) return false;
  return programIds(holder, s.groups).includes(program);
}

/**
 * The certificates waiting for the signed-in user to approve them.
 *
 * @param s - The approver's snapshot or program context.
 * @param members - The members to look through.
 * @returns One entry per pending certificate of a member the user may
 *   approve ({@link mayApproveCertificates}), in member order.
 */
export function certificatesAwaitingApproval(
  s: Snapshot,
  members: Member[],
): CertificateApproval[] {
  return members
    .filter((m) => mayApproveCertificates(s, m))
    .flatMap((m) =>
      normalizeCertifications(m.certifications ?? [])
        .filter((c) => c.pending)
        .map((c) => ({
          userId: m.id,
          name: m.name,
          certificate: withoutFlag(c),
        })),
    );
}

// Every field but the pending flag is the certificate as the holder filed it.
function sameCertificate(a: Certification, b: Certification): boolean {
  return (
    JSON.stringify(canonical(withoutFlag(a))) ===
    JSON.stringify(canonical(withoutFlag(b)))
  );
}

// Sorted keys, and no key for a blank value, so field order, and a form
// sending "" or false where the stored copy has nothing, never count as a
// change: a blank date and an unchecked rating mean "not recorded" either way.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).filter(([, v]) => !isBlank(v));
  return Object.fromEntries(
    entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]),
  );
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

function withoutFlag(c: Certification): Certification {
  const { pending: _pending, ...rest } = c;
  return rest;
}

function flag(c: Certification): Pick<Certification, "pending"> {
  return c.pending ? { pending: true } : {};
}
