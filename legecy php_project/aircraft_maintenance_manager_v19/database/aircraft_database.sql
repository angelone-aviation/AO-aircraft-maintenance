CREATE TABLE aircraft (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  registration VARCHAR(20) NOT NULL UNIQUE,
  make VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  serial_number VARCHAR(100),
  current_tach DECIMAL(10,1) NOT NULL DEFAULT 0,
  current_hobbs DECIMAL(10,1) NOT NULL DEFAULT 0,
  current_landings INT NOT NULL DEFAULT 0,
  status ENUM('AIRWORTHY','MAINTENANCE','GROUNDED') NOT NULL DEFAULT 'AIRWORTHY',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE maintenance_records (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  aircraft_id INT UNSIGNED NOT NULL,
  maintenance_date DATE NOT NULL,
  work_order VARCHAR(50),
  maintenance_type VARCHAR(100),
  description TEXT NOT NULL,
  tach DECIMAL(10,1) DEFAULT 0,
  hobbs DECIMAL(10,1) DEFAULT 0,
  technician VARCHAR(150),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_maintenance_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE components (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  aircraft_id INT UNSIGNED NOT NULL,
  component_type VARCHAR(100) NOT NULL,
  part_number VARCHAR(100),
  serial_number VARCHAR(100),
  manufacturer VARCHAR(150),
  installed_date DATE,
  installed_tach DECIMAL(10,1),
  removed_date DATE,
  removed_tach DECIMAL(10,1),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_components_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE inspections (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  aircraft_id INT UNSIGNED NOT NULL,
  inspection_type VARCHAR(150) NOT NULL,
  last_date DATE,
  due_date DATE,
  last_hours DECIMAL(10,1),
  due_hours DECIMAL(10,1),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_inspections_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE documents (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  aircraft_id INT UNSIGNED,
  component_id INT UNSIGNED,
  title VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  document_type VARCHAR(100),
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_documents_aircraft FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) ON DELETE SET NULL,
  CONSTRAINT fk_documents_component FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('ADMIN','MANAGER','MECHANIC','PILOT','OWNER','AUDITOR') NOT NULL DEFAULT 'MECHANIC',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO aircraft (registration, make, model, serial_number, current_tach, current_hobbs, current_landings, status)
VALUES ('N-DEMO', 'Cessna', '172', 'DEMO-001', 1234.5, 1180.2, 2450, 'AIRWORTHY');

INSERT INTO inspections (aircraft_id, inspection_type, last_date, due_date, last_hours, due_hours, notes)
VALUES (1, 'Annual Inspection', '2026-01-15', '2027-01-15', 1180.0, NULL, 'Demo record — replace with actual aircraft data.'),
       (1, '100 Hour Inspection', '2026-08-01', NULL, 1150.0, 1250.0, 'Demo record — replace with actual aircraft data.');
