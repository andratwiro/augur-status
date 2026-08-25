#!/usr/bin/env bash
# run-backups.sh — the nightly Augur backup run, one instance at a time.
#
#   /opt/augur-backups/run-backups.sh              every configured instance
#   /opt/augur-backups/run-backups.sh go-vocal     just that one
#   /opt/augur-backups/run-backups.sh --check      read everything, write nothing
#
# One .env per instance in /etc/augur-backups.d/ (mode 600), so adding an instance
# is adding a file — no edit to this script, and no instance name compiled into it.
# Each file sets:
#
#   AUGUR_INSTANCE          the label that names the destination directory
#   AUGUR_ORIGIN            the site origin, for the bundle store copy
#   AUGUR_TOKEN             a publish token that can read this instance's manifests
#   CLOUDFLARE_API_TOKEN    account credentials, for the KV copy
#   CLOUDFLARE_ACCOUNT_ID
#   AUGUR_KV_NS             the namespace id the instance's worker is bound to
#   AUGUR_EXPECT_SKIPPED    (optional) unit ids whose absence from the store copy
#                           is deliberate — anything else missing fails the run
#
# Why a shell wrapper rather than two cron lines: the two copies are one backup.
# If the KV export fails and the store export succeeds, the night still produced an
# incomplete answer to "can we rebuild this instance", and the alert should say that
# once, with both results in it, rather than half a truth per job.
#
# ── ALERTING ────────────────────────────────────────────────────────────────────
#
# The same Telegram channel the uptime probes use, read from /etc/augur-probes.env,
# because a second alert channel is a second thing to keep alive. A failed run
# alerts every night until it succeeds: unlike an outage, nobody is already
# looking at a backup that silently stopped — that is precisely the failure mode
# this whole exercise exists to close.
#
# ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────
#
# Off-siting. Everything lands on this box, mode 600, outside every git tree. That
# is enough to survive Cloudflare losing a namespace or a bucket, and not enough to
# survive losing this box. Plan item D-2 (versioned, object-locked, off-site) is the
# real answer and this is the interim that stops the bleeding until it exists.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${AUGUR_BACKUP_CONF_DIR:-/etc/augur-backups.d}"
DEST_ROOT="${AUGUR_BACKUP_DEST:-/var/lib/augur-backups}"
PROBE_ENV="${AUGUR_PROBE_CONF:-/etc/augur-probes.env}"
NODE="${NODE:-/usr/bin/env node}"

ONLY=""
CHECK=""
for a in "$@"; do
  case "$a" in
    --check) CHECK="--check" ;;
    --*)     echo "unknown flag: $a" >&2; exit 2 ;;
    *)       ONLY="$a" ;;
  esac
done

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say()   { echo "$(stamp) $*"; }

notify() {
  local text="$1" tok="" chat=""
  # Read ONLY the two variables we need, rather than sourcing a file full of
  # other instances' credentials into this shell.
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
  say "no instance configs in $CONF_DIR — nothing to back up"
  exit 1
fi

FAILED=()
RAN=0

for conf in "${CONFS[@]}"; do
  name="$(basename "$conf" .env)"
  [ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && continue
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

    dest="$DEST_ROOT/$AUGUR_INSTANCE"
    mkdir -p "$dest/kv" "$dest/store"
    chmod 700 "$DEST_ROOT" "$dest" "$dest/kv" "$dest/store"

    rc=0
    say "── $AUGUR_INSTANCE: KV namespace"
    $NODE "$HERE/kv-backup.mjs" --dir "$dest/kv" $CHECK || rc=1
    say "── $AUGUR_INSTANCE: bundle store"
    $NODE "$HERE/store-backup.mjs" --dir "$dest/store" $CHECK || rc=1
    exit $rc
  )
  [ $? -ne 0 ] && FAILED+=("$name")
done

if [ "$RAN" -eq 0 ]; then
  say "no instance matched '$ONLY' in $CONF_DIR"
  exit 2
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  say "FAILED: ${FAILED[*]}"
  [ -z "$CHECK" ] && notify "$(printf 'Augur backups FAILED for: %s\n\nNothing new is stored for that instance tonight. Log: /var/lib/augur-backups/cron.log' "${FAILED[*]}")"
  exit 1
fi

say "all backups ok ($RAN instance(s))"
