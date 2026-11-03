# Aircraft Spruce API: public documentation review

Reviewed 2026-10-21. Scope: public first-party sources only; no credentials or authenticated API calls were used for this review.

## Findings

- Direct unauthenticated HTTPS requests to the [API documentation index](https://www.aircraftspruce.com/apidocs/) and [applications documentation](https://www.aircraftspruce.com/apidocs/apps.html) both returned HTTP 403 with `403 Access Denied. Login Required`. The web browsing tool could not retrieve either page either.
- Searches restricted to Aircraft Spruce's domain did not locate accessible API reference material describing catalog authentication, order creation, shipment retrieval, cancellations, rate limits, or testing environments. This is a discovery limitation, not evidence that those capabilities do not exist.
- The public [catalog description](https://www.aircraftspruce.com/catalog/stpages/sprucecatalog.php) describes a downloadable PDF with links to website product details, pricing, stock, and ordering. These are website capabilities; the page does not establish equivalent API capabilities.

## What remains unverified

| Capability | Evidence needed |
| --- | --- |
| Product CSV download | Successful authenticated response and downloaded CSV headers; exact request method and encoding |
| Product price and availability lookup | Endpoint contract, price currency, units, stock semantics, and freshness |
| Order submission | Documented request and response, account permissions, payment handling, duplicate prevention |
| Order and shipment synchronization | Retrieval endpoints or webhooks, line identifiers, partial shipment/backorder semantics |
| Order changes and cancellation | Vendor-supported operations and confirmation rules |
| Operational limits | Rate limits, download refresh cadence, expiry timezone, sandbox availability |

The user-provided catalog response example suggests a temporary CSV download URL, but this public-source review did not independently verify that example. Authenticated catalog testing should be reported separately.

## Integration implication

Design proposal: use any verified product catalog to populate a vendor catalog and map supplier SKUs to internal parts. Preserve the existing physical receipt step as the action that increases inventory. Do not implement automatic ordering or assume shipment/cancellation support until authenticated documentation or vendor confirmation establishes the relevant contract.
