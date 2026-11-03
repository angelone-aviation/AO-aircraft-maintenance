<?php
require_once __DIR__.'/../includes/component_service.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);
$component_id=filter_var($_GET['component_id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);
if ($id) { $q=$pdo->prepare('SELECT * FROM component_service_requirements WHERE id=?'); $q->execute([$id]); $record=$q->fetch(); if (!$record) { http_response_code(404); exit('Service requirement not found.'); } $component_id=(int)$record['component_id']; }
else $record=[];
if (!$component_id) { http_response_code(400); exit('Invalid component ID.'); }
$c=component_query($pdo,$component_id); if (!$c) { http_response_code(404); exit('Component not found.'); }
$usage=component_usage($c); $error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $data=component_service_data($usage,$c); $pdo->beginTransaction();
  if ($id) {
   $q=$pdo->prepare('SELECT * FROM component_service_requirements WHERE id=? AND component_id=? FOR UPDATE'); $q->execute([$id,$component_id]); $before=$q->fetch(); if (!$before) throw new RuntimeException('Requirement no longer exists.');
   $fields=array_keys($data); $set=implode(',',array_map(static function($f){return $f.'=?';},$fields));
   $q=$pdo->prepare('UPDATE component_service_requirements SET '.$set.' WHERE id=?'); $q->execute(array_merge(array_values($data),[$id])); audit($pdo,'UPDATE','component_service_requirements',$id,$before,$data);
  } else {
   $fields=array_keys($data); $q=$pdo->prepare('INSERT INTO component_service_requirements (component_id,'.implode(',',$fields).') VALUES ('.implode(',',array_fill(0,count($fields)+1,'?')).')');
   $q->execute(array_merge([$component_id],array_values($data))); $id=(int)$pdo->lastInsertId(); audit($pdo,'CREATE','component_service_requirements',$id,null,$data);
  }
  $pdo->commit(); header('Location: view.php?id='.$component_id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not save requirement. Check the V10 upgrade.'; }
}
$page_title=$id?'Edit service data':'Add service data'; include __DIR__.'/../includes/header.php'; ?>
<h1><?= $id?'Edit':'Add' ?> service data — <?= esc($c['component_type']) ?></h1>
<p class="notice">TSN, TSO, and TSR advance with aircraft total time while installed. Only enabled tracking dimensions are entered and calculated. Calendar time continues while in inventory. Choose absolute total component hours/cycles or an interval after last compliance. Due = selected basis plus interval. The warning fields set when Due soon begins.</p>
<p><?php if ($c['track_time']): ?><strong>TSN:</strong> <?= $usage['error']?'Check readings':esc(number_format($usage['tsn'],1)) ?> · <strong>TSO:</strong> <?= $usage['tso']===null?'Set baseline':esc(number_format($usage['tso'],1)) ?> · <strong>TSR:</strong> <?= $usage['tsr']===null?'Set baseline':esc(number_format($usage['tsr'],1)) ?><?php endif; ?><?php if ($c['track_cycles']): ?> · <strong>Cycles:</strong> <?= $usage['error']?'Check readings':(int)$usage['cycles'] ?><?php endif; ?></p><?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?><form method="post"><?= csrf_field() ?><?php include __DIR__.'/../includes/component_service_fields.php'; ?><div class="actions"><button class="btn">Calculate and save</button><a class="btn secondary" href="view.php?id=<?= (int)$component_id ?>">Cancel</a></div></form><?php include __DIR__.'/../includes/footer.php'; ?>
