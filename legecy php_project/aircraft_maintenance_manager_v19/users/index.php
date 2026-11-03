<?php
require_once __DIR__.'/../includes/auth.php'; permit(['ADMIN']);
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
 verify_csrf();
 $name=trim((string)($_POST['name'] ?? '')); $email=strtolower(trim((string)($_POST['email'] ?? ''))); $role=(string)($_POST['role'] ?? ''); $password=(string)($_POST['password'] ?? '');
 if ($name==='' || !filter_var($email,FILTER_VALIDATE_EMAIL) || strlen($password)<12 || !in_array($role,['ADMIN','MANAGER','MECHANIC','PILOT','OWNER','AUDITOR'],true)) $error='Enter a name, valid email, role and password of at least 12 characters.';
 else { try { $pdo->beginTransaction(); $q=$pdo->prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)'); $q->execute([$name,$email,password_hash($password,PASSWORD_DEFAULT),$role]); audit($pdo,'CREATE','users',(int)$pdo->lastInsertId(),null,['email'=>$email,'role'=>$role]); $pdo->commit(); header('Location: index.php'); exit; } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error='Could not add user. The email may already exist.'; } }
}
$users=$pdo->query('SELECT id,name,email,role,is_active,created_at FROM users ORDER BY name')->fetchAll(); $page_title='Users'; include __DIR__.'/../includes/header.php'; ?>
<h1>Users</h1>
<?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<div class="card"><h2>What each role can do</h2>
<p>Every role can view the fleet and aircraft dashboards, maintenance, flights, inspections, components, parts inventory, and inventory locations.</p>
<div class="table-wrap"><table>
<tr><th>Role</th><th>Additional permissions</th></tr>
<tr><td><strong>Admin</strong></td><td>Add users; add and edit aircraft, inspections, components, stock, and inventory locations; receive, issue, and adjust stock; record maintenance; enter flights; correct the latest flight; replace instruments and manage component installation and service data.</td></tr>
<tr><td><strong>Manager</strong></td><td>Add and edit aircraft, inspections, components, stock, and inventory locations; receive, issue, and adjust stock; record maintenance; enter flights; correct the latest flight; replace instruments and manage component installation and service data. Cannot add users.</td></tr>
<tr><td><strong>Mechanic</strong></td><td>Add and edit aircraft, inspections, components, stock, and inventory locations; receive, issue, and adjust stock; record maintenance; replace instruments and manage component installation and service data. Cannot enter or correct flights or add users.</td></tr>
<tr><td><strong>Pilot</strong></td><td>Enter flight log records. Cannot correct existing flights or change aircraft, maintenance, inspections, components, stock, locations, or users.</td></tr>
<tr><td><strong>Owner</strong></td><td>View only. Cannot enter or edit records.</td></tr>
<tr><td><strong>Auditor</strong></td><td>View only. Currently has the same access as Owner.</td></tr>
</table></div></div>
<div class="card"><h2>Add user</h2><form method="post"><?= csrf_field() ?><div class="form-grid"><div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Email</label><input type="email" name="email" required></div><div class="field"><label>Initial password</label><input type="password" name="password" minlength="12" required></div><div class="field"><label>Role</label><select name="role"><?php foreach (['MANAGER','MECHANIC','PILOT','OWNER','AUDITOR','ADMIN'] as $role): ?><option><?= esc($role) ?></option><?php endforeach; ?></select></div></div><button class="btn">Add user</button></form></div>
<h2>Accounts</h2><div class="table-wrap"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th></tr><?php foreach ($users as $u): ?><tr><td><?= esc($u['name']) ?></td><td><?= esc($u['email']) ?></td><td><?= esc($u['role']) ?></td><td><?= $u['is_active']?'Yes':'No' ?></td></tr><?php endforeach; ?></table></div><?php include __DIR__.'/../includes/footer.php'; ?>
