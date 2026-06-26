#!/usr/bin/env bash
set -euo pipefail

# Battery Monitor system helper for user-session state that containers cannot read
# reliably: focused window, desktop color scheme, and future compositor/session data.
# It writes small JSON files under ./data; the Docker collector imports them.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOCUSED_OUT="${FOCUSED_WINDOW_FILE:-$ROOT/data/focused-window.json}"
DESKTOP_OUT="${DESKTOP_STATE_FILE:-$ROOT/data/desktop-state.json}"
INTERVAL="${BATTERY_MONITOR_SESSION_INTERVAL_SECONDS:-5}"

mkdir -p "$(dirname "$FOCUSED_OUT")" "$(dirname "$DESKTOP_OUT")"

if ! command -v niri >/dev/null 2>&1; then
  echo "niri command not found" >&2
  exit 1
fi
if [[ -z "${NIRI_SOCKET:-}" ]]; then
  echo "NIRI_SOCKET is not set; run this from inside the niri session" >&2
  exit 1
fi

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))'
}

atomic_write() {
  local out="$1"
  local tmp="${out}.tmp"
  cat > "$tmp"
  mv "$tmp" "$out"
}

write_focused_window() {
  local tmp="${FOCUSED_OUT}.tmp"
  if niri msg -j focused-window > "$tmp" 2>/dev/null; then
    mv "$tmp" "$FOCUSED_OUT"
  else
    rm -f "$tmp"
  fi
}

read_audio_state_json() {
  if ! command -v pactl >/dev/null 2>&1; then
    printf '{"playing":null,"browser_playing":null,"apps":[],"media":[],"detail":"pactl not found"}'
    return
  fi
  pactl -f json list sink-inputs 2>/dev/null | python3 -c '
import json, re, sys
try:
    inputs = json.load(sys.stdin)
except Exception as exc:
    print(json.dumps({"playing": None, "browser_playing": None, "apps": [], "media": [], "detail": f"pactl parse failed: {exc}"}))
    raise SystemExit
active = [i for i in inputs if not i.get("corked") and not i.get("mute")]
apps, media = [], []
browser_playing = False
for item in active:
    props = item.get("properties") or {}
    app = str(props.get("application.name") or "")
    binary = str(props.get("application.process.binary") or "")
    name = str(props.get("media.name") or props.get("node.name") or "")
    if app and app not in apps:
        apps.append(app)
    if name and name not in media:
        media.append(name)
    text = f"{app} {binary} {name}".lower()
    if re.search(r"\b(zen|firefox|chrome|chromium|brave|vivaldi|edge|browser)\b", text):
        browser_playing = True
print(json.dumps({
    "playing": bool(active),
    "browser_playing": browser_playing,
    "apps": apps[:8],
    "media": media[:8],
    "detail": ", ".join([*(apps[:3] or ["no active audio"]), *(media[:3])]),
}))
' 2>/dev/null || printf '{"playing":null,"browser_playing":null,"apps":[],"media":[],"detail":"pactl failed"}'
}

write_desktop_state() {
  local color_scheme gtk_theme theme detail audio_state
  color_scheme="$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || true)"
  gtk_theme="$(gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null || true)"
  audio_state="$(read_audio_state_json)"

  case "${color_scheme,,} ${gtk_theme,,}" in
    *prefer-light*|*light*) theme="light" ;;
    *prefer-dark*|*dark*) theme="dark" ;;
    *) theme="unknown" ;;
  esac

  detail="gsettings color-scheme=${color_scheme:-unknown}; gtk-theme=${gtk_theme:-unknown}"
  printf '{"theme":%s,"detail":%s,"color_scheme":%s,"gtk_theme":%s,"audio":%s,"ts":%s}\n' \
    "$(printf '%s' "$theme" | json_escape)" \
    "$(printf '%s' "$detail" | json_escape)" \
    "$(printf '%s' "$color_scheme" | json_escape)" \
    "$(printf '%s' "$gtk_theme" | json_escape)" \
    "$audio_state" \
    "$(date +%s%3N)" | atomic_write "$DESKTOP_OUT"
}

echo "battery-monitor-system-helper: focused=$FOCUSED_OUT desktop=$DESKTOP_OUT interval=${INTERVAL}s" >&2
while true; do
  write_focused_window || true
  write_desktop_state || true
  sleep "$INTERVAL"
done
