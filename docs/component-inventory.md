# Tracked components in inventory

In **Inventory → New stock item**, choose **Category → Trackable Aircraft Component**. Enter the component type, part number, serial number, tracking dimensions and opening readings. Select an **Inventory location**, optionally add a shelf/bin/room in **Parts location**, and choose **Save component**. Images and PDFs can be selected on this form too.

Each tracked component is one serialized item with quantity one. It appears in both Inventory and Components while in storage. Both screens refer to the same component record, so readings, service requirements, documents and history remain together. Ordinary parts and supplies continue to use stock quantities and receipts/issues.

Use **Inventory → Install / service** to plan installation on an aircraft. Choose an open work order or create a new one, select the installation position, and enter the work description/reference. To plan removal, use **Components → Service**, choose the work order and destination inventory location. Open **Work orders** to complete the movement task, review component work and verified completion readings, and finish the order.

Planning a movement does not change inventory availability or reserve the component. Closing the work order applies the movement and includes it, the component part/serial numbers, source or destination aircraft, and completion readings in the saved logbook work. Cancellation leaves the component unchanged. A changed component version requires review before saving. Direct installation/removal service requests and creating new already-installed components are rejected; existing installed records remain readable.

Removal freezes accumulated operating time, cycles and accumulated service days; calendar deadlines continue in inventory. On installation, linked requirements and inspections follow the same component to the destination aircraft.

**Print Tag** automatically uses the most recent removal's saved aircraft registration, make/model, serial number, position, removal date, work-order reference and recorded remover. These aircraft details remain as recorded even if the aircraft record later changes. New components received directly into inventory have saved **Incoming component tag / 8130 details** in their form. Attach the 8130 PDF through the existing attachments control (also available on New stock item); this does not automatically extract or certify the document's contents.

Older stored components appear automatically with their existing shelf/bin description and **Unassigned location**. Open Details and select an inventory location to link them. Location names follow the saved location record, while movement records retain their location ID and shelf/bin notes.

Inventory retains its existing administrator permissions. Maintenance users can choose inventory locations when removing components using their aircraft maintenance permissions. Flight Program boundaries are enforced. Components must be moved out before a location can be transferred to another Flight Program; transferring a component clears its old location link so it can be assigned in the destination program.

You can also plan component movements directly under **Work orders → Requested work → Install/remove component**. The selector groups components on this order’s aircraft for removal and components in this Flight Program’s inventory for installation. Components installed on other aircraft are excluded. Choose the position or removal location, enter the description, add the movement, and save the order.
