#!/bin/bash
# Turn the weekly backup on or off (macOS). Runs scripts/backup.sh every Sunday at 3:17 AM.
# If the Mac is asleep then, macOS runs it the next time it wakes.
#
#   ./scripts/backup-schedule.sh on       turn it on (safe to run again)
#   ./scripts/backup-schedule.sh off      turn it off
#   ./scripts/backup-schedule.sh status   is it on? when did it last run?
#
# BACKUP_DIR and KEEP, if set when you run "on", are remembered for the weekly runs.

set -euo pipefail
LABEL="com.coop.bot-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$BOT_DIR/scripts/backup.sh"
DEST="${BACKUP_DIR:-$HOME/coop-backups}"
LOG="$DEST/backup.log"

[ "$(uname)" = "Darwin" ] || { echo "This schedule uses macOS launchd. On Linux, add a weekly cron job for $SCRIPT instead."; exit 1; }

# escape for the XML file
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

case "${1:-}" in
  on)
    chmod +x "$SCRIPT"
    mkdir -p "$HOME/Library/LaunchAgents" "$DEST"
    chmod 700 "$DEST"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml "$SCRIPT")</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BACKUP_DIR</key><string>$(xml "$DEST")</string>
    <key>KEEP</key><string>$(xml "${KEEP:-8}")</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>3</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Weekly backup is ON: Sundays at 3:17 AM into $DEST (log: $LOG)."
    echo "Running one now to make sure it works..."
    BACKUP_DIR="$DEST" /bin/bash "$SCRIPT"
    ;;
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Weekly backup is OFF. Existing backups in $DEST were not touched."
    ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "Weekly backup: ON (Sundays 3:17 AM)"; else echo "Weekly backup: OFF"; fi
    ls -1t "$DEST"/coop-backup-*.tar.gz 2>/dev/null | head -n 3 | sed 's/^/  latest: /' || true
    [ -f "$LOG" ] && { echo "  last log lines:"; tail -n 3 "$LOG" | sed 's/^/    /'; }
    ;;
  *) echo "Usage: $0 on | off | status"; exit 2 ;;
esac
