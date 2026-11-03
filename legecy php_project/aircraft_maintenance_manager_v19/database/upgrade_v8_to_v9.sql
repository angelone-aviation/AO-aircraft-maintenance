-- Select the existing V8 database first. Import exactly once.
ALTER TABLE inspections
  ADD COLUMN warning_calendar_months INT UNSIGNED NOT NULL DEFAULT 1 AFTER calendar_interval_unit,
  ADD COLUMN warning_hours DECIMAL(10,1) NOT NULL DEFAULT 25.0 AFTER warning_calendar_months,
  ADD COLUMN warning_cycles INT UNSIGNED NOT NULL DEFAULT 10 AFTER warning_hours;
