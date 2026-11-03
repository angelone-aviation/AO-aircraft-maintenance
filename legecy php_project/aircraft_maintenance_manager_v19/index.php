<?php
require_once __DIR__ . '/includes/component_service.php';
require_once __DIR__ . '/includes/ata_chapters.php';
require_login();
$page_title = 'Dashboard';
$aircraft_count = (int)$pdo->query("SELECT COUNT(*) FROM aircraft")->fetchColumn();
$maintenance_count = (int)$pdo->query("SELECT COUNT(*) FROM maintenance_records")->fetchColumn();
$flight_count = (int)$pdo->query("SELECT COUNT(*) FROM flight_logs")->fetchColumn();
$recent_flights = $pdo->query("SELECT f.flight_date, f.tach_end, f.hobbs_end, f.total_time_end, f.landings, f.cycles, a.registration FROM flight_logs f JOIN aircraft a ON a.id=f.aircraft_id ORDER BY f.id DESC LIMIT 5")->fetchAll();
$component_count = (int)$pdo->query("SELECT COUNT(*) FROM components")->fetchColumn();
$all_inspections=$pdo->query("SELECT a.registration, i.*, a.current_cycles, ".total_time_sql('a')." AS aircraft_total_time
                              FROM inspections i JOIN aircraft a ON a.id=i.aircraft_id")->fetchAll();
$upcoming=[];
foreach ($all_inspections as $row) {
    $row['planning_status']=inspection_status($row);
    if ($row['planning_status']!=='Tracked') $upcoming[]=$row;
}
$rank=['Past due'=>0,'Due now'=>1,'Due soon'=>2];
usort($upcoming,static function($a,$b) use ($rank) { return ($rank[$a['planning_status']] <=> $rank[$b['planning_status']]) ?: strcmp($a['due_date'] ?? '9999-12-31',$b['due_date'] ?? '9999-12-31'); });
$upcoming=array_slice($upcoming,0,10);
$service_rows=$pdo->query("SELECT r.*,c.component_type,c.ata_chapter,c.part_number,c.serial_number,c.location_type,c.parts_location,c.aircraft_id,c.track_calendar,c.track_time,c.track_cycles,c.service_hours_base,c.tso_hours_base,c.tsr_hours_base,c.service_cycles_base,c.service_days_base,c.installed_date,c.installed_aircraft_total_time,c.installed_aircraft_cycles,a.registration,a.current_tach,a.current_hobbs,a.current_cycles,a.total_time_source,a.total_time_adjustment
 FROM component_service_requirements r JOIN components c ON c.id=r.component_id LEFT JOIN aircraft a ON a.id=c.aircraft_id")->fetchAll();
$component_due=[];
foreach ($service_rows as $r) {
    $r['service_status']=component_service_status($r,component_usage($r));
    if ($r['service_status']!=='Tracked') $component_due[]=$r;
}
$service_rank=['Check readings'=>0,'Set time baseline'=>1,'Past due'=>2,'Due now'=>3,'Due soon'=>4];
usort($component_due,static function($a,$b) use ($service_rank) { return $service_rank[$a['service_status']] <=> $service_rank[$b['service_status']]; });
$component_due=array_slice($component_due,0,10);
include __DIR__ . '/includes/header.php';
?>
<h1>Fleet Dashboard</h1>
<div class="grid">
  <div class="card"><h3>Aircraft</h3><div class="number"><?= $aircraft_count ?></div></div>
  <div class="card"><h3>Maintenance Records</h3><div class="number"><?= $maintenance_count ?></div></div>
  <div class="card"><h3>Components</h3><div class="number"><?= $component_count ?></div></div>
  <div class="card"><h3>Flights Logged</h3><div class="number"><?= $flight_count ?></div></div>
</div>

<h2>What's Due / Upcoming</h2>
<div class="table-wrap">
<table>
<tr><th>Aircraft</th><th>ATA Chapter</th><th>Inspection</th><th>Due Date</th><th>Due Total Time</th><th>Due Cycles</th><th>Status</th></tr>
<?php foreach ($upcoming as $row): ?>
<tr>
<td><?= htmlspecialchars($row['registration']) ?></td>
<td><?= esc(ata_label($row['ata_chapter'])) ?></td>
<td><?= htmlspecialchars($row['inspection_type']) ?></td>
<td><?= htmlspecialchars($row['due_date'] ?? '-') ?></td>
<td><?= htmlspecialchars($row['due_hours'] ?? '-') ?></td>
<td><?= htmlspecialchars($row['due_cycles'] ?? '-') ?></td>
<td class="<?= $row['planning_status']==='Past due'?'red':'yellow' ?>"><?= esc(strtoupper($row['planning_status'])) ?></td>
</tr>
<?php endforeach; ?>
<?php if (!$upcoming): ?><tr><td colspan="7">No upcoming items found.</td></tr><?php endif; ?>
</table>
</div>
<h2>Component Service Due</h2><div class="table-wrap"><table><tr><th>Component</th><th>ATA Chapter</th><th>Requirement</th><th>Location</th><th>Due date</th><th>Component hours</th><th>Cycles</th><th>Months in service</th><th>Hours remaining</th><th>Cycles remaining</th><th>Calendar remaining</th><th>Due component hours</th><th>Due cycles</th><th>Status</th></tr>
<?php foreach ($component_due as $r): ?><tr><td><a href="<?= esc(url('components/view.php?id='.(int)$r['component_id'])) ?>"><?= esc($r['component_type']) ?> <?= esc($r['serial_number']) ?></a></td><td><?= esc(ata_label($r['ata_chapter'])) ?></td><td><?= esc($r['description']) ?></td><td><?= $r['location_type']==='AIRCRAFT'?esc($r['registration'] ?? 'Check aircraft'):esc('Inventory: '.$r['parts_location']) ?></td><td><?= esc($r['due_date'] ?? '—') ?></td><?php $usage=component_usage($r); $remaining=component_service_remaining($r,$usage); ?><td><?= !$r['track_time']?'—':($usage['error']?'Check readings':(component_hours_for_requirement($r,$usage)===null?'Set baseline':esc(number_format(component_hours_for_requirement($r,$usage),1)))) ?></td><td><?= !$r['track_cycles']?'—':($usage['error']?'—':(int)$usage['cycles']) ?></td><td><?= !$r['track_calendar']?'—':($usage['error']?'—':esc(number_format($usage['months'],1))) ?></td><td><?= esc(remaining_label($remaining['hours'],'hr',1)) ?></td><td><?= esc(remaining_label($remaining['cycles'],'cycles')) ?></td><td><?= esc(remaining_label($remaining['days'],'days')) ?></td><td><?= esc($r['due_hours'] ?? '—') ?></td><td><?= esc($r['due_cycles'] ?? '—') ?></td><td class="<?= in_array($r['service_status'],['Past due','Check readings','Set time baseline'],true)?'red':'yellow' ?>"><?= esc($r['service_status']) ?></td></tr><?php endforeach; ?>
<?php if (!$component_due): ?><tr><td colspan="14">No component service items are flagged.</td></tr><?php endif; ?></table></div>
<h2>Recent Flights</h2><div class="table-wrap"><table><tr><th>Date</th><th>Aircraft</th><th>Ending tach</th><th>Ending Hobbs</th><th>Ending Total Time</th><th>Landings</th><th>Cycles</th></tr><?php foreach ($recent_flights as $f): ?><tr><td><?= esc($f['flight_date']) ?></td><td><?= esc($f['registration']) ?></td><td><?= esc($f['tach_end']) ?></td><td><?= esc($f['hobbs_end']) ?></td><td><?= esc($f['total_time_end']) ?></td><td><?= (int)$f['landings'] ?></td><td><?= (int)$f['cycles'] ?></td></tr><?php endforeach; ?><?php if (!$recent_flights): ?><tr><td colspan="7">No flights logged yet.</td></tr><?php endif; ?></table></div>
<?php include __DIR__ . '/includes/footer.php'; ?>
