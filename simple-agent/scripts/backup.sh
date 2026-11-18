#!/bin/bash
# co|op bot backup: copies everything the bot can't rebuild into one dated, private archive.
#
#   What's in it:  data/ (businesses + agents, notes, encrypted connections, models list)
#                  workspaces/ (files the agent made for each business)  -- skip with --no-workspaces
#                  any of those files you moved elsewhere with .env settings
#   What's NOT:    .env and your encryption keys. Keep TOKEN_ENCRYPTION_KEY and TOOLCONN_KEY in a password
#                  manager: without them the saved connections in the backup can't be decrypted (by anyone,
#                  including you), which is also why a stolen backup alone doesn't expose them.
#
#   Where:         ~/coop-backups  (or set BACKUP_DIR=/Volumes/MyDrive/coop-backups)
#   How many:      keeps the newest 8 (or set KEEP=12)
#
# Usage:  ./scripts/backup.sh                 back up now
#         ./scripts/backup.sh --no-workspaces  just the data (small)
#         ./scripts/backup.sh --list           show existing backups

set -euo pipefail
umask 077

BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-$HOME/coop-backups}"
KEEP="${KEEP:-8}"
WITH_WS=1

for arg in "$@"; do
  case "$arg" in
    --no-workspaces) WITH_WS=0 ;;
    --list) ls -lh "$DEST"/coop-backup-*.tar.gz 2>/dev/null || echo "No backups in $DEST yet."; exit 0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

case "$KEEP" in ''|*[!0-9]*) echo "KEEP must be a number"; exit 2 ;; esac
[ "$KEEP" -ge 1 ] || { echo "KEEP must be at least 1"; exit 2; }

# read a path setting from .env WITHOUT running .env (it holds secrets; we never source it)
env_path() {
  [ -f "$BOT_DIR/.env" ] || return 0
  { grep -E "^[[:space:]]*$1[[:space:]]*=" "$BOT_DIR/.env" || true; } | tail -n 1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//; s/^["'\'']//; s/["'\'']$//'
}

# what to include (paths relative to the bot folder when they live inside it)
items=()
[ -d "$BOT_DIR/data" ] && items+=("data")
if [ "$WITH_WS" = 1 ]; then
  ws="$(env_path WORKSPACES_DIR)"
  if [ -n "$ws" ]; then items+=("$ws"); elif [ -d "$BOT_DIR/workspaces" ]; then items+=("workspaces"); fi
fi
for key in TENANTS_FILE CONNECTIONS_FILE NOTES_FILE MODELS_FILE; do
  p="$(env_path "$key")"
  [ -n "$p" ] && items+=("$p")
done

# drop anything missing, anything that is .env, and duplicates
final=()
for it in "${items[@]}"; do
  case "$(basename "$it")" in .env|.env.*) continue ;; esac
  if [ -e "$it" ] || [ -e "$BOT_DIR/$it" ]; then
    dup=0; for f in "${final[@]:-}"; do [ "$f" = "$it" ] && dup=1; done
    [ "$dup" = 0 ] && final+=("$it")
  fi
done

if [ "${#final[@]}" -eq 0 ]; then
  echo "Nothing to back up: no data/ folder found in $BOT_DIR. Is this the simple-agent folder?"
  exit 1
fi

mkdir -p "$DEST"
chmod 700 "$DEST"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$DEST/coop-backup-$stamp.tar.gz"

# leave out lock/temp files and the crash marker; follow nothing outside what's listed
tar -C "$BOT_DIR" -czf "$out" \
  --exclude='*.tmp-*' --exclude='.running' --exclude='.DS_Store' --exclude='.env' --exclude='.env.*' \
  "${final[@]}" 2> >(grep -v "Removing leading" >&2)
chmod 600 "$out"

# check the archive reads back, and that no .env slipped in
if ! listing="$(tar -tzf "$out")"; then
  echo "Backup FAILED: the archive can't be read back. Removing it."; rm -f "$out"; exit 1
fi
if printf '%s\n' "$listing" | grep -Eq '(^|/)\.env($|\.)'; then
  echo "Backup FAILED safety check (.env found). Removing it."; rm -f "$out"; exit 1
fi
files="$(printf '%s\n' "$listing" | grep -vc '/$' || true)"

# keep the newest $KEEP
old="$(ls -1t "$DEST"/coop-backup-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" || true)"
if [ -n "$old" ]; then printf '%s\n' "$old" | while IFS= read -r f; do rm -f "$f"; done; fi

size="$(du -h "$out" | cut -f1)"
count="$(ls -1 "$DEST"/coop-backup-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')"
echo "Backup saved: $out ($size, $files files). Keeping $count of the newest $KEEP."
echo "Reminder: TOKEN_ENCRYPTION_KEY and TOOLCONN_KEY are NOT in backups. Keep them in your password manager."
