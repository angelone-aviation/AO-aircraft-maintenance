-- Import ONCE into the existing V18 application database. Back up first.
CREATE TABLE inventory_locations (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(150) NOT NULL,
 address_line1 VARCHAR(200) NULL,
 address_line2 VARCHAR(200) NULL,
 city VARCHAR(100) NULL,
 region VARCHAR(100) NULL,
 postal_code VARCHAR(30) NULL,
 country VARCHAR(100) NULL,
 contact_name VARCHAR(150) NULL,
 contact_phone VARCHAR(60) NULL,
 contact_email VARCHAR(255) NULL,
 notes TEXT NULL,
 is_active TINYINT(1) NOT NULL DEFAULT 1,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_inventory_location_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE parts_inventory (
 id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 part_name VARCHAR(200) NOT NULL,
 part_number VARCHAR(100) NOT NULL,
 alternate_part_number VARCHAR(100) NULL,
 manufacturer VARCHAR(150) NULL,
 ata_chapter CHAR(2) NULL,
 category ENUM('PART','HARDWARE','CONSUMABLE','OTHER') NOT NULL,
 quantity_on_hand DECIMAL(12,3) NOT NULL DEFAULT 0,
 unit VARCHAR(30) NOT NULL DEFAULT 'each',
 minimum_quantity DECIMAL(12,3) NOT NULL DEFAULT 0,
 location_id INT UNSIGNED NOT NULL,
 lot_number VARCHAR(100) NULL,
 item_condition ENUM('NEW','SERVICEABLE','UNSERVICEABLE','QUARANTINE') NOT NULL DEFAULT 'NEW',
 received_date DATE NULL,
 expiration_date DATE NULL,
 supplier VARCHAR(150) NULL,
 purchase_reference VARCHAR(150) NULL,
 notes TEXT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 CONSTRAINT fk_parts_inventory_location FOREIGN KEY (location_id) REFERENCES inventory_locations(id) ON DELETE RESTRICT,
 INDEX idx_parts_number (part_number),
 INDEX idx_parts_alternate (alternate_part_number),
 INDEX idx_parts_name (part_name),
 INDEX idx_parts_ata (ata_chapter),
 INDEX idx_parts_location (location_id),
 INDEX idx_parts_lot (lot_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE parts_stock_history (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 inventory_id INT UNSIGNED NOT NULL,
 action ENUM('OPENING','RECEIVE','ISSUE','ADJUST') NOT NULL,
 quantity_change DECIMAL(12,3) NOT NULL,
 quantity_after DECIMAL(12,3) NOT NULL,
 reference_number VARCHAR(150) NULL,
 note VARCHAR(1000) NOT NULL,
 performed_by INT UNSIGNED NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT fk_parts_history_inventory FOREIGN KEY (inventory_id) REFERENCES parts_inventory(id) ON DELETE RESTRICT,
 CONSTRAINT fk_parts_history_user FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL,
 INDEX idx_parts_history_inventory (inventory_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
