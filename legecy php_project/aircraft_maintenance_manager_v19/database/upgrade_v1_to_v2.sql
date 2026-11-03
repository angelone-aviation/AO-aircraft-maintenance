-- Import exactly once after making a complete database backup. Does not delete V1 data.
ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1;
CREATE TABLE audit_log (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 user_id INT UNSIGNED NULL,
 action VARCHAR(30) NOT NULL,
 entity_table VARCHAR(64) NOT NULL,
 entity_id INT UNSIGNED NOT NULL,
 before_json LONGTEXT NULL,
 after_json LONGTEXT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 INDEX idx_audit_entity (entity_table,entity_id),
 INDEX idx_audit_user (user_id),
 CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
