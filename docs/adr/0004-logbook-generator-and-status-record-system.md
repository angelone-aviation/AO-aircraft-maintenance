---
status: accepted
date: 2026-11-01
---

# Angel One generates logbook entries and is the system of record for status records; it is not the signed maintenance record

Under 14 CFR 43.9/43.11 the maintenance record is the signed entry; under 91.417(a)(2) the operator must also keep six permanent status records (total time in service, life-limited part status, time since overhaul, inspection status, AD compliance status with method/number/revision/next due, and copies of Form 337). FAA AC 120-78B sets the bar for an electronic record that *is* the signed entry: authenticated signer under sole control, deliberate signing act, non-repudiation, "once signed, cannot be edited", corrections as superseding signed entries. We decided that Angel One is **not** that record. It generates unsigned 43.9/43.11 entries for signature in the aircraft's logbook (paper or PDF), and it is the **system of record for the six status records**, which it must keep always current, never delete, and export on demand. Job-card signoffs remain internal work-tracking signatures, not approvals for return to service.

We chose this because it matches what the code and docs already promise ("export creates editable text or an unsigned PDF for review and signature"), it keeps the tamper-evidence requirement at "audited, append-only, exportable" rather than AC 120-78B electronic signature, and it leaves the path to the signed-record posture open: the data model already captures who signed what and when.

## Scope decisions taken with it

- **Part 91 now, built to AC 120-78B**: no FAA approval is needed for Part 91; the AC's system expectations (access control, backups yielding an equivalent record, revision control, written procedures) are followed so that a later Part 135 OpSpec A025 application is a documentation exercise.
- **Never delete**: routine (91.417(a)(1)) records may legally be purged after one year; we archive and hide instead.
- **FAA/NTSB access and transfer at sale (91.417(c), 91.419)**: served by an on-demand per-aircraft export package (human-readable PDF plus structured data), not a dedicated inspector login.
- **Form 337 copies** become a first-class aircraft attachment category so all six status records have a home.
- **Signing**: a certificate type and number on file is required to record the **inspection signoff** (the 43.7 person's signature); technician and step signoffs stay open because 43.3(d) lets supervised uncertificated workers perform work. Logbook export keeps requiring the exporter's certificate.
- **Performer named separately**: generated entries carry an explicit "Performed by" line built from the technician signoffs, distinct from the approver line (43.9(a)(3)).

## Consequences

- The audit-trail integrity decision on the hardening map needs tamper evidence proportionate to a status-record system, not an e-signature system.
- Electronic signature design (identity binding, hashing, non-repudiation) is out of scope for this hardening effort; it returns only if the posture changes to "signed record".
- Generated entries must name the performer separately from the approver where they differ (43.9(a)(3)).
