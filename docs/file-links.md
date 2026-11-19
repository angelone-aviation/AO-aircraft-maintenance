# File links that expire

Decision of 2026-11-19 on security findings S7 and SE-12 (D17). Status: designed; the server half is built for aircraft documents, and the rest is listed under [What is left](#what-is-left).

## The problem

Every stored file (Form 337 copies, logbook page photos, aircraft photos, work order and job card files, inventory and purchase order files, manuals, license copies) reaches the browser as a Convex storage URL, `https://<deployment>.convex.cloud/api/storage/<id>`. That URL is a bearer link: it opens the file for anyone, with no sign-in, for as long as the file exists, and the same URL comes back on every request. It survives removal from every group, a password reset, a disabled account and archiving. The snapshot holds most of these URLs, so the device's offline copy keeps them for seven days, and the browser also keeps the bytes for 30 days (`Cache-Control: private, max-age=2592000`). Form 337 copies and logbook page photos are never deleted, so their links never stop working.

## The rule

- A file opens only for a signed-in member who may see the record it belongs to, judged by the same rule that lists it today. Owners keep exactly their current Form 337 copies and their aircraft's photo; board members keep receiving no files, and asking for a link refuses them.
- A link handed to the browser stops working five minutes after it is issued.
- The snapshot, and so the device's offline copy, holds no file links at all: only each file's id, name, type, size and dates.
- The demo keeps its fictional files in the browser and works offline as before. Manuals kept on the device still open offline.

## How it works

```text
screen ──backend.fileLinks([{ kind, id }])──► fileLinks.links mutation
                                              session and active program, then the listing's rule
                                              ◄── [{ url, expiresAt } | null]
browser ──GET <deployment>.convex.site/files/v1/<token>──► HTTP action
                                              verify signature and expiry, stream the blob
```

1. **Issue.** `fileLinks.links` (`convex/fileLinks.ts`) is a mutation, not a query: a query's result is cached and pushed again on any change, so a time-limited link would be served stale. It needs an active session and the active `programUuid`, but not `checkContext`, which refuses owners outright; board members, whose view holds no files, are refused. It takes at most 50 references, each a file kind and its id. For each one it loads the record, applies the rule the snapshot uses to list it, and returns a link, or null when the caller may not see the file or it is gone (the two look alike, so a refusal reveals nothing). It writes nothing and needs no audit entry.
2. **Token.** `v1.<keyId>.<payload>.<signature>`. The payload is base64url JSON of the storage id, the expiry time (issue time plus `FILE_LINK_TTL_MS`, five minutes), the content type and the file name. The signature is HMAC-SHA256 over everything before it, under a key derived from the credential key named by `keyId` (`fileLinkKey` in `convex/secrets.ts`: HMAC of the fixed label `angel-one:file-links:v1` under the 32-byte credential key). Every deployment already holds that key, so no new secret has to be set before release; the derived key never leaves the server and cannot decrypt a credential. Rotating the credential key (its runbook) only ends links issued in the last five minutes.
3. **Serve.** `GET /files/v1/<token>` on the deployment's `.convex.site` origin checks the signature with `crypto.subtle.verify` (constant time) and the expiry, then streams the blob. An altered, foreign or expired token gets 403 with "This link has expired. Open the file again from Angel One."; a deleted file gets 404. Responses carry `Cache-Control: private, no-store` (the browser keeps no copy), `X-Content-Type-Options: nosniff`, and `Access-Control-Allow-Origin: *` so the app can `fetch` the bytes (the records package, the PDF reader, keeping a manual): the token is the only credential, so allowing every origin adds nothing. PDF, JPEG, PNG and WebP open inline under their own name; any other type is sent as a download, so nothing can run as a page on the deployment's origin.
4. **Show.** A thumbnail or Open button asks for its link when it is shown or pressed and asks again before the link expires while it stays on screen. Offline, files other than kept manuals show "Reconnect to open", as uploads already do.

## Content-Security-Policy (`public/_headers`)

| Directive     | Today                                       | Needed                                                                                                                                    |
| ------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `img-src`     | `'self' data: blob: https://*.convex.cloud` | Add `https://*.convex.site` for thumbnails and photos shown straight from a link. Drop `*.convex.cloud` once no screen uses storage URLs. |
| `connect-src` | already allows `https://*.convex.site`      | No change: PDF.js, the records package and Keep on this device fetch from it.                                                             |
| `frame-src`   | `'self'`                                    | No change: no file is framed. PDFs render in PDF.js or open in a new tab, which the app's CSP does not govern.                            |

## Who may open what

The issuing rule for each kind is the one its listing applies today, so nobody gains or loses a file.

| Kind                | Listed today by                           | Opens for                                                                                            |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `aircraftFile`      | `aircraftFileList`, `ownerPortalFiles`    | Workspace readers of the aircraft; owners: current Form 337 copies of their aircraft; board: refused |
| `aircraftPhoto`     | `withPhotoUrls` in `convex/operations.ts` | Workspace readers of the aircraft; owners of the aircraft; board: refused                            |
| `workOrderFile`     | `workOrderAttachments`                    | Readers of the work order in the scoped snapshot                                                     |
| `taskEvidence`      | `taskEvidence`                            | Readers of the job card or archived task card                                                        |
| `inventoryFile`     | `inventoryAttachments`                    | Flight Program administrators                                                                        |
| `poFile`            | `purchaseOrders.files`                    | Inventory administrators of the order's program                                                      |
| `manual`            | `manuals.open`                            | Readers of the manual's aircraft                                                                     |
| `certificationFile` | `certifications.fileUrl`                  | The member, and administrators who manage them                                                       |

## What changes for users

- A file link copied out of the app stops working after five minutes; opening the file again from the app gives a new one.
- Thumbnails, aircraft photos and attachments do not show offline unless the browser happened to keep them; today they sometimes do, from the 30-day browser cache. Kept manuals still open offline.
- A removed member, or one whose password was reset, can no longer open files from links they already had.

## What is left

Built on this branch: the signing key, the token, the HTTP action and `fileLinks.links` for `aircraftFile`, with server tests that issue a link for every file a reader's snapshot lists and for no other (workspace readers, owners and administrators), refuse board members, signed-out callers and a stale program, and an attack from another Flight Program in the tenant-isolation suite.

Still to do, in order:

1. Client for aircraft documents: regenerate `convex/_generated` against a deployment (`npx convex dev`), since no deployment could be reached on this branch and the server tests name `fileLinks:links` directly; then `Backend.fileLinks` (Convex and demo adapters), a `useFileLink` hook with refresh, `AircraftFiles.tsx` and `LogbookPhotos.tsx` on it, the records package fetching each file's link just before downloading it, the `img-src` change above, then stop sending `url` for aircraft files in the snapshot and drop it from `AircraftFile`.
2. The other snapshot kinds, one at a time, each with its rule test and its screens: `aircraftPhoto` (`photoUrl`), `workOrderFile`, `taskEvidence`, `inventoryFile`.
3. The on-demand queries `purchaseOrders.files`, `manuals.open` and `certifications.fileUrl` become mutations returning a link, with their callers in `src/data/backend.ts`.
4. Remove `https://*.convex.cloud` from `img-src`, and note S7 and SE-12 as fixed in the security review and the bug-hunt report.
