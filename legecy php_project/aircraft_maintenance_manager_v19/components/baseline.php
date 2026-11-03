<?php
require_once __DIR__.'/../includes/component_service.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]); if (!$id) { http_response_code(400); exit('Invalid component ID.'); }
$c=component_query($pdo,$id); if (!$c) { http_response_code(404); exit('Component not found.'); } $usage=component_usage($c); $error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $hours=$c['track_time']?posted_decimal('service_hours_base'):(float)$c['service_hours_base'];
  $raw_tso=$c['track_time']?trim((string)($_POST['tso_hours_base'] ?? '')):''; $tso=$c['track_time']?($raw_tso===''?null:posted_decimal('tso_hours_base')):$c['tso_hours_base'];
  $raw_tsr=$c['track_time']?trim((string)($_POST['tsr_hours_base'] ?? '')):''; $tsr=$c['track_time']?($raw_tsr===''?null:posted_decimal('tsr_hours_base')):$c['tsr_hours_base'];
  $cycles=$c['track_cycles']?posted_int('service_cycles_base'):(int)$c['service_cycles_base'];
  $days=$c['track_calendar']?posted_int('service_days_base'):(int)$c['service_days_base'];
  $reason=trim((string)($_POST['reason'] ?? ''));
  if ($cycles>2147483647 || $days>365000 || strlen($reason)<10 || strlen($reason)>2000) throw new RuntimeException('Check the verified values and enter a reason of at least 10 characters.');
  $pdo->beginTransaction(); $q=$pdo->prepare('SELECT id FROM components WHERE id=? FOR UPDATE'); $q->execute([$id]); if (!$q->fetch()) throw new RuntimeException('Component not found.');
  $old=component_query($pdo,$id); $old_usage=component_usage($old); $tt=null; $aircraft_cycles=null;
  if ($old['location_type']==='AIRCRAFT') {
   $q=$pdo->prepare('SELECT * FROM aircraft WHERE id=? FOR UPDATE'); $q->execute([$old['aircraft_id']]); $a=$q->fetch(); if (!$a) throw new RuntimeException('Aircraft not found.');
   $current_tt=aircraft_total_time($a); $current_cycles=(int)$a['current_cycles'];
   $tt=$c['track_time']?posted_decimal('installed_aircraft_total_time'):null; $aircraft_cycles=$c['track_cycles']?posted_int('installed_aircraft_cycles'):null;
   if (($tt!==null && $tt>$current_tt) || ($aircraft_cycles!==null && $aircraft_cycles>$current_cycles)) throw new RuntimeException('At-install aircraft readings cannot exceed current readings.');
  }
  $q=$pdo->prepare('UPDATE components SET service_hours_base=?,tso_hours_base=?,tsr_hours_base=?,service_cycles_base=?,service_days_base=?,installed_aircraft_total_time=?,installed_aircraft_cycles=? WHERE id=?');
  $q->execute([$hours,$tso,$tsr,$cycles,$days,$tt,$aircraft_cycles,$id]);
  audit($pdo,'BASELINE','components',$id,['component_hours'=>$old_usage['hours'],'component_cycles'=>$old_usage['cycles'],'service_days'=>$old_usage['days'],'aircraft_tt_at_install'=>$old['installed_aircraft_total_time'],'aircraft_cycles_at_install'=>$old['installed_aircraft_cycles']],['tsn_at_install'=>$hours,'tso_at_install'=>$tso,'tsr_at_install'=>$tsr,'component_cycles_at_install'=>$cycles,'prior_service_days'=>$days,'aircraft_tt_at_install'=>$tt,'aircraft_cycles_at_install'=>$aircraft_cycles,'reason'=>$reason]);
  $pdo->commit(); header('Location: view.php?id='.$id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not set baseline.'; }
}
$page_title='Component baseline'; include __DIR__.'/../includes/header.php'; ?>
<h1>Set installation baseline — <?= esc($c['component_type']) ?></h1>
<p class="notice">Current component hours = component time at install + current aircraft total time − aircraft total time at install. Cycles use the same calculation. Prior service days plus days since this installation give approximate months in service. Verify each value from records.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<form method="post"><?= csrf_field() ?><div class="form-grid">
<?php if ($c['location_type']==='AIRCRAFT' && $c['track_time']): ?><div class="field"><label>Aircraft total time at install</label><input type="number" name="installed_aircraft_total_time" min="0" step="0.1" value="<?= esc($c['installed_aircraft_total_time']) ?>" required></div><?php endif; ?><?php if ($c['location_type']==='AIRCRAFT' && $c['track_cycles']): ?><div class="field"><label>Aircraft cycles at install</label><input type="number" name="installed_aircraft_cycles" min="0" step="1" value="<?= esc($c['installed_aircraft_cycles']) ?>" required></div><?php endif; ?>
<?php if ($c['track_time']): ?><div class="field"><label>Time Since New (TSN) at install</label><input type="number" name="service_hours_base" min="0" step="0.1" value="<?= esc($c['service_hours_base']) ?>" required></div><div class="field"><label>Time Since Overhaul (TSO) at install</label><input type="number" name="tso_hours_base" min="0" step="0.1" value="<?= esc($c['tso_hours_base']) ?>" placeholder="Unknown / not applicable"></div>
<div class="field"><label>Time Since Repair (TSR) at install</label><input type="number" name="tsr_hours_base" min="0" step="0.1" value="<?= esc($c['tsr_hours_base']) ?>" placeholder="Unknown / not applicable"></div><?php endif; ?>
<?php if ($c['track_cycles']): ?><div class="field"><label>Component cycles at install</label><input type="number" name="service_cycles_base" min="0" step="1" value="<?= (int)$c['service_cycles_base'] ?>" required></div><?php endif; ?>
<?php if ($c['track_calendar']): ?><div class="field"><label>Prior days in service</label><input type="number" name="service_days_base" min="0" max="365000" step="1" value="<?= (int)$c['service_days_base'] ?>" required></div><?php endif; ?>
<div class="field full"><label>Source / reason for adjustment</label><textarea name="reason" minlength="10" maxlength="2000" required></textarea></div></div>
<div class="actions"><button class="btn">Save verified baseline</button><a class="btn secondary" href="view.php?id=<?= $id ?>">Cancel</a></div></form><?php include __DIR__.'/../includes/footer.php'; ?>
