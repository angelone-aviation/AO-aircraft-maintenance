-- Import ONCE into the existing V13 database. Existing tracking stays enabled.
ALTER TABLE components
  ADD COLUMN track_calendar TINYINT(1) NOT NULL DEFAULT 1 AFTER location_type,
  ADD COLUMN track_time TINYINT(1) NOT NULL DEFAULT 1 AFTER track_calendar,
  ADD COLUMN track_cycles TINYINT(1) NOT NULL DEFAULT 1 AFTER track_time,
  ADD COLUMN tso_hours_base DECIMAL(11,1) NULL DEFAULT NULL AFTER service_hours_base,
  ADD COLUMN tsr_hours_base DECIMAL(11,1) NULL DEFAULT NULL AFTER tso_hours_base;
ALTER TABLE component_service_requirements
  ADD COLUMN time_basis ENUM('TSN','TSO','TSR') NOT NULL DEFAULT 'TSN' AFTER interval_hours;
