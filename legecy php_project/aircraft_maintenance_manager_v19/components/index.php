<?php
require_once __DIR__.'/../includes/component_service.php';
require_once __DIR__.'/../includes/ata_chapters.php'; require_login();
$error='';
if ($_SERVER['REQUEST_METHOD']==='POST') {
    permit(['ADMIN','MANAGER','MECHANIC']); verify_csrf();
    try {
        $type=trim((string)($_POST['component_type'] ?? '')); $ata=posted_ata(); $location=(string)($_POST['location_type'] ?? '');
        $part=trim((string)($_POST['part_number'] ?? '')); $serial=trim((string)($_POST['serial_number'] ?? ''));
        $manufacturer=trim((string)($_POST['manufacturer'] ?? '')); $notes=trim((string)($_POST['notes'] ?? ''));
        $track_calendar=isset($_POST['track_calendar'])?1:0; $track_time=isset($_POST['track_time'])?1:0; $track_cycles=isset($_POST['track_cycles'])?1:0;
        if (!$track_calendar && !$track_time && !$track_cycles) throw new RuntimeException('Select at least one tracking dimension.');
        $hours=$track_time?posted_decimal('service_hours_base'):0;
        $raw_tso=$track_time?trim((string)($_POST['tso_hours_base'] ?? '')):''; $tso=$raw_tso===''?null:posted_decimal('tso_hours_base');
        $raw_tsr=$track_time?trim((string)($_POST['tsr_hours_base'] ?? '')):''; $tsr=$raw_tsr===''?null:posted_decimal('tsr_hours_base');
        $cycles=$track_cycles?posted_int('service_cycles_base'):0; $prior_days=$track_calendar?posted_int('service_days_base'):0;
        if ($type==='' || strlen($type)>100 || strlen($part)>100 || strlen($serial)>100 || strlen($manufacturer)>150 || strlen($notes)>10000 || $cycles>2147483647 || $prior_days>365000 || !in_array($location,['AIRCRAFT','INVENTORY'],true)) throw new RuntimeException('Check the component details and location.');
        $aircraft_id=null; $parts_location=null; $position=null; $install_date=null; $installed_tt=null; $installed_cycles=null;
        if ($location==='AIRCRAFT') {
            $aircraft_id=posted_int('aircraft_id'); $position=(string)($_POST['install_position'] ?? ''); $install_date=date_or_null('installed_date');
            if (!$install_date || $install_date>date('Y-m-d') || !in_array($position,['LEFT','RIGHT','NUMBER 1','NUMBER 2','MAIN','AUX'],true)) throw new RuntimeException('Choose an installation date and position.');
        } else {
            $parts_location=trim((string)($_POST['parts_location'] ?? ''));
            if ($parts_location==='' || strlen($parts_location)>150) throw new RuntimeException('Enter a parts location for inventory.');
        }
        $pdo->beginTransaction();
        if ($aircraft_id!==null) {
            $a=$pdo->prepare('SELECT * FROM aircraft WHERE id=? FOR UPDATE'); $a->execute([$aircraft_id]); $aircraft=$a->fetch();
            if (!$aircraft) throw new RuntimeException('Select a valid aircraft.');
            $current_tt=aircraft_total_time($aircraft); $current_cycles=(int)$aircraft['current_cycles'];
            $raw_tt=trim((string)($_POST['installed_aircraft_total_time'] ?? ''));
            $raw_cycles=trim((string)($_POST['installed_aircraft_cycles'] ?? ''));
            $installed_tt=$track_time?($raw_tt===''?$current_tt:posted_decimal('installed_aircraft_total_time')):null;
            $installed_cycles=$track_cycles?($raw_cycles===''?$current_cycles:posted_int('installed_aircraft_cycles')):null;
            if (($installed_tt!==null && $installed_tt>$current_tt) || ($installed_cycles!==null && $installed_cycles>$current_cycles)) throw new RuntimeException('Aircraft readings at install cannot exceed current readings.');
        }
        $data=['aircraft_id'=>$aircraft_id,'location_type'=>$location,'track_calendar'=>$track_calendar,'track_time'=>$track_time,'track_cycles'=>$track_cycles,'parts_location'=>$parts_location,'install_position'=>$position,'component_type'=>$type,'ata_chapter'=>$ata,'part_number'=>$part,'serial_number'=>$serial,'manufacturer'=>$manufacturer,'installed_date'=>$install_date,'service_hours_base'=>$hours,'tso_hours_base'=>$tso,'tsr_hours_base'=>$tsr,'service_cycles_base'=>$cycles,'service_days_base'=>$prior_days,'installed_aircraft_total_time'=>$installed_tt,'installed_aircraft_cycles'=>$installed_cycles,'notes'=>$notes];
        $fields=array_keys($data); $q=$pdo->prepare('INSERT INTO components ('.implode(',',$fields).') VALUES ('.implode(',',array_fill(0,count($fields),'?')).')'); $q->execute(array_values($data));
        $id=(int)$pdo->lastInsertId(); audit($pdo,'CREATE','components',$id,null,$data);
        if ($location==='AIRCRAFT') {
            $q=$pdo->prepare("INSERT INTO component_movements (component_id,action,aircraft_id,install_position,movement_date,component_hours,component_cycles,service_days,note,performed_by) VALUES (?,'INSTALL',?,?,?,?,?,?,?,?)");
            $q->execute([$id,$aircraft_id,$position,$install_date,$hours,$cycles,$prior_days,'Initial component entry',user()['id']]);
        }
        $pdo->commit(); header('Location: view.php?id='.$id); exit;
    } catch (Throwable $e) { if ($pdo->inTransaction()) $pdo->rollBack(); $error=$e instanceof RuntimeException?$e->getMessage():'Could not save component. Check the V10 database upgrade.'; }
}
$aircraft=$pdo->query('SELECT * FROM aircraft ORDER BY registration')->fetchAll();
$components=$pdo->query('SELECT c.*,a.registration,a.current_tach,a.current_hobbs,a.current_cycles,a.total_time_source,a.total_time_adjustment FROM components c LEFT JOIN aircraft a ON a.id=c.aircraft_id ORDER BY c.id DESC')->fetchAll();
$hour_requirements=$pdo->query('SELECT component_id,due_hours,time_basis FROM component_service_requirements WHERE due_hours IS NOT NULL')->fetchAll();
$due_hours_by_component=[]; foreach ($hour_requirements as $requirement) $due_hours_by_component[$requirement['component_id']][]=$requirement;
$page_title='Components'; include __DIR__.'/../includes/header.php'; ?>
<h1>Components &amp; Inventory</h1><?php if ($error): ?><div class="error"><?= esc($error) ?></div><?php endif; ?>
<?php if (in_array(user()['role'],['ADMIN','MANAGER','MECHANIC'])): ?><div class="card"><h2>Add component</h2><form method="post"><?= csrf_field() ?><div class="form-grid">
<div class="field"><label>Component type</label><input name="component_type" maxlength="100" required></div>
<div class="field"><label>ATA Chapter</label><?= ata_select() ?></div>
<div class="field"><label>Part number</label><input name="part_number" maxlength="100"></div><div class="field"><label>Serial number</label><input name="serial_number" maxlength="100"></div><div class="field"><label>Manufacturer</label><input name="manufacturer" maxlength="150"></div>
<div class="field full"><label>Track this component by (select at least one)</label><label class="check-option"><input type="checkbox" name="track_calendar" checked> Calendar</label><label class="check-option"><input type="checkbox" name="track_time" checked> Time</label><label class="check-option"><input type="checkbox" name="track_cycles" checked> Cycles</label></div>
<div class="field"><label>Location</label><select name="location_type" id="component-location"><option value="AIRCRAFT">Installed on aircraft</option><option value="INVENTORY">In inventory</option></select></div>
<div class="field aircraft-fields"><label>Aircraft</label><select name="aircraft_id" id="component-aircraft"><?php foreach ($aircraft as $a): ?><option value="<?= (int)$a['id'] ?>" data-tt="<?= esc(number_format(aircraft_total_time($a),1,'.','')) ?>" data-cycles="<?= (int)$a['current_cycles'] ?>"><?= esc($a['registration']) ?></option><?php endforeach; ?></select></div>
<div class="field aircraft-fields"><label>Date installed</label><input type="date" name="installed_date" value="<?= esc(date('Y-m-d')) ?>"></div>
<div class="field aircraft-fields time-fields"><label>Aircraft total time at install</label><input type="number" name="installed_aircraft_total_time" min="0" step="0.1" placeholder="Blank = current total time"><small>For a historical installation, enter the verified reading at installation.</small></div>
<div class="field aircraft-fields cycle-fields"><label>Aircraft cycles at install</label><input type="number" name="installed_aircraft_cycles" min="0" step="1" placeholder="Blank = current cycles"></div>
<div class="field aircraft-fields"><label>Position installed</label><select name="install_position"><?php foreach (['LEFT','RIGHT','NUMBER 1','NUMBER 2','MAIN','AUX'] as $position): ?><option value="<?= esc($position) ?>"><?= esc(ucwords(strtolower($position))) ?></option><?php endforeach; ?></select></div>
<div class="field inventory-fields" hidden><label>Parts location</label><input name="parts_location" maxlength="150" placeholder="Shelf / bin / room"></div>
<div class="field time-fields"><label>Time Since New (TSN) at install</label><input type="number" step="0.1" min="0" name="service_hours_base" value="0"></div>
<div class="field time-fields"><label>Time Since Overhaul (TSO) at install</label><input type="number" step="0.1" min="0" name="tso_hours_base" placeholder="Unknown / not applicable"></div>
<div class="field time-fields"><label>Time Since Repair (TSR) at install</label><input type="number" step="0.1" min="0" name="tsr_hours_base" placeholder="Unknown / not applicable"></div>
<div class="field cycle-fields"><label>Component cycles at install</label><input type="number" step="1" min="0" name="service_cycles_base" value="0"></div>
<div class="field calendar-fields"><label>Prior days in service</label><input type="number" name="service_days_base" min="0" max="365000" step="1" value="0"><small>Service time before this installation, if verified.</small></div>
<div class="field full"><label>Notes</label><textarea name="notes" maxlength="10000"></textarea></div></div><button class="btn">Save component</button></form></div><?php endif; ?>
<h2>Component list</h2><div class="table-wrap"><table><tr><th>Component</th><th>ATA Chapter</th><th>Part / Serial</th><th>Location</th><th>Tracking</th><th>Position / Shelf</th><th>TSN</th><th>TSO</th><th>TSR</th><th>Cycles</th><th>Months in service</th><th>Nearest hours remaining</th><th>Action</th></tr><?php foreach ($components as $c): $usage=component_usage($c);
 $hours_left=null;
 if (!$usage['error'] && isset($due_hours_by_component[$c['id']])) foreach ($due_hours_by_component[$c['id']] as $requirement) { $basis=component_hours_for_requirement($requirement,$usage); if ($basis===null) continue; $value=round((float)$requirement['due_hours']-$basis,1); if ($hours_left===null || $value<$hours_left) $hours_left=$value; }
 ?><tr><td><?= esc($c['component_type']) ?></td><td><?= esc(ata_label($c['ata_chapter'])) ?></td><td><?= esc($c['part_number']) ?><br><?= esc($c['serial_number']) ?></td><td><?= $c['location_type']==='AIRCRAFT'?esc($c['registration'] ?? 'Check aircraft'):'Inventory' ?></td><td><?= $c['track_calendar']?'Calendar ':'' ?><?= $c['track_time']?'Time ':'' ?><?= $c['track_cycles']?'Cycles':'' ?></td><td><?= esc($c['location_type']==='AIRCRAFT'?$c['install_position']:$c['parts_location']) ?></td><td><?= !$c['track_time']?'—':($usage['error']?'Check readings':esc(number_format($usage['tsn'],1))) ?></td><td><?= !$c['track_time'] || $usage['tso']===null?'—':esc(number_format($usage['tso'],1)) ?></td><td><?= !$c['track_time'] || $usage['tsr']===null?'—':esc(number_format($usage['tsr'],1)) ?></td><td><?= !$c['track_cycles']?'—':($usage['error']?'—':(int)$usage['cycles']) ?></td><td><?= !$c['track_calendar']?'—':($usage['error']?'—':esc(number_format($usage['months'],1))) ?></td><td><?= !$c['track_time']?'—':($usage['error']?'Check readings':esc(remaining_label($hours_left,'hr',1))) ?></td><td><a href="view.php?id=<?= (int)$c['id'] ?>">Open</a></td></tr><?php endforeach; ?><?php if (!$components): ?><tr><td colspan="13">No components yet.</td></tr><?php endif; ?></table></div>
<script>const loc=document.getElementById('component-location');if(loc){const refresh=()=>{const inventory=loc.value==='INVENTORY';for(const el of document.querySelectorAll('.aircraft-fields'))el.hidden=inventory;for(const el of document.querySelectorAll('.inventory-fields'))el.hidden=!inventory;for(const [cls,name] of [['time-fields','track_time'],['cycle-fields','track_cycles'],['calendar-fields','track_calendar']])for(const el of document.querySelectorAll('.'+cls))el.hidden=!document.querySelector('[name="'+name+'"]').checked||((cls==='time-fields'||cls==='cycle-fields')&&el.classList.contains('aircraft-fields')&&inventory)};loc.addEventListener('change',refresh);for(const box of document.querySelectorAll('input[type="checkbox"]'))box.addEventListener('change',refresh);refresh()}</script>
<?php include __DIR__.'/../includes/footer.php'; ?>
