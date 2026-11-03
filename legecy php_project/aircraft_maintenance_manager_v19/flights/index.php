<?php
require_once __DIR__.'/../includes/total_time.php'; require_login();
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    permit(['ADMIN','MANAGER','PILOT']); verify_csrf();
    try {
        $aircraft_id=posted_int('aircraft_id');
        $date=date_or_null('flight_date');
        $pilot=trim((string)($_POST['pilot_name'] ?? ''));
        $origin=strtoupper(trim((string)($_POST['origin'] ?? '')));
        $destination=strtoupper(trim((string)($_POST['destination'] ?? '')));
        $notes=trim((string)($_POST['notes'] ?? ''));
        $tach_end=posted_decimal('tach_end'); $hobbs_end=posted_decimal('hobbs_end'); $landings=posted_int('landings'); $cycles=posted_int('cycles');
        if (!$date || $date>date('Y-m-d') || $pilot==='' || strlen($pilot)>150 || strlen($origin)>20 || strlen($destination)>20 || $landings>10000 || $cycles>10000 || strlen($notes)>10000) throw new RuntimeException('Check the date, pilot, landings and text fields.');
        $pdo->beginTransaction();
        $s=$pdo->prepare('SELECT id,registration,current_tach,current_hobbs,current_landings,current_cycles,total_time_source,total_time_adjustment FROM aircraft WHERE id=? FOR UPDATE'); $s->execute([$aircraft_id]); $a=$s->fetch();
        if (!$a) throw new RuntimeException('Select a valid aircraft.');
        $tach_start=(float)$a['current_tach']; $hobbs_start=(float)$a['current_hobbs'];
        $total_start=aircraft_total_time($a); $total_end=round(($a['total_time_source']==='HOBBS'?$hobbs_end:$tach_end)+(float)$a['total_time_adjustment'],1);
        if ($total_end<$total_start) throw new RuntimeException('Aircraft total time cannot move backward.');
        if ($tach_end<$tach_start || $hobbs_end<$hobbs_start) throw new RuntimeException('End readings cannot be below current aircraft readings. Refresh the page and check the instruments.');
        if ($tach_end===$tach_start && $hobbs_end===$hobbs_start && $landings===0 && $cycles===0) throw new RuntimeException('Enter an increased reading or at least one landing.');
        if ((int)$a['current_cycles']>2147483647-$cycles) throw new RuntimeException('Cycle total exceeds supported range.');
        if ((int)$a['current_landings']>2147483647-$landings) throw new RuntimeException('Landing total exceeds supported range.');
        $entry=['aircraft_id'=>$aircraft_id,'flight_date'=>$date,'origin'=>$origin,'destination'=>$destination,'pilot_name'=>$pilot,'tach_start'=>$tach_start,'tach_end'=>$tach_end,'hobbs_start'=>$hobbs_start,'hobbs_end'=>$hobbs_end,'total_time_start'=>$total_start,'total_time_end'=>$total_end,'landings'=>$landings,'cycles'=>$cycles,'notes'=>$notes,'entered_by'=>(int)user()['id']];
        $s=$pdo->prepare('INSERT INTO flight_logs (aircraft_id,flight_date,origin,destination,pilot_name,tach_start,tach_end,hobbs_start,hobbs_end,total_time_start,total_time_end,landings,cycles,notes,entered_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        $s->execute(array_values($entry)); $flight_id=(int)$pdo->lastInsertId();
        $s=$pdo->prepare('UPDATE aircraft SET current_tach=?,current_hobbs=?,current_landings=current_landings+?,current_cycles=current_cycles+? WHERE id=?'); $s->execute([$tach_end,$hobbs_end,$landings,$cycles,$aircraft_id]);
        audit($pdo,'CREATE','flight_logs',$flight_id,null,$entry);
        audit($pdo,'UPDATE','aircraft',$aircraft_id,['current_tach'=>$tach_start,'current_hobbs'=>$hobbs_start,'current_landings'=>(int)$a['current_landings'],'current_cycles'=>(int)$a['current_cycles']],['current_tach'=>$tach_end,'current_hobbs'=>$hobbs_end,'current_landings'=>(int)$a['current_landings']+$landings,'current_cycles'=>(int)$a['current_cycles']+$cycles]);
        $pdo->commit(); header('Location: index.php?aircraft_id='.$aircraft_id); exit;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        $error=$e instanceof RuntimeException?$e->getMessage():'Could not save the flight. Check database migration and try again.';
    }
}
$aircraft=$pdo->query('SELECT id,registration,current_tach,current_hobbs,current_landings,current_cycles,total_time_source,total_time_adjustment FROM aircraft ORDER BY registration')->fetchAll();
$selected=(int)($_GET['aircraft_id'] ?? 0);
if ($selected) { $s=$pdo->prepare('SELECT f.*,a.registration,u.name AS entered_by_name FROM flight_logs f JOIN aircraft a ON a.id=f.aircraft_id LEFT JOIN users u ON u.id=f.entered_by WHERE f.aircraft_id=? ORDER BY f.id DESC LIMIT 100'); $s->execute([$selected]); $rows=$s->fetchAll(); }
else $rows=$pdo->query('SELECT f.*,a.registration,u.name AS entered_by_name FROM flight_logs f JOIN aircraft a ON a.id=f.aircraft_id LEFT JOIN users u ON u.id=f.entered_by ORDER BY f.id DESC LIMIT 100')->fetchAll();
$page_title='Flights & hours'; include __DIR__.'/../includes/header.php'; ?>
<h1>Flights &amp; Hours</h1><p class="notice">Enter ending tach and Hobbs readings. The saved starting readings come from the aircraft’s current totals. Aircraft total time follows the selected instrument plus its adjustment. Each entry increases landing and cycle totals and immediately updates hour- and cycle-based due items. Set the aircraft’s verified cycle baseline first.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<?php if (in_array(user()['role'],['ADMIN','MANAGER','PILOT'])): ?><div class="card"><h2>Add flight entry</h2><form method="post"><?= csrf_field() ?><div class="form-grid">
<div class="field"><label>Aircraft</label><select name="aircraft_id" id="flight-aircraft" required><?php foreach ($aircraft as $a): ?><option value="<?= (int)$a['id'] ?>" data-tach="<?= esc($a['current_tach']) ?>" data-hobbs="<?= esc($a['current_hobbs']) ?>" data-cycles="<?= (int)$a['current_cycles'] ?>" data-total="<?= esc(number_format(aircraft_total_time($a),1,'.','')) ?>" data-source="<?= esc($a['total_time_source']) ?>" <?= $selected===(int)$a['id']?'selected':'' ?>><?= esc($a['registration']) ?></option><?php endforeach; ?></select><small id="current-readings"></small></div>
<div class="field"><label>Flight date</label><input type="date" name="flight_date" value="<?= esc(date('Y-m-d')) ?>" max="<?= esc(date('Y-m-d')) ?>" required></div>
<div class="field"><label>Pilot name</label><input name="pilot_name" maxlength="150" value="<?= esc(user()['name']) ?>" required></div>
<div class="field"><label>Origin</label><input name="origin" maxlength="20"></div><div class="field"><label>Destination</label><input name="destination" maxlength="20"></div>
<div class="field"><label>Ending tach</label><input type="number" name="tach_end" id="tach-end" min="0" step="0.1" required></div>
<div class="field"><label>Ending Hobbs</label><input type="number" name="hobbs_end" id="hobbs-end" min="0" step="0.1" required></div>
<div class="field"><label>Landings this flight</label><input type="number" name="landings" value="1" min="0" max="10000" step="1" required></div>
<div class="field"><label>Cycles this flight</label><input type="number" name="cycles" value="1" min="0" max="10000" step="1" required></div>
<div class="field full"><label>Notes</label><textarea name="notes" maxlength="10000"></textarea></div></div><button class="btn">Save flight and update aircraft</button></form></div><?php endif; ?>
<h2>Flight history</h2><form method="get" class="actions"><select name="aircraft_id"><option value="0">All aircraft</option><?php foreach ($aircraft as $a): ?><option value="<?= (int)$a['id'] ?>" <?= $selected===(int)$a['id']?'selected':'' ?>><?= esc($a['registration']) ?></option><?php endforeach; ?></select><button class="btn">Filter</button></form>
<div class="table-wrap"><table><tr><th>Date</th><th>Aircraft</th><th>Route</th><th>Pilot</th><th>Tach start → end</th><th>Hobbs start → end</th><th>Total time start → end</th><th>Landings</th><th>Cycles</th><th>Entered by</th><th>Record</th></tr><?php foreach ($rows as $r): ?><tr><td><?= esc($r['flight_date']) ?></td><td><a href="<?= esc(url('aircraft/view.php?id='.(int)$r['aircraft_id'])) ?>"><?= esc($r['registration']) ?></a></td><td><?= esc($r['origin']) ?> → <?= esc($r['destination']) ?></td><td><?= esc($r['pilot_name']) ?></td><td><?= esc($r['tach_start']) ?> → <?= esc($r['tach_end']) ?></td><td><?= esc($r['hobbs_start']) ?> → <?= esc($r['hobbs_end']) ?></td><td><?= esc($r['total_time_start']) ?> → <?= esc($r['total_time_end']) ?></td><td><?= (int)$r['landings'] ?></td><td><?= (int)$r['cycles'] ?></td><td><?= esc($r['entered_by_name'] ?? '—') ?></td><td><a href="<?= esc(url('flights/correction_history.php?id='.(int)$r['id'])) ?>">Details / corrections</a></td></tr><?php endforeach; ?><?php if (!$rows): ?><tr><td colspan="11">No flight entries yet.</td></tr><?php endif; ?></table></div>
<script>const select=document.getElementById('flight-aircraft');if(select){const update=()=>{const o=select.selectedOptions[0];document.getElementById('current-readings').textContent=o?'Current tach: '+o.dataset.tach+' · Hobbs: '+o.dataset.hobbs+' · Total time: '+o.dataset.total+' ('+o.dataset.source+') · Cycles: '+o.dataset.cycles:'';if(o){document.getElementById('tach-end').placeholder=o.dataset.tach;document.getElementById('hobbs-end').placeholder=o.dataset.hobbs;}};select.addEventListener('change',update);update();}</script>
<?php include __DIR__.'/../includes/footer.php'; ?>
