-- Select the existing V4 database first. Import once. Existing aircraft and flights get 0 cycles;
-- set each aircraft's verified current cycle baseline on its Edit page after upgrade.
ALTER TABLE aircraft ADD COLUMN current_cycles INT UNSIGNED NOT NULL DEFAULT 0 AFTER current_landings;
ALTER TABLE flight_logs ADD COLUMN cycles INT UNSIGNED NOT NULL DEFAULT 0 AFTER landings;
ALTER TABLE inspections ADD COLUMN due_cycles INT UNSIGNED NULL DEFAULT NULL AFTER due_hours;
