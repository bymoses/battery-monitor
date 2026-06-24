#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/battery-monitor-focused-window.service"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Battery Monitor focused window helper for niri
Documentation=https://github.com/bymoses/battery-monitor
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/focused-window-niri.sh
Restart=always
RestartSec=5
Environment=FOCUSED_WINDOW_INTERVAL_SECONDS=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now battery-monitor-focused-window.service
systemctl --user status battery-monitor-focused-window.service --no-pager --lines=8
