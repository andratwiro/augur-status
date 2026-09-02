# Synthetic probes

Three questions, asked from outside Cloudflare every three minutes:

| Probe | What it does | The failure it exists for |
|---|---|---|
| `serving` | `GET /`, expects 200 and a fingerprint only a composed page contains | the worker is gone, DNS is wrong, Cloudflare is serving its own error page, the build shipped nothing |
| `login` | `POST /__auth` with a dedicated **viewer** account, expects `303` + a session cookie named `__Host-augur_user` (⏳ the older `__Host-gv_user` is accepted too while instances take the rename; `T_<NAME>_COOKIE_NAME` overrides per target) | the password store is unreachable — it fails closed, so everyone is locked out while the homepage still looks perfect |
| `publish` | the write path, in two lanes | publishing is broken and nobody notices until someone tries to ship |

The third one is the one people skip, and it is the one that matters. A site can
serve yesterday's bytes beautifully for a week while every attempt to change them
fails.

**Fast lane** (every run): authenticate, `check` (which reads every live manifest
out of R2), `PUT` a blob (a real R2 write), read the manifest back, and confirm
`/_build.json` agrees with the store about the live version. The blob is a
constant string, so content addressing makes it the same object every time
instead of a fresh one every three minutes forever.

**Slow lane** (hourly by default): re-commit the live manifest to itself,
unchanged, and watch `/_build.json` advance. That is a genuine end-to-end publish
— the CAS, the unpublish guard, composition, the manifest write, routing
derivation, the cache purge — and it changes not one served byte. Measured on
tenant zero: commit to live in **1.2–1.6 s**.

The commit carries `baseVersion`, so if a real publish lands in the same instant
the store refuses the probe (`409 stale-base`) instead of the probe stepping on a
person. A raced probe counts as a **pass** — nothing was lost, which is exactly
the behaviour under test.

## Cost, stated plainly

Every slow-lane commit writes a manifest version, and manifest versions are never
pruned. Hourly on a 14 KB manifest is about 120 MB a year and 24 version numbers
a day between the real publishes in the rollback list. Probe versions are
labelled `publishedBy: uptime-probe`, so they are easy to skip past. Turn the dial
with `COMMIT_EVERY_MIN`: down if a broken publish path matters more than a tidy
rollback menu, up if the reverse.

## Alerting

Two consecutive failures alert; a single blip is weather. Recovery sends its own
message. A run in which no neutral canary host (none of them on Cloudflare) answers
is skipped without touching the counters: the box has no uplink, which is the
homelab's outage, not Augur's. Alerts go to Telegram — the channel the box already uses for machine
alerts, so this needs nothing installed on the phone — and optionally to an ntfy
topic as well.

## Install

```sh
sudo mkdir -p /opt/augur-probes /var/lib/augur-probes
sudo chown "$USER" /opt/augur-probes /var/lib/augur-probes
install -m 755 augur-probe.py /opt/augur-probes/
sudo install -m 600 -o "$USER" augur-probes.env.example /etc/augur-probes.env
$EDITOR /etc/augur-probes.env          # hostnames, tokens, Telegram

/opt/augur-probes/augur-probe.py --report       # dry run, alerts nothing, writes nothing
/opt/augur-probes/augur-probe.py --test-alert   # prove the phone works

crontab -e
*/3 * * * * /opt/augur-probes/augur-probe.py >> /var/lib/augur-probes/cron.log 2>&1
```

`--report` deliberately skips the commit lane, because it is a dry run and that
is the one probe that writes. Force it with `--commit`.

## Credentials it needs, and why they are the weak ones

- **A viewer account.** Viewers sign in and can hold no publish token at all, so
  leaking this pair costs a session and nothing else. Never point the login probe
  at a real person's account: a probe that hammers `/__auth` shares the login
  rate-limit bucket with that person.
- **A publish token scoped to one space**, minted in the admin panel and labelled
  so it is obvious what it is. Never a `augur login` token — those are
  star-scoped and can push the instance's user list.

Neither belongs in this repo. They live in `/etc/augur-probes.env`, mode 600.

## Dead man

The runner rewrites `/var/lib/augur-probes/status.json` on **every** run, pass or
fail, so "the prober stopped running" looks different from "the prober is happy".
On the homelab that file is registered in `/opt/monitoring/manifest.json` under
`cron_artifacts` with a 12-minute ceiling, which is the box's standard way of
noticing a cron job that quietly died.

`status.json` also carries the four component states in the same vocabulary the
status page uses, which is the seam for wiring the two together later.

## The drill

Point a target's `ORIGIN` at a URL that cannot work, run twice, confirm the phone
buzzes; put it back, run once, confirm the recovery message. Use a scratch state
directory so the real counters are untouched:

```sh
sed 's|^T_DELTA_ORIGIN=.*|T_DELTA_ORIGIN=https://augur.example.com/nope|' \
  /etc/augur-probes.env > /tmp/broken.env
AUGUR_PROBE_CONF=/tmp/broken.env AUGUR_PROBE_STATE=/tmp/drill /opt/augur-probes/augur-probe.py
AUGUR_PROBE_CONF=/tmp/broken.env AUGUR_PROBE_STATE=/tmp/drill /opt/augur-probes/augur-probe.py  # alerts here
AUGUR_PROBE_STATE=/tmp/drill /opt/augur-probes/augur-probe.py                                   # recovers here
rm -rf /tmp/broken.env /tmp/drill
```
