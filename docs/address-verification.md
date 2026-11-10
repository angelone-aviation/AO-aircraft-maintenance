# Addresses and external lookup

Inventory locations, Flight Programs, purchase orders, and parts/repair requests use the same fields: company, street, apartment/suite, city, state/province, ZIP/postal code, country, contact name, email, and phone. The formatted address, including contact information, flows into PO and shipping PDFs. Existing free-text addresses remain available for manual separation; no attempt is made to guess their city or postal code.

Selecting an inventory location autofills the PO shipping address and its separate contact fields. A manually edited shipping address is preserved. Changes clear the user's confirmation; newly structured PO shipping addresses must pass format/completeness checks and be confirmed before the PO is issued. Existing legacy POs remain readable and usable.

## Enable worldwide lookup

1. Create a free account at <https://myprojects.geoapify.com/> and create a project/API key.
2. In Angel One, open **Settings → System → Address verification** (system administrators only).
3. Select **Update…** (its status pill says **On**, **Not set up** or **Unknown**), enter the key in the password field and select **Validate and save API key**. Only global administrators can configure it. The backend checks the key against a public sample address before replacing the previous key. Keys are never included in workspace snapshots, returned to the browser, or written to audit entries.
4. In any address section, enter the street and country and select **Look up address**. Review the returned candidates, select **Use suggested address** where a building/address match is available, review suite and contact details, then **Check & confirm address**.

Only street, city, state/province, postal code and country are sent to Geoapify. Organization, recipient, suite, email and phone are not sent. Suggestions never silently replace the entered address. Street-only and city-only results are displayed as partial matches and cannot be applied as a full suggested address. A failure or no match leaves the entered address intact.

Geoapify offers a free plan with 3,000 daily credits and no credit card requirement, including commercial production use with attribution. This app allows each user at most one lookup per second, and 2,900 per UTC day across users, leaving headroom for key checks. Other applications using the same key may consume its quota. Pricing/terms: <https://www.geoapify.com/pricing/>. API reference: <https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/>.

Geocoding matches mapping data; it does not certify that a postal carrier will deliver to an address, validate a suite number, or verify that the contact's email/phone exists. The saved confirmation records the user's review, not postal certification. External lookup needs the account's API key; manual checking and confirmation remain available before setup or if the service is unavailable.
