<?php
require_once __DIR__.'/../includes/total_time.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=(int)($_GET['id'] ?? 0); $s=$pdo->prepare('SELECT * FROM aircraft WHERE id=?'); $s->execute([$id]); $a=$s->fetch(); if (!$a) { http_response_code(404); exit('Aircraft not found.'); }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $reg=trim((string)($_POST['registration'] ?? '')); $make=trim((string)($_POST['make'] ?? '')); $model=trim((string)($_POST['model'] ?? '')); $serial=trim((string)($_POST['serial_number'] ?? '')); $status=(string)($_POST['status'] ?? '');
  if ($reg==='' || $make==='' || $model==='' || !in_array($status,['AIRWORTHY','MAINTENANCE','GROUNDED'],true)) throw new RuntimeException('Check required fields and status.');
  $source=(string)($_POST['total_time_source'] ?? 'TACH'); if (!in_array($source,['TACH','HOBBS'],true)) throw new RuntimeException('Choose tach or Hobbs.'); $adjustment=posted_adjustment('total_time_adjustment');
  $tach=posted_decimal('current_tach'); $hobbs=posted_decimal('current_hobbs'); $landings=posted_int('current_landings'); $cycles=posted_int('current_cycles'); if (($source==='HOBBS'?$hobbs:$tach)+$adjustment<0) throw new RuntimeException('Aircraft total time cannot be negative.');
  $data=['registration'=>$reg,'make'=>$make,'model'=>$model,'serial_number'=>$serial,'current_tach'=>$tach,'current_hobbs'=>$hobbs,'total_time_source'=>$source,'total_time_adjustment'=>$adjustment,'current_landings'=>$landings,'current_cycles'=>$cycles,'status'=>$status];
  $pdo->beginTransaction(); $q=$pdo->prepare('UPDATE aircraft SET registration=?,make=?,model=?,serial_number=?,current_tach=?,current_hobbs=?,total_time_source=?,total_time_adjustment=?,current_landings=?,current_cycles=?,status=? WHERE id=?'); $q->execute(array_merge(array_values($data),[$id])); audit($pdo,'UPDATE','aircraft',$id,$a,$data); $pdo->commit(); header('Location: view.php?id='.$id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error='Could not save. Check your values and whether the registration is already used.'; }
}
$page_title='Edit aircraft'; include __DIR__.'/../includes/header.php'; ?>
<h1>Edit <?= esc($a['registration']) ?></h1><p class="notice">Aircraft total time = selected instrument reading + signed adjustment. Current total: <?= esc(number_format(aircraft_total_time($a),1)) ?> hours. For instrument replacement, use the dedicated action on the aircraft page to preserve total time automatically.</p><?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?><form method="post"><?= csrf_field() ?><div class="form-grid">
<?php foreach (['registration'=>'Registration','make'=>'Make','model'=>'Model','serial_number'=>'Serial number','current_tach'=>'Tach','current_hobbs'=>'Hobbs','current_landings'=>'Landings','current_cycles'=>'Cycles'] as $key=>$label): ?><div class="field"><label><?= esc($label) ?></label><input name="<?= esc($key) ?>" value="<?= esc($a[$key]) ?>" <?= in_array($key,['current_tach','current_hobbs','current_landings','current_cycles']) ? 'type="number" min="0" step="'.(in_array($key,['current_landings','current_cycles'])?'1':'0.1').'"' : '' ?> required></div><?php endforeach; ?>
<div class="field"><label>Total time source</label><select name="total_time_source"><option value="TACH" <?= $a['total_time_source']==='TACH'?'selected':'' ?>>Tach</option><option value="HOBBS" <?= $a['total_time_source']==='HOBBS'?'selected':'' ?>>Hobbs</option></select></div>
<div class="field"><label>Signed total time adjustment (hours)</label><input type="number" step="0.1" name="total_time_adjustment" value="<?= esc($a['total_time_adjustment']) ?>" required></div>
<div class="field"><label>Status (manual assessment)</label><select name="status"><?php foreach (['AIRWORTHY','MAINTENANCE','GROUNDED'] as $status): ?><option <?= $a['status']===$status?'selected':'' ?>><?= esc($status) ?></option><?php endforeach; ?></select></div></div><div class="actions"><button class="btn">Save changes</button><a class="btn secondary" href="view.php?id=<?= $id ?>">Cancel</a></div></form><?php include __DIR__.'/../includes/footer.php'; ?>
