-- Import ONCE into the existing V10 database. Prior days default to zero;
-- the current installed period is calculated from installed_date.
ALTER TABLE components ADD COLUMN service_days_base INT UNSIGNED NOT NULL DEFAULT 0 AFTER service_cycles_base;
ALTER TABLE component_movements ADD COLUMN service_days INT UNSIGNED NOT NULL DEFAULT 0 AFTER component_cycles;
