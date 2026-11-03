<?php
require_once __DIR__.'/../includes/parts_inventory.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $data=parts_data($pdo);
  $opening=parts_decimal('opening_quantity');
  $pdo->beginTransaction();
  $fields=array_keys($data);
  $q=$pdo->prepare('INSERT INTO parts_inventory ('.implode(',',$fields).',quantity_on_hand) VALUES ('.implode(',',array_fill(0,count($fields)+1,'?')).')');
  $q->execute(array_merge(array_values($data),[$opening]));
  $id=(int)$pdo->lastInsertId();
  $q=$pdo->prepare("INSERT INTO parts_stock_history (inventory_id,action,quantity_change,quantity_after,note,performed_by) VALUES (?,'OPENING',?,?,'Opening balance',?)");
  $q->execute([$id,$opening,$opening,user()['id']]);
  audit($pdo,'CREATE','parts_inventory',$id,null,array_merge($data,['quantity_on_hand'=>$opening]));
  $pdo->commit(); header('Location: view.php?id='.$id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not save item. Confirm the V19 database upgrade.'; }
}
$locations=parts_locations($pdo); $record=[]; $page_title='Add Inventory Item'; include __DIR__.'/../includes/header.php'; ?>
<h1>Add Parts &amp; Hardware Stock</h1>
<p class="notice">Use a separate stock row for each combination of part number, lot, condition, and location. Tracked serialized components belong in Components.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<?php if (!$locations): ?><p class="notice">Create an active <a href="locations.php">location</a> before adding stock.</p><?php else: ?>
<form method="post"><?= csrf_field() ?><?php include __DIR__.'/../includes/parts_form.php'; ?>
<div class="field"><label>Opening quantity</label><input type="number" name="opening_quantity" min="0" max="999999999" step="0.001" value="0" required></div>
<div class="actions"><button class="btn">Add stock row</button><a class="btn secondary" href="index.php">Cancel</a></div></form>
<?php endif; ?>
<?php include __DIR__.'/../includes/footer.php'; ?>
