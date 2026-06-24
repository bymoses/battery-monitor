# Battery Monitor

![Battery Monitor screenshot](docs/assets/screenshot.png)

Low-overhead Bun service that records laptop battery discharge snapshots and estimates which apps/processes are responsible. It serves a local interactive stacked chart.

## Run

```bash
cd /home/user/workspace/bms/devices/battery-monitor
docker compose -f compose.yml up -d --build
```

Open: <http://127.0.0.1:3033>

## What it does

- Polls every **30 seconds** (`POLL_INTERVAL_SECONDS=30`).
- Always stores a small battery sample.
- Stores process snapshots only when unplugged by default (`RECORD_WHEN_PLUGGED=false`).
- Reads host battery data from `/sys/class/power_supply` via a read-only `/sys` mount.
- Reads host process data from `/proc` with `pid: host`.
- Includes its own Bun process as `battery-monitor` so you can verify it stays cheap.
- Groups related helper processes under app families, e.g. Zen web content/extensions under `Zen Browser`, and container descendants under `Docker`.
- Has a `Groups` tab with aggregated per-group usage and expandable subprocess contribution.
- Keeps an explicit adaptive `System / baseline` row so idle/platform watts are not blamed on apps.
- Captures screen/theme/media context: brightness, light/dark theme, fan RPM when exposed by the kernel, audio playback state, network rate, probable browser video streaming, and optional focused-window metadata.

Per-group watts are estimates from process samples. Linux exposes total battery draw, not exact watts per PID/tab, so the monitor attributes dynamic power from CPU time + disk I/O deltas.

## Low-drain choices

- Single Bun process, no frontend framework, no background workers.
- 30s polling interval.
- SQLite writes once per poll.
- No eBPF/perf/GPU polling by default.
- Docker limits: `cpus: 0.25`, `mem_limit: 128m`.
- Process rows are skipped while plugged unless configured otherwise.

## Configuration

Important environment variables in `compose.yml`:

| Variable | Default | Meaning |
|---|---:|---|
| `POLL_INTERVAL_SECONDS` | `30` | Poll interval. |
| `RECORD_WHEN_PLUGGED` | `false` | Also store process snapshots when AC is connected. |
| `BASELINE_MODE` | `adaptive` | Uses lowest recent discharge draw as baseline, clamped below. Use another value for fixed `BASELINE_WATTS`. |
| `BASELINE_WATTS` | `4` | Fixed fallback baseline watts. |
| `BASELINE_MIN_WATTS` | `2` | Adaptive baseline lower clamp. |
| `BASELINE_MAX_WATTS` | `6` | Adaptive baseline upper clamp. |
| `HOST_CONFIG_DIR` | `/host/config` | Read-only mounted desktop config for light/dark theme detection. |
| `FOCUSED_WINDOW_FILE` | `/data/focused-window.json` | Read focused-window JSON written by optional host helper. |
| `VIDEO_RX_MBPS_THRESHOLD` | `1` | Browser video-stream heuristic network RX threshold. |
| `MAX_PROCESSES_PER_SAMPLE` | `0` | `0` stores all active processes; positive value stores top N plus self. |
| `RETENTION_DAYS` | `14` | Deletes older samples hourly. |
| `FORCE_COLLECT` | `false` | Useful on desktops or for testing without battery. |

## Focused window tracking

Wayland does not expose focused windows generically to containers. For niri, run this tiny host helper in your user session:

```bash
cd /home/user/workspace/bms/devices/battery-monitor
./scripts/focused-window-niri.sh
```

It writes `data/focused-window.json`; the Docker service imports it on the next 30s poll.

## Data

SQLite database is stored at:

```text
./data/battery-monitor.sqlite
```

Tables:

- `battery_samples`
- `process_samples` legacy denormalized rows, pruned by retention
- `process_identities` process/app/cmd text stored once
- `process_samples_v2` compact per-sample numeric process rows
- `environment_samples`

## Native development

```bash
cd /home/user/workspace/bms/devices/battery-monitor
bun run check
PORT=13030 FORCE_COLLECT=true POLL_INTERVAL_SECONDS=5 bun run start
```
