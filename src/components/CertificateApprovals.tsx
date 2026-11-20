/**
 * Responsibility: The Administration notice listing the certificates waiting
 *   for the signed-in administrator's approval, each with its Approve button.
 * Layer: UI. Reads the workspace and approves through the Backend.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/domain (certificateApproval, certifications), ./design (NoticeBar),
 *   ./ui (errorText).
 */
import { useEffect, useState } from "react";
import { IdentificationCard } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import type { CertificateApproval } from "../domain/certificateApproval";
import {
  certificateSummary,
  certificationLabels,
} from "../domain/certifications";
import { NoticeBar } from "./design";
import { errorText } from "./ui";

type Approvals = { list: CertificateApproval[]; error?: string };

/**
 * The certificates waiting for the signed-in user to approve them: members'
 * filed or changed mechanic and pilot certificates, which neither print on
 * entries nor allow the inspection signoff until approved. Asks the server
 * again whenever the workspace changes.
 *
 * @returns The notice, or nothing when no certificate waits for this user.
 */
export function CertificateApprovals() {
  const { approvals, refresh } = useApprovals();
  const live = useWorkspace((x) => x.online && x.connected);
  const { busy, error, approve } = useApprove(refresh);
  if (approvals.error)
    return (
      <NoticeBar tone="neutral" icon={IdentificationCard} className="rise">
        Certificates waiting for approval could not be checked:{" "}
        {approvals.error}
      </NoticeBar>
    );
  if (!approvals.list.length) return null;
  return (
    <section className="adm-review rise" aria-labelledby="cert-approvals">
      <NoticeBar tone="blue" icon={IdentificationCard}>
        <ApprovalsIntro count={approvals.list.length} />
        <ul className="adm-review-list">
          {approvals.list.map((a) => (
            <ApprovalItem
              key={a.userId + a.certificate.kind}
              approval={a}
              disabled={busy || !live}
              onApprove={approve}
            />
          ))}
        </ul>
        {error && <p role="alert">{error}</p>}
      </NoticeBar>
    </section>
  );
}

// Approves one certificate, then asks for the list again.
function useApprove(refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const approve = async (a: CertificateApproval) => {
    setBusy(true);
    setError("");
    try {
      await useWorkspace
        .getState()
        .backend!.approveCertificate(a.userId, a.certificate);
      refresh();
    } catch (e) {
      setError(errorText(e, "Unable to approve the certificate."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, approve };
}

// Asks again when the workspace's records change (a member filed a
// certificate, or another administrator approved one) and drops a reply that
// arrives after that.
function useApprovals() {
  const backend = useWorkspace((x) => x.backend);
  const program = useWorkspace((x) => x.snapshot?.activeProgramUuid);
  const syncedAt = useWorkspace((x) => x.snapshot?.syncedAt);
  const [approvals, setApprovals] = useState<Approvals>({ list: [] });
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!backend) return;
    let current = true;
    backend.certificatesAwaitingApproval().then(
      (list) => current && setApprovals({ list }),
      (error: unknown) =>
        current &&
        setApprovals({
          list: [],
          error: errorText(error, "The check did not run."),
        }),
    );
    return () => {
      current = false;
    };
  }, [backend, program, syncedAt, asked]);
  return { approvals, refresh: () => setAsked((n) => n + 1) };
}

function ApprovalsIntro({ count }: { count: number }) {
  return (
    <>
      <p id="cert-approvals" className="adm-review-title">
        <strong>
          {count} {count === 1 ? "certificate waits" : "certificates wait"} for
          your approval
        </strong>
      </p>
      <p>
        A certificate a member files or changes neither prints on logbook
        entries nor allows the inspection signoff until an administrator
        approves it. Check each against the holder&apos;s certificate first.
      </p>
    </>
  );
}

function ApprovalItem({
  approval: a,
  disabled,
  onApprove,
}: {
  approval: CertificateApproval;
  disabled: boolean;
  onApprove: (a: CertificateApproval) => void;
}) {
  const label = certificationLabels[a.certificate.kind];
  return (
    <li className="adm-review-item">
      <div className="adm-review-text">
        <span className="adm-review-head">
          <strong>{a.name}</strong>
          <span className="adm-review-program">{label}</span>
        </span>
        <span>{certificateSummary(a.certificate)}</span>
      </div>
      <button
        type="button"
        className="button small adm-button"
        aria-label={`Approve ${a.name}'s ${label} certificate`}
        disabled={disabled}
        onClick={() => onApprove(a)}
      >
        Approve
      </button>
    </li>
  );
}
