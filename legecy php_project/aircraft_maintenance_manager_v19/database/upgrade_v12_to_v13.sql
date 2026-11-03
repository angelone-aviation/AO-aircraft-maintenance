-- Select existing V12 database. Import ONCE. Existing due values are preserved.
ALTER TABLE component_service_requirements
  ADD COLUMN time_limit_mode ENUM('FROM_LAST_COMPLIED','ABSOLUTE') NOT NULL DEFAULT 'FROM_LAST_COMPLIED' AFTER interval_hours,
  ADD COLUMN cycle_limit_mode ENUM('FROM_LAST_COMPLIED','ABSOLUTE') NOT NULL DEFAULT 'FROM_LAST_COMPLIED' AFTER interval_cycles;
