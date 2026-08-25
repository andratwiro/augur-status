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
probes/                  synthetic probes: serving, login, publish  (runs on the homelab)
ops/                     Cloudflare notification policies, as code
```

`docs/status.json` is a machine-readable mirror of the page, so a probe or a
script can read the same truth the humans read.

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
