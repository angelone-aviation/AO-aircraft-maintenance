<?php
require_once __DIR__.'/total_time.php';
function months_before_due($date,$months) {
    $d=DateTimeImmutable::createFromFormat('!Y-m-d',$date);
    if (!$d) throw new RuntimeException('Invalid due date.');
    $index=(int)$d->format('Y')*12+(int)$d->format('n')-1-$months;
    if ($index<12) return '0001-01-01';
    $year=intdiv($index,12); $month=$index%12+1;
    $first=DateTimeImmutable::createFromFormat('!Y-n-j',$year.'-'.$month.'-1');
    return $first->setDate($year,$month,min((int)$d->format('j'),(int)$first->format('t')))->format('Y-m-d');
}
function inspection_status($row,$today=null) {
    $today=$today ?? date('Y-m-d');
    $date=$row['due_date'] ?? null;
    $hours=$row['due_hours']===null?null:round((float)$row['due_hours']-(float)$row['aircraft_total_time'],1);
    $cycles=$row['due_cycles']===null?null:(int)$row['due_cycles']-(int)$row['current_cycles'];
    if (($date!==null && $today>$date) || ($hours!==null && $hours<0) || ($cycles!==null && $cycles<0)) return 'Past due';
    if (($date!==null && $today===$date) || ($hours!==null && $hours==0) || ($cycles!==null && $cycles===0)) return 'Due now';
    $calendar_soon=$date!==null && $today>=months_before_due($date,(int)$row['warning_calendar_months']);
    $hours_soon=$hours!==null && $hours<=(float)$row['warning_hours'];
    $cycles_soon=$cycles!==null && $cycles<=(int)$row['warning_cycles'];
    return $calendar_soon || $hours_soon || $cycles_soon ? 'Due soon' : 'Tracked';
}
