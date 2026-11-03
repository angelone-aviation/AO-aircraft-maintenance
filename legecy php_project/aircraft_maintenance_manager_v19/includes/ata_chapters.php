<?php
require_once __DIR__.'/auth.php';
function ata_groups() {
 return [
  'Aircraft General (00–18)'=>[
   '00'=>'General','01'=>'Maintenance Policy','02'=>'Operations','03'=>'Support','04'=>'Airworthiness Limitations',
   '05'=>'Time Limits / Maintenance Checks','06'=>'Dimensions and Areas','07'=>'Lifting and Shoring',
   '08'=>'Leveling and Weighing','09'=>'Towing and Taxiing','10'=>'Parking, Mooring, Storage and Return to Service',
   '11'=>'Placards and Markings','12'=>'Servicing','13'=>'Hardware and General Tools','14'=>'Reserved',
   '15'=>'Aircrew Information','16'=>'Change of Role','18'=>'Vibration and Noise Analysis (Helicopter Only)'],
  'Aircraft Systems (20–49)'=>[
   '20'=>'Standard Practices – Airframe','21'=>'Air Conditioning','22'=>'Auto Flight','23'=>'Communications',
   '24'=>'Electrical Power','25'=>'Equipment / Furnishings','26'=>'Fire Protection','27'=>'Flight Controls',
   '28'=>'Fuel','29'=>'Hydraulic Power','30'=>'Ice and Rain Protection','31'=>'Indicating / Recording Systems',
   '32'=>'Landing Gear','33'=>'Lights','34'=>'Navigation','35'=>'Oxygen','36'=>'Pneumatic','37'=>'Vacuum',
   '38'=>'Water / Waste','39'=>'Electrical / Electronic Panels','40'=>'Multisystem or Reserved','41'=>'Water Ballast',
   '42'=>'Integrated Avionics','44'=>'Cabin Systems','45'=>'Central Maintenance System (OMS)',
   '46'=>'Information Systems','47'=>'Inert Gas System','48'=>'Fuel Dispensing System','49'=>'Auxiliary Power Unit (APU)'],
  'Structures (50–57)'=>[
   '50'=>'Cargo and Baggage Compartments','51'=>'Standard Practices and Structures – General','52'=>'Doors',
   '53'=>'Fuselage','54'=>'Nacelles / Pylons','55'=>'Stabilizers','56'=>'Windows','57'=>'Wings'],
  'Propeller / Rotor (60–67)'=>[
   '60'=>'Standard Practices – Propeller / Rotor','61'=>'Propellers','62'=>'Main Rotors','63'=>'Main Rotor Drives',
   '64'=>'Tail Rotor','65'=>'Tail Rotor Drive','66'=>'Folding Blades and Pylons','67'=>'Rotory Flight Controls'],
  'Power Plant (70–84)'=>[
   '70'=>'Standard Practices – Engine','71'=>'Power Plant – General','72'=>'Engine – Turbine / Reciprocating',
   '73'=>'Engine Fuel and Control','74'=>'Ignition','75'=>'Bleed Air','76'=>'Engine Controls','77'=>'Engine Indicating',
   '78'=>'Exhaust','79'=>'Oil','80'=>'Starting','81'=>'Turbines (Reciprocating Engines)','82'=>'Water Injection',
   '83'=>'Accessory Gearboxes','84'=>'Propulsion Augmentation']
 ];
}
function ata_label($code) {
 if ($code===null || $code==='') return 'Unassigned';
 foreach (ata_groups() as $chapters) if (isset($chapters[$code])) return 'ATA '.$code.' — '.$chapters[$code];
 return 'ATA '.$code;
}
function posted_ata() {
 $code=(string)($_POST['ata_chapter'] ?? '');
 foreach (ata_groups() as $chapters) if (array_key_exists($code,$chapters)) return $code;
 throw new RuntimeException('Select an ATA chapter from the list.');
}
function ata_select($selected=null) {
 $html='<select name="ata_chapter" required><option value="">Select ATA chapter</option>';
 foreach (ata_groups() as $group=>$chapters) {
  $html.='<optgroup label="'.esc($group).'">';
  foreach ($chapters as $code=>$label) $html.='<option value="'.esc($code).'"'.((string)$selected===(string)$code?' selected':'').'>ATA '.esc($code).': '.esc($label).'</option>';
  $html.='</optgroup>';
 }
 return $html.'</select>';
}
