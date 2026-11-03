-- Select the existing V14 database first. Import exactly once.
-- Existing rows retain NULL until assigned an ATA chapter.
ALTER TABLE components ADD COLUMN ata_chapter CHAR(2) NULL AFTER component_type, ADD INDEX idx_components_ata (ata_chapter);
ALTER TABLE inspections ADD COLUMN ata_chapter CHAR(2) NULL AFTER inspection_type, ADD INDEX idx_inspections_ata (ata_chapter);
