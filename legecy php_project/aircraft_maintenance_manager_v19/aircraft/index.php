<?php
require_once __DIR__ . '/../includes/total_time.php';
require_login();
$page_title = 'Aircraft';
$aircraft = $pdo->query("SELECT * FROM aircraft ORDER BY registration")->fetchAll();
include __DIR__ . '/../includes/header.php';
?>
<h1>Aircraft</h1>
<?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])): ?><div class="actions"><a class="btn" href="add.php">+ Add Aircraft</a></div><?php endif; ?>
<div class="table-wrap"><table>
<tr><th>Registration</th><th>Make</th><th>Model</th><th>Serial</th><th>Tach</th><th>Total Time</th><th>Cycles</th><th>Status</th></tr>
<?php foreach ($aircraft as $a): ?>
<tr>
<td><a href="view.php?id=<?= (int)$a['id'] ?>"><?= htmlspecialchars($a['registration']) ?></a></td>
<td><?= htmlspecialchars($a['make']) ?></td>
<td><?= htmlspecialchars($a['model']) ?></td>
<td><?= htmlspecialchars($a['serial_number']) ?></td>
<td><?= htmlspecialchars($a['current_tach']) ?></td><td><?= esc(number_format(aircraft_total_time($a),1)) ?></td>
<td><?= (int)$a['current_cycles'] ?></td>
<td class="green"><?= htmlspecialchars($a['status']) ?></td>
</tr>
<?php endforeach; ?>
</table></div>
<?php include __DIR__ . '/../includes/footer.php'; ?>
