-- Import exactly once into the existing V6 database. Existing due values are retained.
ALTER TABLE inspections
  ADD COLUMN last_cycles INT UNSIGNED NULL DEFAULT NULL AFTER last_hours,
  ADD COLUMN interval_hours DECIMAL(10,1) NULL DEFAULT NULL AFTER due_hours,
  ADD COLUMN interval_cycles INT UNSIGNED NULL DEFAULT NULL AFTER due_cycles,
  ADD COLUMN calendar_interval_value INT UNSIGNED NULL DEFAULT NULL AFTER interval_cycles,
  ADD COLUMN calendar_interval_unit ENUM('DAYS','MONTHS','YEARS') NULL DEFAULT NULL AFTER calendar_interval_value;
