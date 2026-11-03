<?php
require_once __DIR__.'/includes/auth.php';
if ($_SERVER['REQUEST_METHOD']!=='POST') { http_response_code(405); exit; }
verify_csrf(); $_SESSION=[]; session_regenerate_id(true); session_destroy(); header('Location: '.url('login.php')); exit;
