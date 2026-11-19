# Saved shipping and return addresses

Saved addresses belong to a Flight Program. Signed-in members of that program can view them and pick them on requests and orders; only Flight Program administrators (and system administrators) can add or edit them. Users outside the program cannot access them. Open **Saved addresses** in the sidebar to search or edit the directory.

Parts requests, repair requests and purchase orders use compact address selectors. When an inventory location is selected, choose whether to use its address. Otherwise choose a saved address. Flight Program administrators also get **Add new address**, here and on the Saved addresses page; other members do not, since the server refuses their saves ("Flight Program administrator required."). New addresses open in a separate window; saving adds the address to the program directory and selects it on the original form without submitting that form.

Each address has a descriptive address name and a recipient/contact name, together with shipping and contact details. Incomplete inventory addresses open in the same window for completion. Saving confirms the entered address details. External address lookup remains available in the address window where configured.

Requests and purchase orders retain a copy of the selected address. Editing the directory later does not rewrite existing documents. Each save writes an `address.saved` change-log entry with the address before and after, which Flight Program administrators read in Change history. Full addresses remain available in the address window and printed documents, without cluttering the request or order forms.
