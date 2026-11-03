# An Angel One project

Mission aircraft status and maintenance tracker

## Summary

This app will track flight data, regular maintenance events, life limited parts, recurring airworthiness, Parts inventory, consumable inventory.

It will have a dashboard that shows the status of aircraft with the capacity to flag upcoming maintenance events and inventory requirements for the event.

## User Roles/Permissions

User access and permission(read/write) should be manageable. User Roles and Groups should be manageable. Example:

- Pilots
- Mechanics
- Project Director
- Director of maintenance
- Operations coordinator

Customize which user can read/write data of which aircraft.

## Authentication

- no sign up available (admin can add users)

## Target platforms

- Web
- iOS/Android phone/tablet
- Desktop app

## Device sizes

UI for small devices like phones and also an extended UI for iPad/Desktop applications.

## Features

- should also work offline and sync when reconnected (mark unsynced items in UI)
- writing data should check for collisions and sync correctly (maybe a change date when the change was done. Last change wins)
- history of changes (incl. which user id the change)
- backup function for admin (download of CSV files with all the data)
- mark favourite aircrafts (for dashboard)

## Aircraft Dashboard

- favorite aircrafts
  - show time to next inspection

## Technology stack

### Client

- React
- Vite
- TanStack Router
- Zustand

#### Progressive Web App (PWA)

The application must be implemented as an **installable Progressive Web App (PWA)** that works on desktop and mobile devices, including iOS and Android.

- Provide a **Web App Manifest** with app name, icons, theme, and standalone display mode.
- Use a **Service Worker** to cache the application files required to start and use the app without an internet connection.
- The application must remain usable **offline after the initial installation/load**.
- Store required local application data using **IndexedDB** or equivalent persistent browser storage.
- When connectivity returns, locally stored data may be synchronized with the backend where required.
- On iOS, users must be able to install the app using **Add to Home Screen** and launch it like a standalone application.
- Core functionality must not depend on an active internet connection.

#### Offline Mode
- just allow adding flights and discrepancies when offline.
- sync database for offline use. (shouldn't be to much data)

### Backend

- Convex

## Data Structure

### Program

-	`uuid`
-	`name`: String*
-	`address`
    -	`street`: String
    -	`postal_code`: String
    -	`city`: String
    -	`state`: String
    -	`country`: String
-	`contact_person`: String
    -	`name`: String
    -	`email`: String
    -	`phone`: String

### Prop

-	`uuid`
-	`prop_make`: String*
-	`prop_model`: String*
-	`prop_serial`: String*

### Engine

-	`uuid`: String
-	`name`: String (example: right/left)
-	`make`: String*
-	`model`: String*
-	`serial`: String*
-	`prop`: Prop

### Aircraft

-	`uuid`: String
-	`registration`: String*
-	`program_uuid`: Program*
-	`make`: String*
-	`serial`: String*
-	`hobbes_adjustment`: int in seconds
-	`tach_adjustment`: int in seconds
    -	for `aircraft_total_time` = `tach_adjustment` + `current_hobbes_counter`
-	`use_hobbes_for_total_time`: boolean
    -	if false: use tach
- `current_hobbes_counter`: int <span style="color: #2563eb">(calculated field)</span>
    - get current hobbes counter from last flight
- `current_tach_counter`: int <span style="color: #2563eb">(calculated field)</span>
    - get current tach counter from last flight
- `total_time`: int <span style="color: #2563eb">(calculated field)</span>
    - if `use_hobbes_for_total_time`: `= hobbes_adjustment + current_hobbes_counter`
    - else: `= tach_adjustment + current_tach_counter`
-	`init_landings`: int
    -	To Calculate total landings using flights
-	`init_cycles`: int
    -	To Calculate total cycles using flights
- `cycles`: int
    - `= init_cycles + sum(aircraft.flights.cycles)`
-	`engines`: list[Engine]
-	`accessories`
    -	`name`: String*
    -	`make`: String*
    -	`model`: String*
    -	`serial`: String*
    -	`remarks`: String

### Flight

-	`uuid`: String
-	`aircraft`: Aircraft*
-	`pilot`: User*
-	`copilot`: User
-	`start_time`: datetime timezone aware*
    -	Option to set the time (else at 0:00 in UTC)
-	`hobbes_time_off` <span style="color: #2563eb">(calculated field)</span>
    -	Get hobbes time from previous flight
-	`hobbes_time_on`: int in hours with 1 decimal
    -	Hobbes or tach has to be set
-	`tach_time_off` <span style="color: #2563eb">(calculated field)</span>
    -	Get tach time from previous flight
-	`tach_time_on`: int in hours with 1 decimal
-	`type_of_operation`
    -	Gov medical
    -	Mission medical
    -	Mission
    -	Commercial
    -	Private
-	`type_of_flight`
    -	VFR
    -	IFR
-	`landings`: int (default = 1)
-	`cycles`: int (default = 1)
-	`start_location`: Location
    -	Can be null for (somewhere in the boonies)
-	`end_location`: Location
    -	Can be null for (somewhere in the boonies)
-	`estimated_time_enroute`: int in seconds
    -	`ui`: hours:minutes
-	`discrepancy`: string
    -	Creates a flag if set
-	`discrepancy_solution`: string
    -	Removes the flag if set
-	`remarks`: String
-	`total_flight_time` <span style="color: #2563eb">(calculated field)</span>
    -	Use start_time to end_time or hobbes or tach

### Location

-	`uuid`: String
-	`iata`: string(3)
-	`icao`: string(4)
-	`custom_code`: string (for custom locations)
    -	A location should have at least one of `iata`, `icao` or `custom_code`
-	`name`: string*
-	`latitude`: decimal
-	`longitude`: decimal
-	`altitude`: decimal

### Inspection

-	`uuid`: String
-	`aircraft`: Aircraft
-	`reference`: String
-	`description`: String
-	`time_interval`: int (UI: hours, saved: seconds)
-	`part_numbers_required`: list[Part]
-	`supplies_required`: list[string]
-	`last_time_complied_with`: list
    -	`engine`: Engine
        -	Set engine or prop (nothing selected -> aircraft time)
    -	`prop`: Prop
        -	Set engine or prop (nothing selected -> aircraft time)
    -	`time`: decimal
        -	aircraft time for type aircraft

    #### -> Fields for month based inspections
    -	`date_interval`: int (months)
    -	`last_date_complied_with`: date
        -	Date of inspection
    -	`next_inspection_due_date`: <span style="color: #2563eb">(calculated field)</span>
        -	When is the next inspection ( = `last_date_complied_with` + `date_interval` -> at the end of the month)

    #### -> Fields for cycle interval based inspections
    -	`cycle_interval`: int
    -	`last_cycle_complies_with`: int
        -	Cycles at the inspection
    -	`next_inspection_due_cycles`: <span style="color: #2563eb">(calculated field)</span>
        -	When is the next inspection due (= `last_cycle_complies_with` + `cycle_interval`)

### Life limited parts

-	`uuid`: String
-	`aircraft`: Aircraft
    -	Only one is set: aircraft, engine or prop
-	`engine`: Engine
    -	Only one is set: aircraft, engine or prop
-	`prop`: Prop
    -	Only one is set: aircraft, engine or prop
-	`part_number`: string
-	`part_description`: string
-	`date_when_installed_on_aircraft`: date

    #### -> Life time based fields
    -	`time_installed`: decimal (hour with 1 decimal)
        -	`aircraft_total_time` for aircraft
        -	`engine_time_for_engine`
        -	`prop_total_time_for_prop`
    -	`time_since_new_at_install`: decimals (hour with 1 decimal)
        -	Run time of part at installation
    -	`time_since_overhaul_at_install`: decimal (hour with 1 decimal)
        -	When was part overhauled before the install
    -	`overhaul_time_interval`: decimal (hour with 1 decimal)
        -	Time of overhaul (new installation: null)
    -	`time_interval_since_last_overhaul`: <span style="color: #2563eb">(calculated field)</span>
        -	If `overhaul_time_interval` set:
            -	`= aircraft_total_time - overhaul_time_interval`
        -	Else
            -	`= aircraft_total_time - overhaul_time_interval + time_since_overhaul_at_installation`
    -	`time_life_limit_on_part`: int
        -	Max lifetime of this part

    #### -> Month based lifetime fields
    -	`manufactoring_date`: date
    -	`overhaul_date`: date
    -	`months_to_overhaul_interval`: int
        -	How many months until next overhaul is needed
    -	`months_life_limit`: int
        -	Use to calculate the end of life (`manufactoring_date` + `months_life_limit` = end of life)

    #### -> Cycle based fields
    -	`cycles_of_aircraft_at_install`: int
    -	`cycles_on_part_since_new_at_install`: int
        -	How many cycles did the part have when it was installed (init value)
    -	`cycles_of_aircraft_at_overhaul`: int
        -	When was the last overhaul
    -	`cycle_overhaul_interval`: int
        -	How many cycles from last overhaul  until next overhaul
    -	`cycles_remaining_to_next_overhaul`: int <span style="color: #2563eb">(calculated field)</span>
        - `aircraft.cycles` - `cycles_of_aircraft_at_overhaul`
    -	`cycles_life_limit`: int
        -	How many cycles until the end of the lifetime
    -	`cycles`: int <span style="color: #2563eb">(calculated field)</span>
        - `= (aircraft.cycles - cycles_of_aircraft_at_install) + cycles_on_part_since_new_at_install`
    -	`cycles_remaining_to_life_limit`: int <span style="color: #2563eb">(calculated field)</span>
        -	`= cycles_life_limit - cycles`

### Recurring Airworthiness Directives

-	`uuid`: String
-	`aircraft`: Aircraft
-	`reference`: string
    -	`identifier`
-	`description`: String
-	`parts_required`: [String]
    -	Maybe search in `part.oem_pn`, `part.alternate_part_number`

    #### -> Interval based fields:
    -	`recurring_time_interval`: hours with 1 decimal
    -	`aircraft_time_last_complied_with`: hours with 1 decimal
    -	`remaining_time`: hours with 1 decimal <span style="color: #2563eb">(calculated field)</span>
        -	`= aircraft.total_time - aircraft_time_last_complied_with - recurring_time_interval`

    #### -> Calendar based fields:
    -	`recurring_calendar_interval`: int (months)
    -	`aircraft_calendar_last_complied_with`
    -	`remaining_months`: hours with 1 decimal <span style="color: #2563eb">(calculated field)</span>
        -	`= aircraft_calendar_last_complied_with - recurring_calendar_interval`

    #### -> Cycle based fields:
    -	`aircraft_cycles_last_complied_with`: int
    -	`recurring_cycle_interval`: int
    -	`remaining_cycles`: hours with 1 decimal <span style="color: #2563eb">(calculated field)</span>
        -	`= aircraft.cycles - aircraft_cycles_last_complied_with - recurring_cycle_interval`

### Parts location

-	`uuid`: String
-	`name`: String
-	`address` (optional)
    -	`street`: String
    -	`postal_code`: String
    -	`city`: String
    -	`state`: String
    -	`country`: String
-	`longitude`: decimal (optional)
-	`latitude`: decimal (optional)
-	`contact_name`: String
-	`contact_email`: String
-	`contact_phone_number`: String

### Part

-	`uuid`: String
-	`aircraft_part_number`: String
    -	Like product number of the manufacturer
-	`alternate_part_numbers`: [String]
-	`description`: String
-	`part_location`: PartLocation
-	`status`: Choice Field
    -	Core
    -	as removed
    -	Overhauled
    -	new
-	`quantity`: int

### Supplies Inventory

-	`uuid`: String
-	`aircraft_part_number`: String
    -	Like product number of the manufacturer
-	`alternate_part_numbers`: [String]
-	`description`: String
-	`part_location`: PartLocation
-	`quantity`: int