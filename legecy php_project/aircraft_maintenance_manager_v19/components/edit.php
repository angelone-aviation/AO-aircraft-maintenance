<?php
require_once __DIR__.'/../includes/component_service.php';
require_once __DIR__.'/../includes/ata_chapters.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]); if (!$id) { http_response_code(400); exit('Invalid component ID.'); }
$c=component_query($pdo,$id); if (!$c) { http_response_code(404); exit('Component not found.'); } $error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $type=trim((string)($_POST['component_type'] ?? '')); $ata=posted_ata(); $part=trim((string)($_POST['part_number'] ?? '')); $serial=trim((string)($_POST['serial_number'] ?? '')); $manufacturer=trim((string)($_POST['manufacturer'] ?? '')); $notes=trim((string)($_POST['notes'] ?? ''));
  if ($type==='' || strlen($type)>100 || strlen($part)>100 || strlen($serial)>100 || strlen($manufacturer)>150 || strlen($notes)>10000) throw new RuntimeException('Check component details.');
  $position=$c['location_type']==='AIRCRAFT'?(string)($_POST['install_position'] ?? ''):null;
  $date=$c['location_type']==='AIRCRAFT'?date_or_null('installed_date'):null;
  $parts=$c['location_type']==='INVENTORY'?trim((string)($_POST['parts_location'] ?? '')):null;
  if ($c['location_type']==='AIRCRAFT' && (!$date || !in_array($position,['LEFT','RIGHT','NUMBER 1','NUMBER 2','MAIN','AUX'],true))) throw new RuntimeException('Choose the installation date and position.');
  if ($c['location_type']==='INVENTORY' && ($parts==='' || strlen($parts)>150)) throw new RuntimeException('Enter a parts location.');
  $track_calendar=isset($_POST['track_calendar'])?1:0; $track_time=isset($_POST['track_time'])?1:0; $track_cycles=isset($_POST['track_cycles'])?1:0;
  if (!$track_calendar && !$track_time && !$track_cycles) throw new RuntimeException('Select at least one tracking dimension.');
  $data=['track_calendar'=>$track_calendar,'track_time'=>$track_time,'track_cycles'=>$track_cycles,'component_type'=>$type,'ata_chapter'=>$ata,'part_number'=>$part,'serial_number'=>$serial,'manufacturer'=>$manufacturer,'notes'=>$notes,'install_position'=>$position,'installed_date'=>$date,'parts_location'=>$parts];
  $pdo->beginTransaction(); $q=$pdo->prepare('SELECT * FROM components WHERE id=? FOR UPDATE'); $q->execute([$id]); $before=$q->fetch(); if (!$before || $before['location_type']!==$c['location_type']) throw new RuntimeException('Location changed. Refresh the page.');
  // Count calendar limits separately; SQL aggregate over zero rows returns NULL sums.
  $q=$pdo->prepare('SELECT SUM(CASE WHEN due_date IS NOT NULL THEN 1 ELSE 0 END) AS calendar_count, SUM(CASE WHEN due_hours IS NOT NULL THEN 1 ELSE 0 END) AS time_count, SUM(CASE WHEN due_cycles IS NOT NULL THEN 1 ELSE 0 END) AS cycle_count FROM component_service_requirements WHERE component_id=?'); $q->execute([$id]); $used=$q->fetch();
  if ((!$track_calendar && (int)$used['calendar_count']>0) || (!$track_time && (int)$used['time_count']>0) || (!$track_cycles && (int)$used['cycle_count']>0)) throw new RuntimeException('A service requirement still uses a dimension being disabled. Edit those requirements first.');
  $set=implode(',',array_map(static function($f){return $f.'=?';},array_keys($data)));
  $q=$pdo->prepare('UPDATE components SET '.$set.' WHERE id=?'); $q->execute(array_merge(array_values($data),[$id])); audit($pdo,'UPDATE','components',$id,$before,$data);
  $pdo->commit(); header('Location: view.php?id='.$id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not update component.'; }
}
$page_title='Edit component'; include __DIR__.'/../includes/header.php'; ?>
<h1>Edit <?= esc($c['component_type']) ?></h1><?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?><p class="notice">Use Move to change between aircraft and inventory. This form updates details and the position or shelf at the current location.</p>
<form method="post"><?= csrf_field() ?><div class="form-grid"><div class="field full"><label>Track by (at least one)</label><label class="check-option"><input type="checkbox" name="track_calendar" <?= $c['track_calendar']?'checked':'' ?>> Calendar</label><label class="check-option"><input type="checkbox" name="track_time" <?= $c['track_time']?'checked':'' ?>> Time</label><label class="check-option"><input type="checkbox" name="track_cycles" <?= $c['track_cycles']?'checked':'' ?>> Cycles</label></div><div class="field"><label>Component type</label><input name="component_type" maxlength="100" value="<?= esc($c['component_type']) ?>" required></div><div class="field"><label>ATA Chapter</label><?= ata_select($c['ata_chapter']) ?></div><div class="field"><label>Part number</label><input name="part_number" maxlength="100" value="<?= esc($c['part_number']) ?>"></div><div class="field"><label>Serial number</label><input name="serial_number" maxlength="100" value="<?= esc($c['serial_number']) ?>"></div><div class="field"><label>Manufacturer</label><input name="manufacturer" maxlength="150" value="<?= esc($c['manufacturer']) ?>"></div>
<?php if ($c['location_type']==='AIRCRAFT'): ?><div class="field"><label>Installed date</label><input type="date" name="installed_date" value="<?= esc($c['installed_date']) ?>" required></div><div class="field"><label>Installed position</label><select name="install_position"><?php foreach (['LEFT','RIGHT','NUMBER 1','NUMBER 2','MAIN','AUX'] as $pos): ?><option value="<?= esc($pos) ?>" <?= $c['install_position']===$pos?'selected':'' ?>><?= esc(ucwords(strtolower($pos))) ?></option><?php endforeach; ?></select></div><?php else: ?><div class="field"><label>Parts location</label><input name="parts_location" maxlength="150" value="<?= esc($c['parts_location']) ?>" required></div><?php endif; ?>
<div class="field full"><label>Notes</label><textarea name="notes" maxlength="10000"><?= esc($c['notes']) ?></textarea></div></div><div class="actions"><button class="btn">Save details</button><a class="btn secondary" href="view.php?id=<?= $id ?>">Cancel</a></div></form><?php include __DIR__.'/../includes/footer.php'; ?>
