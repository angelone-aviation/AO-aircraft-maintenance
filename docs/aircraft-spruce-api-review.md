# Aircraft Spruce API review

Cached export response observed on 2026-10-21: the products endpoint may return `url`, `expires`, and `size` without a `status` field. The integration accepts this variant after validating the HTTPS download address and CSV structure, but still rejects explicit failure status values.

## Latest findings: documented line-detail export

The user supplied the orders endpoint's request/contents tables. They document optional exact order selection (`order`), status filtering (`I` invoiced, `D` cancelled), order and ship date ranges, and PO-number search (`po`, with `%` for partial matching). `fields` is required. Upper date bounds are described as before the given date, so an inclusive-through-October-21 request uses October 22 as its upper boundary. Earlier sections below retain the historical test results and limitations at each stage.

The documented output includes `PONO`, invoice/status fields, and `PARTS`, `DESCS`, `QOS`, `QPS`, `QSS`, `QBOS`, `NPS`, `DSS`, `GPS`, `EXTS` for parts, descriptions, ordered/to-pick/shipped/backordered quantities and pricing. This supersedes the earlier seven-field export's lack of line data.

A new authenticated request for January 1 through before October 22, 2026, including these line fields, succeeded. The private `.local/aircraft-spruce/orders-2026-details.csv` contains 256 rows, 47 distinct nonempty ORN values, and 109 rows with a PONO. All rows have the selected column count. Although the documentation calls the detail fields arrays, this CSV has individual scalar values on repeated order rows, not JSON arrays in cells. Some quantity/price values are blank; retain them as unknown. Exact row identity, non-product rows, duplicate-part handling, numeric price scale, and shipment-versus-cumulative quantity semantics still require verification before automated reconciliation.

Recommended integration: use exact PONO matching to propose links to internal POs, require review for missing or ambiguous matches, and persist the confirmed external order association. Show line-level supplier ordered/shipped/backordered values and invoice/tracking references. Synchronization must reconcile snapshots rather than repeatedly append the same shipments. Import into existing quantity-bearing shipment records only after line matching and quantity semantics are verified. Receipt confirmation remains manual and controls local inventory. Cart creation and order placement remain unverified.

Reviewed 2026-10-21 using a read-only catalog request. No orders were placed and no application inventory was changed.

## Verified access

An authenticated JSON POST to [download/products](https://www.aircraftspruce.com/api/download/products), with `userid`, `password`, and `apikey`, returned HTTP 200 and `status: true`, plus `url`, `expires`, and `size`. The supplied HTTPS URL downloaded a 24,014,352-byte CSV containing 126,633 data rows and 33 columns. All PN values were unique in this snapshot; no rows had excess columns. These are observations from this request, not guarantees about the API contract.

Credentials remain in the ignored `.env.aircraftspruce.local`. The downloaded catalog is saved at `.local/aircraft-spruce/products.csv`, also ignored by Git. Both files have owner-only read/write permissions. The report omits credentials, temporary download URLs, and individual price records.

## Catalog fields and proposed application use

| Observed columns                                                         | Proposed use and limitations                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PN, DESCRIPTION                                                          | Vendor product search and PO description. Keep supplier PN separate from any internal/manufacturer part identifier until mappings are verified. Two descriptions are blank.                    |
| RETAILPRICE, DISCOUNT, NETPRICE                                          | Draft pricing display. Confirm currency, account pricing rules, discount meaning, and price validity before adopting NETPRICE as a PO unit price. No explicit currency column is present.      |
| GA-AVAIL, CA-AVAIL, CANADA-AVAIL, IL-AVAIL, TX-AVAIL, PA-AVAIL, AZ-AVAIL | Display supplier availability by the feed's location codes with a fetch timestamp. These are supplier values, not local inventory. Blank values must remain unknown rather than becoming zero. |
| Matching location -DUE columns                                           | Display supplier due text. Values include dates and CALL; do not parse every value as a guaranteed delivery date.                                                                              |
| UOM                                                                      | Unit-of-measure mapping. Observed units include EA, PC, PACK, KIT, FT, GAL. Verify pack quantities and conversion before mapping to the app's integer order quantities.                        |
| MFG                                                                      | Preserve supplier manufacturer metadata pending documentation of its format.                                                                                                                   |
| CORE                                                                     | Preserve raw value; observed entries look like part identifiers, so do not interpret this as a monetary core charge.                                                                           |
| DIMS, WEIGHT, HAZ, OVERSIZE                                              | Shipping-related metadata. Confirm dimensions/weight units and flag meanings. HAZ and OVERSIZE contain codes beyond Y/N.                                                                       |
| URL, IMAGE, SECTION, CATEGORY                                            | Product links, images, and browsing filters. These fields are populated on 92,294 rows in this snapshot.                                                                                       |
| VOLDISC, SPECIAL, AVCODE                                                 | Preserve raw codes; meanings and pricing effects remain unverified.                                                                                                                            |

## Integration recommendation

1. Store the feed in a vendor catalog linked to the Aircraft Spruce vendor record; do not import it as stock on hand.
2. Add product search to parts requests and draft PO lines, with explicit internal-part mapping and unit review.
3. Display supplier availability and due text separately from local on-hand/reserved quantities. Show when the feed was fetched.
4. Copy reviewed values into draft POs. Catalog refreshes must not silently rewrite historical or issued orders. Confirm currency before converting price strings to integer minor units.
5. Keep the existing PO receipt transaction as the point where local stock increases and request allocations become reservations.

The existing PO model supports vendor references, integer quantities and unit cents, shipment tracking, receipts, and serialized component details; it does not currently contain an external vendor order identifier or submission state. See [PO domain](../src/domain/purchaseOrders.ts), [vendors](vendors.md), [purchase orders](purchase-orders.md), and [parts requests](parts-and-repair-requests.md).

## Still unverified

### Orders download probe

An authenticated JSON POST to the user-supplied [download/orders endpoint](https://www.aircraftspruce.com/api/download/orders), using the same three credential fields as the successful products request, returned HTTP 200 with `{"status":0,"error":"052 '' is not valid"}`. It supplied no download URL. This is an application-level failure despite HTTP 200. The message does not identify which value is missing or invalid; the endpoint's documented request parameters are needed before further testing. No order records were downloaded. The response does not establish cart modification or order placement capabilities.

Catalog access does not demonstrate order submission, live quoting, shipment/status lookup, cancellation, invoice retrieval, webhook support, or a sandbox. Request limits and refresh frequency are also unknown. Do not implement or probe guessed order-changing endpoints.

### Successful orders export with documented fields

After the user supplied the request example, the same endpoint succeeded with `order_from: "01/01/2026"`, `order_to: "10/21/2026"`, and `fields: ["ORN", "DATEORDER", "DATESHIP", "SHIPVIA", "CARRIER", "TRACKING", "INVAMOUNT"]` in addition to the credentials. It returned `status: true` and a temporary download URL. The downloaded CSV is 4,373 bytes with 52 data rows and exactly those seven headers. It is stored privately at `.local/aircraft-spruce/orders-2026.csv`; no individual order details are included here.

This verifies a date-filtered order export with order/shipping/tracking/invoice-amount fields. The field names suggest order number, order date, ship date, shipping method, carrier, tracking reference, and invoice amount; precise field semantics and currency remain undocumented. Row granularity has not been established, so 52 rows must not be treated as 52 distinct orders or shipments. This supersedes the earlier inability to download orders and narrows the unknowns above: shipping metadata export is verified, but a live status API is not.

Recommended use: let an administrator link an exported order reference to an existing internal PO, then display supplier shipping metadata separately from local receipt state. This selected field set has no line items, part numbers, shipped quantities, or internal PO reference. It cannot by itself reconcile individual lines, automatically populate the app's quantity-bearing shipment records, or confirm receipt into inventory. Neither this export nor the product export establishes cart creation or order submission support.

The [documentation index](https://www.aircraftspruce.com/apidocs/) and [apps page](https://www.aircraftspruce.com/apidocs/apps.html) return HTTP 403 for unauthenticated access. Successful API-key authentication on the catalog endpoint does not establish a documentation login session. See [public documentation investigation](aircraft-spruce-api-public-research.md). An accessible documentation export or documented authentication procedure is needed to verify additional capabilities.
