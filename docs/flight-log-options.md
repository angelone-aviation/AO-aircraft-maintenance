# Aircraft options in the flight log

Aircraft profile options control additional fields in the flight form, including flights opened from a flight plan:

| Aircraft options                          | Additional fields                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| None, or Twin only                        | None                                                                   |
| Turbine                                   | Start time (engine-start duration in seconds), Start max EGT (°C)      |
| Twin and Turbine                          | Separate left and right start durations and maximum start EGT readings |
| Amphibious, with any engine configuration | Sea/Land selection beside the landing count                            |

The new readings are optional. Empty readings stay unrecorded rather than becoming zero. Start duration may include fractional seconds. Maximum EGT records the observed value; no aircraft-specific temperature limits are inferred. A Sea/Land selection describes the landing count for that flight entry, rather than maintaining separate sea and land counters.

Recorded readings appear in the flight log and survive offline queuing, synchronization, corrections and counter rebuilds. Historical engine positions and landing surfaces remain editable if the aircraft profile options later change. Switching aircraft in a new-flight form resets the aircraft-specific inputs to prevent carrying readings to another aircraft. Existing flight dates, meter readings, cycles and landing totals retain their prior behavior.

## Flight time log

Enable **Flight time log** in the aircraft profile beside Twin, Turbine, and the other options. Enter its current cumulative hours, then select **Flight time log** as the default maintenance time source if required. Switching sources preserves aircraft total time through the existing adjustment calculation.

Pilots enter the updated cumulative takeoff-to-touchdown hours, in tenths, rather than takeoff and touchdown timestamps. When this is the selected source, Hobbs and tach ending readings are optional. The selected source drives aircraft total time and the maintenance/component tracking that uses aircraft time. Flight time log readings also appear in work-order completion, logbook entries, and aircraft status sheets.

The new input and source option are hidden when the aircraft option is off. Previously recorded flight readings remain available for history and corrections. Disabling the option while it is the selected source switches back to Hobbs and preserves total time. Existing aircraft are unchanged until the option is enabled.

## Same as last flight and place suggestions

On a new flight (not one from a plan, a flight session, a retry or a review), **Same as last flight** fills the pilot, copilot, origin and destination from the most recent flight of the chosen aircraft that you can see; rejected flights are skipped. It never fills meter readings, times, fuel, oil, remarks or the date: starting readings still come from the aircraft's totals. The button appears only when the aircraft has a previous flight. A pilot or copilot who can no longer be chosen is not filled in.

The Origin and Destination fields suggest the Flight Program's eight most-used places from its own flight records, origins and destinations counted together, most used first and then most recent. Spellings that differ only in letter case or spaces count as one place. Any other place can still be typed. No outside lookup is made.
