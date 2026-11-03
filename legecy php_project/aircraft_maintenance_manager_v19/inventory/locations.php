<?php
require_once __DIR__.'/../includes/parts_inventory.php';
require_login();
$can_edit=in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'],true);
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 permit(['ADMIN','MANAGER','MECHANIC']); verify_csrf();
 try {
  $data=[
   'name'=>parts_text('name',150,true),
   'address_line1'=>parts_text('address_line1',200),
   'address_line2'=>parts_text('address_line2',200),
   'city'=>parts_text('city',100),
   'region'=>parts_text('region',100),
   'postal_code'=>parts_text('postal_code',30),
   'country'=>parts_text('country',100),
   'contact_name'=>parts_text('contact_name',150),
   'contact_phone'=>parts_text('contact_phone',60),
   'contact_email'=>parts_text('contact_email',255),
   'notes'=>parts_text('notes',10000),
   'is_active'=>isset($_POST['is_active'])?1:0,
  ];
  if ($data['contact_email']!==null && !filter_var($data['contact_email'],FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Enter a valid contact email.');
  $pdo->beginTransaction();
  if ($id) {
   $q=$pdo->prepare('SELECT * FROM inventory_locations WHERE id=? FOR UPDATE'); $q->execute([$id]); $before=$q->fetch();
   if (!$before) throw new RuntimeException('Location not found.');
   $fields=array_keys($data);
   $q=$pdo->prepare('UPDATE inventory_locations SET '.implode(',',array_map(static fn($field)=>$field.'=?',$fields)).' WHERE id=?');
   $q->execute(array_merge(array_values($data),[$id]));
   audit($pdo,'UPDATE','inventory_locations',$id,$before,$data);
  } else {
   if (!$data['is_active']) throw new RuntimeException('A new location must be active.');
   $fields=array_keys($data);
   $q=$pdo->prepare('INSERT INTO inventory_locations ('.implode(',',$fields).') VALUES ('.implode(',',array_fill(0,count($fields),'?')).')');
   $q->execute(array_values($data));
   audit($pdo,'CREATE','inventory_locations',(int)$pdo->lastInsertId(),null,$data);
  }
  $pdo->commit(); header('Location: locations.php'); exit;
 } catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  $error=$e instanceof RuntimeException?$e->getMessage():'Could not save location. Check for a duplicate name and confirm the V19 database upgrade.';
 }
}
$editing=null;
if ($id) {
 $q=$pdo->prepare('SELECT * FROM inventory_locations WHERE id=?'); $q->execute([$id]); $editing=$q->fetch();
 if (!$editing) { http_response_code(404); exit('Location not found.'); }
}
$locations=$pdo->query('SELECT l.*, (SELECT COUNT(*) FROM parts_inventory p WHERE p.location_id=l.id) AS item_count FROM inventory_locations l ORDER BY l.name')->fetchAll();
$page_title='Inventory Locations'; include __DIR__.'/../includes/header.php';
?>
<h1>Inventory Locations</h1>
<p class="notice">Keep a location for its stock history. Mark it inactive to remove it from new stock selections; existing inventory remains assigned to it.</p>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<?php if ($can_edit): ?>
<div class="card"><h2><?= $editing?'Edit location':'Add location' ?></h2>
<form method="post" action="<?= esc($editing?'locations.php?id='.(int)$editing['id']:'locations.php') ?>"><?= csrf_field() ?>
<div class="form-grid">
<?php $limits=['name'=>150,'address_line1'=>200,'address_line2'=>200,'city'=>100,'region'=>100,'postal_code'=>30,'country'=>100,'contact_name'=>150,'contact_phone'=>60,'contact_email'=>255]; ?>
<?php foreach (['name'=>'Location name','address_line1'=>'Address line 1','address_line2'=>'Address line 2','city'=>'City','region'=>'State / Province / District','postal_code'=>'Postal code','country'=>'Country','contact_name'=>'Contact name','contact_phone'=>'Contact phone','contact_email'=>'Contact email'] as $key=>$label): ?>
<div class="field"><label><?= esc($label) ?></label><input name="<?= esc($key) ?>" value="<?= esc($editing[$key] ?? '') ?>" maxlength="<?= $limits[$key] ?>" <?= $key==='name'?'required':'' ?>></div>
<?php endforeach; ?>
<div class="field full"><label>Notes</label><textarea name="notes" maxlength="10000"><?= esc($editing['notes'] ?? '') ?></textarea></div>
<div class="field full"><label class="check-option"><input type="checkbox" name="is_active" <?= !$editing || $editing['is_active']?'checked':'' ?>> Active</label></div>
</div><div class="actions"><button class="btn">Save location</button><?php if ($editing): ?><a class="btn secondary" href="locations.php">Cancel</a><?php endif; ?></div>
</form></div>
<?php endif; ?>
<h2>Location list</h2><div class="table-wrap"><table><tr><th>Name</th><th>Address</th><th>Contact</th><th>Stock rows</th><th>Status</th><th>Action</th></tr>
<?php foreach ($locations as $location): ?><tr><td><?= esc($location['name']) ?></td><td><?= esc(implode(', ',array_filter([$location['address_line1'],$location['address_line2'],$location['city'],$location['region'],$location['postal_code'],$location['country']],static fn($value)=>$value!==null && $value!==''))) ?></td><td><?= esc($location['contact_name']) ?><br><?= esc($location['contact_phone']) ?> <?= esc($location['contact_email']) ?></td><td><?= (int)$location['item_count'] ?></td><td><?= $location['is_active']?'Active':'Inactive' ?></td><td><?php if ($can_edit): ?><a href="locations.php?id=<?= (int)$location['id'] ?>">Edit</a><?php else: ?>—<?php endif; ?></td></tr><?php endforeach; ?>
<?php if (!$locations): ?><tr><td colspan="6">No locations yet.</td></tr><?php endif; ?></table></div>
<div class="actions"><a class="btn secondary" href="<?= esc(url('inventory/')) ?>">Back to inventory</a></div>
<?php include __DIR__.'/../includes/footer.php'; ?>
