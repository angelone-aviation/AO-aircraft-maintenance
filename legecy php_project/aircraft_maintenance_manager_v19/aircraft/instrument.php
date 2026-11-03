<?php
require_once __DIR__.'/../includes/total_time.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);
if (!$id) { http_response_code(400); exit('Invalid aircraft ID.'); }
$s=$pdo->prepare('SELECT * FROM aircraft WHERE id=?'); $s->execute([$id]); $aircraft=$s->fetch();
if (!$aircraft) { http_response_code(404); exit('Aircraft not found.'); }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    verify_csrf();
    try {
        $instrument=(string)($_POST['instrument'] ?? '');
        if (!in_array($instrument,['TACH','HOBBS'],true)) throw new RuntimeException('Choose tach or Hobbs.');
        $new_reading=posted_decimal('new_reading');
        $reason=trim((string)($_POST['reason'] ?? ''));
        if (strlen($reason)<10 || strlen($reason)>2000) throw new RuntimeException('Describe the replacement in at least 10 characters.');
        $pdo->beginTransaction();
        $q=$pdo->prepare('SELECT * FROM aircraft WHERE id=? FOR UPDATE'); $q->execute([$id]); $old=$q->fetch();
        if (!$old) throw new RuntimeException('Aircraft not found.');
        $before_total=aircraft_total_time($old);
        $adjustment=$instrument===$old['total_time_source']?round($before_total-$new_reading,1):(float)$old['total_time_adjustment'];
        if (abs($adjustment)>99999999.9) throw new RuntimeException('Required adjustment exceeds supported range.');
        $field=$instrument==='TACH'?'current_tach':'current_hobbs';
        if ((float)$old[$field]===$new_reading) throw new RuntimeException('New reading equals the existing reading.');
        $q=$pdo->prepare('UPDATE aircraft SET '.$field.'=?,total_time_adjustment=? WHERE id=?');
        $q->execute([$new_reading,$adjustment,$id]);
        $after=['instrument'=>$instrument,'reading'=>$new_reading,'total_time_adjustment'=>$adjustment,'aircraft_total_time'=>$before_total,'reason'=>$reason];
        audit($pdo,'REPLACE_INSTRUMENT','aircraft',$id,['instrument'=>$instrument,'reading'=>$old[$field],'total_time_adjustment'=>$old['total_time_adjustment'],'aircraft_total_time'=>$before_total],$after);
        $pdo->commit(); header('Location: view.php?id='.$id); exit;
    } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Instrument change could not be saved.'; }
}
$page_title='Replace instrument'; include __DIR__.'/../includes/header.php'; ?>
<h1>Replace instrument — <?= esc($aircraft['registration']) ?></h1>
<p class="notice">Current aircraft total time: <strong><?= esc(number_format(aircraft_total_time($aircraft),1)) ?> hours</strong> (<?= esc($aircraft['total_time_source']) ?> plus <?= esc($aircraft['total_time_adjustment']) ?> hours). If you replace the selected source instrument, the adjustment changes automatically so total time stays the same.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<form method="post"><?= csrf_field() ?><div class="form-grid"><div class="field"><label>Instrument being replaced</label><select name="instrument"><option value="TACH">Tach (currently <?= esc($aircraft['current_tach']) ?>)</option><option value="HOBBS">Hobbs (currently <?= esc($aircraft['current_hobbs']) ?>)</option></select></div><div class="field"><label>New instrument reading</label><input type="number" name="new_reading" min="0" step="0.1" required></div><div class="field full"><label>Replacement details / reason</label><textarea name="reason" minlength="10" maxlength="2000" required></textarea></div></div><div class="actions"><button class="btn">Save instrument replacement</button><a class="btn secondary" href="view.php?id=<?= $id ?>">Cancel</a></div></form>
<?php include __DIR__.'/../includes/footer.php'; ?>
