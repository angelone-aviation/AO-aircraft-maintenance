<?php
require_once __DIR__.'/includes/auth.php';
if (user()) { header('Location: '.url()); exit; }
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    verify_csrf();
    $email=strtolower(trim((string)($_POST['email'] ?? '')));
    $stmt=$pdo->prepare('SELECT id,name,email,password_hash,role FROM users WHERE email=? AND is_active=1'); $stmt->execute([$email]); $candidate=$stmt->fetch();
    if ($candidate && password_verify((string)($_POST['password'] ?? ''),$candidate['password_hash'])) {
        session_regenerate_id(true); unset($candidate['password_hash']); $_SESSION['user']=$candidate; header('Location: '.url()); exit;
    }
    $error='Invalid email or password.';
    usleep(300000);
}
$page_title='Sign in'; include __DIR__.'/includes/header.php'; ?>
<div class="auth-card"><h1>Sign in</h1><?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<form method="post"><?= csrf_field() ?><div class="field"><label>Email</label><input type="email" name="email" required autocomplete="username"></div><div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div><button class="btn">Sign in</button></form></div>
<?php include __DIR__.'/includes/footer.php'; ?>
