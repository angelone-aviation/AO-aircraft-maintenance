<?php
require_once __DIR__.'/../includes/total_time.php'; permit(['ADMIN','MANAGER']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);
if (!$id) { http_response_code(400); exit('Invalid flight ID.'); }
$select='SELECT f.*,a.registration,a.current_tach,a.current_hobbs,a.current_landings FROM flight_logs f JOIN aircraft a ON a.id=f.aircraft_id WHERE f.id=?';
$s=$pdo->prepare($select); $s->execute([$id]); $flight=$s->fetch();
if (!$flight) { http_response_code(404); exit('Flight not found.'); }
$last=$pdo->prepare('SELECT MAX(id) FROM flight_logs WHERE aircraft_id=?'); $last->execute([$flight['aircraft_id']]); $is_latest=(int)$last->fetchColumn()===(int)$id;
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    verify_csrf();
    try {
        if (!$is_latest) throw new RuntimeException('Only the latest flight on an aircraft can be corrected.');
        $reason=trim((string)($_POST['reason'] ?? ''));
        $end_tach=posted_decimal('tach_end'); $end_hobbs=posted_decimal('hobbs_end'); $landings=posted_int('landings'); $cycles=posted_int('cycles');
        $date=date_or_null('flight_date'); $pilot=trim((string)($_POST['pilot_name'] ?? ''));
        $origin=strtoupper(trim((string)($_POST['origin'] ?? ''))); $destination=strtoupper(trim((string)($_POST['destination'] ?? '')));
        $notes=trim((string)($_POST['notes'] ?? ''));
        if (strlen($reason)<10 || strlen($reason)>2000 || $landings>10000 || $cycles>10000 || !$date || $date>date('Y-m-d') || $pilot==='' || strlen($pilot)>150 || strlen($origin)>20 || strlen($destination)>20 || strlen($notes)>10000) throw new RuntimeException('Enter a reason of at least 10 characters and check the flight fields.');
        $pdo->beginTransaction();
        // Lock the aircraft before reading its latest flight, matching the lock order in flight creation.
        $a_stmt=$pdo->prepare('SELECT * FROM aircraft WHERE id=? FOR UPDATE'); $a_stmt->execute([$flight['aircraft_id']]); $aircraft=$a_stmt->fetch();
        $latest_stmt=$pdo->prepare('SELECT * FROM flight_logs WHERE aircraft_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE'); $latest_stmt->execute([$flight['aircraft_id']]); $current=$latest_stmt->fetch();
        if (!$aircraft || !$current || (int)$current['id']!==(int)$id) throw new RuntimeException('A newer flight exists. Refresh the flight history.');
        if ((float)$aircraft['current_tach']!==(float)$current['tach_end'] || (float)$aircraft['current_hobbs']!==(float)$current['hobbs_end']) throw new RuntimeException('Aircraft readings changed outside this flight. Review the aircraft history before correcting it.');
        if ($end_tach<(float)$current['tach_start'] || $end_hobbs<(float)$current['hobbs_start']) throw new RuntimeException('Corrected end readings cannot be below the recorded starting readings.');
        $total_end=round(($aircraft['total_time_source']==='HOBBS'?$end_hobbs:$end_tach)+(float)$aircraft['total_time_adjustment'],1);
        if ($total_end<(float)$current['total_time_start']) throw new RuntimeException('Corrected aircraft total time cannot be below the flight starting total.');
        $new_total=(int)$aircraft['current_landings']+(int)$landings-(int)$current['landings'];
        $new_cycles=(int)$aircraft['current_cycles']+$cycles-(int)$current['cycles'];
        if ($new_cycles<0 || $new_cycles>2147483647) throw new RuntimeException('The corrected cycle total is out of range.');
        if ($new_total<0 || $new_total>2147483647) throw new RuntimeException('The corrected landing total is out of range.');
        $before=['flight_date'=>$current['flight_date'],'origin'=>$current['origin'],'destination'=>$current['destination'],'pilot_name'=>$current['pilot_name'],'tach_end'=>$current['tach_end'],'hobbs_end'=>$current['hobbs_end'],'total_time_end'=>$current['total_time_end'],'landings'=>(int)$current['landings'],'cycles'=>(int)$current['cycles'],'notes'=>$current['notes']];
        $after=['flight_date'=>$date,'origin'=>$origin,'destination'=>$destination,'pilot_name'=>$pilot,'tach_end'=>$end_tach,'hobbs_end'=>$end_hobbs,'total_time_end'=>$total_end,'landings'=>$landings,'cycles'=>$cycles,'notes'=>$notes];
        $changed=false;
        foreach ($after as $key=>$value) { if ((string)($before[$key] ?? '') !== (string)($value ?? '')) { $changed=true; break; } }
        if (!$changed) throw new RuntimeException('No changes were entered.');
        $q=$pdo->prepare('UPDATE flight_logs SET flight_date=?,origin=?,destination=?,pilot_name=?,tach_end=?,hobbs_end=?,total_time_end=?,landings=?,cycles=?,notes=? WHERE id=?');
        $q->execute([$date,$origin,$destination,$pilot,$end_tach,$end_hobbs,$total_end,$landings,$cycles,$notes,$id]);
        $q=$pdo->prepare('UPDATE aircraft SET current_tach=?,current_hobbs=?,current_landings=?,current_cycles=? WHERE id=?'); $q->execute([$end_tach,$end_hobbs,$new_total,$new_cycles,$aircraft['id']]);
        $q=$pdo->prepare('INSERT INTO flight_corrections (flight_id,aircraft_id,corrected_by,reason,before_json,after_json) VALUES (?,?,?,?,?,?)');
        $q->execute([$id,$aircraft['id'],user()['id'],$reason,json_encode($before),json_encode($after)]);
        $correction_id=(int)$pdo->lastInsertId();
        audit($pdo,'CORRECT','flight_logs',(int)$id,$before,$after);
        audit($pdo,'UPDATE','aircraft',(int)$aircraft['id'],['current_tach'=>$aircraft['current_tach'],'current_hobbs'=>$aircraft['current_hobbs'],'current_landings'=>$aircraft['current_landings'],'current_cycles'=>$aircraft['current_cycles']],['current_tach'=>$end_tach,'current_hobbs'=>$end_hobbs,'current_landings'=>$new_total,'current_cycles'=>$new_cycles]);
        $pdo->commit(); header('Location: correction_history.php?id='.$id); exit;
    } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Correction could not be saved. Check the V4 database upgrade.'; }
}
$page_title='Correct flight'; include __DIR__.'/../includes/header.php'; ?>
<h1>Correct flight #<?= (int)$id ?> — <?= esc($flight['registration']) ?></h1>
<p class="notice">Only the latest entered flight for this aircraft can be corrected. Its starting readings remain fixed. The original values, corrected values, reason and user will be retained.</p>
<?php if (!$is_latest): ?><div class="error">This aircraft has a later flight. This entry cannot be corrected here.</div><?php endif; ?>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<?php if ($is_latest): ?><form method="post"><?= csrf_field() ?><div class="form-grid">
<div class="field"><label>Date</label><input type="date" name="flight_date" value="<?= esc($flight['flight_date']) ?>" max="<?= esc(date('Y-m-d')) ?>" required></div>
<div class="field"><label>Pilot</label><input name="pilot_name" value="<?= esc($flight['pilot_name']) ?>" maxlength="150" required></div>
<div class="field"><label>Origin</label><input name="origin" value="<?= esc($flight['origin']) ?>" maxlength="20"></div>
<div class="field"><label>Destination</label><input name="destination" value="<?= esc($flight['destination']) ?>" maxlength="20"></div>
<div class="field"><label>Ending tach (start: <?= esc($flight['tach_start']) ?>)</label><input type="number" min="0" step="0.1" name="tach_end" value="<?= esc($flight['tach_end']) ?>" required></div>
<div class="field"><label>Ending Hobbs (start: <?= esc($flight['hobbs_start']) ?>)</label><input type="number" min="0" step="0.1" name="hobbs_end" value="<?= esc($flight['hobbs_end']) ?>" required></div>
<div class="field"><label>Landings</label><input type="number" min="0" max="10000" step="1" name="landings" value="<?= (int)$flight['landings'] ?>" required></div>
<div class="field"><label>Cycles</label><input type="number" min="0" max="10000" step="1" name="cycles" value="<?= (int)$flight['cycles'] ?>" required></div>
<div class="field full"><label>Notes</label><textarea name="notes" maxlength="10000"><?= esc($flight['notes']) ?></textarea></div>
<div class="field full"><label>Reason for correction (required)</label><textarea name="reason" minlength="10" maxlength="2000" required></textarea></div></div>
<div class="actions"><button class="btn">Save correction</button><a class="btn secondary" href="<?= esc(url('flights/correction_history.php?id='.$id)) ?>">Cancel</a></div></form><?php endif; ?>
<?php include __DIR__.'/../includes/footer.php'; ?>
