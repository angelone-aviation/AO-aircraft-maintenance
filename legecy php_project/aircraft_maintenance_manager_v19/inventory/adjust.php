<?php
require_once __DIR__.'/../includes/parts_inventory.php'; permit(['ADMIN','MANAGER','MECHANIC']);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]); if (!$id) { http_response_code(400); exit('Invalid stock ID.'); }
$q=$pdo->prepare('SELECT p.*,l.name AS location_name FROM parts_inventory p JOIN inventory_locations l ON l.id=p.location_id WHERE p.id=?'); $q->execute([$id]); $item=$q->fetch();
if (!$item) { http_response_code(404); exit('Stock row not found.'); }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 try {
  $action=(string)($_POST['action'] ?? '');
  if (!in_array($action,['RECEIVE','ISSUE','ADJUST'],true)) throw new RuntimeException('Choose a valid stock action.');
  $quantity=parts_decimal('quantity',$action!=='ADJUST');
  $note=parts_text('note',1000,true); $reference=parts_text('reference_number',150);
  if ($action==='ADJUST' && strlen($note)<10) throw new RuntimeException('Describe the reason for an adjustment (at least 10 characters).');
  $pdo->beginTransaction();
  $q=$pdo->prepare('SELECT * FROM parts_inventory WHERE id=? FOR UPDATE'); $q->execute([$id]); $before=$q->fetch();
  if (!$before) throw new RuntimeException('Stock row not found.');
  $old=(float)$before['quantity_on_hand'];
  $next=$action==='RECEIVE'?$old+(float)$quantity:($action==='ISSUE'?$old-(float)$quantity:(float)$quantity);
  if ($next<0 || $next>999999999.999) throw new RuntimeException('Quantity would fall below zero or exceed the allowed range.');
  $after=number_format($next,3,'.',''); $delta=number_format($next-$old,3,'.','');
  if ($delta==='0.000') throw new RuntimeException('Quantity did not change.');
  $q=$pdo->prepare('UPDATE parts_inventory SET quantity_on_hand=? WHERE id=?'); $q->execute([$after,$id]);
  $q=$pdo->prepare('INSERT INTO parts_stock_history (inventory_id,action,quantity_change,quantity_after,reference_number,note,performed_by) VALUES (?,?,?,?,?,?,?)');
  $q->execute([$id,$action,$delta,$after,$reference,$note,user()['id']]);
  audit($pdo,$action,'parts_inventory',$id,['quantity_on_hand'=>$before['quantity_on_hand']],['quantity_on_hand'=>$after,'reference'=>$reference,'note'=>$note]);
  $pdo->commit(); header('Location: view.php?id='.$id); exit;
 } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not update quantity.'; }
}
$page_title='Change Stock Quantity'; include __DIR__.'/../includes/header.php'; ?>
<h1>Change stock — <?= esc($item['part_name']) ?></h1>
<p><?= esc($item['part_number']) ?> · <?= esc($item['lot_number'] ?? 'No lot') ?> · <?= esc($item['location_name']) ?> · Current quantity: <strong><?= esc($item['quantity_on_hand']) ?> <?= esc($item['unit']) ?></strong></p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<form method="post" class="card"><?= csrf_field() ?><div class="form-grid">
<div class="field"><label>Action</label><select name="action" required><option value="RECEIVE">Receive stock (add)</option><option value="ISSUE">Issue stock (subtract)</option><option value="ADJUST">Set corrected on-hand quantity</option></select></div>
<div class="field"><label>Quantity</label><input type="number" name="quantity" min="0" max="999999999" step="0.001" required><small>For an adjustment, enter the corrected total. For receive or issue, enter the amount changed.</small></div>
<div class="field"><label>Reference number</label><input name="reference_number" maxlength="150" placeholder="Invoice, work order, or document"></div>
<div class="field full"><label>Reason / note</label><textarea name="note" maxlength="1000" required></textarea></div></div>
<div class="actions"><button class="btn">Record change</button><a class="btn secondary" href="view.php?id=<?= $id ?>">Cancel</a></div></form>
<?php include __DIR__.'/../includes/footer.php'; ?>
