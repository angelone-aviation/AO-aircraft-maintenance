<?php
require_once __DIR__.'/inspection_due.php';
require_once __DIR__.'/inspection_status.php';
function component_usage($c) {
    $tsn=(float)$c['service_hours_base'];
    $tso=$c['tso_hours_base']===null?null:(float)$c['tso_hours_base'];
    $tsr=$c['tsr_hours_base']===null?null:(float)$c['tsr_hours_base'];
    $cycles=(int)$c['service_cycles_base']; $days=(int)$c['service_days_base'];
    $error=false;
    if ($c['location_type']==='AIRCRAFT') {
        if ($c['aircraft_id']===null || !$c['installed_date']) $error=true;
        $delta_hours=0; $delta_cycles=0;
        if (!empty($c['track_time'])) {
            if ($c['installed_aircraft_total_time']===null) $error=true;
            else $delta_hours=round(aircraft_total_time($c)-(float)$c['installed_aircraft_total_time'],1);
            if ($delta_hours<0) $error=true;
        }
        if (!empty($c['track_cycles'])) {
            if ($c['installed_aircraft_cycles']===null) $error=true;
            else $delta_cycles=(int)$c['current_cycles']-(int)$c['installed_aircraft_cycles'];
            if ($delta_cycles<0) $error=true;
        }
        $installed=DateTimeImmutable::createFromFormat('!Y-m-d',$c['installed_date'] ?? ''); $today=new DateTimeImmutable('today');
        if (!$installed || $installed>$today) $error=true;
        if (!$error) {
            $tsn=round($tsn+$delta_hours,1);
            if ($tso!==null) $tso=round($tso+$delta_hours,1);
            if ($tsr!==null) $tsr=round($tsr+$delta_hours,1);
            $cycles+=$delta_cycles;
            if (!empty($c['track_calendar'])) $days+=(int)$installed->diff($today)->format('%a');
        }
    }
    return ['hours'=>$error?null:$tsn,'tsn'=>$error?null:$tsn,'tso'=>$error?null:$tso,'tsr'=>$error?null:$tsr,'cycles'=>$error?null:$cycles,'days'=>$error?null:$days,'months'=>$error?null:round($days/30.4375,1),'error'=>$error];
}
function component_hours_for_requirement($r,$usage) {
    $basis=$r['time_basis'] ?? 'TSN';
    return $usage[strtolower($basis)] ?? null;
}
function component_service_data($usage,$component) {
    $type=(string)($_POST['requirement_type'] ?? '');
    $description=trim((string)($_POST['description'] ?? ''));
    $notes=trim((string)($_POST['notes'] ?? ''));
    $last_date=!empty($component['track_calendar'])?date_or_null('last_date'):null;
    $raw=!empty($component['track_time'])?trim((string)($_POST['last_hours'] ?? '')):''; $last_hours=$raw===''?null:posted_decimal('last_hours');
    $last_cycles=!empty($component['track_cycles'])?optional_nonnegative_int('last_cycles'):null;
    $interval_hours=!empty($component['track_time'])?optional_positive_hours('interval_hours'):null;
    $interval_cycles=!empty($component['track_cycles'])?optional_positive_int('interval_cycles'):null;
    $time_mode=(string)($_POST['time_limit_mode'] ?? 'ABSOLUTE');
    $cycle_mode=(string)($_POST['cycle_limit_mode'] ?? 'ABSOLUTE');
    if (!in_array($time_mode,['ABSOLUTE','FROM_LAST_COMPLIED'],true) || !in_array($cycle_mode,['ABSOLUTE','FROM_LAST_COMPLIED'],true)) throw new RuntimeException('Choose a valid limit basis.');
    $calendar_value=!empty($component['track_calendar'])?optional_positive_int('calendar_interval_value'):null;
    $calendar_unit=$calendar_value===null?null:(string)($_POST['calendar_interval_unit'] ?? '');
    $warning_months=!empty($component['track_calendar'])?optional_nonnegative_int('warning_calendar_months'):0;
    $raw=!empty($component['track_time'])?trim((string)($_POST['warning_hours'] ?? '')):''; $warning_hours=$raw===''?(!empty($component['track_time'])?null:0):posted_decimal('warning_hours');
    $warning_cycles=!empty($component['track_cycles'])?optional_nonnegative_int('warning_cycles'):0;
    $time_basis=(string)($_POST['time_basis'] ?? 'TSN'); if (!in_array($time_basis,['TSN','TSO','TSR'],true)) throw new RuntimeException('Choose TSN, TSO or TSR.');
    $basis_hours=$usage[strtolower($time_basis)] ?? null;
    if (!in_array($type,['Life Limits','Overhaul Requirement','Inspection Requirement'],true) || $description==='' || strlen($description)>255 || strlen($notes)>10000) throw new RuntimeException('Choose a requirement and enter a description.');
    if ($interval_hours===null && $interval_cycles===null && $calendar_value===null) throw new RuntimeException('Set at least one service interval.');
    if ($calendar_value!==null && (!$last_date || !in_array($calendar_unit,['DAYS','MONTHS','YEARS'],true))) throw new RuntimeException('Calendar interval needs a last complied date and unit.');
    if ($interval_hours!==null && $time_mode==='FROM_LAST_COMPLIED' && $last_hours===null) throw new RuntimeException('Hours after last compliance need a last complied component-hours value.');
    if ($interval_cycles!==null && $cycle_mode==='FROM_LAST_COMPLIED' && $last_cycles===null) throw new RuntimeException('Cycles after last compliance need a last complied component-cycles value.');
    if ($interval_hours!==null && $basis_hours===null) throw new RuntimeException('Set a verified '.$time_basis.' baseline on the component before adding a time limit.');
    if (!$usage['error'] && $last_hours!==null && $basis_hours!==null && $last_hours>$basis_hours) throw new RuntimeException('Last complied hours exceed current component hours. Use the component-hour reading from the record, or clear the field for an absolute limit.');
    if (!$usage['error'] && $last_cycles!==null && $last_cycles>$usage['cycles']) throw new RuntimeException('Last complied cycles exceed current component cycles. Check the component baseline or clear this field for an absolute limit.');
    if ($warning_months===null || $warning_hours===null || $warning_cycles===null || $warning_months>1200 || $warning_hours>99999999.9 || $warning_cycles>1000000) throw new RuntimeException('Enter valid Due soon thresholds.');
    $due_date=$calendar_value===null?null:calendar_due($last_date,$calendar_value,$calendar_unit);
    $due_hours=$interval_hours===null?null:round(($time_mode==='ABSOLUTE'?0:$last_hours)+$interval_hours,1);
    $due_cycles=$interval_cycles===null?null:($cycle_mode==='ABSOLUTE'?0:$last_cycles)+$interval_cycles;
    if (($due_hours!==null && $due_hours>9999999999.9) || ($due_cycles!==null && $due_cycles>4294967295)) throw new RuntimeException('Calculated due value exceeds supported range.');
    return ['requirement_type'=>$type,'description'=>$description,'last_date'=>$last_date,'last_hours'=>$last_hours,'last_cycles'=>$last_cycles,'calendar_interval_value'=>$calendar_value,'calendar_interval_unit'=>$calendar_unit,'interval_hours'=>$interval_hours,'time_basis'=>$time_basis,'time_limit_mode'=>$time_mode,'interval_cycles'=>$interval_cycles,'cycle_limit_mode'=>$cycle_mode,'due_date'=>$due_date,'due_hours'=>$due_hours,'due_cycles'=>$due_cycles,'warning_calendar_months'=>$warning_months,'warning_hours'=>$warning_hours,'warning_cycles'=>$warning_cycles,'notes'=>$notes];
}
function component_service_remaining($r,$usage,$today=null) {
    $today=$today ?? date('Y-m-d');
    $days=null;
    if (!empty($r['track_calendar']) && $r['due_date']!==null) {
        $current=DateTimeImmutable::createFromFormat('!Y-m-d',$today);
        $due=DateTimeImmutable::createFromFormat('!Y-m-d',$r['due_date']);
        $days=(int)$current->diff($due)->format('%r%a');
    }
    $basis_hours=component_hours_for_requirement($r,$usage);
    $hours=($usage['error'] || empty($r['track_time']) || $r['due_hours']===null || $basis_hours===null)?null:round((float)$r['due_hours']-(float)$basis_hours,1);
    $cycles=($usage['error'] || empty($r['track_cycles']) || $r['due_cycles']===null)?null:(int)$r['due_cycles']-(int)$usage['cycles'];
    return ['hours'=>$hours,'cycles'=>$cycles,'days'=>$days];
}
function remaining_label($value,$unit,$decimals=0) {
    if ($value===null) return '—';
    $amount=number_format(abs($value),$decimals);
    if ($value<0) return 'Overdue by '.$amount.' '.$unit;
    if ($value==0) return 'Due now';
    return $amount.' '.$unit.' remaining';
}
function component_service_status($r,$usage) {
    if ($usage['error']) return 'Check readings';
    $basis_hours=component_hours_for_requirement($r,$usage);
    if (!empty($r['track_time']) && $r['due_hours']!==null && $basis_hours===null) return 'Set time baseline';
    $r['aircraft_total_time']=$basis_hours ?? 0; $r['current_cycles']=$usage['cycles'];
    if (empty($r['track_calendar'])) $r['due_date']=null;
    if (empty($r['track_time'])) $r['due_hours']=null;
    if (empty($r['track_cycles'])) $r['due_cycles']=null;
    return inspection_status($r);
}
function component_query($pdo,$id) {
    $q=$pdo->prepare('SELECT c.*,a.registration,a.current_tach,a.current_hobbs,a.current_cycles,a.total_time_source,a.total_time_adjustment FROM components c LEFT JOIN aircraft a ON a.id=c.aircraft_id WHERE c.id=?');
    $q->execute([$id]); return $q->fetch();
}
