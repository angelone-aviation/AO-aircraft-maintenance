<?php
require_once __DIR__.'/includes/auth.php';
if ((int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn()!==0) { http_response_code(404); exit('Setup is closed.'); }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    verify_csrf();
    $name=trim((string)($_POST['name'] ?? '')); $email=strtolower(trim((string)($_POST['email'] ?? ''))); $pass=(string)($_POST['password'] ?? '');
    if ($name==='' || !filter_var($email,FILTER_VALIDATE_EMAIL) || strlen($pass)<12) $error='Enter a name, valid email and password of at least 12 characters.';
    else { try { $s=$pdo->prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'ADMIN')"); $s->execute([$name,$email,password_hash($pass,PASSWORD_DEFAULT)]); header('Location: '.url('login.php')); exit; } catch (PDOException $e) { $error='Setup could not finish. Check that the email is unused.'; } }
}
$page_title='Create administrator'; include __DIR__.'/includes/header.php'; ?>
<div class="auth-card"><h1>Create administrator</h1><p>Use this once after importing the V2 upgrade.</p><?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?><form method="post"><?= csrf_field() ?><div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Email</label><input name="email" type="email" required></div><div class="field"><label>Password (12 characters minimum)</label><input name="password" type="password" minlength="12" required></div><button class="btn">Create administrator</button></form></div>
<?php include __DIR__.'/includes/footer.php'; ?>
