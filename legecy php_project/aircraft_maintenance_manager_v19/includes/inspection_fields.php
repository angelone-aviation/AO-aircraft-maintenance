<?php // $record contains an inspection row or an empty array on the add page. ?>
<div class="form-grid">
<div class="field"><label>Inspection type</label><input name="inspection_type" maxlength="150" value="<?= esc($record['inspection_type'] ?? '') ?>" required></div>
<div class="field"><label>Last completed date</label><input type="date" name="last_date" value="<?= esc($record['last_date'] ?? '') ?>"></div>
<div class="field"><label>Last completed aircraft total time</label><input type="number" name="last_hours" min="0" step="0.1" value="<?= esc($record['last_hours'] ?? '') ?>"></div>
<div class="field"><label>Last completed cycles</label><input type="number" name="last_cycles" min="0" step="1" value="<?= esc($record['last_cycles'] ?? '') ?>"></div>
<div class="field"><label>Time interval (aircraft hours)</label><input type="number" name="interval_hours" min="0.1" step="0.1" value="<?= esc($record['interval_hours'] ?? '') ?>"></div>
<div class="field"><label>Cycles interval</label><input type="number" name="interval_cycles" min="1" step="1" value="<?= esc($record['interval_cycles'] ?? '') ?>"></div>
<div class="field"><label>Calendar interval</label><input type="number" name="calendar_interval_value" min="1" step="1" value="<?= esc($record['calendar_interval_value'] ?? '') ?>"></div>
<div class="field"><label>Calendar unit</label><select name="calendar_interval_unit"><?php foreach (['DAYS','MONTHS','YEARS'] as $unit): ?><option value="<?= $unit ?>" <?= ($record['calendar_interval_unit'] ?? 'MONTHS')===$unit?'selected':'' ?>><?= ucfirst(strtolower($unit)) ?></option><?php endforeach; ?></select></div>
<div class="field"><label>Due soon: calendar months before due</label><input type="number" name="warning_calendar_months" min="0" max="1200" step="1" value="<?= esc($record['warning_calendar_months'] ?? '1') ?>" required></div>
<div class="field"><label>Due soon: aircraft hours before due</label><input type="number" name="warning_hours" min="0" step="0.1" value="<?= esc($record['warning_hours'] ?? '25.0') ?>" required></div>
<div class="field"><label>Due soon: cycles before due</label><input type="number" name="warning_cycles" min="0" max="1000000" step="1" value="<?= esc($record['warning_cycles'] ?? '10') ?>" required></div>
<div class="field full"><label>Notes</label><textarea name="notes" maxlength="10000"><?= esc($record['notes'] ?? '') ?></textarea></div>
</div>
