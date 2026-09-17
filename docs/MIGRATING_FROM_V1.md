# Migrating from Kiri 1.x

Kiri 2.0 is a new application with a new database. Nothing upgrades in place —
instead, a one-shot importer reads a running (or stopped) Kiri 1.x install
directly and reproduces it in Kiri 2: users, series, library entries, chapters,
pages, reading positions, notifications, settings and the chapter files
themselves.

The importer **never writes to the 1.x database.** Every connection it opens is
put into `default_transaction_read_only`, so the old install stays exactly as it
was and you can run the import as many times as you like.

---

## What you need

1. **The 1.x PostgreSQL connection string** — the `DATABASE_URL` from the 1.x
   `.env` or compose file, e.g.
   `postgresql://kiri:secret@db:5432/readingtracker`. The Kiri 2 server must be
   able to reach that host.
2. **The 1.x data directory** — the folder that contains `rips/` and `covers/`
   (the `RIPPER_OUTPUT_ROOT` / `COVER_OUTPUT_ROOT` volume, usually `/data`).
   The Kiri 2 server must be able to _read_ it at the path you give.
3. **A 1.x database at migration `0017_add_rip_cookie_updated_at`** — the
   importer refuses to run against anything older. If in doubt, start the 1.x
   app once so it applies its migrations.
4. **A Kiri 2 instance that is already set up** (`/setup` has created the first
   admin), or an empty one — see _Who becomes admin_ below.

---

## Two ways to run it

### A. Admin page (recommended)

Sign in as an admin and open **Admin → Import from 1.x**. Fill in the connection
string and the data directory, leave **Dry run** on, and start it. The page
follows the job's progress and then renders the report.

The connection string is encrypted with `APP_SECRET` before it is stored on the
job row and is only decrypted inside the worker. It never appears in the job
log, the report, or an error message.

When the dry run looks right, turn **Dry run** off and start it again.

### B. Command line

Useful before the app is even running, or when you want the report in a file.

```bash
npm run -w apps/web import:v1 -- \
  --v1-db postgresql://kiri:secret@localhost:5432/readingtracker \
  --v1-data /srv/kiri-v1/data \
  --dry-run
```

Options:

| Flag                    | Meaning                                               |
| ----------------------- | ----------------------------------------------------- |
| `--v1-db <url>`         | 1.x connection string (read-only)                     |
| `--v1-data <dir>`       | 1.x data directory containing `rips/` and `covers/`   |
| `--copy`                | Copy the chapter files into `DATA_ROOT` (**default**) |
| `--link`                | Symlink the 1.x directories instead of copying        |
| `--dry-run`             | Walk the whole import, write nothing                  |
| `--admin-email <email>` | Which 1.x user becomes the admin                      |
| `--import-jobs=history` | Also import finished 1.x jobs as history rows         |

Progress goes to **stderr**, the report to **stdout**, so
`… > import-report.txt` keeps the report and still shows progress live. The
process exits `1` on failure and `2` on a usage error.

The CLI reads `apps/web/.env`, so `DATABASE_URL`, `APP_SECRET`, `DATA_ROOT` and
`PUBLIC_URL` must be set there for the _Kiri 2_ side.

---

## Always dry-run first

`--dry-run` (and the switch on the admin page) runs the identical code path
against the identical data — it just swaps the component that performs writes
for one that records what it _would_ have done. Nothing is inserted, no file is
copied, no invite is minted, and the report you get back has exactly the shape
of a real run.

It is the cheapest way to find a wrong data directory, a site with no plugin, or
a set of chapters whose `manifest.json` went missing.

---

## Copy or link?

|                | `--copy` (default)                                                  | `--link`                                                                      |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| What happens   | Every chapter file is streamed into `DATA_ROOT/library/<seriesId>/` | `DATA_ROOT/library/<seriesId>` becomes a directory link to the 1.x rip folder |
| Disk           | Needs the library's size a second time                              | No extra space                                                                |
| 1.x afterwards | Can keep running                                                    | **Must be decommissioned** — those folders now belong to Kiri 2               |
| Speed          | Bounded by disk throughput                                          | Instant                                                                       |

Choose `--copy` unless you are tight on disk. Use `--link` only when 1.x is
switched off for good: Kiri 2 will optimise, rename and delete files in there.

On Windows the link is a directory junction, which needs no elevation; on Linux
and macOS it is a normal directory symlink.

---

## What is imported

| 1.x                | Kiri 2                   | Notes                                                                                              |
| ------------------ | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `users`            | `User` + one invite each | Lower-cased email, `display_name` → both `name` and `displayName`, optimizer preferences verbatim  |
| `series`           | `Series`                 | Deduplicated by `mal_id`, then by (title, creator); `link` → `sourceUrl`; every series is `SHARED` |
| `user_series`      | `LibraryEntry`           | Status, chapter counter, rating and notes verbatim                                                 |
| `series_rips`      | `Source`                 | One per series, except `pdf`/`manual` which need none                                              |
| `manifest.json`    | `Chapter` + `Page`       | Same ingest the plugin runner uses; `source: "manual"` → `origin MANUAL`, `"pdf"` → `PDF`          |
| `reader_progress`  | `ReadingPosition`        | Chapter matched by slug                                                                            |
| `notifications`    | `Notification`           | Unread and newer than 30 days only                                                                 |
| `app_settings`     | `AppSetting`             | `verbose_rip_logging` → `verbosePluginLogging`                                                     |
| `site_credentials` | `PluginCredential`       | Only when a matching plugin is installed                                                           |
| `rip_jobs`         | `Job`                    | Only with `--import-jobs=history`, terminal rows, without their logs                               |

### Passwords and invites

Kiri 1.x had no passwords — identity came from a proxy header. So every
imported account is created with `mustSetPassword` and **no credentials**, and
the importer mints one invite per newly created user, pinned to that address and
valid for 30 days. The report lists the links.

**The invite links are shown once.** Only a hash is stored, so a lost link
cannot be recovered — mint a replacement from **Admin → Invites**.

If you run Kiri 2 behind Cloudflare Access, imported users do not need the
invite at all: a verified Cloudflare identity is linked to the existing account
with the same email address.

### Who becomes admin

- If the Kiri 2 instance **already has an admin**, everyone is imported as a
  member and no roles are changed.
- Otherwise: `--admin-email` wins; failing that, the 1.x user who created the
  most series; failing that, the oldest account.

### Covers

A 1.x cover stored locally (`image_url = /api/series/<id>/cover`) is read from
`covers/<id>/cover.<ext>`, converted to WebP and stored under the new series id.
A cover that was still a remote URL is recorded as `externalIds.remoteCover` and
**not** downloaded — an import must not depend on thirty third-party image hosts
still being up. You can fetch it later by editing the series.

A cover is only written when the Kiri 2 series has none yet, so the import never
replaces a cover somebody set by hand.

### Cookies

Cloudflare cookies (`cf_clearance` and friends) are re-encrypted with
`APP_SECRET`, but only when they are **less than 7 days old**; anything older —
or undated, which 1.x wrote before it started stamping them — is dropped, and
the report says so. Cloudflare's own volatile cookies (`__cf_bm`, `_cfuvid`,
`cf_chl_*`) are stripped: they are bound to the browser's IP and TLS
fingerprint, so replaying them from a server causes a fresh challenge.

Paste a new cookie on the series page (or capture one with the Kiri Cookie
Bridge extension) after the import.

---

## NEEDS_PLUGIN

Kiri 2 ships with **no content-source plugins**. The ~30 rippers that were baked
into 1.x live in a separate repository now and are installed one at a time.

So a series whose 1.x site has no matching plugin installed gets a `Source` with
status **`NEEDS_PLUGIN`**. That means:

- everything already downloaded is **fully readable** — chapters, pages, offline
  downloads, notes, progress;
- only _syncing new chapters_ is paused;
- the moment you install a plugin whose id or hosts match that site, the source
  picks it up and syncing resumes. Nothing has to be re-imported.

The report lists every such site with the number of series waiting on it, under
"Waiting for a plugin".

Two 1.x "sites" never had a plugin and never need one: `pdf` and `manual`. Those
series get no `Source` at all; their chapters carry `origin = PDF` / `MANUAL`
and behave exactly like a fresh upload.

---

## Re-running the import

The import is idempotent. Every row it writes is recorded in an `ImportMapping`
table keyed by `(v1 table, v1 id)`, so a second run:

- **updates** rows it created before, picking up anything you changed in 1.x
  since;
- **reuses** rows that already existed in Kiri 2 for other reasons — a series
  with the same `mal_id`, a user who had already signed up — recording the link
  without touching their data;
- **creates** nothing twice, mints no second invite, and copies no file whose
  target already exists at the same size.

The report's `created` / `reused` / `updated` / `skipped` columns say exactly
which of those happened.

That makes the safe sequence: dry run → real run → keep using 1.x for a few days
→ run it again to top up → decommission 1.x.

The one thing a re-run does **not** do is overwrite data you have edited inside
Kiri 2 on a row the importer merely _attached_ to. If you want 1.x to win for
such a series, delete the Kiri 2 series first and import again.

---

## Reading the report

| Column    | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `read`    | Rows found in 1.x (for chapters/pages: entries in the manifests)                              |
| `created` | New Kiri 2 rows                                                                               |
| `reused`  | Existing rows the import attached to, unchanged                                               |
| `updated` | Rows the import had created before and refreshed from 1.x                                     |
| `skipped` | Rows deliberately not imported (read/old notifications, `pdf`/`manual` rips, unfinished jobs) |

The content line reports how many rip folders were seen, how many were copied or
linked, how many bytes moved, and how many `manifest.json` files were missing.

Common warnings:

| Code                             | What it means                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `MANIFEST_MISSING`               | A rip folder has no readable `manifest.json`; that series imported with no chapters                         |
| `POSITION_UNRESOLVED`            | A saved reading position pointed at a chapter slug that no longer exists; the position kept its page number |
| `COOKIE_DROPPED_STALE`           | A per-series cookie was older than 7 days                                                                   |
| `CREDENTIAL_SKIPPED_NO_PLUGIN`   | A saved site credential has no matching plugin installed yet                                                |
| `COVER_MISSING` / `COVER_FAILED` | The cover file was gone, or could not be decoded                                                            |
| `SERIES_CREATOR_MISSING`         | A series' creator could not be imported; the admin now owns it                                              |
| `INGEST_WARNING`                 | Something in a `manifest.json` was odd (missing image file, duplicate slug)                                 |

---

## Troubleshooting

**"The Kiri 1.x database is missing migration 0017…"** — start the 1.x app once
so it runs `prisma migrate deploy`, then import.

**"Could not connect to the Kiri 1.x database"** — the Kiri 2 _server_ has to
reach that host, not your laptop. Inside Docker, use the compose service name,
not `localhost`.

**"The data directory … does not exist on this server."** — same thing for
files: mount the 1.x volume into the Kiri 2 container (read-only is fine for
`--copy`) and give the path as the container sees it.

**A V1_IMPORT job is already queued or running** — only one import runs at a
time per instance. Cancel it from **Admin → Jobs** if it is stuck.

**The chapters imported but the reader shows nothing** — check the report for
`MANIFEST_MISSING`, and confirm the data directory really is the one with
`rips/` in it (not its parent).
