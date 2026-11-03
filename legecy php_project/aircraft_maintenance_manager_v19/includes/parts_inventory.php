<?php
require_once __DIR__.'/ata_chapters.php';
function parts_decimal($key, $positive=false) {
    $raw=trim((string)($_POST[$key] ?? ''));
    if (!preg_match('/^\d{1,9}(?:\.\d{1,3})?$/D',$raw)) throw new RuntimeException('Enter a valid '.$key.' with at most three decimal places.');
    $value=(float)$raw;
    if ($positive && $value<=0) throw new RuntimeException('Quantity must be greater than zero.');
    return number_format($value,3,'.','');
}
function parts_text($key,$limit,$required=false) {
    $value=trim((string)($_POST[$key] ?? ''));
    if (strlen($value)>$limit || ($required && $value==='')) throw new RuntimeException('Check '.str_replace('_',' ',$key).'.');
    return $value===''?null:$value;
}
function parts_data($pdo,$existing_location_id=null) {
    $data=[
        'part_name'=>parts_text('part_name',200,true),
        'part_number'=>parts_text('part_number',100,true),
        'alternate_part_number'=>parts_text('alternate_part_number',100),
        'manufacturer'=>parts_text('manufacturer',150),
        'ata_chapter'=>posted_ata(),
        'category'=>(string)($_POST['category'] ?? ''),
        'unit'=>parts_text('unit',30,true),
        'minimum_quantity'=>parts_decimal('minimum_quantity'),
        'location_id'=>posted_int('location_id'),
        'lot_number'=>parts_text('lot_number',100),
        'item_condition'=>(string)($_POST['item_condition'] ?? ''),
        'received_date'=>date_or_null('received_date'),
        'expiration_date'=>date_or_null('expiration_date'),
        'supplier'=>parts_text('supplier',150),
        'purchase_reference'=>parts_text('purchase_reference',150),
        'notes'=>parts_text('notes',10000),
    ];
    if (!in_array($data['category'],['PART','HARDWARE','CONSUMABLE','OTHER'],true) || !in_array($data['item_condition'],['NEW','SERVICEABLE','UNSERVICEABLE','QUARANTINE'],true)) throw new RuntimeException('Choose a valid category and condition.');
    if ($data['received_date'] && $data['expiration_date'] && $data['expiration_date']<$data['received_date']) throw new RuntimeException('Expiration must be on or after received date.');
    $q=$pdo->prepare('SELECT id,is_active FROM inventory_locations WHERE id=?'); $q->execute([$data['location_id']]); $location=$q->fetch();
    if (!$location || (!$location['is_active'] && (int)$existing_location_id!==(int)$data['location_id'])) throw new RuntimeException('Choose an active location.');
    return $data;
}
function parts_locations($pdo) { return $pdo->query('SELECT id,name FROM inventory_locations WHERE is_active=1 ORDER BY name')->fetchAll(); }
