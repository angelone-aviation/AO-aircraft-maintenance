-- Import once into the existing V7 database. Current total time initially equals current tach.
ALTER TABLE aircraft
  ADD COLUMN total_time_source ENUM('TACH','HOBBS') NOT NULL DEFAULT 'TACH' AFTER current_hobbs,
  ADD COLUMN total_time_adjustment DECIMAL(10,1) NOT NULL DEFAULT 0.0 AFTER total_time_source;
ALTER TABLE flight_logs
  ADD COLUMN total_time_start DECIMAL(11,1) NULL DEFAULT NULL AFTER hobbs_end,
  ADD COLUMN total_time_end DECIMAL(11,1) NULL DEFAULT NULL AFTER total_time_start;
-- Existing flight snapshots follow the prior tach-based baseline. This does not alter aircraft readings.
UPDATE flight_logs SET total_time_start=tach_start,total_time_end=tach_end WHERE total_time_start IS NULL;
