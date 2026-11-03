<?php
require_once __DIR__ . '/../includes/total_time.php';
require_login();
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    permit(['ADMIN','MANAGER','MECHANIC']); verify_csrf();
    $source=(string)($_POST['total_time_source'] ?? 'TACH'); if (!in_array($source,['TACH','HOBBS'],true)) { http_response_code(400); exit('Invalid total time source.'); }
    $adjustment=posted_adjustment('total_time_adjustment');
    $reading=$source==='HOBBS'?posted_decimal('current_hobbs'):posted_decimal('current_tach');
    if ($reading+$adjustment<0) { http_response_code(400); exit('Aircraft total time cannot be negative.'); }
    $stmt = $pdo->prepare("INSERT INTO aircraft (registration, make, model, serial_number, current_tach, current_hobbs, total_time_source, total_time_adjustment, current_landings, current_cycles, status)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    $stmt->execute([
        trim($_POST['registration']), trim($_POST['make']), trim($_POST['model']),
        trim($_POST['serial_number']), posted_decimal('current_tach'), posted_decimal('current_hobbs'), $source, $adjustment,
        posted_int('current_landings'), posted_int('current_cycles'), $_POST['status']
    ]);
    audit($pdo,'CREATE','aircraft',(int)$pdo->lastInsertId(),null,['registration'=>trim($_POST['registration'])]);
    header('Location: index.php'); exit;
}
$page_title = 'Add Aircraft';
include __DIR__ . '/../includes/header.php';
?>
<h1>Add Aircraft</h1><?php if (!in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])) { http_response_code(403); exit('Permission denied.'); } ?>
<form method="post"><?= csrf_field() ?>
<div class="form-grid">
<div class="field"><label>Registration / Tail Number</label><input name="registration" required></div>
<div class="field"><label>Make</label><input name="make" required></div>
<div class="field"><label>Model</label><input name="model" required></div>
<div class="field"><label>Serial Number</label><input name="serial_number"></div>
<div class="field"><label>Current Tach</label><input type="number" step="0.1" name="current_tach" value="0"></div>
<div class="field"><label>Current Hobbs</label><input type="number" step="0.1" name="current_hobbs" value="0"></div>
<div class="field"><label>Total time source</label><select name="total_time_source"><option value="TACH">Tach</option><option value="HOBBS">Hobbs</option></select></div>
<div class="field"><label>Signed total time adjustment (hours)</label><input type="number" name="total_time_adjustment" step="0.1" value="0" required></div>
<div class="field"><label>Current Landings</label><input type="number" min="0" name="current_landings" value="0"></div>
<div class="field"><label>Current Cycles</label><input type="number" min="0" name="current_cycles" value="0" required></div>
<div class="field"><label>Status</label><select name="status"><option>AIRWORTHY</option><option>MAINTENANCE</option><option>GROUNDED</option></select></div>
</div>
<div class="actions"><button class="btn" type="submit">Save Aircraft</button><a class="btn secondary" href="index.php">Cancel</a></div>
</form>
<?php include __DIR__ . '/../includes/footer.php'; ?>
