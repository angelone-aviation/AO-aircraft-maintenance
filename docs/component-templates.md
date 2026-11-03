# Component templates

Open Components → Imported components → Component templates → New template / import CSV. Enter a name and aircraft make/model matching an aircraft profile. Import a UTF-8 CSV or edit the CSV text. Templates belong to the current Flight Program and can be reused for matching aircraft.

Required CSV headers: `Component type,ATA chapter,Part number,Component Name`. ATA and part-number cells can be blank. Optional headers: `Manufacturer,Position,ID,Parent ID`.

Component types: Appliance, Engine, Propeller, Main Rotor, Tail Rotor. Positions: LEFT, RIGHT, NUMBER 1, NUMBER 2, MAIN, AUX. Use a unique ID per row and refer to it in Parent ID to describe an assembly. A child must have a valid parent; circular relationships are rejected. Helicopters accept rotor types rather than propellers.

Preview / apply to aircraft shows matching aircraft and lets you select rows. Existing template imports and possible matches by type, name, part number and position are blocked. Distinguish multiple similar components by name or position. Include a parent when selecting a new child.

Import creates Setup incomplete recommendations, not installed components or inventory stock. No serial, installation date, hours or cycles are invented. Complete setup opens the normal component form with the template identity filled in and unknown opening readings blank. Verify that the component is already installed, supply the applicable verified baselines, and save. Serial may remain blank if unknown. If a required baseline is unknown, leave the recommendation incomplete until it is verified.

Complete parent components before their children. Children are then attached using the existing component assembly workflow and stay with their parent through installation/removal. Actual installation or removal still uses a work order; this flow records initial aircraft setup only. Service requirements are added separately to verified components or child parts.

Editing a template changes future imports only. Already imported recommendations retain their original details. Reapplying the same template rows to the same aircraft does not create duplicates. Removing or replacing an installed component does not reset this initial-setup import history.
