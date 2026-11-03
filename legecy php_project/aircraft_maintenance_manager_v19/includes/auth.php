<?php
require_once __DIR__ . '/db.php';
if (session_status() !== PHP_SESSION_ACTIVE) {
    session_name('amm_session');
    session_set_cookie_params(['httponly'=>true,'secure'=>!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off','samesite'=>'Lax','path'=>'/']);
    session_start();
}
function url($path='') { return rtrim(defined('BASE_URL') ? BASE_URL : '', '/') . '/' . ltrim($path, '/'); }
function esc($value) { return htmlspecialchars((string)($value ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function csrf() { if (empty($_SESSION['csrf'])) $_SESSION['csrf']=bin2hex(random_bytes(32)); return $_SESSION['csrf']; }
function csrf_field() { return '<input type="hidden" name="csrf" value="'.esc(csrf()).'">'; }
function verify_csrf() { if (!hash_equals(csrf(), (string)($_POST['csrf'] ?? ''))) { http_response_code(403); exit('Invalid form token. Reload and try again.'); } }
function user() { return $_SESSION['user'] ?? null; }
function require_login() { if (!user()) { header('Location: '.url('login.php')); exit; } }
function permit($roles) { require_login(); if (!in_array(user()['role'], $roles, true)) { http_response_code(403); exit('Permission denied.'); } }
function audit($pdo,$action,$table,$id,$before=null,$after=null) {
    $s=$pdo->prepare('INSERT INTO audit_log (user_id, action, entity_table, entity_id, before_json, after_json) VALUES (?,?,?,?,?,?)');
    $s->execute([user()['id'] ?? null,$action,$table,$id,$before===null?null:json_encode($before),$after===null?null:json_encode($after)]);
}
function posted_decimal($key) { $v=trim((string)($_POST[$key] ?? '')); if ($v==='' || !is_numeric($v) || (float)$v<0) throw new RuntimeException('Enter a valid nonnegative '.$key.'.'); return round((float)$v,1); }
function posted_int($key) { $v=trim((string)($_POST[$key] ?? '')); if (!ctype_digit($v)) throw new RuntimeException('Enter a valid '.$key.'.'); return (int)$v; }
function date_or_null($key) { $v=trim((string)($_POST[$key] ?? '')); if ($v==='') return null; $d=DateTimeImmutable::createFromFormat('!Y-m-d',$v); if (!$d || $d->format('Y-m-d')!==$v) throw new RuntimeException('Invalid date.'); return $v; }
