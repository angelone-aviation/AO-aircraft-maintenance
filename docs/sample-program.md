# Hosted sample aviation program

`SAMPLE — Hope Aviation Training` is an isolated fictional program, provisioned explicitly using the internal `sampleProgram:seed` mutation. It is never loaded automatically. The fixed program UUID makes repeat provisioning a no-op; no existing program or aircraft is overwritten.

It contains four aircraft (registrations SAMPLE-1 through SAMPLE-4), four accepted historical flights, four future flight plans plus four linked historical plans, four checklists, four discrepancies, four inspections, four inspection templates, four linked job cards and open work orders, four fictional AD examples, four purchase orders, four inventory locations, four stock items, four installed engines plus four spare engines, four component requirements and baseline movements, and four unassigned permission groups.

Four generated PDFs are linked to the reference library, inventory, work orders, job-card evidence, and purchase orders. They are visibly marked as fictional training material and do not represent approved manuals, invoices, certificates, or maintenance releases. AD examples use SAMPLE-NOT-FAA identifiers and remain unreviewed. Purchase orders demonstrate draft, issued, partially shipped, and shipped states; no vendor order is transmitted. No artificial compliance signatures are created.

Authentication tables, FAA credentials/monitoring state, upload staging, and request-deduplication tables are system state, not sample business data. Existing users and permissions remain unchanged. If the administrator has no active program, this program is selected; otherwise their existing selection is preserved.

Before provisioning a deployment that holds records, take a Convex backup (dashboard → Backups → **Backup now**). The export this page used to name belonged to the old test deployment, deleted on 2026-11-03.

Validation: `npx vitest run convex/sampleProgram.test.ts` checks linked counters, work-card relationships, repeat safety, account preservation, and document attachment/storage repeat safety.
