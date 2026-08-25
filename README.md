# Augur status page

**Live: <https://andratwiro.github.io/augur-status/>**

A hand-written status page for Augur, plus the response times support actually
commits to, plus the synthetic probes that will eventually keep the page honest
without anyone typing.

## Why it lives here and not on Augur

Augur serves from Cloudflare — Pages, Workers, KV, R2, Durable Objects, one
account. A status page on any of those reports on itself, and goes dark at
exactly the moment it earns its keep. So this one is on GitHub Pages: different
company, different network (Fastly), different DNS, different everything. The
only thing the two have in common is a person.

The page also makes **zero subresource requests** — no fonts, no scripts, no
images, no analytics. The CSS and the logo are inlined. A status page that needs
a CDN to render has quietly acquired a third failure domain.

### No custom domain, on purpose

`status.augur.works` would be nicer to read out loud, and it would be a mistake.
GitHub Pages serves a custom domain by *redirecting* the `github.io` URL to it —
so the moment the `augur.works` zone is unreachable (Cloudflare DNS, a billing
lapse, an account suspension), both addresses die and the fallback dies with
them. The ugly URL is the one that survives. Link to it from the app, from
onboarding mail, and from the incident mail itself.

If a nicer name becomes worth it, the way to get one without the redirect is a
second registrar and a second DNS provider — not a hostname on the zone Augur
already depends on.

## Updating it

`bin/status` renders, commits and pushes in one go. GitHub publishes it in well
under a minute.

```sh
bin/status                      # what the page says right now
bin/status set publish outage "R2 writes are failing"
bin/status open "Publishes are failing" --components publish
bin/status update "Cause found: the R2 binding lost its token"
bin/status resolve "Rotated, publishes confirmed working"
bin/status ok                   # everything back to operational
bin/status note "Investigating slow publishes"
bin/status note --clear
```

States: `operational`, `maintenance`, `degraded`, `partial`, `outage`.
Add `--no-push` to any of them to look before you leap.

Everything is derived from `status.json`. Editing that by hand and running
`bin/status render` works identically — the CLI is a convenience, not a schema.

During a real incident, the order that works is: say something within minutes
(`open`), then keep saying things (`update`), then close it (`resolve`). An
empty status page during an outage is worse than a wrong one.

## Layout

```
status.json              the only source of truth
src/render.mjs           status.json -> docs/*.html, everything inlined
src/support.body.html    the response-time commitments, as prose
bin/status               the one command
docs/                    what GitHub Pages serves (generated — do not hand-edit)
probes/augur-probe.py    synthetic probes: serving, login, publish, deploy health
probes/inbox-watch.py    support mail -> the maintainer's phone
ops/cf-alerts.mjs        Cloudflare notification policies, as code
ops/kv-backup.mjs        binary-safe KV export, rotated, off GitHub
ops/store-backup.mjs     bundle-store copy, shared blob pool, off GitHub
ops/run-backups.sh       the nightly run, one .env per instance
```

`docs/status.json` is a machine-readable mirror of the page, so a probe or a
script can read the same truth the humans read.

## The three layers, and why none of them replaces another

**Cloudflare's own notifications** (`ops/`) are the platform telling you about
itself. Fast, free, and blind to anything Cloudflare thinks is fine.

**Synthetic probes** (`probes/`) are somebody else checking, from a machine
Cloudflare does not run, over a channel Cloudflare does not own. They ask the
three questions a dashboard cannot: does it serve, can you sign in, can you
publish.

A fourth, slower lane asks the question none of those can: **is this instance
still being kept current?** A site whose deploy machinery has stopped serves
perfectly — that is the whole problem — so the lane watches for a working-tree
publish left standing, baked chrome older than the deployed engine, an engine pin
falling behind the public main, and free-tier quota burn heading for a cap. It is
opt-in per instance and never colours a component on the page: a stale pin is not
an outage, and a status page that says otherwise is one people learn to
disbelieve. The engine-staleness check is the only one that re-notifies weekly
instead of alerting once, because an outage gets fixed and a slow rot gets
forgotten.

**Backups** (`ops/`) are the fourth layer, and the one whose absence is silent by
construction. Each deploy shell has a `kv-backup.yml` and a `store-backup.yml`; an
org whose GitHub Actions billing lapses has neither, and nothing anywhere says so.
`ops/run-backups.sh` takes both copies from cron on the same box as the probes,
with no CI in the path. See `ops/README.md`.

**This page** is what a user sees. It is written by hand on purpose: an
automated status page reports what the monitoring understood, and the gap
between that and what is actually happening is where trust is lost.

The seam between the second and the third is `/var/lib/augur-probes/status.json`
on the probe host, which already carries the four component states in this page's
vocabulary. Wiring it up needs a GitHub token on that host and a call to
`bin/status set`; until then, a phone alert wakes a person and the person types
the truth.

## The support inbox

`hi@augur.works` is the mailbox; `abuse@` and `legal@` alias onto it.
`probes/inbox-watch.py` polls it and pushes new mail to the maintainer's phone,
then nudges once a day if anything sits unread past a threshold. A published
response time is only worth the notification behind it — the commitments on
`docs/support.html` assume that notification exists.

## The drill

The page's whole claim is "still up when Augur is not", and a claim like that is
worth exactly one rehearsal. Twice a year:

1. Load the page with every Cloudflare-served host blackholed
   (`curl --resolve` the Augur hostnames to `127.0.0.1`, or pull the Pages
   project's custom domain in a maintenance window).
2. Confirm the page renders identically — it will, because it fetches nothing.
3. Flip a component to `outage` and confirm the change is live inside a minute.
4. Put it back with `bin/status ok`.

## Search engines

The pages ship `noindex,nofollow` and a deny-all `robots.txt` while Augur is
still unannounced. Remove both at launch — during an incident, people search for
"augur status", and a page search engines were told to ignore is a page they
cannot find. The switch is `<meta name="robots">` in `src/render.mjs` and the
`robots.txt` line beside it.
