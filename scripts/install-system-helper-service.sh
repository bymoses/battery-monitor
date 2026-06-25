#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="battery-monitor-system-helper.service"
OLD_UNIT_NAME="battery-monitor-focused-window.service"
UNIT="$UNIT_DIR/$UNIT_NAME"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Battery Monitor system helper
Documentation=https://github.com/bymoses/battery-monitor
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/battery-monitor-system-helper.sh
Restart=always
RestartSec=5
Environment=BATTERY_MONITOR_SESSION_INTERVAL_SECONDS=5
Environment=FOCUSED_WINDOW_FILE=$ROOT/data/focused-window.json
Environment=DESKTOP_STATE_FILE=$ROOT/data/desktop-state.json

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
# Migrate the old focused-window-only unit name if it exists.
systemctl --user disable --now "$OLD_UNIT_NAME" >/dev/null 2>&1 || true
systemctl --user enable --now "$UNIT_NAME"
systemctl --user restart "$UNIT_NAME"
systemctl --user status "$UNIT_NAME" --no-pager --lines=8
