# Offsite backup — where last night's copy cannot be deleted tonight

`../kv-backup.mjs` and `../store-backup.mjs` put a copy on this machine. That survives
Cloudflare losing a namespace or a bucket, and it does not survive losing the machine.
This directory is the other half: one copy per workspace in an S3 bucket with **Object
Lock and versioning enabled at creation**, so a credential that can write tonight's copy
cannot take away last night's — not by mistake, not by ransomware, not as root.

Plan item **`D-2-hosted-namespace-backup`**. It exists because of a specific day:

> On 28 Aug 2026 a migration attempt destroyed a live hosted workspace's identity
> documents — `publish:tokens`, `users:roster`, `users:names`, `users:avatars`,
> `spaces:icons`. Almost everything was rebuilt from values still open in a session. One
> publish token was not, because it existed nowhere else. **There was nothing to restore
> from.**

## Use

```sh
node ops/offsite/offsite-backup.mjs --check          # prove the lock, upload nothing
node ops/offsite/offsite-backup.mjs --slot nightly   # take the copy
node ops/offsite/fetch-backup.mjs --list --tenant <workspace>
node ops/offsite/fetch-backup.mjs --out /tmp/recover --tenant <workspace>
node ops/offsite/restore-kv.mjs /tmp/recover/kv.json --into <fresh-namespace-id> --verify
node ops/offsite/restore-drill.mjs                   # ⭐ prove the whole loop, on a throwaway
```

`run.sh` is the cron entry point: one `.env` per instance in `/etc/augur-backups.d/`,
the same files `../run-backups.sh` reads. **An instance whose file names no
`BACKUP_S3_BUCKET` is skipped**, so installing this changes nothing for an instance that
only has the local copy.

## What a copy contains, and the one word that decides it

| part | what |
|---|---|
| `store.tar.gz` | `augur export --full` — manifests, content blobs, **and** `state.json` + `assets/`: roster overlay, invites, publish tokens, statuses, card names, comment threads, boards, pins, canvas images |
| `kv.json.gz` | the whole KV namespace, values carried as **bytes** (base64 when they are not UTF-8) |
| `roster.tar.gz` | the shell's `identity.json` + `deploy.config.json`, when there is a shell |
| `backup.json` | the index: sha256 and version id of every part, family and blob counts, and this run's lock evidence |

⚠️ **`--full` is the default here and is not the default in the engine.** Without it,
`augur export` copies published content and nothing else — not who could publish it, not
who had been invited, not a comment, not a board. That was the entire backup of the live
hosted workspace on 28 Aug, and the engine prints a yellow *"content only — pass --full"*
line on every run that nobody had read. `--no-full` still exists and is recorded in the
index, so a content-only copy can never be mistaken for a whole one.

⚠️ **One prefix per WORKSPACE, never per deployment.** The shared hosted worker serves
many workspaces from one script and one KV namespace. `tenants/<workspace>/…` is what
makes restoring one of them possible; there is deliberately no `default` fallback, and
the job stops rather than guess.

## The lock is proven on every run, not configured once

1. the bucket must report Object Lock **and** versioning, or the job stops;
2. a throwaway canary is written with this run's retention and a **version-addressed**
   delete of it is attempted. Refused → carry on. Allowed → upload nothing and fail;
3. after upload, the same permanent delete is attempted against the **previous** run's
   index. That is the assertion that matters.

An unversioned `DELETE` proves nothing: it writes a delete marker and destroys nothing.
And the verdict is read off the object afterwards, not taken from the status code —
providers disagree (Backblaze 403 `AccessDenied`, MinIO 400 `InvalidRequest`).

⚠️ The lock mode is **COMPLIANCE**. Nobody can shorten or lift a retention, root
included. That is what makes it WORM and it is also what makes a mistake permanent:
anything uploaded is storage paid for until its retention expires, and a bad upload
cannot be cleaned up, only waited out.

## `restore-drill.mjs` — the part that is easy to fake

A restore nobody has executed is not a rollback. The drill creates a scratch KV
namespace, seeds it with the seven documents 28 Aug lost, takes a **real** offsite copy
of it, then **destroys three and overwrites four with a sentinel**, then fetches the copy
back down from the bucket and replays it, then compares.

**The mutation is the whole point.** Back up and immediately restore, and a restore that
did nothing at all produces exactly the same bytes as one that worked. Both read green.
The sentinel has to be gone for the run to pass.

⚠️ **And every read is the Cloudflare account API, and even that is cached.** A worker's
`kv.get` carries a 60-second cache TTL, so verifying through the site can hand you
pre-restore bytes and call them a match. The account API is the authority — and it is
*also* cached for about 60 s, with the cache filled **by a read**, so the drill's own
baseline read is what makes the following minute stale. Measured here: an overwrite of a
just-read key was still invisible 38 s later. There is no read path that is both
immediate and authoritative; what makes the answer trustworthy is the sentinel (a stale
read can only produce a false *red*) plus outwaiting the TTL.

`restore-kv.mjs --verify` retries a mismatch for the same reason. Without that it failed
a **sound** restore — three of nine keys read as their pre-restore selves — which is a
false red at 3am on the one command whose job is telling an operator whether their data
came back.

## Installing on the homelab

```sh
sudo install -d -o "$USER" -g "$USER" -m 755 /opt/augur-offsite
rsync -az ops/offsite/ /opt/augur-offsite/
git clone --depth 1 https://github.com/andratwiro/augur.git /opt/augur-offsite/engine
sudo install -m 600 -o "$USER" <filled-in>.env /etc/augur-backups.d/<instance>.env
/opt/augur-offsite/run.sh --check
```

```cron
50 3 * * * /opt/augur-offsite/run.sh >> /var/lib/augur-backups/offsite.log 2>&1
```

`/var/lib/augur-backups/offsite-status.json` is the dead-man and belongs in
`/opt/monitoring/manifest.json` `cron_artifacts` at `max_age_min: 1560` — a backup nobody
is watching is a backup that stops. The engine is a plain clone here rather than a
submodule; `git -C /opt/augur-offsite/engine pull --ff-only` keeps it current, and an
engine older than the export it is asked for makes the job **fail** rather than file a
short copy.

### The instance `.env`

```
AUGUR_INSTANCE=<label>          BACKUP_TENANT=<workspace>
AUGUR_ORIGIN=https://…          AUGUR_TOKEN=<STAR-scope publish token>
CLOUDFLARE_API_TOKEN=           CLOUDFLARE_ACCOUNT_ID=      AUGUR_KV_NS=
BACKUP_S3_KEY_ID=  BACKUP_S3_SECRET=  BACKUP_S3_BUCKET=  BACKUP_S3_ENDPOINT=
AUGUR_SHELL_ROOT=/opt/augur-offsite   AUGUR_ENGINE_DIR=/opt/augur-offsite/engine
```

⚠️ `BACKUP_S3_ENDPOINT` must be set explicitly. Absent, the script asks **Backblaze**
which region the key lives in, which cannot answer for a Scaleway bucket. And the script
reads `BACKUP_S3_*` (falling back to `B2_*`); it does **not** read `SCW_*`, so a key
filed under the Scaleway-shaped names alone leaves the job reporting an unset
destination rather than failing loudly.

## Why it is not a GitHub Action

The deployment this exists for is the shared hosted worker, whose deploy shell
`augur-deploy-hosted` **has no git remote** — so there is no repository a scheduled
Action could live in. A workflow is committed there ready for the day it gets one, and
it checks this repo out rather than copying these files, so the two cannot drift.

Cron on a machine that is neither GitHub nor Cloudflare is also simply the better place:
an org whose Actions billing lapses has no backups and nothing says so, because the site
keeps serving and the first symptom is the day you need a restore.
