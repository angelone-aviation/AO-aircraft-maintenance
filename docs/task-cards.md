# Task cards

Use **Task templates → Create task template** on an inspection, installed component service requirement, or discrepancy to prepare reusable instructions. Adding that source to a work order creates independent job cards for the order. Open **Job cards** in the order details to record work and signoffs. Standalone cards can also be created from **Job cards → New job card** (under **Maintain** in the navigation).

Templates contain instructions, notes and required parts; results and signoffs belong to work-order copies. Each copy retains its template origin, starts in draft, and has no execution results. Later template edits apply to future copies. For existing orders, use **Add missing task templates**. Repeating this action does not duplicate existing copies.

Card numbers are unique within the aircraft's current Flight Program. Leave the number blank for `TC-YYYY-NNNN`. The table filters by aircraft, status and card number/title. Linked records include an optional open work order, inspection, installed component, component service requirement and originating discrepancy. Related records must belong to the same aircraft. A saved work-order association cannot be reassigned.

The editor includes ATA chapter, description, maintenance-data references, applicability and a **Notes / remarks** field. Planning contains only **Required parts**. Previous step data remains readable in **Previously recorded step details**; it is no longer an editable checklist or a signoff prerequisite. Existing planning and functional-test data is retained in storage.

Execution records include findings, actual work, additional measurements, actual labor and completion date. Parts-used rows record part number/description, positive quantity, serial or lot and removed/installed component details. Choose **Non-stock item** for manual entry, or **Inventory stock** and select a storage location and stock item. Stock selection uses your existing inventory access, fills the part number and description and must belong to the aircraft’s Flight Program. Each stock item shows its available quantity (on hand less reservations), as in parts requests. Lots past their shelf life are marked **Expired** and cannot be linked; a lot linked before it expired stays on the card. Linking records the source; issue quantities separately through **Inventory → Move stock**. Component installation changes also remain separate.

Save a draft before uploading evidence. PDF, JPEG and PNG files up to 7 MB can be categorized as photos, supporting documents or parts traceability. Evidence is stored with the card and remains readable after completion.

Statuses are draft, ready, in progress, awaiting parts, awaiting inspection, completed and canceled. To complete a card:

1. Change Draft to In progress, enter actual work performed and a completion date, then save.
2. Record technician signoff, then inspection signoff when required.
3. Select completed and save.

Signoffs record the authenticated maintenance user's identity and server timestamp. Inspection signoff follows technician signoff. Step, prerequisite-card and functional-test checks are no longer part of the simplified completion flow. These are recorded account attestations; separate certification/credential roles are not introduced.

Save content changes before signing. Content edits or new evidence invalidate existing signatures; status-only changes retain them. Completed and canceled cards are read-only. Work orders cannot be completed or canceled until their linked cards are completed or canceled. Work-order lists show requested-work counts separately from detailed task-card counts and include task-card parts delays and originating discrepancies.

Card completion does not automatically advance inspection compliance, resolve a discrepancy or move a component. Complete the parent work order to update its routine inspection compliance; use the existing discrepancy and component screens for resolution or movement. Maintenance access and a connection are required for changes; cached cards remain readable offline. Aircraft/program scoping, version checks and audit history apply to card changes, links, signatures and evidence uploads.
