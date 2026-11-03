<div class="form-grid">
<div class="field"><label>Part name / description</label><input name="part_name" maxlength="200" value="<?= esc($record['part_name'] ?? '') ?>" required></div>
<div class="field"><label>Part number</label><input name="part_number" maxlength="100" value="<?= esc($record['part_number'] ?? '') ?>" required></div>
<div class="field"><label>Alternate part number</label><input name="alternate_part_number" maxlength="100" value="<?= esc($record['alternate_part_number'] ?? '') ?>"></div>
<div class="field"><label>Manufacturer</label><input name="manufacturer" maxlength="150" value="<?= esc($record['manufacturer'] ?? '') ?>"></div>
<div class="field"><label>ATA Chapter</label><?= ata_select($record['ata_chapter'] ?? null) ?></div>
<div class="field"><label>Category</label><select name="category" required><?php foreach (['PART'=>'Part','HARDWARE'=>'Hardware','CONSUMABLE'=>'Consumable','OTHER'=>'Other'] as $value=>$label): ?><option value="<?= esc($value) ?>" <?= ($record['category'] ?? 'PART')===$value?'selected':'' ?>><?= esc($label) ?></option><?php endforeach; ?></select></div>
<div class="field"><label>Location</label><select name="location_id" required><option value="">Select location</option><?php foreach ($locations as $location): ?><option value="<?= (int)$location['id'] ?>" <?= (int)($record['location_id'] ?? 0)===(int)$location['id']?'selected':'' ?>><?= esc($location['name']) ?></option><?php endforeach; ?></select><small><a href="<?= esc(url('inventory/locations.php')) ?>">Add or edit locations</a></small></div>
<div class="field"><label>Lot / batch number</label><input name="lot_number" maxlength="100" value="<?= esc($record['lot_number'] ?? '') ?>"></div>
<div class="field"><label>Condition</label><select name="item_condition" required><?php foreach (['NEW'=>'New','SERVICEABLE'=>'Serviceable','UNSERVICEABLE'=>'Unserviceable','QUARANTINE'=>'Quarantine'] as $value=>$label): ?><option value="<?= esc($value) ?>" <?= ($record['item_condition'] ?? 'NEW')===$value?'selected':'' ?>><?= esc($label) ?></option><?php endforeach; ?></select></div>
<div class="field"><label>Unit</label><input name="unit" maxlength="30" value="<?= esc($record['unit'] ?? 'each') ?>" placeholder="each, box, litre" required></div>
<div class="field"><label>Minimum quantity</label><input type="number" name="minimum_quantity" min="0" max="999999999" step="0.001" value="<?= esc($record['minimum_quantity'] ?? '0') ?>" required></div>
<div class="field"><label>Received date</label><input type="date" name="received_date" value="<?= esc($record['received_date'] ?? '') ?>"></div>
<div class="field"><label>Expiration date</label><input type="date" name="expiration_date" value="<?= esc($record['expiration_date'] ?? '') ?>"></div>
<div class="field"><label>Supplier</label><input name="supplier" maxlength="150" value="<?= esc($record['supplier'] ?? '') ?>"></div>
<div class="field"><label>Purchase reference</label><input name="purchase_reference" maxlength="150" value="<?= esc($record['purchase_reference'] ?? '') ?>"></div>
<div class="field full"><label>Notes</label><textarea name="notes" maxlength="10000"><?= esc($record['notes'] ?? '') ?></textarea></div>
</div>
