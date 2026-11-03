<?php
require_once __DIR__.'/../includes/parts_inventory.php'; require_login();
$id=filter_var($_GET['id'] ?? null,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]); if (!$id) { http_response_code(400); exit('Invalid stock ID.'); }
$q=$pdo->prepare('SELECT p.*,l.name AS location_name,l.address_line1,l.address_line2,l.city,l.region,l.postal_code,l.country,l.contact_name,l.contact_phone,l.contact_email FROM parts_inventory p JOIN inventory_locations l ON l.id=p.location_id WHERE p.id=?'); $q->execute([$id]); $item=$q->fetch();
if (!$item) { http_response_code(404); exit('Stock row not found.'); }
$q=$pdo->prepare('SELECT h.*,u.name AS user_name FROM parts_stock_history h LEFT JOIN users u ON u.id=h.performed_by WHERE h.inventory_id=? ORDER BY h.id DESC LIMIT 100'); $q->execute([$id]); $history=$q->fetchAll();
$page_title=$item['part_name']; include __DIR__.'/../includes/header.php'; ?>
<h1><?= esc($item['part_name']) ?></h1>
<div class="grid"><div class="card"><h3>Part number</h3><div class="number small-number"><?= esc($item['part_number']) ?></div></div><div class="card"><h3>On hand</h3><div class="number"><?= esc($item['quantity_on_hand']) ?></div><p><?= esc($item['unit']) ?></p></div><div class="card"><h3>Location</h3><div class="number small-number"><?= esc($item['location_name']) ?></div></div></div>
<?php if ((float)$item['minimum_quantity']>0 && (float)$item['quantity_on_hand']<=(float)$item['minimum_quantity']): ?><div class="error">At or below minimum quantity of <?= esc($item['minimum_quantity']) ?> <?= esc($item['unit']) ?>.</div><?php endif; ?>
<?php if ($item['expiration_date'] && $item['expiration_date']<date('Y-m-d')): ?><div class="error">Expiration date has passed. Check this stock before use.</div><?php endif; ?>
<?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'],true)): ?><div class="actions"><a class="btn" href="adjust.php?id=<?= $id ?>">Receive / Issue / Adjust</a><a class="btn secondary" href="edit.php?id=<?= $id ?>">Edit details</a></div><?php endif; ?>
<div class="card"><h2>Item details</h2>
<p><strong>Alternate part:</strong> <?= esc($item['alternate_part_number'] ?? '—') ?> · <strong>Manufacturer:</strong> <?= esc($item['manufacturer'] ?? '—') ?> · <strong>ATA:</strong> <?= esc(ata_label($item['ata_chapter'])) ?> · <strong>Category:</strong> <?= esc($item['category']) ?></p>
<p><strong>Lot / batch:</strong> <?= esc($item['lot_number'] ?? '—') ?> · <strong>Condition:</strong> <?= esc($item['item_condition']) ?> · <strong>Minimum:</strong> <?= esc($item['minimum_quantity']) ?> <?= esc($item['unit']) ?></p>
<p><strong>Received:</strong> <?= esc($item['received_date'] ?? '—') ?> · <strong>Expires:</strong> <?= esc($item['expiration_date'] ?? '—') ?> · <strong>Supplier:</strong> <?= esc($item['supplier'] ?? '—') ?> · <strong>Purchase reference:</strong> <?= esc($item['purchase_reference'] ?? '—') ?></p>
<p><strong>Location address:</strong> <?= esc(implode(', ',array_filter([$item['address_line1'],$item['address_line2'],$item['city'],$item['region'],$item['postal_code'],$item['country']]))) ?> · <strong>Contact:</strong> <?= esc($item['contact_name']) ?> <?= esc($item['contact_phone']) ?> <?= esc($item['contact_email']) ?></p>
<p><strong>Notes:</strong> <?= nl2br(esc($item['notes'] ?? '—')) ?></p></div>
<h2>Stock history</h2><div class="table-wrap"><table><tr><th>Date / time</th><th>Action</th><th>Change</th><th>Quantity after</th><th>Reference</th><th>Recorded by</th><th>Note</th></tr>
<?php foreach ($history as $row): ?><tr><td><?= esc($row['created_at']) ?></td><td><?= esc($row['action']) ?></td><td><?= esc($row['quantity_change']) ?></td><td><?= esc($row['quantity_after']) ?></td><td><?= esc($row['reference_number']) ?></td><td><?= esc($row['user_name'] ?? 'Former user') ?></td><td><?= esc($row['note']) ?></td></tr><?php endforeach; ?>
<?php if (!$history): ?><tr><td colspan="7">No stock history recorded.</td></tr><?php endif; ?></table></div>
<?php include __DIR__.'/../includes/footer.php'; ?>
