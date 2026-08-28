#!/usr/bin/env bash
# run.sh — the nightly offsite copy, one instance at a time, from cron.
#
#   /opt/augur-offsite/run.sh                 every instance that has a bucket
#   /opt/augur-offsite/run.sh <instance>      just that one
#   /opt/augur-offsite/run.sh --check         prove the lock, upload nothing
#   /opt/augur-offsite/run.sh --slot monthly  fill the old slot instead
#
# ── WHY THIS RUNS HERE AND NOT IN CI ────────────────────────────────────────────
#
# The instance this exists for is `augur-deploy-hosted`, the deploy shell of the
# shared worker that serves every hosted workspace. THAT SHELL HAS NO GIT REMOTE and
# no `.github/` at all, so there is no repository for a scheduled Action to live in.
# A workflow file is committed there anyway, ready for the day it gets a remote — and
# a workflow that cannot fire is not a backup, so this is the path that runs today.
#
# It is also the better home on its own merits: cron on a machine that is neither
# GitHub nor Cloudflare has no third party in it at all, which is the whole argument
# of ../README.md's "Backups that do not need a CI runner".
#
# ── IT SHARES ITS CONFIG WITH run-backups.sh AND DOES NOT SHARE ITS CODE ────────
#
# One `.env` per instance in /etc/augur-backups.d/, exactly as the local nightly copy
# reads them — adding an instance is adding a file. An instance whose file names no
# `BACKUP_S3_BUCKET` IS SKIPPED, silently and on purpose: that is how an instance can
# have the local copy and not the offsite one without either job needing to know
# about the other, and it is why installing this changes nothing for an instance that
# was already being backed up locally.
#
# Deliberately a SECOND script rather than three more lines in run-backups.sh. That
# script is the only backup a live client instance has; a syntax error in an edit to
# it would take that away tonight, silently, to add a feature that instance does not
# use. The two should be folded together once this has run clean for a week — the
# same rule the offsite job's own header applies to the jobs it supersedes.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${AUGUR_BACKUP_CONF_DIR:-/etc/augur-backups.d}"
STATE_DIR="${AUGUR_OFFSITE_STATE:-/var/lib/augur-backups}"
PROBE_ENV="${AUGUR_PROBE_CONF:-/etc/augur-probes.env}"
NODE="${NODE:-node}"

ONLY=""; CHECK=""; SLOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK="--check" ;;
    --slot)  shift; SLOT="$1" ;;
    --*)     echo "unknown flag: $1" >&2; exit 2 ;;
    *)       ONLY="$1" ;;
  esac
  shift
done

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say()   { echo "$(stamp) $*"; }

notify() {
  local text="$1" tok chat
  # Read ONLY the two variables needed, rather than sourcing a file full of other
  # instances' credentials into this shell.
  tok="$(sed -n 's/^TG_BOT_TOKEN=//p' "$PROBE_ENV" 2>/dev/null | tr -d '"'"'"' ' | head -1)"
  chat="$(sed -n 's/^TG_CHAT_ID=//p' "$PROBE_ENV" 2>/dev/null | tr -d '"'"'"' ' | head -1)"
  if [ -z "$tok" ] || [ -z "$chat" ]; then
    say "NO ALERT CHANNEL — would have sent: $text"
    return
  fi
  curl -sS --max-time 15 -o /dev/null \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" \
    "https://api.telegram.org/bot${tok}/sendMessage" || say "telegram send failed"
}

shopt -s nullglob
CONFS=("$CONF_DIR"/*.env)
if [ ${#CONFS[@]} -eq 0 ]; then
  say "no instance configs in $CONF_DIR — nothing to copy offsite"
  exit 1
fi

mkdir -p "$STATE_DIR"
FAILED=(); RAN=0; SKIPPED=()

for conf in "${CONFS[@]}"; do
  name="$(basename "$conf" .env)"
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue

  if ! grep -q '^BACKUP_S3_BUCKET=..*' "$conf"; then
    SKIPPED+=("$name")
    continue
  fi
  RAN=$((RAN + 1))

  # A subshell per instance: one instance's credentials never reach the next one's
  # process, and a `set -a` here cannot leak into the loop.
  (
    set -a
    # shellcheck disable=SC1090
    . "$conf"
    set +a
    : "${AUGUR_INSTANCE:=$name}"
    export AUGUR_INSTANCE
    say "── $AUGUR_INSTANCE → ${BACKUP_S3_BUCKET}"
    # shellcheck disable=SC2086
    $NODE "$HERE/offsite-backup.mjs" ${SLOT:+--slot "$SLOT"} $CHECK
  )
  rc=$?
  if [ $rc -ne 0 ]; then FAILED+=("$name"); fi
done

if [ ${#SKIPPED[@]} -gt 0 ]; then
  say "skipped (no BACKUP_S3_BUCKET, local copy only): ${SKIPPED[*]}"
fi

if [ "$RAN" -eq 0 ]; then
  say "no instance in $CONF_DIR has an offsite destination${ONLY:+ matching '$ONLY'}"
  exit 2
fi

# The dead-man. Registered in /opt/monitoring/manifest.json `cron_artifacts` — a
# backup nobody is watching is a backup that stops.
# `printf '"%s",' "${EMPTY[@]}"` still prints one `""` — which put a nameless failure in
# the first status file this wrote, i.e. a green run that reported a casualty.
json_list() { [ $# -eq 0 ] && { printf ''; return; }; printf '"%s",' "$@" | sed 's/,$//'; }
printf '{"job":"offsite-backup","at":"%s","ok":%s,"ran":%d,"failed":[%s],"skipped":[%s]}\n' \
  "$(stamp)" "$([ ${#FAILED[@]} -eq 0 ] && echo true || echo false)" "$RAN" \
  "$(json_list ${FAILED[@]+"${FAILED[@]}"})" \
  "$(json_list ${SKIPPED[@]+"${SKIPPED[@]}"})" \
  > "$STATE_DIR/offsite-status.json"

if [ ${#FAILED[@]} -gt 0 ]; then
  say "FAILED: ${FAILED[*]}"
  [ -z "$CHECK" ] && notify "$(printf 'Augur OFFSITE backup FAILED for: %s\n\nThere is no copy of that instance outside Cloudflare tonight. Log: %s/offsite.log' "${FAILED[*]}" "$STATE_DIR")"
  exit 1
fi

say "offsite ok ($RAN instance(s))"
