# Kiri Cookie Bridge (Chrome/Chromium extension)

Automates the worst part of syncing Cloudflare-gated sites through a Kiri content-source plugin.
Instead of opening DevTools, copying `cf_clearance` by hand, and pasting it into Kiri every time
it expires, grant the extension access to a site once and it captures that site's cookies
(including the HttpOnly `cf_clearance` that page scripts can't read) plus the matching
User-Agent, and sends them to your Kiri instance. Any sync for that site then uses the freshest
credentials automatically.

Unlike Kiri v1's extension, this one carries **no built-in list of sites**. On install, on
browser startup, and once a day, it asks your Kiri instance which hosts its _installed plugins_
actually need (`GET /api/plugins/hosts`) and adapts as you install/uninstall plugins — nothing
to keep in sync by hand.

## How it works

```
Options page: set your Kiri instance URL + extension token, Test connection
  → background fetches GET /api/plugins/hosts  (the sites your installed plugins need)
Popup: "Grant" a site  (a real user click — Chrome requires this for host permissions)
  → background can now read that site's cookies
You browse the site normally (or click "Capture now")
  → background reads chrome.cookies.getAll({ domain }) (incl. HttpOnly cf_clearance)
  → drops volatile Cloudflare cookies (__cf_bm, _cfuvid, cf_chl_*) — replaying those from
    Kiri's server IP just triggers a fresh challenge
  → POST { host, cookie, userAgent } → <Kiri>/api/plugins/credentials  (Bearer token)
  → Kiri stores it per host; a series without its own cookie falls back to it
```

Credentials are stored **per host**, so one grant covers every series synced from that site. A
per-series cookie pasted in the Kiri UI still takes precedence over the extension's.

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the extension's icon → **Options** (or **Details → Extension options**) and set:
   - **Kiri instance URL** — e.g. `http://192.168.1.50:3000` (the address you open Kiri at).
   - **Extension token** — from your Kiri instance's **Admin → Plugins** page.
     When you save, Chrome asks permission to contact that host — accept it.
5. Click **Test connection** to confirm it can reach Kiri and see how many hosts your installed
   plugins have registered.
6. Open the toolbar popup and click **Grant** next to each site you want covered (or use
   **Capture now** for whatever site the current tab is on). Granting is per-site by design —
   Chrome will only let the extension request access one host at a time, from a real click.

That's it. Browse a granted site (or revisit it after solving a Cloudflare challenge) and the
bridge sends fresh cookies automatically; the popup also has a manual **Capture now** per site.

## Why hosts aren't built in

Kiri v1's extension shipped a static list of ~11 sites that had to be kept in sync by hand across
`manifest.json`, `sites.js`, and the server's site registry. In Kiri 2.0, every site is a plugin,
so the set of hosts that matter is whatever's currently installed — the extension just asks.
`optional_host_permissions: ["*://*/*"]` lets it request access to any host the server names, but
it never gets that access without you clicking **Grant**.

## Security / privacy

- Cookies are only read for hosts your own Kiri instance's installed plugins listed, and only
  after you've explicitly granted that host — nothing is read implicitly.
- Cookies are sent only to the Kiri instance URL you configured, authenticated with the token
  from that instance's Admin → Plugins page. The token rotates if `APP_SECRET` changes on the
  server, so a stale token just stops working — no cookies get sent anywhere else.
- Revoke a grant any time from `chrome://extensions` → Kiri Cookie Bridge → **Site access**, or
  by removing the host permission there.

## Caveat

`cf_clearance` is bound to the IP **and** User-Agent that solved the challenge. Kiri syncs from
the server's IP, not your browser's, so a strict Cloudflare configuration may still reject the
cookie. This is the same limitation as pasting the cookie manually in the Kiri UI — the extension
just removes the manual step and keeps the credential fresh.
