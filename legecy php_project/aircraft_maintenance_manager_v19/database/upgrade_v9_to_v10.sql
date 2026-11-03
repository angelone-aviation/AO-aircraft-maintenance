-- Import ONCE into the existing V9 database. Back up first.
ALTER TABLE components DROP FOREIGN KEY fk_components_aircraft;
ALTER TABLE components
  MODIFY aircraft_id INT UNSIGNED NULL,
  ADD COLUMN location_type ENUM('AIRCRAFT','INVENTORY') NOT NULL DEFAULT 'AIRCRAFT' AFTER aircraft_id,
  ADD COLUMN parts_location VARCHAR(150) NULL AFTER location_type,
  ADD COLUMN install_position ENUM('LEFT','RIGHT','NUMBER 1','NUMBER 2','MAIN','AUX') NULL AFTER parts_location,
  ADD COLUMN service_hours_base DECIMAL(11,1) NOT NULL DEFAULT 0 AFTER install_position,
  ADD COLUMN service_cycles_base INT UNSIGNED NOT NULL DEFAULT 0 AFTER service_hours_base,
  ADD COLUMN installed_aircraft_total_time DECIMAL(11,1) NULL AFTER service_cycles_base,
  ADD COLUMN installed_aircraft_cycles INT UNSIGNED NULL AFTER installed_aircraft_total_time;
ALTER TABLE components ADD CONSTRAINT fk_components_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE SET NULL;
-- Existing components begin at zero component time/cycles. Set verified baselines in the app.
UPDATE components c JOIN aircraft a ON a.id=c.aircraft_id
 SET c.installed_aircraft_total_time=(CASE WHEN a.total_time_source='HOBBS' THEN a.current_hobbs ELSE a.current_tach END + a.total_time_adjustment),
     c.installed_aircraft_cycles=a.current_cycles
 WHERE c.aircraft_id IS NOT NULL;
CREATE TABLE component_service_requirements (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 component_id INT UNSIGNED NOT NULL,
 requirement_type ENUM('Life Limits','Overhaul Requirement','Inspection Requirement') NOT NULL,
 description VARCHAR(255) NOT NULL,
 last_date DATE NULL,
 last_hours DECIMAL(11,1) NULL,
 last_cycles INT UNSIGNED NULL,
 calendar_interval_value INT UNSIGNED NULL,
 calendar_interval_unit ENUM('DAYS','MONTHS','YEARS') NULL,
 interval_hours DECIMAL(10,1) NULL,
 interval_cycles INT UNSIGNED NULL,
 due_date DATE NULL,
 due_hours DECIMAL(11,1) NULL,
 due_cycles INT UNSIGNED NULL,
 warning_calendar_months INT UNSIGNED NOT NULL DEFAULT 1,
 warning_hours DECIMAL(10,1) NOT NULL DEFAULT 25.0,
 warning_cycles INT UNSIGNED NOT NULL DEFAULT 10,
 notes TEXT NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT fk_component_service_component FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE RESTRICT,
 INDEX idx_component_service_component (component_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE component_movements (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 component_id INT UNSIGNED NOT NULL,
 action ENUM('INSTALL','REMOVE') NOT NULL,
 aircraft_id INT UNSIGNED NULL,
 parts_location VARCHAR(150) NULL,
 install_position VARCHAR(20) NULL,
 movement_date DATE NOT NULL,
 component_hours DECIMAL(11,1) NOT NULL,
 component_cycles INT UNSIGNED NOT NULL,
 note TEXT NOT NULL,
 performed_by INT UNSIGNED NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT fk_movement_component FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE RESTRICT,
 CONSTRAINT fk_movement_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE SET NULL,
 CONSTRAINT fk_movement_user FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL,
 INDEX idx_movement_component (component_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
