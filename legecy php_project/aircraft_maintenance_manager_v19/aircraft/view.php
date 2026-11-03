<?php
require_once __DIR__ . '/../includes/component_service.php';
require_once __DIR__ . '/../includes/ata_chapters.php';
require_login();
$id = (int)($_GET['id'] ?? 0);
$stmt = $pdo->prepare("SELECT * FROM aircraft WHERE id=?"); $stmt->execute([$id]); $a=$stmt->fetch();
if (!$a) exit('Aircraft not found.');
$ins=$pdo->prepare('SELECT i.*, a.current_cycles, '.total_time_sql('a').' AS aircraft_total_time FROM inspections i JOIN aircraft a ON a.id=i.aircraft_id WHERE i.aircraft_id=? ORDER BY i.due_date,i.due_hours,i.due_cycles,i.id');
$ins->execute([$id]); $inspections=$ins->fetchAll();
$cs=$pdo->prepare("SELECT c.*,a.current_tach,a.current_hobbs,a.current_cycles,a.total_time_source,a.total_time_adjustment FROM components c JOIN aircraft a ON a.id=c.aircraft_id WHERE c.aircraft_id=? AND c.location_type='AIRCRAFT' ORDER BY c.component_type,c.id");
$cs->execute([$id]); $components=$cs->fetchAll();
$requirements=[];
if ($components) {
    $ids=array_column($components,'id');
    $qs=$pdo->prepare('SELECT * FROM component_service_requirements WHERE component_id IN ('.implode(',',array_fill(0,count($ids),'?')).') ORDER BY id');
    $qs->execute($ids);
    foreach ($qs->fetchAll() as $requirement) $requirements[$requirement['component_id']][]=$requirement;
}
$flagged=[];
$inspection_statuses=[];
$service_statuses=[];
foreach ($inspections as $inspection) {
    $status=inspection_status($inspection);
    $inspection_statuses[$inspection['id']]=$status;
    if (in_array($status,['Past due','Due now','Due soon'],true)) {
        $flagged[]=['kind'=>'Inspection','name'=>$inspection['inspection_type'],'ata'=>$inspection['ata_chapter'],'status'=>$status,'due_date'=>$inspection['due_date'],'due_hours'=>$inspection['due_hours'],'time_basis'=>'aircraft total time','due_cycles'=>$inspection['due_cycles'],'url'=>in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'],true)?url('inspections/edit.php?id='.(int)$inspection['id']):null];
    }
}
foreach ($components as $component) {
    $usage=component_usage($component);
    foreach ($requirements[$component['id']] ?? [] as $requirement) {
        $status=component_service_status(array_merge($component,$requirement),$usage);
        $service_statuses[$requirement['id']]=$status;
        if (in_array($status,['Past due','Due now','Due soon'],true)) {
            $flagged[]=['kind'=>'Component','name'=>$component['component_type'].' — '.$requirement['description'],'ata'=>$component['ata_chapter'],'status'=>$status,'due_date'=>$requirement['due_date'],'due_hours'=>$requirement['due_hours'],'time_basis'=>$requirement['time_basis'],'due_cycles'=>$requirement['due_cycles'],'url'=>url('components/view.php?id='.(int)$component['id'])];
        }
    }
}
$flag_rank=['Past due'=>0,'Due now'=>1,'Due soon'=>2];
usort($flagged,static function($left,$right) use ($flag_rank) {
    return ($flag_rank[$left['status']] <=> $flag_rank[$right['status']])
        ?: strcmp($left['due_date'] ?? '9999-12-31',$right['due_date'] ?? '9999-12-31')
        ?: strcmp($left['name'],$right['name']);
});
$ms=$pdo->prepare("SELECT * FROM maintenance_records WHERE aircraft_id=? ORDER BY maintenance_date DESC LIMIT 20"); $ms->execute([$id]); $maintenance=$ms->fetchAll();
$fs=$pdo->prepare('SELECT flight_date,origin,destination,pilot_name,tach_end,hobbs_end,total_time_end,landings,cycles FROM flight_logs WHERE aircraft_id=? ORDER BY id DESC LIMIT 10'); $fs->execute([$id]); $flights=$fs->fetchAll();
$page_title = $a['registration'];
include __DIR__ . '/../includes/header.php';
?>
<h1><?= htmlspecialchars($a['registration']) ?> — <?= htmlspecialchars($a['make'].' '.$a['model']) ?></h1>
<div class="grid">
<div class="card"><h3>Status</h3><div class="number"><?= htmlspecialchars($a['status']) ?></div></div>
<div class="card"><h3>Tach</h3><div class="number"><?= htmlspecialchars($a['current_tach']) ?></div></div>
<div class="card"><h3>Hobbs</h3><div class="number"><?= htmlspecialchars($a['current_hobbs']) ?></div></div>
<div class="card"><h3>Aircraft Total Time</h3><div class="number"><?= esc(number_format(aircraft_total_time($a),1)) ?></div><small><?= esc($a['total_time_source']) ?> <?= esc($a[$a['total_time_source']==='HOBBS'?'current_hobbs':'current_tach']) ?> + adjustment <?= esc($a['total_time_adjustment']) ?></small></div>
<div class="card"><h3>Landings</h3><div class="number"><?= htmlspecialchars($a['current_landings']) ?></div></div>
<div class="card"><h3>Cycles</h3><div class="number"><?= (int)$a['current_cycles'] ?></div></div>
</div>
<div class="actions"><?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])): ?><a class="btn" href="edit.php?id=<?= (int)$a['id'] ?>">Edit aircraft</a> <a class="btn secondary" href="instrument.php?id=<?= (int)$a['id'] ?>">Replace instrument</a><?php endif; ?></div><h2>Aircraft Information</h2>
<div class="card">
<p><b>Serial:</b> <?= htmlspecialchars($a['serial_number']) ?></p>
<p><b>Added:</b> <?= htmlspecialchars($a['created_at']) ?></p>
</div>
<h2>Flagged Inspections &amp; Components</h2>
<div class="table-wrap"><table>
<tr><th>Type</th><th>ATA Chapter</th><th>Item</th><th>Due date</th><th>Due time</th><th>Due cycles</th><th>Status</th></tr>
<?php foreach ($flagged as $item): ?>
<tr><td><?= esc($item['kind']) ?></td><td><?= esc(ata_label($item['ata'])) ?></td><td><?php if ($item['url']): ?><a href="<?= esc($item['url']) ?>"><?= esc($item['name']) ?></a><?php else: ?><?= esc($item['name']) ?><?php endif; ?></td><td><?= esc($item['due_date'] ?? '—') ?></td><td><?= $item['due_hours']===null?'—':esc($item['due_hours'].' '.$item['time_basis']) ?></td><td><?= esc($item['due_cycles'] ?? '—') ?></td><td class="<?= $item['status']==='Past due'?'red':'yellow' ?>"><?= esc($item['status']) ?></td></tr>
<?php endforeach; ?>
<?php if (!$flagged): ?><tr><td colspan="7">No inspections or component service requirements are due soon or past due.</td></tr><?php endif; ?>
</table></div>
<h2>Inspections</h2>
<div class="table-wrap"><table>
<tr><th>ATA Chapter</th><th>Inspection</th><th>Due date</th><th>Due total time</th><th>Due cycles</th><th>Status</th><th>Action</th></tr>
<?php foreach ($inspections as $inspection): $status=$inspection_statuses[$inspection['id']]; ?>
<tr><td><?= esc(ata_label($inspection['ata_chapter'])) ?></td><td><?= esc($inspection['inspection_type']) ?></td><td><?= esc($inspection['due_date'] ?? '—') ?></td><td><?= esc($inspection['due_hours'] ?? '—') ?></td><td><?= esc($inspection['due_cycles'] ?? '—') ?></td><td class="<?= $status==='Past due'?'red':($status==='Tracked'?'green':'yellow') ?>"><?= esc($status) ?></td><td><?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])): ?><a href="<?= esc(url('inspections/edit.php?id='.(int)$inspection['id'])) ?>">Open</a><?php else: ?>—<?php endif; ?></td></tr>
<?php endforeach; ?>
<?php if (!$inspections): ?><tr><td colspan="7">No inspections assigned to this aircraft.</td></tr><?php endif; ?>
</table></div>
<h2>Installed Components</h2>
<div class="table-wrap"><table>
<tr><th>ATA Chapter</th><th>Component</th><th>Part / Serial</th><th>Position</th><th>Installed</th><th>Service requirements</th><th>Action</th></tr>
<?php foreach ($components as $component): ?>
<tr><td><?= esc(ata_label($component['ata_chapter'])) ?></td><td><?= esc($component['component_type']) ?></td><td><?= esc($component['part_number']) ?><br><?= esc($component['serial_number']) ?></td><td><?= esc($component['install_position'] ?? '—') ?></td><td><?= esc($component['installed_date'] ?? '—') ?></td><td>
<?php if (empty($requirements[$component['id']])): ?>No service requirements
<?php else: foreach ($requirements[$component['id']] as $requirement): $status=$service_statuses[$requirement['id']]; ?>
<div><?= esc($requirement['description']) ?>: <span class="<?= in_array($status,['Past due','Check readings','Set time baseline'],true)?'red':($status==='Tracked'?'green':'yellow') ?>"><?= esc($status) ?></span></div>
<?php endforeach; endif; ?>
</td><td><a href="<?= esc(url('components/view.php?id='.(int)$component['id'])) ?>">Open</a></td></tr>
<?php endforeach; ?>
<?php if (!$components): ?><tr><td colspan="7">No components installed on this aircraft.</td></tr><?php endif; ?>
</table></div>
<h2>Recent Maintenance</h2>
<div class="table-wrap"><table>
<tr><th>Date</th><th>Work Order</th><th>Type</th><th>Description</th><th>Tach</th></tr>
<?php foreach($maintenance as $m): ?>
<tr><td><?= htmlspecialchars($m['maintenance_date']) ?></td><td><?= htmlspecialchars($m['work_order']) ?></td><td><?= htmlspecialchars($m['maintenance_type']) ?></td><td><?= htmlspecialchars($m['description']) ?></td><td><?= htmlspecialchars($m['tach']) ?></td></tr>
<?php endforeach; ?>
<?php if(!$maintenance): ?><tr><td colspan="5">No maintenance records yet.</td></tr><?php endif; ?>
</table></div>
<h2>Recent Flights</h2><div class="actions"><a class="btn" href="<?= esc(url('flights/?aircraft_id='.$id)) ?>">View flight history</a></div><div class="table-wrap"><table><tr><th>Date</th><th>Route</th><th>Pilot</th><th>Ending tach</th><th>Ending Hobbs</th><th>Ending total time</th><th>Landings</th><th>Cycles</th></tr><?php foreach ($flights as $f): ?><tr><td><?= esc($f['flight_date']) ?></td><td><?= esc($f['origin']) ?> → <?= esc($f['destination']) ?></td><td><?= esc($f['pilot_name']) ?></td><td><?= esc($f['tach_end']) ?></td><td><?= esc($f['hobbs_end']) ?></td><td><?= esc($f['total_time_end']) ?></td><td><?= (int)$f['landings'] ?></td><td><?= (int)$f['cycles'] ?></td></tr><?php endforeach; ?><?php if (!$flights): ?><tr><td colspan="8">No flights logged yet.</td></tr><?php endif; ?></table></div>
<?php include __DIR__ . '/../includes/footer.php'; ?>
