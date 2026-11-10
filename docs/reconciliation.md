# Paper check

While the program keeps paper logbooks beside the app, someone compares the two once a month. The **paper check** is a one-page list of what the app recorded for one aircraft in one month, with an empty **Checked** column to tick against the paper logbook. It lists the app's rows as recorded; the signed paper logbook stays the maintenance record ([ADR-0004](adr/0004-logbook-generator-and-status-record-system.md)), so the check is a checklist, not a record, and its footer says so.

## Where

**Paper check (month)** is on **View aircraft** (beside **Export status sheet**) for that aircraft, and at the top of the **Flight log** with a choice of aircraft. Pick the month, then **Save PDF** (landscape letter, the same style as the status sheet) or **Save CSV** (opens in a spreadsheet). The file is named `<registration>-paper-check-<YYYY-MM>.pdf` or `.csv`. Reading the aircraft is enough; anyone who sees it can run the check.

## What it lists

**Flights**, earliest first, every flight that started in the month by its local date: the date (the one the Flight log shows on this device, not the UTC date the start time is stored under, so an evening flight stays on its own day and month), the pilot, the aircraft's tracking meter at the start and the end of the flight (the column is named after the meter, such as **Hobbs start**), the hours flown (end minus start), landings, oil added (such as "1.5 US qt"), the flight's status (Accepted, Needs review or Rejected), whether a [logbook page photo](logbook-photos.md) is attached, and **Checked**. A reading that was not recorded is left blank, as is the hours cell that depends on it.

**Month totals** count accepted flights only: flights, hours and landings. A held flight (Needs review) or a rejected one changes no aircraft totals, so it is listed for the comparison but not counted.

**Maintenance sign-offs**, by completion date: every work order completed in the month, with its number and scope, who signed (the certifying person recorded at close-out, else the order's supervisor), whether a photo of the signed page is attached, and **Checked**.

A month with no flights or completed work orders prints both tables with a single **None recorded** row and zero totals.

## CSV

The CSV has one set of columns for every row: **Section** (Flight, Work order or Totals), Date, Pilot, the meter's start and end, Hours, Landings, Oil added, Status, Work order, Signed by, Photo, Checked and Flights; cells a section does not use are empty, and the header is the same for an empty month. Every cell is quoted and text that would run as a spreadsheet formula is neutralized, as in the app's other exports.
