# Cessna 441 Chapter 5 extraction for N626KB

The supplied manual can be used to generate reviewable inspection templates. This proof of concept creates draft files, not active website records. The website does not currently implement manual-to-template importing. See [implementation feasibility](manual-import-feasibility.md).

## Source and scope

Source: D2518-15-13 maintenance manual (`16802162-Cessna_441_Maintenance_Manual_D2518-15-13_Mm.pdf`, kept in the Reference library, not the repository), 2,937 PDF pages, 98.48 MiB. Its text is extractable without OCR. The title identifies Revision 15, July 1, 2002 (PDF pages 1–2). Chapter 5 includes Temporary Revision 5-1 dated December 1, 2003 and 5-2 dated February 2, 2004 (PDF pages 3–5). These dates describe this copy; currency has not been established.

Page references below are one-based PDF page numbers. The JSON also retains the printed manual section, original interval wording, and source-file SHA-256.

[Generated draft records](cessna-441-inspection-drafts.json) contain 23 phase definitions, 14 extracted Phase 2 checklist rows, nine component-limit candidates, seven event-triggered candidates, and references to external component publications. Checklists for phases other than Phase 2 remain source references; this is not a complete digitization of every task or maintenance procedure.

## Phase definitions

Intervals were cross-checked between the inspection cross-reference table (5-10-00, PDF pages 33–34) and each phase cover sheet. “First” thresholds are distinct from repeat intervals and require confirmation of the applicable counter/baseline.

| Phase | First threshold, where specified | Repeat interval                        | PDF checklist pages |
| ----- | -------------------------------- | -------------------------------------- | ------------------- |
| 2     | —                                | 100 hours or 12 months, first reached  | 79–80               |
| 3     | —                                | 200 hours or 12 months, first reached  | 81–90               |
| 4     | —                                | 600 hours or 24 months, first reached  | 91–95               |
| 5     | —                                | 600 hours or 24 months, first reached  | 96–101              |
| 6     | —                                | 600 hours or 24 months, first reached  | 102–104             |
| D     | —                                | Combined 4/5/6; 600 hours or 24 months | 68–78               |
| 8     | 1,900 hours                      | 600 hours                              | 105                 |
| 9     | —                                | 1,000 hours                            | 106                 |
| 11    | 1,300 hours                      | 1,200 hours                            | 107                 |
| 12    | —                                | 2 years                                | 108                 |
| 13    | —                                | 3 years                                | 109                 |
| 14    | —                                | 5 years                                | 110                 |
| 16    | —                                | 400 hours                              | 111                 |
| 17    | —                                | 900 hours                              | 112                 |
| 18    | 4,000 hours                      | 2,000 hours                            | 113                 |
| 19    | 5,000 hours                      | 2,000 hours                            | 114                 |
| 20    | 6,000 hours                      | 2,000 hours                            | 115                 |
| 23    | 4,000 hours                      | 200 hours                              | 116                 |
| 24    | 4,000 hours                      | 400 hours                              | 117                 |
| 25    | —                                | 3,000 hours                            | 118                 |
| 26    | —                                | 12 years                               | 119                 |
| 27    | —                                | 6 years                                | 120                 |
| 28    | 3,000 hours                      | 2,000 hours                            | 121                 |

Phase D combines phases 4, 5 and 6; those are alternative program arrangements, not four independent inspections to activate together. Method 1 sequences phases 4, 5, and 6 at the 200-, 400-, and 600-hour positions of the cycle, alongside phases 2 and 3. Method 2 performs Phase D at the 600-hour position. Program selection and startup requirements must be captured before generating actual due readings. Source: 5-12-00, PDF pages 64–67, and Phase D cover, PDF page 68.

## Phase 2 example

The draft contains the 14 item codes and task descriptions from 5-12-02, PDF pages 79–80: batteries/vents, emergency-bus fuses, battery reconditioning, air-cycle-machine oil level, propeller deice equipment, engine-manual inspection requirements, fuel lines, engine controls, exhaust, three starter-generator checks, Hartzell blade-clamp lubrication, and tires. Each includes its source page and zone numbers. The Hartzell-only task demonstrates why installed-component applicability must be reviewed.

General phase criteria also require surrounding-area inspections, reconfirmation of affected tasks after subsequent maintenance, and a final preflight inspection. Those criteria and referenced detailed procedures must remain available with a generated task package; the extracted rows alone are not complete work instructions (PDF pages 79–80).

## Components and events

Component time limits are separate from phase inspections (5-11-00, PDF pages 62–63). Examples include trim actuators at 1,000 hours or three years, starter-generators at 1,000 hours, and particular oxygen cylinders at 24 years or 4,380 cycles. Fire-extinguisher cartridges have different part-number-specific shelf/service/manufacture-age limits. Engine hoses have a five-year-or-engine-overhaul rule. Aileron hinge brackets have serial applicability. Engine, propeller, governor and other intervals refer to external manufacturer publications; this chapter alone does not supply all their limits.

Unscheduled checks cover hard/overweight landings, overspeed, landing-gear blowdown, severe turbulence/maneuvers, lightning, foreign-object damage and certain towing/ground-handling loads. These are event-triggered records, not calendar recurrences (5-50-00, PDF pages 160–163).

## Proposed website workflow

1. Upload a manual in the aircraft or component profile; record manufacturer, document number, revision and applicability.
2. Extract candidate phase inspections, component requirements and checklist tasks with clickable source pages.
3. Review applicability, program method, initial/repeat thresholds and unresolved external references. Retain draft status until these are resolved.
4. Enter actual last-compliance dates and readings, then create selected inspection schedules and reusable task definitions. Instantiated work-order task cards retain their own results and signoffs.

For calendar-month inspection schedules, retain the requested application rule: completion on December 12, 2025 plus 12 months gives December 31, 2026, subject to an earlier hours limit. Do not silently apply that rounding to cartridge manufacture-age/shelf-life limits or other differently defined component limits.

N626KB was not found in the development deployment's aircraft query. It may exist in browser demo storage or another deployment. No aircraft link, serial applicability, compliance baseline, due date or active maintenance record was fabricated. The draft uses N626KB as the intended registration only.

## Validation

Confirmed 23 phase definitions against phase covers and the cross-reference table; checked 14 Phase 2 codes and nonempty descriptions/zones against both checklist pages. JSON parses successfully. No application code or active database records were changed. Remaining work includes current-revision verification, aircraft/component applicability, full task extraction for other phases, and implementing the upload/review workflow.
