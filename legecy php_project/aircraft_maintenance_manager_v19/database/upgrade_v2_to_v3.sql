-- Import once into the EXISTING V2 database. No existing rows are changed.
CREATE TABLE flight_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  aircraft_id INT UNSIGNED NOT NULL,
  flight_date DATE NOT NULL,
  origin VARCHAR(20) NOT NULL DEFAULT '',
  destination VARCHAR(20) NOT NULL DEFAULT '',
  pilot_name VARCHAR(150) NOT NULL,
  tach_start DECIMAL(10,1) NOT NULL,
  tach_end DECIMAL(10,1) NOT NULL,
  hobbs_start DECIMAL(10,1) NOT NULL,
  hobbs_end DECIMAL(10,1) NOT NULL,
  landings INT UNSIGNED NOT NULL DEFAULT 0,
  notes TEXT NULL,
  entered_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_flight_aircraft_date (aircraft_id,flight_date),
  CONSTRAINT fk_flight_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE RESTRICT,
  CONSTRAINT fk_flight_user FOREIGN KEY (entered_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
