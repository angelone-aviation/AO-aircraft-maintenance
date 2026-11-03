# Work-order logbook entries

Completed work orders offer **Generate logbook entry** in their details. Formats cover maintenance/inspection, component service/replacement, and AD compliance. They are based on the structure of the [SOMA examples](https://www.somasoftware.com/post/aircraft-logbook-entry): completion date, aircraft identity and time, recorded work and parts, references, and certifying credentials. The renderer uses actual recorded work and release outcome; choosing a format does not assert airworthiness or AD compliance.

The source regulations distinguish maintenance record content in [14 CFR 43.9](https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-43/section-43.9) from inspection records in [14 CFR 43.11](https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-43/section-43.11). Export creates editable text or an unsigned PDF for review and signature. It does not grant certification authority or create an electronic approval.

The authenticated user's name appears as the certifying person. License number and certificate type can be entered and saved to that user's profile. A different person's signed job-card work retains that person's recorded name in the work summary. License fields are required to enable export. Existing job-card signatures are not replaced by a generated signature.

A **Performed by** line above the certifying person names each technician who signed a job card included in the entry, once each, when that person is not the certifying person (14 CFR 43.9(a)(3)). It is omitted when the certifying person performed all of the work. Job cards excluded from the log book entry and canceled cards do not count, and inspection signers are not performers. The live sample builds the line from the current job cards; close-out records the performers with the work summary, so later name changes do not alter it. Work orders closed before the line was introduced keep their entries without it.

Completion records preserve aircraft and component readings separately from the opening header. Future aircraft flights, component service, template edits and profile changes do not rewrite the completed work summary or compliance snapshot. A component moved to another aircraft, or with tracking movements after a backdated completion, requires review before closeout. Removed components that remain scoped to the aircraft use their recorded stored totals.

PDFs use an embedded DejaVu Sans font with pagination; its license is included in `public/fonts/DejaVu-LICENSE.txt`. PDF and clipboard export contain the same reviewed text. Editing or exporting an entry does not update compliance again. Older completed work orders are supported as reviewable drafts from their opening snapshots without retroactive compliance changes.

## Annual / 100-Hour template

Choose **Annual / 100-Hour inspection**, then select the inspection type, enter the manufacturer's checklist and revision, and enter the date or bi-weekly issue through which ADs and service bulletins were checked. The date is formatted MM/DD/YYYY and total time uses one decimal place. The entry includes the user's supplied Appendix D wording, recorded work, aircraft and tracked-component readings, and certificate details.

The airworthy finding starts unselected. Selecting it inserts the airworthy certification from 43.11; export requires the finding, checklist, review cutoff, and credentials. This template is specifically for an airworthy finding. The signature line remains blank. Each template retains its own text edits while the dialog is open; updating inspection inputs updates unchanged generated lines and preserves custom text. Drafts are not saved when the dialog closes.

## Component service / replacement template

Uses the supplied maintenance-entry example with MM/DD/YYYY date, aircraft total time, recorded work, parts (including recorded P/N and serial/lot), maintenance references, and tracked-component details. Selecting **Work satisfactory — approved only for the work performed** inserts the supplied satisfactory-work and limited return-to-service statement. The outcome starts unselected and is required for export alongside credentials. The printed name comes from the signed-in user; the signature line is blank. Missing part or reference details can be added to the editable entry before export.

## Procedure wording and inclusion

Work-order tasks and inspection, discrepancy, and service job-card templates have **Include in log book entry** and **Log book wording** controls. New tasks start unchecked. Select the procedures to include; only completed work is used. Each selected task or procedure produces `Task #2 Cabin fittings: inspected IAW AMM 25-10`. Task numbers retain their work-order position even when preceding tasks are excluded. A procedure uses its title (including the inspection and item code), selected wording, and manual-library reference, falling back to its maintenance-data reference. Recorded work and inspection signers follow the procedure line. Custom phrases keep their capitalization; standard verbs appear in lowercase. An inspection’s name/reference is not a maintenance manual reference. When the task’s maintenance manual reference is blank, the line ends with `IAW Standard Practice found in AC43.13`.

**Manage log book phrases** adds or edits the dropdown choices, one per line, and saves them to your account for use across tasks. Initial choices are Performed, Inspected, Repaired, Complied with, Installed, Removed, and Updated. Changing the list does not change wording already selected on another task. Template selections carry into independent work-order job cards. Work-item and job-card selections control their own lines, so select both only when both descriptions should appear.

Older records without an explicit selection retain their original summaries. Closed work orders retain their frozen entry text. Phrase and inclusion changes apply when saving open work and do not change compliance tracking.

## Live sample in the work-order form

Open work orders show a **Sample log book entry** below closeout fields. Task inclusion, wording, references, work-order number, release outcome, completion date and readings update the sample before saving. **Include unfinished work in sample** is enabled initially so you can preview selected planned work; turn it off to see completed work only. The sample uses the maintenance format and saved profile credentials. It is read-only; adjust the source fields above it. It does not close the order or record compliance. The final exported entry still requires completion and uses the frozen closeout snapshot.

## Reusable release statements

In the work order’s **Closeout and final review**, select a **Release statement** to fill the editable **Release outcome**. The live sample updates immediately and the saved wording is included in the generated log book entry. Nothing is selected automatically. Five starter choices cover the manufacturer’s inspection program, maintenance return to service, a 100-hour airworthy finding, an annual inspection with discrepancies, and alteration/repair return to service. The starter annual-discrepancy text retains October 2, 2026; adjust its date for the actual record.

**Manage release statements** lets you name, edit, add or remove reusable statements and save the list to your account. Editing the list does not rewrite an existing work order’s release outcome. Save the work order to keep its selected or edited statement. Completed orders retain their recorded wording.

## Component work at closeout

Repair/overhaul selections in the work order appear in the live sample and the final entry with the component identity, work description, completion date and supporting reference. The final entry records the post-service TSO/TSR, while the closed work-order details preserve both before and after readings. Exporting the entry never reapplies the tracking update.
