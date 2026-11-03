# Landing-based maintenance schedules

Inspection templates and aircraft inspection schedules offer Hours, Calendar, Cycles, and Landings checkboxes. Component service requirements and AD actions also support Landings. Only selected dimensions are saved; multiple selected limits are due when the first is reached.

Landings use the aircraft's cumulative **total landings**, independently of its cycle count and Turbine option. Flight entries increase this total; queued flights include estimated landings in maintenance projections.

For Phase 34 repeating every 500 landings, select Landings, enter 500, and choose recurring from last compliance. When activating the template, enter the verified aircraft total landings at the last compliance. Last complied at 1,000 means next due at 1,500. Completion at 1,520 renews the inspection to 2,020. Initial one-time landing thresholds remain separate from recurring intervals.

Work-order completion captures aircraft total landings, including explicit readings for backdated work. Completion cannot precede the opening/previous-compliance readings or exceed current totals. Landing-only inspections remain active after recurring completion. Aircraft status, inspection lists, maintenance alerts, and logbook/report output show landing limits and remaining counts.

Component service landing limits reference the installed aircraft's total, not a component lifetime landing counter. After moving a component to a different aircraft, its service requirement reports that the landing baseline needs review. Open the requirement and enter verified limits and compliance readings for the new aircraft before using the schedule.

Template CSVs accept optional `landings`, `initial_landings`, and `landing_mode` columns in addition to the existing format. `landing_mode` is `FROM_LAST_COMPLIED` or `ABSOLUTE`. Existing CSVs and records without landing fields remain supported. Do not put landing intervals in the cycles column.
