<?php
require_once __DIR__ . '/../includes/auth.php';
require_login();
$aircraft = $pdo->query("SELECT id, registration FROM aircraft ORDER BY registration")->fetchAll();
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    permit(['ADMIN','MANAGER','MECHANIC']); verify_csrf();
    $stmt=$pdo->prepare("INSERT INTO maintenance_records (aircraft_id, maintenance_date, work_order, maintenance_type, description, tach, hobbs, technician)
                         VALUES (?,?,?,?,?,?,?,?)");
    $stmt->execute([(int)$_POST['aircraft_id'], $_POST['maintenance_date'], trim($_POST['work_order']), trim($_POST['maintenance_type']),
                    trim($_POST['description']), (float)$_POST['tach'], (float)$_POST['hobbs'], trim($_POST['technician'])]);
    audit($pdo,'CREATE','maintenance_records',(int)$pdo->lastInsertId(),null,['aircraft_id'=>(int)$_POST['aircraft_id'],'description'=>trim($_POST['description'])]);
    header('Location: index.php'); exit;
}
$records=$pdo->query("SELECT m.*, a.registration FROM maintenance_records m JOIN aircraft a ON a.id=m.aircraft_id ORDER BY m.maintenance_date DESC LIMIT 100")->fetchAll();
$page_title='Maintenance';
include __DIR__ . '/../includes/header.php';
?>
<h1>Maintenance</h1>
<?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])): ?><div class="card">
<form method="post"><?= csrf_field() ?>
<div class="form-grid">
<div class="field"><label>Aircraft</label><select name="aircraft_id" required><?php foreach($aircraft as $a): ?><option value="<?= $a['id'] ?>"><?= htmlspecialchars($a['registration']) ?></option><?php endforeach; ?></select></div>
<div class="field"><label>Date</label><input type="date" name="maintenance_date" value="<?= date('Y-m-d') ?>" required></div>
<div class="field"><label>Work Order</label><input name="work_order"></div>
<div class="field"><label>Type</label><input name="maintenance_type" placeholder="50-hour, annual, repair..."></div>
<div class="field"><label>Tach</label><input type="number" step="0.1" name="tach" value="0"></div>
<div class="field"><label>Hobbs</label><input type="number" step="0.1" name="hobbs" value="0"></div>
<div class="field"><label>Technician</label><input name="technician"></div>
<div class="field" style="grid-column:1/-1"><label>Description</label><textarea name="description" required></textarea></div>
</div>
<div class="actions"><button class="btn" type="submit">Save Maintenance Record</button></div>
</form>
</div><?php endif; ?>
<h2>Recent Records</h2>
<div class="table-wrap"><table>
<tr><th>Date</th><th>Aircraft</th><th>Work Order</th><th>Type</th><th>Tach</th><th>Technician</th></tr>
<?php foreach($records as $r): ?><tr><td><?= htmlspecialchars($r['maintenance_date']) ?></td><td><?= htmlspecialchars($r['registration']) ?></td><td><?= htmlspecialchars($r['work_order']) ?></td><td><?= htmlspecialchars($r['maintenance_type']) ?></td><td><?= htmlspecialchars($r['tach']) ?></td><td><?= htmlspecialchars($r['technician']) ?></td></tr><?php endforeach; ?>
</table></div>
<?php include __DIR__ . '/../includes/footer.php'; ?>
