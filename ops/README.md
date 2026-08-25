# Cloudflare notifications

Cloudflare will tell you your Workers are erroring, your Pages deploys are
failing, and that Cloudflare itself is having a bad day — but only per account,
and only if someone configured it. Augur runs on more than one account, so
"configured" is not a single act.

`cf-alerts.mjs` declares what every account should carry and creates what is
missing. It never deletes.

```sh
export CF_ACCOUNTS="hosted,delta"
export CF_HOSTED_TOKEN=…  CF_HOSTED_ACCOUNT=…  CF_HOSTED_EMAIL=you@example.com
export CF_DELTA_TOKEN=…   CF_DELTA_ACCOUNT=…   CF_DELTA_EMAIL=you@example.com

node ops/cf-alerts.mjs            # what exists vs what should
node ops/cf-alerts.mjs --apply    # create the difference
```

## What it configures

| Policy | Fires when |
|---|---|
| Workers errors | a Workers Observability alert rule trips — error rate, invocation failures — and again when it clears |
| Pages deployment failures | a deploy fails, so the worker or the chrome did not ship |
| Cloudflare is having an incident | major or critical, on Cloudflare's own status feed |

The first one is the delivery half of an error-rate alert. The threshold half
lives in **Workers Observability → Alerts** in the dashboard, where you say what
counts as too many errors on which worker. A notification policy with no
observability rule behind it is a phone that never rings; a rule with no policy
is an alarm in an empty room. Both halves, per account.

## The permission this needs

Reading policies needs nothing special. **Creating** one needs
**Account · Notifications · Edit**, and a token without it fails the POST with a
bare `10000 Authentication error` while every GET keeps working — which reads
exactly like a bug in the script. It is not, and the script says so by name
rather than reporting a partial success as a success. Creating the observability
*rules* additionally needs **Account · Workers Observability · Edit**.

Add both rows in the Cloudflare dashboard: My Profile → API Tokens → edit the
token → add the permission → Continue → Save. Then re-run with `--apply`.

## Where alerts can go

On a free plan the only eligible destination is **email**. Webhooks and PagerDuty
need a paid plan, so there is no direct push channel from Cloudflare to a phone
— the mail has to land in an inbox with notifications turned on, or the
Cloudflare mobile app has to be installed and signed in to that account.

This is also why the synthetic probes in `../probes/` are not redundant with
these alerts. Cloudflare's notifications are the platform telling you about
itself; the probes are somebody else checking, from somewhere else, with a
channel Cloudflare does not own.

---

# Backups that do not need a CI runner

`kv-backup.mjs`, `store-backup.mjs` and `run-backups.sh` take the two copies an
Augur instance cannot be rebuilt without, from cron on a machine that is neither
GitHub nor Cloudflare.

```sh
sudo install -m 755 ops/kv-backup.mjs ops/store-backup.mjs ops/run-backups.sh /opt/augur-backups/
sudo install -m 600 ops/augur-backups.env.example /etc/augur-backups.d/<instance>.env   # then fill it in

/opt/augur-backups/run-backups.sh --check      # read everything, write nothing
/opt/augur-backups/run-backups.sh              # the nightly run
10 3 * * * /opt/augur-backups/run-backups.sh >> /var/lib/augur-backups/cron.log 2>&1
```

One `.env` per instance in `/etc/augur-backups.d/`, so adding an instance is
adding a file. Each run writes `status.json`, which belongs in
`/opt/monitoring/manifest.json` `cron_artifacts` at `max_age_min: 1560` — a
backup nobody is watching is a backup that stops.

## Why not the workflows that already exist

Each deploy shell carries `kv-backup.yml` and `store-backup.yml`. They are GitHub
Actions jobs, so an org whose Actions billing lapses has no backups at all and
nothing says so: the site keeps serving, and the first symptom is the day you
need a restore. These run the same two copies with no CI in the path. Leave the
workflows in place — if billing comes back they resume, and two copies is not a
problem.

## Why not their destination either

`kv-backup.yml` commits its export to an orphan `kv-backups` branch in the deploy
shell. **Do not reproduce that.** A public fork of the engine once carried 24
daily exports of a client's production KV — real names, personal addresses,
internal discussion, a `users:secrets` entry — reachable unauthenticated, and
because GitHub shares objects across a fork network it stayed fetchable through
the *parent* repo's URL after the branch was deleted. Only a Support purge closes
that.

A KV export is a credential: it holds password hashes and publish tokens.
`kv-backup.mjs` refuses to write anywhere inside a git tree for that reason.

## The bug both older paths had

Every export path in this stack — the workflow's `curl -o` + `jq --rawfile`, the
engine's `/__admin/backup`, and the shells' `kv-export.mjs` — reads each value as
UTF-8 **text**. KV stores arbitrary bytes, and `basset:` / `avatar:` values are
raw image bytes. Decoding those as UTF-8 turns every invalid sequence into
U+FFFD, which does not decode back. On one live instance that was **161 of 272
keys**: present in the backup by name, contents already gone. A 58,784-byte PNG
was being stored as 105,191 bytes of replacement characters.

`kv-backup.mjs` fetches bytes and round-trips them strictly (decode `fatal:true`,
re-encode, compare). Anything that survives is text in `data`, exactly the old
envelope. Anything that does not is base64 in a separate `binary` field, so an
older reader **omits** those keys rather than writing replacement characters over
real images — absent is recoverable, corrupt is not. Restore both halves with
`--restore <file> --into <ns>`; the guard refuses the live namespace without
`--force`.

## Layout, and why history is nearly free

```
/var/lib/augur-backups/<instance>/
  kv/     kv-<date>.json.gz, latest.json.gz -> newest, monthly/, status.json
  store/  blobs/<sha256>            one immutable pool, shared by every snapshot
          snapshots/<date>/         manifests + export.json + blobs -> ../../../blobs
          monthly/<date>/           hard-linked, survives the daily prune
          latest -> snapshots/<date>
```

Blobs are named by their own hash, so two snapshots that share content share
bytes and each snapshot directory is still a valid `augur restore <dir>` target
on its own. `store-backup.yml` uploads a full ~102 MB artifact per run into
GitHub's org-wide storage pool, which is why it could only afford weekly plus
monthly; here the second night costs the delta, so the cadence is nightly and the
retention is a fortnight. The pool is swept after the prune, against every
surviving manifest.

## What this is not

Off-site. Everything lands on one machine. That survives Cloudflare losing a
namespace or a bucket and does not survive losing the machine. Plan item **D-2**
— one nightly copy to versioned, object-locked storage where last night's copy
cannot be deleted tonight by anything holding today's credentials — is the real
answer, and this is the interim that stops the bleeding until the bucket exists.
