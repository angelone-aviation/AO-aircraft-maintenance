<?php
require_once __DIR__.'/../includes/inspection_due.php';
require_once __DIR__.'/../includes/inspection_status.php';
require_once __DIR__.'/../includes/ata_chapters.php'; require_login();
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    permit(['ADMIN','MANAGER','MECHANIC']); verify_csrf();
    try {
        $aircraft_id=posted_int('aircraft_id');
        $data=inspection_schedule_from_post(); $data['ata_chapter']=posted_ata();
        $check=$pdo->prepare('SELECT id FROM aircraft WHERE id=?'); $check->execute([$aircraft_id]);
        if (!$check->fetch()) throw new RuntimeException('Select an aircraft.');
        $pdo->beginTransaction();
        $fields=array_keys($data);
        $q=$pdo->prepare('INSERT INTO inspections (aircraft_id,'.implode(',',$fields).') VALUES ('.implode(',',array_fill(0,count($fields)+1,'?')).')');
        $q->execute(array_merge([$aircraft_id],array_values($data)));
        audit($pdo,'CREATE','inspections',(int)$pdo->lastInsertId(),null,array_merge(['aircraft_id'=>$aircraft_id],$data));
        $pdo->commit(); header('Location: index.php'); exit;
    } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not save inspection. Check the V7 migration.'; }
}
$aircraft=$pdo->query('SELECT id,registration FROM aircraft ORDER BY registration')->fetchAll();
$rows=$pdo->query('SELECT i.*,a.registration,a.current_cycles,'.total_time_sql('a').' AS aircraft_total_time FROM inspections i JOIN aircraft a ON a.id=i.aircraft_id ORDER BY i.due_date,i.due_hours,i.due_cycles')->fetchAll();
$page_title='Inspections'; include __DIR__.'/../includes/header.php'; ?>
<h1>Inspections &amp; What’s Due</h1>
<p class="notice">Enter the last completed aircraft total time, cycles, date and one or more intervals. The next due date, aircraft total time, and cycles are calculated when you save. Existing inspections retain their earlier due values until edited.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])): ?><div class="card"><h2>Add inspection</h2><form method="post"><?= csrf_field() ?><div class="field"><label>ATA Chapter</label><?= ata_select() ?></div><div class="field"><label>Aircraft</label><select name="aircraft_id" required><?php foreach ($aircraft as $a): ?><option value="<?= (int)$a['id'] ?>"><?= esc($a['registration']) ?></option><?php endforeach; ?></select></div><?php $record=[]; include __DIR__.'/../includes/inspection_fields.php'; ?><button class="btn">Add inspection</button></form></div><?php endif; ?>
<h2>Tracked items</h2><div class="table-wrap"><table><tr><th>Aircraft</th><th>ATA Chapter</th><th>Inspection</th><th>Last completed</th><th>Intervals</th><th>Due date</th><th>Due total time</th><th>Due cycles</th><th>Due soon thresholds</th><th>Status</th><th>Action</th></tr>
<?php foreach ($rows as $r):
  $status=inspection_status($r);
 ?><tr><td><?= esc($r['registration']) ?></td><td><?= esc(ata_label($r['ata_chapter'])) ?></td><td><?= esc($r['inspection_type']) ?></td><td><?= esc($r['last_date'] ?? '—') ?><br>Total time <?= esc($r['last_hours'] ?? '—') ?> · Cycles <?= esc($r['last_cycles'] ?? '—') ?></td>
<td><?= $r['calendar_interval_value']!==null?esc($r['calendar_interval_value'].' '.strtolower($r['calendar_interval_unit'])):'—' ?><br><?= $r['interval_hours']!==null?esc($r['interval_hours'].' aircraft hrs'):'—' ?> · <?= $r['interval_cycles']!==null?esc($r['interval_cycles'].' cycles'):'—' ?></td>
<td><?= esc($r['due_date'] ?? '—') ?></td><td><?= esc($r['due_hours'] ?? '—') ?></td><td><?= esc($r['due_cycles'] ?? '—') ?></td><td><?= (int)$r['warning_calendar_months'] ?> months · <?= esc($r['warning_hours']) ?> hours · <?= (int)$r['warning_cycles'] ?> cycles</td>
<td class="<?= $status==='Past due'?'red':($status==='Tracked'?'green':'yellow') ?>"><?= esc($status) ?></td><td><?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])): ?><a href="edit.php?id=<?= (int)$r['id'] ?>">Edit</a><?php else: ?>—<?php endif; ?></td></tr><?php endforeach; ?>
<?php if (!$rows): ?><tr><td colspan="11">No inspections yet.</td></tr><?php endif; ?></table></div><?php include __DIR__.'/../includes/footer.php'; ?>
