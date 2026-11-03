# Component model: legacy review and implementation

Reviewed the v19 PHP component pages, `database/aircraft_database.sql`, the v10–v15 upgrade scripts, and `includes/component_service.php`. The active model consists of **components**, **component_service_requirements**, and **component_movements**. The earlier React delivery represented only part of this model and incorrectly limited each aircraft to a single engine/propeller.

The component module now follows those three records. Convex persists the component, its requirement records, and immutable movement records separately within the typed management collection. Relationships use component UUIDs, and related changes are committed in one transaction. This is a model alignment, not a legacy-data import.

## Component fields

| Legacy fields                                                | Current field / behavior                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `component_type`                                             | Free-text component type; no restriction to engines, propellers, and life-limited parts              |
| `ata_chapter`                                                | The user-supplied ATA dropdown and stored two-digit chapter code                                     |
| `part_number`, `serial_number`, `manufacturer`               | Part number, serial number, manufacturer; optional as in the legacy form                             |
| `notes`, `created_at`                                        | Notes and server-recorded creation timestamp                                                         |
| `track_calendar`, `track_time`, `track_cycles`               | Independent tracking switches; at least one required                                                 |
| `location_type`                                              | Installed on aircraft or in inventory                                                                |
| `aircraft_id`, `parts_location`                              | Aircraft selection or inventory shelf/bin/room                                                       |
| `install_position`                                           | LEFT, RIGHT, NUMBER 1, NUMBER 2, MAIN, AUX                                                           |
| `installed_date`, `removed_date`                             | Installation and removal dates                                                                       |
| `installed_aircraft_total_time`, `installed_aircraft_cycles` | Verified aircraft readings at installation                                                           |
| `service_hours_base`                                         | TSN at installation / stored TSN                                                                     |
| `tso_hours_base`, `tsr_hours_base`                           | Nullable TSO and TSR at installation / stored readings; blank means unknown, not zero                |
| `service_cycles_base`, `service_days_base`                   | Component cycles and accumulated service days before installation                                    |
| Derived TSN / TSO / TSR, cycles, months                      | Usage advances with aircraft readings while installed; months are accumulated service days / 30.4375 |

The obsolete raw `installed_tach` / `removed_tach` columns from the initial SQL schema are not revived. The active PHP v19 workflow uses the aircraft's selected total-time meter and installation baselines instead.

## Separate service requirements

Each component can have multiple **Life Limits**, **Overhaul Requirement**, or **Inspection Requirement** records. Each record includes description, notes, last compliance date/hours/cycles, calendar interval and unit (days/months/years), time interval, TSN/TSO/TSR basis, absolute or after-last-compliance hour/cycle modes, calculated due values, and separate warning thresholds for calendar months, hours, and cycles.

Time/cycle due values use either an absolute limit or last compliance plus interval. Per the user’s instruction, calendar month/year intervals fall due on the last day of the target month, matching the existing aircraft inspection convention. For example, January 15 plus one month is due February 28 (February 29 in a leap year). Day intervals use exact dates. Due-soon warnings count calendar months backward from the due date, clamping to a shorter month when necessary.

Deadlines and remaining usage are visible in the component details. Status distinguishes Tracked, Due soon, Due now, Past due, and missing time baseline. Due now means a usage limit (hours, cycles or landings) with nothing left; a calendar limit is due soon on its due date and past due from the next day (see [Due soon and overdue](maintenance-workflows.md#due-soon-and-overdue)). Calendar requirements continue to age while the component is in inventory. Dashboard component alerts include approaching service requirements and inventory-held components.

## Movements and baselines

- Components may be created in inventory or installed on an aircraft with verified historical readings.
- Current movements use today's date and aircraft readings, matching the legacy movement form. Removal freezes current usage; installation on the selected aircraft resumes tracking without losing accumulated usage.
- Positions allow multiple engines/propellers on the same aircraft. The former single-engine/single-propeller restriction is removed.
- **Set baseline** records verified TSN, optional TSO/TSR, cycles, prior service days, and aircraft installation readings with automatic change history. It supports historical installations without pretending that today's counters are historical readings.
- Overhaul resets TSO and repair resets TSR; neither resets TSN. Both require the component to be in inventory.
- Movement/baseline history captures date, action, aircraft/location/position, usage, service days, actor, and note. All events are also recorded in audit history.
- Separate component service requirements and linked aircraft inspection schedules follow the component when installed on another aircraft.

## Clean component model and access

The user confirmed that there is no component data to preserve. Components use one strict schema with an explicit component type, tracking switches, and TSN/TSO/TSR, cycle, and service-day baselines. Optional user values such as an unknown TSO/TSR are represented explicitly; omitted fields are not filled from the former model.

Life, overhaul, and inspection limits exist only in separate service requirements. The former category/description pair, embedded life/overhaul limits and manufacturing/overhaul dates, cycles-since-overhaul field, old-limit display, and old-record fallback logic have been removed. Repair and overhaul dates are recorded by service events. No conversion or migration of component records is included.

Inventory-only components without an aircraft scope are administrator-managed. A component removed from an aircraft retains that aircraft's access scope so its maintenance team can service it in storage. Installing on another aircraft requires maintenance permission for both the source scope and destination; requirements and linked inspection schedules acquire the destination scope. Historical movement visibility retains the scope in which the event was recorded. Administrators can see the full history.

All writes remain online-only, version-checked, idempotent, and audited. Serialized components remain separate from quantity-based stock items; moving a component does not change stock quantities.

The component list shows the nearest remaining hours, months, and cycles across its service requirements. Months are approximate (remaining days divided by 30.4375), with exact days underneath; due dates keep their existing end-of-month rules. Negative values indicate overdue limits, and a dash means no corresponding limit is recorded.
