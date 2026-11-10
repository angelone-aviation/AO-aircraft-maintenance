# Board view

The board view is the read-only fleet summary for board members of a Flight Program: aircraft status, what falls due, open discrepancies, spend against budget and the last off-site backup, with a PDF to take to the meeting. It shows recorded status only and is not a maintenance release.

## Who sees it

A board member is a user whose only read access in the active Flight Program comes from **board groups** (groups with the **Board member (read-only board view)** flag). A board group reads only: the server and the form refuse administrator rights and every write permission on it, and a group cannot be both a board group and an aircraft owner group. Board groups cover all aircraft in the program unless specific aircraft are chosen, like ordinary groups. A user who also holds an ordinary group in the program (one without either reduced-view flag) keeps the full workspace, as mixed owner memberships do. Reduced-view groups never add up to the workspace: a user whose only groups are board groups and aircraft owner groups gets the board view for the aircraft their board groups reach and the owner portal for the aircraft their owner groups name, and nothing else. They open the board view at `/board` (its link is in their navigation) and the owner portal on every other route, and every other server call from them is refused.

Every new Flight Program gets a **Board (read-only)** default group with its other default groups. A program created before the group existed gets it when a system administrator runs the default-group backfill (`defaultGroups:initialize`), which adds only the groups a program lacks.

Board members land on the board view at `/board` and see nothing else: every route shows it, the navigation holds only **Board view**, and there are no alerts, settings or flight tools. Flight Program administrators and system administrators also open **Board view** from the navigation; they keep their own workspace around it.

## What the board sees

The server sends board members a whitelist built in `boardSnapshot` (`src/domain/boardView.ts`), applied by the scoped snapshot, so a field added anywhere else stays hidden until someone decides the board may see it:

- aircraft identity and counters, and what decides their status: unarchived inspections, installed components with their requirements, ADs with their due limits and compliance dates and counters, open discrepancies with their grounding flag and deferral type, category and expiry;
- completed work orders as number, dates and scope line;
- cost **totals** per aircraft (this quarter, this year, the year's budget), never cost records: no rates, labor lines, part prices, vendors or invoices;
- the time of the newest off-site backup;
- the member's own record and groups.

Nothing else passes: no flights, no change log, no files or attachments, no inventory, purchasing or parts requests, no other people, and no free text (discrepancy descriptions, notes, reasons, placards, mechanic names and evidence references are cleared).

Every other server call from a board member is refused with "Board access is read-only."; the tenant-isolation suite runs every public function as a board member and checks the whitelist.

## The screen

- **Fleet status** tiles: how many aircraft are airworthy, due soon and grounded, and how many items are overdue, from the same status rules as the overview.
- **Aircraft**: each aircraft's status, overdue and due-soon counts, open discrepancies (with how many are grounding), and spend: this quarter's total, this year's total against the year's budget, and "over budget" when it is.
- **Due in the next 30 days**: every inspection, component limit and AD that is overdue, due soon, or has a calendar limit within 30 days, worst first and then soonest first.
- **Off-site backup**: the freshness sentence from the nightly backup (ADR-0008). The demo has no backups and says so; a program administrator who opens the view is pointed to Settings → System, where the status is reported to system administrators.
- **Download board summary (PDF)**: the same summary as paragraphs, in Helvetica, named `board-summary-<date>.pdf`.

## Demo

**Preview board view** in the top bar switches the demo to a sample board member, Taylor Brooks; **Exit board preview** switches back. The demo has no backups, work orders or costs unless they are added during the session.
