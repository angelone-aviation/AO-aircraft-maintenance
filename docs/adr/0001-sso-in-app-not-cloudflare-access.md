---
status: accepted
date: 2026-11-01
---

# Access control stays in the app; Cloudflare Access is not the gate

Moving the static site to Cloudflare made Cloudflare Access (Zero Trust) an option for single sign-on in front of the site. We rejected it as the access-control layer. Access would gate only the HTML shell: the client talks to the Convex backend directly over websockets, and every query and mutation is authorized there with Convex Auth and Flight Program membership, so a gate in front of the static files protects nothing the data path depends on, while adding a second identity system and breaking the installed PWA and offline flows. Google and Microsoft sign-in therefore go in-app through `@convex-dev/auth` OAuth providers (see the authentication hardening decision on the hardening map).

## Considered options

- Cloudflare Access in front of the static site (rejected: wrong layer, second identity store, PWA/offline breakage)
- In-app OAuth via Convex Auth (chosen)
