---
status: accepted
date: 2026-11-01
---

# The change log is protected by limited database access and off-site backups, not by hash chaining

> Amended by [ADR-0010](0010-one-convex-administrator.md): production dashboard access is limited to **one** named administrator, not two.

Every write in the app appends an audit entry (who, what, when, before, after, reason), and no code path can edit or delete one. The remaining ways to alter history are direct edits in the Convex dashboard and loss of the database. We decided to protect the log by **limiting production dashboard access to two named administrators**, **banning direct edits to production data** except through a written recovery procedure (each such edit recorded in the log by hand afterwards), and relying on the **daily backups and off-site copies** from the backup policy so that tampering can be proved by comparing copies. We did not adopt hash chaining now: it cannot stop the one actor who could tamper (a person who can rewrite the whole chain), while off-site copies can, and it can be added later without rework. This is proportionate to the posture in ADR-0004 (a status-record system, not the signed maintenance record) and meets AC 120-78B's expectation that records are preserved and unalterable without authentication, with periodic checks.

## Decisions taken with it

- Every correction to a completed record carries a mandatory reason.
- Corrections to AD compliance records are Flight Program administrator only; work-order corrections stay open to maintenance users.
- The History page stays readable by anyone who can read the program; transparency is itself a control, and the log holds no secrets.
- The audit log is part of the per-aircraft records export package.

## Considered options

- Hash-chained audit entries (deferred: detectable-by-app tampering is worth less than off-site proof against the realistic actor).
- Write-once external log store (deferred: the off-site backup copies already provide an independent record; revisit if the posture changes to signed record).

## Notes

- 2026-11-02: until this date, `convex/workOrderCleanup.ts` (`removeAuthorization`) rewrote `before`/`after` on existing work-order change-log rows to strip retired authorization fields, and Flight Program transfers re-tagged `programUuid`/`aircraftUuid` on the moved records' rows (security review S8). Either may have been run on production before 2026-11-02, so rows there may not be exactly as first written. Both now leave existing rows untouched and append entries instead. This note does not change the decision above.
