# File links that expire

Decision of 2026-11-19 on security findings S7 and SE-12 (D17). Status: built for every stored file and in production; see [What is left](#what-is-left).

## The problem

Every stored file (Form 337 copies, logbook page photos, aircraft photos, work order and job card files, inventory and purchase order files, manuals, license copies) reaches the browser as a Convex storage URL, `https://<deployment>.convex.cloud/api/storage/<id>`. That URL is a bearer link: it opens the file for anyone, with no sign-in, for as long as the file exists, and the same URL comes back on every request. It survives removal from every group, a password reset, a disabled account and archiving. The snapshot holds most of these URLs, so the device's offline copy keeps them for seven days, and the browser also keeps the bytes for 30 days (`Cache-Control: private, max-age=2592000`). Form 337 copies and logbook page photos are never deleted, so their links never stop working.

## The rule

- A file opens only for a signed-in member who may see the record it belongs to, judged by the same rule that lists it today. Owners keep exactly their current Form 337 copies and their aircraft's photo, also when they sit on a board too; board-only members keep receiving no files, and asking for a link refuses them.
- A link handed to the browser stops working five minutes after it is issued.
- The snapshot, and so the device's offline copy, holds no file links at all: only each file's id, name, type, size and dates, and `hasPhoto` on an aircraft with a photo. The demo's records keep their stored copies (data URLs) in `url` and `photoUrl`, which the server never sends.
- The demo keeps its fictional files in the browser and works offline as before. Manuals kept on the device still open offline.

## How it works

```text
screen ──backend.fileLinks([{ kind, id }])──► fileLinks.links mutation
                                              session and active program, then the listing's rule
                                              ◄── [{ url, expiresAt } | null]
browser ──GET <deployment>.convex.site/files/v1/<token>──► HTTP action
                                              verify signature and expiry, stream the blob
```

1. **Issue.** `fileLinks.links` (`convex/fileLinks.ts`) is a mutation, not a query: a query's result is cached and pushed again on any change, so a time-limited link would be served stale. It needs an active session and the active `programUuid`, but not `checkContext`, which refuses owners outright; a member who is only on a board, whose view holds no files, is refused. It takes at most 50 references, each a file kind and its id. For each one it loads the record and applies the rule the snapshot query uses to list it: an owner portal adds only the aircraft photo and current Form 337 copies, and a workspace lists the files of every work order, job card and stock record that `scopedSnapshot` keeps, which the check finds by handing `scopedSnapshot` the caller's context with just that record. It returns a link, or null when the caller may not see the file or it is gone (the two look alike, so a refusal reveals nothing). It writes nothing and needs no audit entry.
2. **Token.** `v1.<keyId>.<payload>.<signature>`. The payload is base64url JSON of the storage id, the expiry time (issue time plus `FILE_LINK_TTL_MS`, five minutes), the content type and the file name. The signature is HMAC-SHA256 over everything before it, under a key derived from the credential key named by `keyId` (`fileLinkKey` in `convex/secrets.ts`: HMAC of the fixed label `angel-one:file-links:v1` under the 32-byte credential key). Every deployment already holds that key, so no new secret has to be set before release; the derived key never leaves the server and cannot decrypt a credential. Rotating the credential key (its runbook) only ends links issued in the last five minutes.
3. **Serve.** `GET /files/v1/<token>` (`convex/fileTokens.ts`, which also signs) on the deployment's `.convex.site` origin checks the signature with `crypto.subtle.verify` (constant time) and the expiry, then streams the blob. An altered, foreign or expired token gets 403 with "This link has expired. Open the file again from Angel One."; a deleted file gets 404. Responses carry `Cache-Control: private, no-store` (the browser keeps no copy), `X-Content-Type-Options: nosniff`, and `Access-Control-Allow-Origin: *` so the app can `fetch` the bytes (the records package, the PDF reader, keeping a manual): the token is the only credential, so allowing every origin adds nothing. PDF, JPEG, PNG and WebP open inline under their own name; any other type is sent as a download, so nothing can run as a page on the deployment's origin.
4. **Show.** Screens ask through `Backend.fileLinks`. `src/data/fileLinks.ts` sends the links a screen needs in one call and reuses each until a minute before it expires; `useFileLink`, `LinkedImage`, `OpenLink` and `NamedFileLink` (`src/components/FileLink.tsx`) ask while the file is on screen, and an Open link asks again before it expires. Offline, files other than kept manuals say "Reconnect to open." (an aircraft photo falls back to the drawing). The records package asks for each file's link just before downloading it, since a package can outlast five minutes. Manuals, purchase-order files and license copies use the same call: `Backend.openManual` and `certificationFileUrl` return a fresh link, the viewer downloads an online manual once so its buttons keep working, and keeping a manual still streams the link straight into Cache Storage.

## Content-Security-Policy (`public/_headers`)

| Directive     | Today                                      | Needed                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `img-src`     | `'self' data: blob: https://*.convex.site` | Only the site host, for thumbnails and photos drawn straight from a link; no image loads from storage on `*.convex.cloud`. `scripts/check-csp-origin.mjs` checks the deployment's site host here before a deploy, and `scripts/pin-csp-origin.mjs` pins it to production's. |
| `connect-src` | already allows `https://*.convex.site`     | No change: PDF.js, the records package and Keep on this device fetch from it.                                                                                                                                                                                               |
| `frame-src`   | `'self'`                                   | No change: no file is framed. PDFs render in PDF.js or open in a new tab, which the app's CSP does not govern.                                                                                                                                                              |

## Who may open what

The issuing rule for each kind is the one its listing applies today, so nobody gains or loses a file.

| Kind                | Listed today by                            | Opens for                                                                                                 |
| ------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `aircraftFile`      | `aircraftFileList`, `ownerPortalFiles`     | Workspace readers of the aircraft; owners: current Form 337 copies of their aircraft; board only: refused |
| `aircraftPhoto`     | `withPhotoFlags` in `convex/operations.ts` | Workspace readers of the aircraft; owners of the aircraft; board only: refused                            |
| `workOrderFile`     | `workOrderAttachments`                     | Readers of the work order in the scoped snapshot                                                          |
| `taskEvidence`      | `taskEvidence`                             | Readers of the job card or archived task card                                                             |
| `inventoryFile`     | `inventoryAttachments`                     | Flight Program administrators                                                                             |
| `poFile`            | `purchaseOrders.files`                     | Flight Program administrators of the order's program (the app's messages say "inventory administrator")   |
| `manual`            | the library (formerly `manuals.open`)      | Workspace readers of the manual's aircraft                                                                |
| `certificationFile` | `certifications.list` (formerly `fileUrl`) | The member, and system administrators                                                                     |

## What changes for users

- A file link copied out of the app stops working after five minutes; opening the file again from the app gives a new one.
- Thumbnails, aircraft photos and attachments do not show offline; before, they sometimes did, from the 30-day browser cache. Kept manuals still open offline.
- An online manual is downloaded whole before the viewer shows it, as a kept copy is read whole.
- A removed member, or one whose password was reset, can no longer open files from links they already had.

## What is left

Built: the signing key, the token, the HTTP action, `fileLinks.links` for all eight kinds, every screen on links, and no file link in the snapshot or any listing. Server tests issue a link for exactly the files each role's snapshot lists (workspace reader, owner, owner who is also on a board, program and system administrators), refuse board-only members, signed-out callers and a stale program, pin the manual, purchase-order and license-copy rules with their features, and attack every kind from another Flight Program in the tenant-isolation suite.

Left: nothing for the feature, which is in production. `convex/_generated` has listed `fileLinks` and `fileTokens` since its regeneration, but the browser adapter and the e2e fixture still name `fileLinks:links` with `makeFunctionReference` (`FILE_LINKS` in `src/data/backend.ts` and `tests/fixtures/fileLinks.ts`). That reaches the same function; changing them to `api.fileLinks.links` is a tidy-up, not a fix.
