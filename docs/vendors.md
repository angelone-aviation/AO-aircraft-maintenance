# Vendors

Open **Vendors** directly below **Purchase orders** in the sidebar, or use **View vendors** on the PO page. Flight Program administrators (the app's messages say "inventory administrator") can add and edit vendors within their active Flight Program.

The PO editor displays only the vendor name. Typing offers existing names; an unknown name offers **Quick add** (name only) or **Add vendor** (the full details form). Returning from the details form preserves the unfinished PO. Per-line vendor overrides use the same selector.

Vendor details include structured address and contact fields, address lookup, website, account number, payment terms, and notes. Existing names from purchase orders, parts requests, and stock remain available; editing one creates a directory record. Vendor changes do not rewrite historical purchase orders. New PO drafts copy the selected vendor's details for printed ordering documents and retain the directory reference.

Vendor records use the existing management command persistence, optimistic version checks, audit history, and Flight Program permissions. Duplicate names are rejected case-insensitively within a program. No vendor-ordering integration is enabled by this feature.
