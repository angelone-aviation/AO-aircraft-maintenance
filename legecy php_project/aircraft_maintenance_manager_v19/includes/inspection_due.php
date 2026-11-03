<?php
require_once __DIR__.'/auth.php';
function optional_positive_int($key) {
    $raw=trim((string)($_POST[$key] ?? ''));
    if ($raw==='') return null;
    if (!ctype_digit($raw) || (int)$raw<1 || (int)$raw>1000000) throw new RuntimeException('Enter a positive '.$key.' within the supported range.');
    return (int)$raw;
}
function optional_nonnegative_int($key) {
    $raw=trim((string)($_POST[$key] ?? ''));
    if ($raw==='') return null;
    if (!ctype_digit($raw) || (int)$raw>2147483647) throw new RuntimeException('Enter a valid '.$key.'.');
    return (int)$raw;
}
function optional_positive_hours($key) {
    $raw=trim((string)($_POST[$key] ?? ''));
    if ($raw==='') return null;
    $value=posted_decimal($key);
    if ($value<=0 || $value>99999999) throw new RuntimeException('Enter a positive time interval.');
    return $value;
}
function calendar_due($date,$value,$unit) {
    $start=DateTimeImmutable::createFromFormat('!Y-m-d',$date);
    if ($unit==='DAYS') { $due=$start->add(new DateInterval('P'.$value.'D')); if ((int)$due->format('Y')>9999) throw new RuntimeException('Calendar interval extends beyond supported dates.'); return $due->format('Y-m-d'); }
    $months=$value*($unit==='YEARS'?12:1);
    // Clamp month-end dates (e.g. January 31 + one month -> February 28/29).
    $year=(int)$start->format('Y'); $month=(int)$start->format('n');
    $index=$year*12+$month-1+$months; $target_year=intdiv($index,12); $target_month=$index%12+1;
    if ($target_year>9999) throw new RuntimeException('Calendar interval extends beyond supported dates.');
    $first=DateTimeImmutable::createFromFormat('!Y-n-j',$target_year.'-'.$target_month.'-1');
    $day=min((int)$start->format('j'),(int)$first->format('t'));
    return $first->setDate($target_year,$target_month,$day)->format('Y-m-d');
}
function inspection_schedule_from_post() {
    $type=trim((string)($_POST['inspection_type'] ?? ''));
    $notes=trim((string)($_POST['notes'] ?? ''));
    $last_date=date_or_null('last_date');
    $last_raw=trim((string)($_POST['last_hours'] ?? '')); $last_hours=$last_raw===''?null:posted_decimal('last_hours');
    $last_cycles=optional_nonnegative_int('last_cycles');
    $interval_hours=optional_positive_hours('interval_hours');
    $interval_cycles=optional_positive_int('interval_cycles');
    $calendar_value=optional_positive_int('calendar_interval_value');
    $calendar_unit=$calendar_value===null?null:(string)($_POST['calendar_interval_unit'] ?? '');
    $warning_months=optional_nonnegative_int('warning_calendar_months');
    $warning_raw=trim((string)($_POST['warning_hours'] ?? '')); $warning_hours=$warning_raw===''?null:posted_decimal('warning_hours');
    $warning_cycles=optional_nonnegative_int('warning_cycles');
    if ($warning_months===null || $warning_hours===null || $warning_cycles===null || $warning_months>1200 || $warning_hours>99999999.9 || $warning_cycles>1000000) throw new RuntimeException('Enter nonnegative Due soon thresholds for months, hours, and cycles.');
    if ($type==='' || strlen($type)>150 || strlen($notes)>10000) throw new RuntimeException('Enter a valid inspection type and notes.');
    if ($interval_hours===null && $interval_cycles===null && $calendar_value===null) throw new RuntimeException('Enter at least one interval.');
    if ($calendar_value!==null && (!in_array($calendar_unit,['DAYS','MONTHS','YEARS'],true) || !$last_date)) throw new RuntimeException('A calendar interval needs a last completed date and unit.');
    if ($interval_hours!==null && $last_hours===null) throw new RuntimeException('A time interval needs the last completed aircraft total time.');
    if ($interval_cycles!==null && $last_cycles===null) throw new RuntimeException('A cycles interval needs the last completed cycles.');
    $due_date=$calendar_value===null?null:calendar_due($last_date,$calendar_value,$calendar_unit);
    $due_hours=$interval_hours===null?null:round($last_hours+$interval_hours,1);
    $due_cycles=$interval_cycles===null?null:$last_cycles+$interval_cycles;
    if ($due_hours!==null && $due_hours>999999999.9) throw new RuntimeException('Calculated aircraft total time exceeds supported range.');
    if ($due_cycles!==null && $due_cycles>4294967295) throw new RuntimeException('Calculated cycles exceed supported range.');
    return ['inspection_type'=>$type,'last_date'=>$last_date,'last_hours'=>$last_hours,'last_cycles'=>$last_cycles,'calendar_interval_value'=>$calendar_value,'calendar_interval_unit'=>$calendar_unit,'interval_hours'=>$interval_hours,'interval_cycles'=>$interval_cycles,'warning_calendar_months'=>$warning_months,'warning_hours'=>$warning_hours,'warning_cycles'=>$warning_cycles,'due_date'=>$due_date,'due_hours'=>$due_hours,'due_cycles'=>$due_cycles,'notes'=>$notes];
}
