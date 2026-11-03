<?php
require_once __DIR__.'/auth.php';
function aircraft_total_time($a) {
    $reading=($a['total_time_source']==='HOBBS') ? (float)$a['current_hobbs'] : (float)$a['current_tach'];
    return round($reading+(float)$a['total_time_adjustment'],1);
}
function total_time_sql($alias='a') {
    return '(CASE WHEN '.$alias.".total_time_source='HOBBS' THEN ".$alias.'.current_hobbs ELSE '.$alias.'.current_tach END + '.$alias.'.total_time_adjustment)';
}
function posted_adjustment($key) {
    $raw=trim((string)($_POST[$key] ?? ''));
    if ($raw==='' || !is_numeric($raw) || abs((float)$raw)>99999999.9 || !preg_match('/^-?\d+(?:\.\d)?$/',$raw)) throw new RuntimeException('Enter a signed adjustment to one decimal place.');
    return round((float)$raw,1);
}
