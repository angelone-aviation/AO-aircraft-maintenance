-- Import once into the existing V3 database; previous flight entries are unchanged.
CREATE TABLE flight_corrections (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flight_id BIGINT UNSIGNED NOT NULL,
  aircraft_id INT UNSIGNED NOT NULL,
  corrected_by INT UNSIGNED NULL,
  reason TEXT NOT NULL,
  before_json LONGTEXT NOT NULL,
  after_json LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_corrections_flight (flight_id,created_at),
  CONSTRAINT fk_correction_flight FOREIGN KEY (flight_id) REFERENCES flight_logs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_correction_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE RESTRICT,
  CONSTRAINT fk_correction_user FOREIGN KEY (corrected_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
