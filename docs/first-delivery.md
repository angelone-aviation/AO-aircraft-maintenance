# Agreed first delivery

Confirmed in the project interview, 29 September 2026. Updated after the user confirmed that there is no legacy operational data to import.

## Scope

React + Vite + TanStack Router + Zustand, Convex backend, installable PWA. An administrator creates accounts; public registration is blocked server-side. Permission groups belong to one Flight Program and combine an optional aircraft restriction with read, flight-entry, discrepancy-entry, and discrepancy-resolution, and maintenance permissions. Global administrators manage the workspace.

The dashboard shows aircraft totals, favorites, editable inspection schedules, approaching deadlines, open discrepancies, and flights requiring review. It does not declare an aircraft ready based on absent records. Initial demo data is explicitly fictional and isolated from live data.

The flight form shows read-only starting Hobbs and tach readings for pilot verification, followed by editable ending readings. Draft starting readings are captured alongside the aircraft version; a live update warns that they changed. Historical records display their own stored starting readings. The log shows starting and ending values for both meters. Flights require the aircraft's selected tracking meter, with the other meter optional. Meter readings and adjustments use integer seconds; the UI accepts tenths of an hour. Flight times are timezone-aware and stored as UTC instants. Origins and destinations can be blank or custom location text. Pilot identity references a user. Cycles and landings are recorded separately.

Only flight and discrepancy additions work offline. IndexedDB stores the last authorized snapshot and a durable outbox. The service worker caches static application assets, not authenticated API responses. Offline access expires seven days after the actual authentication session began. Reconnecting and receiving another snapshot does not extend that lease. Unsynced entries survive logout and expiry, belong to their original account, and can be exported. Aircraft access is checked again on the server at sync time.

Client UUIDs make retries idempotent. Flights with an outdated aircraft version, decreasing readings, or an earlier/equal timestamp are retained for review; they do not change totals. Administrators can accept corrected data or reject an entry with an explanation. Corrections re-evaluate all accepted flights against opening baselines and reject an inconsistent chronology. Audit records retain before/after values and the actor. A rejected flight's problem report remains open until explicitly resolved.

Discrepancies can be standalone or created alongside a flight. Only authorized maintenance users can resolve them; resolution requires connectivity and a written explanation. Reports and history are retained.

## Fresh-data setup

No operational import or migration is required. The PHP v19 source under `legecy php_project/aircraft_maintenance_manager_v19/` is retained as a business-logic reference. The import interface, preview parser, sample export, and exporter have been removed.

Administrators enter verified opening Hobbs/tach readings, the selected meter's total-time adjustment, cycles, and landings for each aircraft. These form the baselines for new flight records. Users then receive aircraft access through permission groups.

## Maintenance and inventory delivery

Inspection schedules, completion records, serialized components, and inventory management have been implemented. Maintenance changes require aircraft-scoped maintenance permission; program inventory requires a Flight Program or system administrator. See [the workflow guide](maintenance-workflows.md).

Per the user's instruction, real aircraft/user provisioning was skipped. No legacy import is needed. Operational deployment and device verification remain rollout tasks. Aircraft add/edit and a structured program directory are implemented; see [aircraft and program workflows](aircraft-programs.md). A dedicated airworthiness-directive register remains additional work; recurring checks can already be recorded as referenced inspection schedules.

## Operating limits

The first release loads each permitted aircraft's records into a snapshot, appropriate for the stated small offline dataset. Larger histories need pagination and an explicit offline retention window. Browser storage can be removed by the device owner or operating system; sync while connected and use pending-entry export when needed. Revocation cannot reach a device that remains offline, so the seven-day offline lease bounds that exposure under normal device-clock operation.

Administration, maintenance, inventory movements, corrections, and resolutions require a working authenticated connection. Live backend tests and production-build browser tests complement unit tests; the local demo is not an authentication or multi-user simulator.

Flight Program isolation, user memberships through permission groups, active-program switching, automatic record ownership, and explicit system-administrator transfers are implemented. See [Flight Program access](flight-program-access.md) for setup and offline rules.
