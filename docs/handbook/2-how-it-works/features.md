# Features

Every feature, one line each, with the page that describes its rules. How to use each screen, step by step, is in the user guide: [Using the app](../../wiki/Home.md), one page per role and per screen.

## Flying

| Feature                          | What it does                                                                        | Rules                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Log a flight                     | Phone-first flight form with read-only starting Hobbs and tach; works offline       | [Flight log options](../../flight-log-options.md), [offline](../../offline.md)            |
| Held flights and conflict review | Flights that no longer fit the aircraft wait for an administrator                   | [Offline: held flights](../../offline.md#flights-held-for-review)                         |
| Report a problem                 | Raise a discrepancy, also offline; 200 open per member                              | [Maintenance workflows](../../maintenance-workflows.md)                                   |
| Discrepancies screen             | Open, grounding, deferred and resolved counts; **Record resolution**; MEL deferrals | [Maintenance workflows](../../maintenance-workflows.md)                                   |
| OK to fly and the dispatch gate  | One verdict per aircraft; grounded aircraft are refused                             | [Maintenance workflows](../../maintenance-workflows.md), [glossary](../../../GLOSSARY.md) |
| Checklists                       | Import ForeFlight `.fmd` checklists, or build them                                  | [Checklists](../../checklists.md)                                                         |
| Flight plans                     | Read an ICAO flight plan PDF in the browser and queue it to fly                     | [Flight plans](../../flight-plans.md)                                                     |
| Logbook page photos              | Photograph the paper logbook line for a flight or work order                        | [Logbook photos](../../logbook-photos.md)                                                 |
| Sync center                      | Pending entries, **Sync now**, **Edit and retry**, export                           | [Offline](../../offline.md)                                                               |
| Engine trends                    | Engine monitor data and limits per aircraft                                         | Not documented on its own page                                                            |

## Maintaining

| Feature                  | What it does                                                                           | Rules                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Inspections              | Due by hours, calendar, cycles or landings; built from templates                       | [Inspection templates](../../inspection-templates.md), [landing schedules](../../landing-schedules.md)       |
| Components               | Life-limited parts installed or in inventory, with requirements and movements          | [Component templates](../../component-templates.md), [components in inventory](../../component-inventory.md) |
| Airworthiness directives | AD register per aircraft, compliance records, FAA DRS monitoring, Word report import   | [Airworthiness](../../airworthiness.md)                                                                      |
| Work orders              | Requested work, close-out with readings, attachments                                   | [Work orders](../../work-orders.md)                                                                          |
| Job cards and templates  | Executable cards, technician and inspection signoffs, evidence                         | [Job cards](../../task-cards.md)                                                                             |
| Logbook entries          | Unsigned 43.9/43.11 wording or PDF from a completed work order                         | [Logbook entries](../../logbook-entries.md)                                                                  |
| Certificates             | Pilot and mechanic certificates with license copies; approval by another administrator | [User certifications](../../user-certifications.md)                                                          |
| Reference library        | Manuals in the browser; **Keep on this device** for offline                            | [Reference library](../../reference-library.md)                                                              |
| Maintenance CSV import   | Import inspections and tasks drafted from a manual                                     | [Maintenance CSV import](../../maintenance-csv-import.md), [task file import](../../task-csv-import.md)      |
| Planning and forecast    | What falls due across the fleet                                                        | [Maintenance workflows](../../maintenance-workflows.md)                                                      |

## Parts and purchasing

| Feature                    | What it does                                                                            | Rules                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Inventory                  | Stock by location, shelf life, reorder levels, stock movements                          | [Maintenance workflows: inventory](../../maintenance-workflows.md#inventory)                                      |
| Labels and tags            | QR labels and component tags; QR scanner                                                | [Inventory printing](../../inventory-printing.md)                                                                 |
| Inventory attachments      | Images and PDFs on stock items                                                          | [Inventory attachments](../../inventory-attachments.md)                                                           |
| Parts and repair requests  | Request, reserve, issue; send components for repair                                     | [Parts and repair requests](../../parts-and-repair-requests.md), [parts availability](../../maintenance-parts.md) |
| Purchase orders            | Draft, issue, ship, receive, close; PO PDF                                              | [Purchase orders](../../purchase-orders.md)                                                                       |
| Vendors                    | Vendor directory, order history and spend                                               | [Vendors](../../vendors.md)                                                                                       |
| Aircraft Spruce            | Linked account, catalogue and order downloads                                           | [Aircraft Spruce](../../aircraft-spruce.md)                                                                       |
| Saved addresses and lookup | Shipping addresses; Geoapify address check                                              | [Saved addresses](../../saved-addresses.md), [addresses](../../address-verification.md)                           |
| Costs and budgets          | Labor, parts and other costs per work order; budgets; Costs report from the cost ledger | [History paging: cost ledger](../../history-paging.md#cost-ledger-s4)                                             |

## Administering

| Feature                           | What it does                                                                               | Rules                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Flight Programs, groups and users | Programs, permission groups, accounts, transfers                                           | [Flight Program access](../../flight-program-access.md), [aircraft and programs](../../aircraft-programs.md) |
| Aircraft setup wizard             | Load an aircraft's history from CSV templates after a dry run                              | [Aircraft setup](../../aircraft-setup.md)                                                                    |
| Aircraft photos                   | A dashboard photo per aircraft                                                             | [Aircraft photos](../../aircraft-photos.md)                                                                  |
| Alerts and expiring dates         | Bell, daily digest, urgent email and push; renewal dates                                   | [Alerts](../../alerts.md)                                                                                    |
| Change history and Summary        | Append-only change log; a period summary                                                   | [Change history](../../change-history.md)                                                                    |
| Paper check                       | Monthly list to tick against the paper logbooks                                            | [Paper check](../../reconciliation.md)                                                                       |
| Records package                   | One aircraft's complete records as one ZIP, for the FAA or a buyer                         | [Records package](../../records-export.md)                                                                   |
| Status sheet                      | The 91.417(a)(2) status records for one aircraft as a PDF                                  | [Records package](../../records-export.md)                                                                   |
| Settings                          | My account, Alerts, This device, Flight Program, System (deployment status, keys, backups) | [README: settings on the deployment](../../../README.md#settings-that-live-on-the-deployment)                |
| Reading aids                      | Larger text, term tips, glossary, keyboard shortcuts                                       | [Reading and shortcuts](../../reading-and-shortcuts.md)                                                      |

## Owners and board

| Feature      | What it does                                      | Rules                                                   |
| ------------ | ------------------------------------------------- | ------------------------------------------------------- |
| Owner portal | Read-only status records for the owner's aircraft | [Flight Program access](../../flight-program-access.md) |
| Board view   | Read-only fleet summary with a meeting PDF        | [Board view](../../board-view.md)                       |

## Behind the scenes

| Feature                        | What it does                                                  | Rules                                                                                                      |
| ------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Offline copy and sign-out wipe | Seven-day device copy; sign-out clears it                     | [Offline](../../offline.md)                                                                                |
| History window and Load older  | Three months in the workspace; older pages on demand          | [History paging](../../history-paging.md)                                                                  |
| Expiring file links            | Five-minute links for every stored file                       | [File links](../../file-links.md)                                                                          |
| Nightly backup                 | Export to R2, optional Excel copy in Dropbox                  | [Backup runbook](../../runbooks/backup-restore.md), [Dropbox copy](../../runbooks/dropbox-records-copy.md) |
| File sweep                     | Removes stored files nothing refers to; starts in report mode | [File sweep](../../runbooks/file-sweep.md)                                                                 |
| Demo mode                      | The whole app on fictional data in the browser                | [README: start the app](../../../README.md#start-the-app), [sample program](../../sample-program.md)       |

Background pages that are not features: [first delivery](../../first-delivery.md) (the agreed scope), [component legacy alignment](../../component-legacy-alignment.md), [manual import feasibility](../../manual-import-feasibility.md), [Cessna 441 chapter 5](../../cessna-441-chapter-5.md), [Aircraft Spruce API research](../../aircraft-spruce-api-public-research.md) and [review](../../aircraft-spruce-api-review.md), [peer testing hosting](../../peer-testing-hosting.md) (historical).
