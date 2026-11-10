# Peer testing with Convex Cloud and A2 Hosting

> Historical. The A2 Hosting plan was not used: the site is served by Cloudflare ([release runbook](runbooks/release.md)). The demo download described below is now **Settings → System → Download this demo's data**, and no Angel One script or server function imports its file.

The website runs on A2; records, accounts, backend functions and uploaded files run on Convex. Use a separate empty Convex project/deployment and an HTTPS test subdomain for peers.

## Browser demo source (confirmed)

The user confirmed their working records are in **Explore the local demo**, not the local Convex database. Do not run the local-database transfer wizard for these records. In the same browser and origin that shows the records, open **Settings → System → Download this demo's data → Download demo data**. Save the JSON under `.convex/peer-testing/` for conversion and import. It includes all Flight Programs, embedded work-order/job-card attachments, separately stored manual PDFs and pending entries. Missing PDFs are reported rather than silently omitted. Demo users have no password credentials; real cloud accounts and identity mappings must be set up as part of the subsequent import. This file is an application backup, not a Convex snapshot ZIP, and cannot be passed directly to `convex import`.

## Original local-database verification

The local database inspected during preparation contained four aircraft and four users, but no work orders, component records or uploaded files. This does not match the maintenance records shown in the browser screenshots. Confirm which backend the browser is connected to before copying data. Browser demo data is separate from local Convex and is not included by `convex export`.

A backup was saved under `.convex/peer-testing/`. These files contain private account and application data and must never be uploaded to the website host.

## Guided transfer

Once the correct local Convex data is available, run from the project terminal:

```bash
bash scripts/setup-peer-testing.sh
```

The wizard:

1. Exports local Convex records and file storage, displaying record counts for review.
2. Asks for the cloud deployment URL, a matching production deploy key and the A2 HTTPS website origin. Obtain the URL and key from the peer-testing project's Production deployment Settings. The key must permit backend deployment, data reads/import and environment-variable updates. Values are saved in `.env.peer-testing`, which is git-ignored and restricted to the local user.
3. Checks that the destination is empty, deploys the backend, imports the ZIP with preserved identifiers and files, configures Convex Auth signing keys and `SITE_URL`, then builds a website linked to that deployment. It leaves `.env.local` and the original database unchanged. No replace/append imports are used.
4. Walks through uploading `.convex/peer-testing/a2-website.zip` to the test domain's document root in A2's control panel and extracting its contents. `index.html` and `.htaccess` should sit directly in the document root. This package includes Apache/LiteSpeed SPA routing and cache revalidation for the app entry point.

The transfer refuses an export without the expected work orders/components and refuses nonempty cloud tables. Do not bypass those checks to resolve a source-data mismatch. A successful transfer is recorded locally to prevent an accidental repeat import.

The imported app accounts retain their password data; sign in afresh on the hosted website. Do not run administrator bootstrap against an imported user database. Create peer accounts in the app and assign Flight Program groups/permissions.

For a later website-only rebuild, retaining the saved deployment configuration:

```bash
node scripts/peer-testing-transfer.mjs build
```

This command builds the frontend only. Deploy backend changes separately to the same cloud deployment before publishing a frontend that depends on them. Local edits to records do not synchronize into the separate cloud copy.

## Verification

Test sign-in, the aircraft list, work orders, components and an uploaded file. Refresh a deep link such as `/work-orders`. Confirm a peer has the intended permissions and cannot view another program's restricted aircraft. Keep the database snapshot and `.env.peer-testing` private; only `a2-website.zip` belongs on A2.

## References

- [Convex export/import](https://docs.convex.dev/database/import-export/import): ZIP imports preserve document identifiers and stored files; nonempty tables are rejected by default.
- [Convex custom hosting](https://docs.convex.dev/production/hosting/custom): the compiled static website can be hosted separately from Convex.
- [Convex deployment settings](https://docs.convex.dev/dashboard/deployments/deployment-settings): deployment URLs and deploy keys.
- [cPanel document roots](https://support.cpanel.net/hc/en-us/articles/1500004206502-How-to-find-the-document-root-of-a-domain).
