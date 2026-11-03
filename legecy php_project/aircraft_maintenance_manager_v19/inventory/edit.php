<?php
require_once __DIR__.'/../includes/parts_inventory.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]); if (!$id) { http_response_code(400); exit('Invalid stock ID.'); }
$q=$pdo->prepare('SELECT * FROM parts_inventory WHERE id=?'); $q->execute([$id]); $record=$q->fetch();
if (!$record) { http_response_code(404); exit('Stock row not found.'); }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $data=parts_data($pdo,$record['location_id']);
  $pdo->beginTransaction();
  $q=$pdo->prepare('SELECT * FROM parts_inventory WHERE id=? FOR UPDATE'); $q->execute([$id]); $before=$q->fetch();
  if (!$before) throw new RuntimeException('Stock row not found.');
  $fields=array_keys($data);
  $q=$pdo->prepare('UPDATE parts_inventory SET '.implode(',',array_map(static fn($field)=>$field.'=?',$fields)).' WHERE id=?');
  $q->execute(array_merge(array_values($data),[$id]));
  audit($pdo,'UPDATE','parts_inventory',$id,$before,$data);
  $pdo->commit(); header('Location: view.php?id='.$id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not update stock row.'; }
}
$locations=parts_locations($pdo);
if (!array_filter($locations,static fn($location)=>(int)$location['id']===(int)$record['location_id'])) {
 $q=$pdo->prepare('SELECT id,name FROM inventory_locations WHERE id=?'); $q->execute([$record['location_id']]); $old=$q->fetch(); if ($old) $locations[]=$old;
}
$page_title='Edit Inventory Item'; include __DIR__.'/../includes/header.php'; ?>
<h1>Edit <?= esc($record['part_name']) ?></h1>
<p class="notice">Quantity is changed through Receive, Issue, or Adjust so each change appears in the stock history.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<form method="post"><?= csrf_field() ?><?php include __DIR__.'/../includes/parts_form.php'; ?><div class="actions"><button class="btn">Save item details</button><a class="btn secondary" href="view.php?id=<?= $id ?>">Cancel</a></div></form>
<?php include __DIR__.'/../includes/footer.php'; ?>
