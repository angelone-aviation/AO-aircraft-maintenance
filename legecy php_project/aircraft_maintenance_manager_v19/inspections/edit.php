<?php
require_once __DIR__.'/../includes/inspection_due.php';
require_once __DIR__.'/../includes/ata_chapters.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);
if (!$id) { http_response_code(400); exit('Invalid inspection ID.'); }
$s=$pdo->prepare('SELECT i.*,a.registration FROM inspections i JOIN aircraft a ON a.id=i.aircraft_id WHERE i.id=?'); $s->execute([$id]); $record=$s->fetch();
if (!$record) { http_response_code(404); exit('Inspection not found.'); }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    verify_csrf();
    try {
        $data=inspection_schedule_from_post(); $data['ata_chapter']=posted_ata();
        $pdo->beginTransaction();
        $lock=$pdo->prepare('SELECT * FROM inspections WHERE id=? FOR UPDATE'); $lock->execute([$id]); $before=$lock->fetch();
        if (!$before) throw new RuntimeException('Inspection was removed.');
        $changed=false;
        foreach ($data as $key=>$value) { if ((string)($before[$key] ?? '') !== (string)($value ?? '')) { $changed=true; break; } }
        if (!$changed) throw new RuntimeException('No changes were entered.');
        $fields=array_keys($data);
        $set=implode(',',array_map(static function($field){return $field.'=?';},$fields));
        $q=$pdo->prepare('UPDATE inspections SET '.$set.' WHERE id=?');
        $q->execute(array_merge(array_values($data),[$id]));
        audit($pdo,'UPDATE','inspections',(int)$id,$before,$data);
        $pdo->commit(); header('Location: index.php'); exit;
    } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not update the inspection. Check the V7 migration.'; }
}
$history_stmt=$pdo->prepare("SELECT a.created_at,a.before_json,a.after_json,u.name AS changed_by FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_table='inspections' AND a.entity_id=? AND a.action='UPDATE' ORDER BY a.id DESC LIMIT 20");
$history_stmt->execute([$id]); $history=$history_stmt->fetchAll();
$page_title='Edit inspection'; include __DIR__.'/../includes/header.php'; ?>
<h1>Edit inspection — <?= esc($record['registration']) ?></h1>
<p class="notice">Enter the last completed date, aircraft total time, and cycles with their respective intervals. Saving recalculates the next due values. Set the Due soon thresholds independently for months, aircraft hours, and cycles. Blank intervals do not create due limits.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<form method="post"><?= csrf_field() ?><div class="field"><label>ATA Chapter</label><?= ata_select($record['ata_chapter']) ?></div><?php include __DIR__.'/../includes/inspection_fields.php'; ?>
<div class="actions"><button class="btn">Calculate and save</button><a class="btn secondary" href="index.php">Cancel</a></div></form>
<h2>Recent changes</h2><?php if (!$history): ?><p>No edits recorded yet.</p><?php endif; ?>
<?php foreach ($history as $change): $old=json_decode($change['before_json'],true) ?: []; $new=json_decode($change['after_json'],true) ?: []; ?><div class="card"><strong><?= esc($change['created_at']) ?> · <?= esc($change['changed_by'] ?? 'Former user') ?></strong><div class="table-wrap"><table><tr><th>Field</th><th>Previous</th><th>Updated</th></tr><?php foreach ($new as $key=>$value): if ((string)($old[$key] ?? '') === (string)($value ?? '')) continue; ?><tr><td><?= esc(str_replace('_',' ',$key)) ?></td><td><?= nl2br(esc($old[$key] ?? '')) ?></td><td><?= nl2br(esc($value)) ?></td></tr><?php endforeach; ?></table></div></div><?php endforeach; ?>
<?php include __DIR__.'/../includes/footer.php'; ?>
