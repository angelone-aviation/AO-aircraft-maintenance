# Maintenance parts availability

Use **Parts / repair requests** on inspections, component services, discrepancies, AD tasks, components and job cards, or **Request parts for task** on any saved work-order task. The shared form checks inventory, and the resulting request supports reservations, purchase orders, receiving and issuing.

For scheduled recurring work, check **Recurring — required each time this inspection/service/AD task is performed**. Its recurring list forecasts future parts needs; each matching open work-order task receives its own request. Fulfillment and purchasing history stay with that occurrence. A recurring list itself cannot reserve or order parts.

Existing required-parts lists are preserved and prefill the new request form. Until requests exist for an item, its saved legacy inventory-location links continue to provide availability. Once requests exist, their lines drive the display.

**View aircraft**, **Maintenance outlook**, and the maintenance source pages show shortages. Request-based availability uses exact part numbers and serviceable stock across locations, subtracts other reservations, and credits stock already reserved or issued for the request. Alternates require explicit selection. A template and its active occurrence are not counted twice. Forecasts do not reserve stock or combine all competing future demand; reserve against an occurrence to commit inventory.

Archived inspections, resolved discrepancies, completed/cancelled work, and inactive or terminated AD tasks do not create active work demand. Offline views identify quantities as cached. Reconnect to verify current stock. Flight Program and aircraft permissions still apply.

See [Parts and repair requests](parts-and-repair-requests.md) for the complete workflow.
