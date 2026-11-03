<?php
require_once __DIR__.'/../includes/component_service.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]); if (!$id) { http_response_code(400); exit('Invalid component ID.'); }
$c=component_query($pdo,$id); if (!$c) { http_response_code(404); exit('Component not found.'); }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $date=date_or_null('movement_date'); $note=trim((string)($_POST['note'] ?? ''));
  if (!$date || $date!==date('Y-m-d') || strlen($note)<10 || strlen($note)>2000) throw new RuntimeException('Use today’s date for a reading snapshot and enter a reason of at least 10 characters.');
  $target_aircraft=null; $position=null; $parts_location=null;
  if ($c['location_type']==='INVENTORY') {
   $target_aircraft=posted_int('aircraft_id'); $position=(string)($_POST['install_position'] ?? '');
   if (!in_array($position,['LEFT','RIGHT','NUMBER 1','NUMBER 2','MAIN','AUX'],true)) throw new RuntimeException('Choose an installation position.');
  } else {
   $parts_location=trim((string)($_POST['parts_location'] ?? ''));
   if ($parts_location==='' || strlen($parts_location)>150) throw new RuntimeException('Enter a parts location.');
  }
  $pdo->beginTransaction();
  // Lock the component, then the relevant aircraft, before freezing/starting usage.
  $q=$pdo->prepare('SELECT id FROM components WHERE id=? FOR UPDATE'); $q->execute([$id]); if (!$q->fetch()) throw new RuntimeException('Component was removed.');
  $current=component_query($pdo,$id);
  if ($current['location_type']!==$c['location_type']) throw new RuntimeException('Location changed. Refresh the page.');
  $aircraft=null;
  if ($target_aircraft!==null) { $q=$pdo->prepare('SELECT * FROM aircraft WHERE id=? FOR UPDATE'); $q->execute([$target_aircraft]); $aircraft=$q->fetch(); if (!$aircraft) throw new RuntimeException('Select a valid aircraft.'); }
  else { $q=$pdo->prepare('SELECT * FROM aircraft WHERE id=? FOR UPDATE'); $q->execute([$current['aircraft_id']]); $locked_aircraft=$q->fetch(); if (!$locked_aircraft) throw new RuntimeException('Installed aircraft was not found.'); $current=array_merge($current,$locked_aircraft); }
  $usage=component_usage($current); if ($usage['error']) throw new RuntimeException('Aircraft readings are below the installation baseline. Review them first.');
  if ($target_aircraft!==null) {
   $tt=$current['track_time']?aircraft_total_time($aircraft):null; $cy=$current['track_cycles']?(int)$aircraft['current_cycles']:null;
   $q=$pdo->prepare("UPDATE components SET aircraft_id=?,location_type='AIRCRAFT',parts_location=NULL,install_position=?,installed_date=?,removed_date=NULL,removed_tach=NULL,installed_aircraft_total_time=?,installed_aircraft_cycles=?,service_hours_base=?,tso_hours_base=?,tsr_hours_base=?,service_cycles_base=?,service_days_base=? WHERE id=?");
   $q->execute([$target_aircraft,$position,$date,$tt,$cy,$usage['tsn'],$usage['tso'],$usage['tsr'],$usage['cycles'],$usage['days'],$id]); $action='INSTALL'; $move_aircraft=$target_aircraft;
  } else {
   $q=$pdo->prepare("UPDATE components SET aircraft_id=NULL,location_type='INVENTORY',parts_location=?,install_position=NULL,removed_date=?,installed_aircraft_total_time=NULL,installed_aircraft_cycles=NULL,service_hours_base=?,tso_hours_base=?,tsr_hours_base=?,service_cycles_base=?,service_days_base=? WHERE id=?");
   $q->execute([$parts_location,$date,$usage['tsn'],$usage['tso'],$usage['tsr'],$usage['cycles'],$usage['days'],$id]); $action='REMOVE'; $move_aircraft=(int)$current['aircraft_id'];
  }
  $q=$pdo->prepare('INSERT INTO component_movements (component_id,action,aircraft_id,parts_location,install_position,movement_date,component_hours,component_cycles,service_days,note,performed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  $q->execute([$id,$action,$move_aircraft,$parts_location,$position,$date,$usage['hours'],$usage['cycles'],$usage['days'],$note,user()['id']]);
  audit($pdo,$action,'components',$id,['location_type'=>$current['location_type'],'aircraft_id'=>$current['aircraft_id'],'component_hours'=>$usage['hours'],'component_cycles'=>$usage['cycles'],'service_days'=>$usage['days']],['location_type'=>$target_aircraft===null?'INVENTORY':'AIRCRAFT','aircraft_id'=>$target_aircraft,'parts_location'=>$parts_location,'position'=>$position,'note'=>$note]);
  $pdo->commit(); header('Location: view.php?id='.$id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not move component. Check the V10 upgrade.'; }
}
$aircraft=$pdo->query('SELECT id,registration FROM aircraft ORDER BY registration')->fetchAll(); $page_title='Move component'; include __DIR__.'/../includes/header.php'; ?>
<h1><?= $c['location_type']==='AIRCRAFT'?'Move to inventory':'Install on aircraft' ?> — <?= esc($c['component_type']) ?></h1>
<p class="notice">Current component hours and cycles are frozen when removed. On installation, tracking resumes from the new aircraft’s current total time and cycles. Months in service accumulate only while installed. Calendar requirements continue while in inventory. Movement snapshots use today’s aircraft readings.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<form method="post"><?= csrf_field() ?><div class="form-grid"><div class="field"><label>Movement date</label><input type="date" name="movement_date" value="<?= esc(date('Y-m-d')) ?>" min="<?= esc(date('Y-m-d')) ?>" max="<?= esc(date('Y-m-d')) ?>" required></div>
<?php if ($c['location_type']==='AIRCRAFT'): ?><div class="field"><label>Parts location</label><input name="parts_location" maxlength="150" required></div>
<?php else: ?><div class="field"><label>Aircraft</label><select name="aircraft_id" required><?php foreach ($aircraft as $a): ?><option value="<?= (int)$a['id'] ?>"><?= esc($a['registration']) ?></option><?php endforeach; ?></select></div><div class="field"><label>Installed position</label><select name="install_position"><?php foreach (['LEFT','RIGHT','NUMBER 1','NUMBER 2','MAIN','AUX'] as $pos): ?><option value="<?= esc($pos) ?>"><?= esc(ucwords(strtolower($pos))) ?></option><?php endforeach; ?></select></div><?php endif; ?>
<div class="field full"><label>Reason / reference</label><textarea name="note" minlength="10" maxlength="2000" required></textarea></div></div><div class="actions"><button class="btn">Save movement</button><a class="btn secondary" href="view.php?id=<?= $id ?>">Cancel</a></div></form>
<?php include __DIR__.'/../includes/footer.php'; ?>
