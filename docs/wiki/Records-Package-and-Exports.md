# Records package and exports

| Export            | What it is                                                                     | Where                                                         | Who                                       |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------- |
| Status sheet      | One aircraft's status records as a PDF                                         | **View aircraft**, owner portal                               | Anyone who reads the aircraft             |
| Records package   | Everything Angel One holds for one aircraft, as a ZIP                          | **View aircraft**; **Change history** with an aircraft chosen | Maintenance and administrators            |
| Paper check       | A month's flights and completed work orders, to tick against the paper logbook | **View aircraft**; **Flight log**                             | Anyone who reads the aircraft             |
| AD compliance PDF | Every AD with its compliance history                                           | **Airworthiness directives**, owner portal                    | Anyone who reads the aircraft             |
| Planning list     | What falls due                                                                 | **Planning → Print** or **Export CSV**                        | See [Planning](Planning-and-Due-Items.md) |
| Costs             | Labor, parts and other costs against flight hours and budget                   | **Costs**                                                     | Flight Program administrators             |
| Board summary     | Fleet summary PDF                                                              | **Board view**                                                | Board, administrators                     |
| Change summary    | Change-log counts by person                                                    | **Change history → Summary → Export CSV**                     | Flight Program administrators             |

None of these is the signed maintenance record. The signed paper logbook is.

## Status sheet

**Export status sheet** on **View aircraft** saves a PDF: the aircraft's
status and reasons, totals, installed components and their limits,
inspections, ADs with their next due, Form 337 copies and open problems.

## Records package

For an FAA inspector (14 CFR 91.417(c)), a buyer (91.419) or an insurer.

1. Open **View aircraft** on the Overview, or choose the aircraft in **Change
   history**.
2. Choose **Export records package**.
3. Wait while it gathers the records. It saves
   `<registration>-records-<date>.zip`.

The ZIP holds:

| File              | Contents                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.txt`      | The aircraft, who made it and when, warnings, and files left out                                                                                                           |
| `records.pdf`     | Every table, printable                                                                                                                                                     |
| CSV files         | One per table: status sheet, flights, discrepancies, work orders with frozen logbook text, AD compliance history, components and requirements, Form 337 copies, change log |
| `form-337/`       | Every Form 337 copy                                                                                                                                                        |
| `files/`          | Work-order attachments                                                                                                                                                     |
| `logbook-photos/` | Current logbook page photos                                                                                                                                                |

Rules:

- Others get "Records packages are for users with maintenance permission on
  the aircraft."
- All times in the package are UTC.
- It copies at most 150 MiB of files. Files past that, or that cannot be
  downloaded, are listed in `README.txt`; the tables are never cut.
- Made offline, it holds only what the device keeps. The README's
  **WARNINGS** say which tables are partial. Make it online for a complete
  package.

## Paper check

While paper logbooks run beside the app, compare them once a month.

1. Choose **Paper check (month)** on **View aircraft** or the **Flight log**.
2. Choose the aircraft and month.
3. Choose **Save PDF** or **Save CSV**.
4. Tick each row in the **Checked** column against the paper logbook.

| Section               | Lists                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Flights               | Each flight that started in the month: date, pilot, meter start and end, hours, landings, oil, status, photo |
| Month totals          | Accepted flights only: flights, hours, landings                                                              |
| Maintenance sign-offs | Work orders completed in the month, who signed, photo                                                        |

Offline, a month older than the device holds is refused: "Older records need
a connection. Reconnect to check this month."

## Costs

Flight Program administrators only. Needs a connection: "The cost report needs
a connection."

1. Choose the aircraft and **This year**, **Last 12 months** or **Custom
   range**.
2. Read **Labor**, **Parts** (at the price recorded at each issue), **Other**
   and **Total**, with cost per flight hour.
3. Under **Annual budget**, enter the year's budget and **Save budget**.
4. **Export CSV** saves the figures.

Add labor and other costs on each work order
([Work orders](Work-Orders.md#work-the-order)). The default labor rate is in
[Settings](Settings.md#flight-program).

## CSV extract

**Settings → Flight Program → CSV extract (partial)** saves some tables from
the device's copy. It is not a backup: it leaves out work orders, job cards,
AD compliance, costs, purchasing and files. Use the records package for one
aircraft's complete record.
