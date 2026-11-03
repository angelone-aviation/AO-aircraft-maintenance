FLIGHT HOPE AIRCRAFT MAINTENANCE — V19 PARTS & HARDWARE INVENTORY
PHP 8.0+, PDO MySQL, MySQL/MariaDB, HTTPS. Upgrade from a working V18 app.

A2/CPANEL UPGRADE
1. Back up the application database and site files outside the public folder.
2. In phpMyAdmin, click your EXISTING application database in the left sidebar. Import database/upgrade_v18_to_v19.sql ONCE. It creates inventory_locations, parts_inventory, and parts_stock_history. It does not change existing rows.
3. Extract V19 into the SAME app document root, overwriting application files while keeping config.php. Remove the uploaded ZIP from the public folder afterward.
4. Sign in as Admin, Manager, or Mechanic. Open Parts Inventory > Locations and add at least one active location. Then add a stock row, search for it, and record a test receipt or issue. Check the stock history.

Stock rows are separate for each part number / lot / condition / location combination. A location has a name, address, contact name, phone, email, notes, and active state. Locations can be edited or made inactive; existing stock stays assigned, but inactive locations cannot be selected for new stock rows. Locations with stock cannot be deleted (there is no delete action).

Stock stores description, part and alternate numbers, manufacturer, ATA chapter, category, quantity/unit, minimum quantity, location, lot/batch, condition, dates, supplier, purchase reference, and notes. Search by part details, manufacturer, lot, supplier or reference, and filter by ATA, category, condition, location or low stock. Results are limited to the first 500; narrow a search to see more.

Opening quantity is recorded in stock history. Receipts, issues, and corrections record the change, resulting quantity, reference, note, user and timestamp. Quantity cannot be negative. Only Admin, Manager, and Mechanic can edit locations, stock details, or quantities; other signed-in roles can view and search.

The new Parts Inventory is separate from the existing tracked Components module. Components' legacy free-text parts_location field is unchanged in this release; moving or installing a tracked component does not automatically change a stock quantity. Serialized, life-limited components remain in Components.

If an unknown-table error appears, verify that the migration ran in the database referenced by config.php. Do not rerun a partially completed migration without checking which tables already exist.
