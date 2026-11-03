<?php
require_once __DIR__.'/../includes/parts_inventory.php'; require_login();
$search=trim((string)($_GET['q'] ?? ''));
$ata=trim((string)($_GET['ata'] ?? ''));
$category=trim((string)($_GET['category'] ?? ''));
$condition=trim((string)($_GET['condition'] ?? ''));
$location=trim((string)($_GET['location_id'] ?? ''));
$low=isset($_GET['low']) && $_GET['low']==='1';
$where=[]; $params=[];
if ($search!=='') {
 $where[]='(p.part_name LIKE :term1 OR p.part_number LIKE :term2 OR p.alternate_part_number LIKE :term3 OR p.manufacturer LIKE :term4 OR p.lot_number LIKE :term5 OR p.supplier LIKE :term6 OR p.purchase_reference LIKE :term7)';
 $term='%'.str_replace(['\\','%','_'],['\\\\','\\%','\\_'],substr($search,0,100)).'%';
 for ($i=1;$i<=7;$i++) $params[':term'.$i]=$term;
}
$known_ata=false; foreach (ata_groups() as $group) if (array_key_exists($ata,$group)) $known_ata=true;
if ($ata!=='' && $known_ata) { $where[]='p.ata_chapter=:ata'; $params[':ata']=$ata; }
if (in_array($category,['PART','HARDWARE','CONSUMABLE','OTHER'],true)) { $where[]='p.category=:category'; $params[':category']=$category; }
if (in_array($condition,['NEW','SERVICEABLE','UNSERVICEABLE','QUARANTINE'],true)) { $where[]='p.item_condition=:condition'; $params[':condition']=$condition; }
if (ctype_digit($location) && (int)$location>0) { $where[]='p.location_id=:location'; $params[':location']=(int)$location; }
if ($low) $where[]='p.minimum_quantity>0 AND p.quantity_on_hand<=p.minimum_quantity';
$sql='SELECT p.*,l.name AS location_name FROM parts_inventory p JOIN inventory_locations l ON l.id=p.location_id';
if ($where) $sql.=' WHERE '.implode(' AND ',$where);
$sql.=' ORDER BY p.part_name,p.part_number,p.id LIMIT 500';
$q=$pdo->prepare($sql); $q->execute($params); $rows=$q->fetchAll();
$locations=$pdo->query('SELECT id,name FROM inventory_locations ORDER BY name')->fetchAll();
$page_title='Parts & Hardware Inventory'; include __DIR__.'/../includes/header.php'; ?>
<h1>Parts &amp; Hardware Inventory</h1>
<div class="actions"><a class="btn secondary" href="locations.php">Locations</a><?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'],true)): ?><a class="btn" href="add.php">+ Add stock row</a><?php endif; ?></div>
<form method="get" class="card"><h2>Search stock</h2><div class="form-grid">
<div class="field"><label>Search</label><input name="q" value="<?= esc($search) ?>" maxlength="100" placeholder="Name, part number, lot, supplier, reference"></div>
<div class="field"><label>ATA Chapter</label><select name="ata"><option value="">All chapters</option><?php foreach (ata_groups() as $group=>$chapters): ?><optgroup label="<?= esc($group) ?>"><?php foreach ($chapters as $code=>$label): ?><option value="<?= esc($code) ?>" <?= (string)$ata===(string)$code?'selected':'' ?>>ATA <?= esc($code) ?>: <?= esc($label) ?></option><?php endforeach; ?></optgroup><?php endforeach; ?></select></div>
<div class="field"><label>Category</label><select name="category"><option value="">All categories</option><?php foreach (['PART'=>'Part','HARDWARE'=>'Hardware','CONSUMABLE'=>'Consumable','OTHER'=>'Other'] as $value=>$label): ?><option value="<?= esc($value) ?>" <?= $category===$value?'selected':'' ?>><?= esc($label) ?></option><?php endforeach; ?></select></div>
<div class="field"><label>Condition</label><select name="condition"><option value="">All conditions</option><?php foreach (['NEW'=>'New','SERVICEABLE'=>'Serviceable','UNSERVICEABLE'=>'Unserviceable','QUARANTINE'=>'Quarantine'] as $value=>$label): ?><option value="<?= esc($value) ?>" <?= $condition===$value?'selected':'' ?>><?= esc($label) ?></option><?php endforeach; ?></select></div>
<div class="field"><label>Location</label><select name="location_id"><option value="">All locations</option><?php foreach ($locations as $place): ?><option value="<?= (int)$place['id'] ?>" <?= (int)$location===(int)$place['id']?'selected':'' ?>><?= esc($place['name']) ?></option><?php endforeach; ?></select></div>
<div class="field"><label class="check-option"><input type="checkbox" name="low" value="1" <?= $low?'checked':'' ?>> Low stock only</label></div>
</div><div class="actions"><button class="btn">Search</button><a class="btn secondary" href="index.php">Clear</a></div></form>
<p><?= count($rows) ?> stock row(s) shown<?= count($rows)===500?' (first 500; narrow your search for more)':'' ?>.</p>
<div class="table-wrap"><table><tr><th>Part</th><th>ATA</th><th>Category</th><th>Part / Alternate</th><th>Lot</th><th>Condition</th><th>Location</th><th>On hand</th><th>Minimum</th><th>Expires</th><th>Status</th></tr>
<?php foreach ($rows as $row): $is_low=(float)$row['minimum_quantity']>0 && (float)$row['quantity_on_hand']<=(float)$row['minimum_quantity']; ?>
<tr><td><a href="view.php?id=<?= (int)$row['id'] ?>"><?= esc($row['part_name']) ?></a></td><td><?= esc(ata_label($row['ata_chapter'])) ?></td><td><?= esc($row['category']) ?></td><td><?= esc($row['part_number']) ?><br><?= esc($row['alternate_part_number']) ?></td><td><?= esc($row['lot_number']) ?></td><td><?= esc($row['item_condition']) ?></td><td><?= esc($row['location_name']) ?></td><td><?= esc($row['quantity_on_hand']) ?> <?= esc($row['unit']) ?></td><td><?= esc($row['minimum_quantity']) ?></td><td><?= esc($row['expiration_date'] ?? '—') ?></td><td class="<?= $is_low?'red':'green' ?>"><?= $is_low?'Low stock':'—' ?></td></tr>
<?php endforeach; ?><?php if (!$rows): ?><tr><td colspan="11">No matching stock rows.</td></tr><?php endif; ?></table></div>
<?php include __DIR__.'/../includes/footer.php'; ?>
