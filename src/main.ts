import { Database } from "bun:sqlite";
import { cpus } from "node:os";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "node:fs";

type BatterySample = {
  ts: number;
  onBattery: boolean;
  status: string;
  capacity: number | null;
  energyWh: number | null;
  powerW: number | null;
  source: string;
};

type EnvironmentSample = {
  sampleId: number;
  ts: number;
  theme: string;
  themeDetail: string;
  brightnessPercent: number | null;
  brightnessSource: string;
  audioPlaying: boolean | null;
  audioDetail: string;
  videoStreaming: boolean | null;
  videoDetail: string;
  netRxMbps: number;
  netTxMbps: number;
  focusedApp: string;
  focusedTitle: string;
  focusedPid: number | null;
  lidClosed: boolean | null;
  lidDetail: string;
  screenLocked: boolean | null;
  screenLockDetail: string;
  fanRpm: number | null;
  fanSource: string;
};

type ProcNow = {
  pid: number;
  ppid: number;
  name: string;
  app: string;
  cmd: string;
  ticks: number;
  startTime: number;
  readBytes: number;
  writeBytes: number;
  rssMb: number;
  isSelf: boolean;
};

type SeriesBatteryRow = {
  id: number;
  ts: number;
  capacity: number | null;
  power_w: number | null;
  on_battery: number;
  status: string;
  focused_app: string | null;
  focused_title: string | null;
  focused_pid: number | null;
  lid_closed: number | null;
  lid_detail: string | null;
  screen_locked: number | null;
  screen_lock_detail: string | null;
  brightness_percent: number | null;
  brightness_source: string | null;
  theme: string | null;
  theme_detail: string | null;
  video_streaming: number | null;
  video_detail: string | null;
  net_rx_mbps: number | null;
  net_tx_mbps: number | null;
};

type ProcPrev = Pick<ProcNow, "ticks" | "startTime" | "readBytes" | "writeBytes">;

type ProcRow = ProcNow & {
  cpuPercent: number;
  cpuSeconds: number;
  ioMb: number;
  score: number;
  estimatedWatts: number;
};

const cfg = {
  host: env("HOST", "0.0.0.0"),
  port: intEnv("PORT", 3030),
  pollMs: intEnv("POLL_INTERVAL_SECONDS", 30) * 1000,
  procRoot: env("PROC_ROOT", "/proc"),
  powerRoot: env("SYS_POWER_SUPPLY", "/sys/class/power_supply"),
  dataDir: env("DATA_DIR", path.resolve("data")),
  recordWhenPlugged: boolEnv("RECORD_WHEN_PLUGGED", false),
  forceCollect: boolEnv("FORCE_COLLECT", false),
  retentionDays: intEnv("RETENTION_DAYS", 14),
  baselineMode: env("BASELINE_MODE", "adaptive"),
  baselineWatts: numEnv("BASELINE_WATTS", 4),
  baselineMinWatts: numEnv("BASELINE_MIN_WATTS", 2),
  baselineMaxWatts: numEnv("BASELINE_MAX_WATTS", 6),
  baselineLookbackHours: numEnv("BASELINE_LOOKBACK_HOURS", 24),
  hostConfigDir: env("HOST_CONFIG_DIR", "/host/config"),
  focusedWindowFile: env("FOCUSED_WINDOW_FILE", "/data/focused-window.json"),
  desktopStateFile: env("DESKTOP_STATE_FILE", "/data/desktop-state.json"),
  suspendGapMs: intEnv("SUSPEND_GAP_SECONDS", 120) * 1000,
  videoRxMbpsThreshold: numEnv("VIDEO_RX_MBPS_THRESHOLD", 1),
  maxProcessesPerSample: intEnv("MAX_PROCESSES_PER_SAMPLE", 0),
  clkTck: intEnv("CLK_TCK", 100),
  cpuWeight: numEnv("CPU_WEIGHT", 1),
  ioMbWeight: numEnv("IO_MB_WEIGHT", 0.02),
};

mkdirSync(cfg.dataDir, { recursive: true });
const dbPath = path.join(cfg.dataDir, "battery-monitor.sqlite");
const db = new Database(dbPath, { create: true });
const indexHtml = readFileSync(path.join(import.meta.dir, "..", "public", "index.html"), "utf8");
initDb();

const cpuCount = Math.max(1, cpus().length || 1);
const selfPid = process.pid;
let prevTotalJiffies: number | null = null;
let prevPollTs: number | null = null;
let prevProcs = new Map<number, ProcPrev>();
let prevBattery: BatterySample | null = loadLatestBatteryFromDb();
let prevNet: { ts: number; rxBytes: number; txBytes: number } | null = null;
let lastRetentionAt = 0;

async function pollOnce() {
  const ts = Date.now();
  const battery = readBattery(ts);
  recordSleepGapIfNeeded(prevBattery, battery);
  const sampleId = insertBattery(battery);
  const shouldCollectProcesses = battery.onBattery || cfg.recordWhenPlugged || cfg.forceCollect;

  if (shouldCollectProcesses) {
    const totalJiffies = readTotalJiffies();
    const procs = readProcesses();
    const rows = computeProcRows(procs, totalJiffies, battery.powerW);
    insertProcessRows(sampleId, ts, rows);
    insertEnvironment(readEnvironment(sampleId, ts, rows));
    prevTotalJiffies = totalJiffies;
    prevPollTs = ts;
    prevProcs = new Map(procs.map((p) => [p.pid, { ticks: p.ticks, startTime: p.startTime, readBytes: p.readBytes, writeBytes: p.writeBytes }]));
    const self = rows.find((r) => r.isSelf);
    console.log(`[battery-monitor] ${new Date(ts).toISOString()} ${battery.onBattery ? "unplugged" : "plugged"} ${fmtPct(battery.capacity)} ${fmtW(battery.powerW)} rows=${rows.length} self=${fmtW(self?.estimatedWatts ?? 0)}`);
  } else {
    // Keep CPU/IO baselines fresh, but do not write process rows while plugged.
    prevTotalJiffies = readTotalJiffies();
    const procs = readProcesses();
    prevPollTs = ts;
    prevProcs = new Map(procs.map((p) => [p.pid, { ticks: p.ticks, startTime: p.startTime, readBytes: p.readBytes, writeBytes: p.writeBytes }]));
    insertEnvironment(readEnvironment(sampleId, ts, []));
    console.log(`[battery-monitor] ${new Date(ts).toISOString()} plugged ${fmtPct(battery.capacity)}; skipped process snapshot`);
  }

  prevBattery = battery;
  if (ts - lastRetentionAt > 60 * 60 * 1000) {
    pruneOld(ts);
    lastRetentionAt = ts;
  }
}

function recordSleepGapIfNeeded(prev: BatterySample | null, current: BatterySample) {
  if (!prev) return;
  const durationMs = current.ts - prev.ts;
  if (durationMs < cfg.suspendGapMs) return;
  const durationSec = durationMs / 1000;
  const durationHours = durationMs / 3600000;
  const capacityDelta = current.capacity != null && prev.capacity != null ? current.capacity - prev.capacity : null;
  const energyDeltaWh = current.energyWh != null && prev.energyWh != null ? current.energyWh - prev.energyWh : null;
  const avgPowerW = energyDeltaWh != null ? energyDeltaWh / durationHours : null;
  const avgPercentPerHour = capacityDelta != null ? capacityDelta / durationHours : null;
  const kind = (energyDeltaWh ?? capacityDelta ?? 0) > 0 ? "suspend charge" : (energyDeltaWh ?? capacityDelta ?? 0) < 0 ? "suspend discharge" : "sample gap";

  const existing = db.query("SELECT 1 FROM sleep_events WHERE start_ts=? AND end_ts=? LIMIT 1").get(prev.ts, current.ts);
  if (existing) return;
  db.run(`INSERT INTO sleep_events
    (start_ts,end_ts,duration_sec,kind,start_capacity,end_capacity,capacity_delta,start_energy_wh,end_energy_wh,energy_delta_wh,avg_power_w,avg_percent_per_hour)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    prev.ts,
    current.ts,
    durationSec,
    kind,
    prev.capacity,
    current.capacity,
    capacityDelta,
    prev.energyWh,
    current.energyWh,
    energyDeltaWh,
    avgPowerW,
    avgPercentPerHour,
  );
  console.log(`[battery-monitor] detected ${kind}: ${(durationSec / 60).toFixed(1)}min, ${avgPowerW == null ? "?" : avgPowerW.toFixed(2)}W avg, ${avgPercentPerHour == null ? "?" : avgPercentPerHour.toFixed(2)}%/h`);
}

function currentBaselineWatts(totalPowerW: number): number {
  if (totalPowerW <= 0) return 0;
  if (cfg.baselineMode !== "adaptive") return Math.min(cfg.baselineWatts, totalPowerW);
  const since = Date.now() - cfg.baselineLookbackHours * 60 * 60 * 1000;
  const row = db.query("SELECT MIN(power_w) AS min_power FROM battery_samples WHERE on_battery=1 AND power_w > 0 AND ts >= ?").get(since) as { min_power: number | null } | null;
  const observed = row?.min_power ?? cfg.baselineWatts;
  return Math.min(totalPowerW, clamp(observed, cfg.baselineMinWatts, cfg.baselineMaxWatts));
}

function computeProcRows(procs: ProcNow[], totalJiffies: number, totalPowerW: number | null): ProcRow[] {
  const totalDelta = prevTotalJiffies == null ? 0 : Math.max(0, totalJiffies - prevTotalJiffies);
  const elapsedSec = prevPollTs == null ? cfg.pollMs / 1000 : Math.max(1, (Date.now() - prevPollTs) / 1000);

  let rows: ProcRow[] = procs.map((p) => {
    const prev = prevProcs.get(p.pid);
    const sameProcess = prev && prev.startTime === p.startTime;
    const deltaTicks = sameProcess ? Math.max(0, p.ticks - prev.ticks) : 0;
    const readDelta = sameProcess ? Math.max(0, p.readBytes - prev.readBytes) : 0;
    const writeDelta = sameProcess ? Math.max(0, p.writeBytes - prev.writeBytes) : 0;
    const cpuSeconds = deltaTicks / cfg.clkTck;
    const cpuPercent = totalDelta > 0 ? (deltaTicks / totalDelta) * cpuCount * 100 : (cpuSeconds / elapsedSec) * 100;
    const ioMb = (readDelta + writeDelta) / 1024 / 1024;
    const score = cpuSeconds * cfg.cpuWeight + ioMb * cfg.ioMbWeight;
    return { ...p, cpuPercent, cpuSeconds, ioMb, score, estimatedWatts: 0 };
  });

  // Keep only processes that actually moved since the previous sample, plus this monitor.
  rows = rows.filter((r) => r.score > 0 || r.isSelf);
  if (cfg.maxProcessesPerSample > 0 && rows.length > cfg.maxProcessesPerSample) {
    const self = rows.filter((r) => r.isSelf);
    rows = rows
      .filter((r) => !r.isSelf)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, cfg.maxProcessesPerSample - self.length))
      .concat(self);
  }

  const power = Math.max(0, totalPowerW ?? 0);
  const baseline = currentBaselineWatts(power);
  const dynamicPower = Math.max(0, power - baseline);
  const scoreSum = rows.reduce((sum, r) => sum + r.score, 0);
  if (dynamicPower > 0 && scoreSum > 0) {
    for (const row of rows) row.estimatedWatts = dynamicPower * (row.score / scoreSum);
  }

  // Pseudo-row prevents attributing unavoidable idle/platform watts to foreground apps.
  rows.push({
    pid: 0,
    ppid: 0,
    name: "system-baseline",
    app: "System / baseline",
    cmd: `Estimated idle/platform baseline (${baseline.toFixed(2)} W, ${cfg.baselineMode} mode)` ,
    ticks: 0,
    startTime: 0,
    readBytes: 0,
    writeBytes: 0,
    rssMb: 0,
    isSelf: false,
    cpuPercent: 0,
    cpuSeconds: 0,
    ioMb: 0,
    score: 0,
    estimatedWatts: baseline,
  });

  return rows.sort((a, b) => b.estimatedWatts - a.estimatedWatts);
}

function readBattery(ts: number): BatterySample {
  if (!existsSync(cfg.powerRoot)) {
    return { ts, onBattery: false, status: "no power_supply", capacity: null, energyWh: null, powerW: null, source: cfg.powerRoot };
  }

  const entries = safeReaddir(cfg.powerRoot);
  const batteryDirs = entries
    .map((name) => path.join(cfg.powerRoot, name))
    .filter((dir) => safeReadTrim(path.join(dir, "type")) === "Battery" || path.basename(dir).startsWith("BAT"));

  const acOnline = entries
    .map((name) => path.join(cfg.powerRoot, name))
    .filter((dir) => !batteryDirs.includes(dir))
    .map((dir) => safeReadTrim(path.join(dir, "online")))
    .some((v) => v === "1");

  if (batteryDirs.length === 0) {
    return { ts, onBattery: cfg.forceCollect, status: acOnline ? "AC" : "no battery", capacity: null, energyWh: null, powerW: null, source: cfg.powerRoot };
  }

  let energyWh = 0;
  let energyFullWh = 0;
  let powerW = 0;
  let haveEnergy = false;
  let havePower = false;
  const capacities: number[] = [];
  const statuses: string[] = [];

  for (const dir of batteryDirs) {
    const status = safeReadTrim(path.join(dir, "status")) || "Unknown";
    statuses.push(status);
    const cap = readNum(path.join(dir, "capacity"));
    if (cap != null) capacities.push(cap);

    const eNow = readEnergyWh(dir, "now");
    const eFull = readEnergyWh(dir, "full");
    if (eNow != null) { energyWh += eNow; haveEnergy = true; }
    if (eFull != null) energyFullWh += eFull;

    const p = readPowerW(dir);
    if (p != null) { powerW += p; havePower = true; }
  }

  let capacity: number | null = null;
  if (haveEnergy && energyFullWh > 0) capacity = (energyWh / energyFullWh) * 100;
  else if (capacities.length > 0) capacity = capacities.reduce((a, b) => a + b, 0) / capacities.length;

  const status = [...new Set(statuses)].join(", ");
  let onBattery = statuses.some((s) => s.toLowerCase() === "discharging");
  if (!onBattery && !acOnline) onBattery = !statuses.every((s) => ["full", "charging"].includes(s.toLowerCase()));

  let finalPowerW: number | null = havePower ? powerW : null;
  if (finalPowerW == null && prevBattery?.energyWh != null && haveEnergy) {
    const dtHours = Math.max(1 / 3600, (ts - prevBattery.ts) / 3600000);
    const deltaWh = prevBattery.energyWh - energyWh;
    if (onBattery && deltaWh >= 0) finalPowerW = deltaWh / dtHours;
  }

  return {
    ts,
    onBattery,
    status,
    capacity,
    energyWh: haveEnergy ? energyWh : null,
    powerW: finalPowerW,
    source: batteryDirs.map((d) => path.basename(d)).join(","),
  };
}

function readEnvironment(sampleId: number, ts: number, rows: ProcRow[]): EnvironmentSample {
  const theme = readTheme();
  const brightness = readBrightness();
  const audio = readAudioState();
  const net = readNetworkRates(ts);
  const focused = readFocusedWindow();
  const lid = readLidState();
  const lock = readScreenLockState();
  const fan = readFanSpeed();
  const browserWatts = rows
    .filter((r) => ["Zen Browser", "Firefox", "Chrome/Chromium"].includes(r.app))
    .reduce((sum, r) => sum + r.estimatedWatts, 0);
  const browserCpu = rows
    .filter((r) => ["Zen Browser", "Firefox", "Chrome/Chromium"].includes(r.app))
    .reduce((sum, r) => sum + r.cpuPercent, 0);
  const browserActive = browserWatts > 0.3 || browserCpu > 5;
  const videoStreaming = net.rxMbps >= cfg.videoRxMbpsThreshold && browserActive;
  const videoDetail = videoStreaming
    ? `probable: ${net.rxMbps.toFixed(2)} Mbps RX + browser activity (${browserWatts.toFixed(2)} W, ${browserCpu.toFixed(1)}% CPU)`
    : `not detected: ${net.rxMbps.toFixed(2)} Mbps RX; browser ${browserWatts.toFixed(2)} W, ${browserCpu.toFixed(1)}% CPU`;

  return {
    sampleId,
    ts,
    theme: theme.theme,
    themeDetail: theme.detail,
    brightnessPercent: brightness.percent,
    brightnessSource: brightness.source,
    audioPlaying: audio.playing,
    audioDetail: audio.detail,
    videoStreaming,
    videoDetail,
    netRxMbps: net.rxMbps,
    netTxMbps: net.txMbps,
    focusedApp: focused.app,
    focusedTitle: focused.title,
    focusedPid: focused.pid,
    lidClosed: lid.closed,
    lidDetail: lid.detail,
    screenLocked: lock.locked,
    screenLockDetail: lock.detail,
    fanRpm: fan.rpm,
    fanSource: fan.source,
  };
}

function readLidState(): { closed: boolean | null; detail: string } {
  const root = path.join(cfg.procRoot, "acpi", "button", "lid");
  const states: string[] = [];
  for (const lid of safeReaddir(root)) {
    const state = safeReadTrim(path.join(root, lid, "state"));
    if (state) states.push(`${lid}: ${state.replace(/\s+/g, " ")}`);
  }
  if (states.length === 0) return { closed: null, detail: "no ACPI lid state" };
  const detail = states.join(", ");
  return { closed: /closed/i.test(detail), detail };
}

function readScreenLockState(): { locked: boolean | null; detail: string } {
  const lockers = ["swaylock", "hyprlock", "gtklock", "waylock", "i3lock", "xsecurelock", "kscreenlocker", "gnome-screensaver"];
  for (const name of safeReaddir(cfg.procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const dir = path.join(cfg.procRoot, name);
    const comm = safeReadTrim(path.join(dir, "comm"));
    const cmd = readCmdline(path.join(dir, "cmdline")) || comm;
    const lower = `${comm} ${cmd}`.toLowerCase();
    const locker = lockers.find((l) => lower.includes(l));
    if (locker) return { locked: true, detail: `${locker} pid ${name}` };
  }
  return { locked: false, detail: "no known lock-screen process" };
}

function readFanSpeed(): { rpm: number | null; source: string } {
  const hwmonRoot = path.join(path.dirname(cfg.powerRoot), "hwmon");
  const fans: { rpm: number; source: string }[] = [];
  for (const hwmon of safeReaddir(hwmonRoot)) {
    const dir = path.join(hwmonRoot, hwmon);
    const chip = safeReadTrim(path.join(dir, "name")) || hwmon;
    for (const file of safeReaddir(dir)) {
      const match = file.match(/^fan(\d+)_input$/);
      if (!match) continue;
      const rpm = readNum(path.join(dir, file));
      if (rpm == null || rpm < 0) continue;
      const label = safeReadTrim(path.join(dir, `fan${match[1]}_label`));
      fans.push({ rpm, source: `${chip}/${label || file}` });
    }
  }

  const thinkpad = safeReadTrim(path.join(cfg.procRoot, "acpi", "ibm", "fan"));
  const speed = thinkpad.match(/^speed:\s*(\d+)/m);
  if (speed) fans.push({ rpm: Number(speed[1]), source: "thinkpad_acpi" });

  if (fans.length === 0) return { rpm: null, source: `no fan sensor in ${hwmonRoot}` };
  const active = fans.sort((a, b) => b.rpm - a.rpm)[0];
  return active;
}

function readFocusedWindow(): { app: string; title: string; pid: number | null } {
  const text = safeReadTrim(cfg.focusedWindowFile);
  if (!text) return { app: "", title: "", pid: null };
  try {
    const data = JSON.parse(text) as { app_id?: unknown; app?: unknown; title?: unknown; pid?: unknown };
    const app = String(data.app_id ?? data.app ?? "").slice(0, 120);
    const title = String(data.title ?? "").slice(0, 240);
    const pid = Number(data.pid);
    return { app, title, pid: Number.isFinite(pid) ? pid : null };
  } catch {
    return { app: "", title: "", pid: null };
  }
}

function readTheme(): { theme: string; detail: string } {
  const helper = safeReadTrim(cfg.desktopStateFile);
  if (helper) {
    try {
      const state = JSON.parse(helper) as { theme?: unknown; detail?: unknown; color_scheme?: unknown; gtk_theme?: unknown };
      const theme = String(state.theme ?? "").toLowerCase();
      if (theme === "light" || theme === "dark") return { theme, detail: String(state.detail ?? state.color_scheme ?? state.gtk_theme ?? "desktop helper") };
    } catch {
      // Ignore malformed helper state and fall back to config files.
    }
  }

  const checks = [
    path.join(cfg.hostConfigDir, "gtk-3.0", "settings.ini"),
    path.join(cfg.hostConfigDir, "gtk-4.0", "settings.ini"),
    path.join(cfg.hostConfigDir, "kdeglobals"),
  ];
  for (const file of checks) {
    const text = safeReadTrim(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    const base = path.basename(path.dirname(file)) === "." ? path.basename(file) : `${path.basename(path.dirname(file))}/${path.basename(file)}`;
    if (/gtk-application-prefer-dark-theme\s*=\s*1/i.test(text)) return { theme: "dark", detail: base };
    if (/gtk-application-prefer-dark-theme\s*=\s*0/i.test(text)) return { theme: "light", detail: base };
    const themeLine = lower.split("\n").find((l) => l.includes("theme") || l.includes("colorscheme") || l.includes("lookandfeel"));
    if (themeLine?.includes("dark")) return { theme: "dark", detail: `${base}: ${themeLine.slice(0, 80)}` };
    if (themeLine?.includes("light")) return { theme: "light", detail: `${base}: ${themeLine.slice(0, 80)}` };
  }
  return { theme: "unknown", detail: `no readable theme config in ${cfg.hostConfigDir}` };
}

function readBrightness(): { percent: number | null; source: string } {
  const root = path.join(path.dirname(cfg.powerRoot), "backlight");
  const rows = safeReaddir(root)
    .map((name) => {
      const dir = path.join(root, name);
      const current = readNum(path.join(dir, "brightness"));
      const max = readNum(path.join(dir, "max_brightness"));
      return current != null && max && max > 0 ? { name, percent: (current / max) * 100 } : null;
    })
    .filter((x): x is { name: string; percent: number } => Boolean(x));
  if (rows.length === 0) return { percent: null, source: root };
  const best = rows.sort((a, b) => b.percent - a.percent)[0];
  return { percent: best.percent, source: best.name };
}

function readAudioState(): { playing: boolean | null; detail: string } {
  const asound = path.join(cfg.procRoot, "asound");
  if (!existsSync(asound)) return { playing: null, detail: "no /proc/asound" };
  for (const card of safeReaddir(asound).filter((n) => n.startsWith("card"))) {
    const cardDir = path.join(asound, card);
    for (const pcm of safeReaddir(cardDir).filter((n) => /^pcm\d+p$/.test(n))) {
      const pcmDir = path.join(cardDir, pcm, "sub0");
      const status = safeReadTrim(path.join(pcmDir, "status"));
      if (status.includes("RUNNING")) return { playing: true, detail: `${card}/${pcm} RUNNING` };
    }
  }
  return { playing: false, detail: "all playback PCM devices idle/suspended" };
}

function readNetworkRates(ts: number): { rxMbps: number; txMbps: number } {
  const counters = readNetworkCounters();
  if (!prevNet) {
    prevNet = { ts, ...counters };
    return { rxMbps: 0, txMbps: 0 };
  }
  const dt = Math.max(1, (ts - prevNet.ts) / 1000);
  const rxMbps = Math.max(0, counters.rxBytes - prevNet.rxBytes) * 8 / dt / 1_000_000;
  const txMbps = Math.max(0, counters.txBytes - prevNet.txBytes) * 8 / dt / 1_000_000;
  prevNet = { ts, ...counters };
  return { rxMbps, txMbps };
}

function readNetworkCounters(): { rxBytes: number; txBytes: number } {
  const text = safeReadTrim(path.join(cfg.procRoot, "net", "dev"));
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of text.split("\n")) {
    if (!line.includes(":")) continue;
    const [ifaceRaw, rest] = line.split(":");
    const iface = ifaceRaw.trim();
    if (!iface || iface === "lo" || iface.startsWith("docker") || iface.startsWith("br-") || iface.startsWith("veth")) continue;
    const parts = rest.trim().split(/\s+/).map(Number);
    if (parts.length >= 16) {
      rxBytes += parts[0] || 0;
      txBytes += parts[8] || 0;
    }
  }
  return { rxBytes, txBytes };
}

function readProcesses(): ProcNow[] {
  const out: ProcNow[] = [];
  for (const name of safeReaddir(cfg.procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const dir = path.join(cfg.procRoot, name);
    const statText = safeReadTrim(path.join(dir, "stat"));
    if (!statText) continue;
    const parsed = parseProcStat(statText);
    if (!parsed) continue;
    const comm = safeReadTrim(path.join(dir, "comm")) || parsed.comm;
    const cmd = readCmdline(path.join(dir, "cmdline")) || comm;
    const io = readProcIo(path.join(dir, "io"));
    const isSelf = pid === selfPid || looksLikeSelf(pid, cmd, comm);
    out.push({
      pid,
      ppid: parsed.ppid,
      name: comm.slice(0, 80),
      app: "",
      cmd: cmd.slice(0, 300),
      ticks: parsed.utime + parsed.stime,
      startTime: parsed.startTime,
      readBytes: io.readBytes,
      writeBytes: io.writeBytes,
      rssMb: (parsed.rssPages * 4096) / 1024 / 1024,
      isSelf,
    });
  }
  assignProcessGroups(out);
  return out;
}

function parseProcStat(text: string) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 2).trim().split(/\s+/);
  if (rest.length < 22) return null;
  return {
    comm,
    ppid: Number(rest[1]) || 0,
    utime: Number(rest[11]) || 0,
    stime: Number(rest[12]) || 0,
    startTime: Number(rest[19]) || 0,
    rssPages: Number(rest[21]) || 0,
  };
}

function readTotalJiffies(): number {
  const text = safeReadTrim(path.join(cfg.procRoot, "stat"));
  const line = text.split("\n")[0] || "";
  const parts = line.trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  return parts.reduce((a, b) => a + b, 0);
}

function readProcIo(file: string) {
  const text = safeReadTrim(file);
  let readBytes = 0;
  let writeBytes = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("read_bytes:")) readBytes = Number(line.split(/\s+/)[1]) || 0;
    if (line.startsWith("write_bytes:")) writeBytes = Number(line.split(/\s+/)[1]) || 0;
  }
  return { readBytes, writeBytes };
}

function readCmdline(file: string): string {
  try {
    const raw = readFileSync(file, "utf8");
    return raw.replace(/\0/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function looksLikeSelf(pid: number, cmd: string, comm: string): boolean {
  if (comm !== "bun" && !cmd.includes("bun")) return false;
  if (cmd.includes("battery-monitor") || cmd.includes("src/main.ts")) return true;
  try {
    const cwd = readlinkSync(path.join(cfg.procRoot, String(pid), "cwd"));
    return cwd.includes("battery-monitor") || cwd === "/app";
  } catch {
    return false;
  }
}

function assignProcessGroups(procs: ProcNow[]) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  for (const proc of procs) {
    if (proc.isSelf) {
      proc.app = "battery-monitor";
      continue;
    }

    const inherited = ancestorOwnerGroup(proc, byPid);
    const direct = directProcessGroup(proc);

    // Browser helper names like "Isolated Web Content" do not carry the browser name
    // in /proc, so inherit the app from Zen/Firefox/Chrome parent processes.
    if (inherited && (isBrowserHelper(proc) || inherited === "Docker" || isElectronHelper(proc))) {
      proc.app = inherited;
    } else {
      proc.app = direct ?? fallbackAppName(proc.name, proc.cmd);
    }
  }
}

function ancestorOwnerGroup(proc: ProcNow, byPid: Map<number, ProcNow>): string | null {
  let current = byPid.get(proc.ppid);
  const seen = new Set<number>();
  for (let depth = 0; current && depth < 12 && !seen.has(current.pid); depth++) {
    seen.add(current.pid);
    if (current.isSelf) return "battery-monitor";
    const owner = directOwnerGroup(current);
    if (owner) return owner;
    current = byPid.get(current.ppid);
  }
  return null;
}

function directOwnerGroup(proc: ProcNow): string | null {
  const direct = directProcessGroup(proc);
  if (!direct) return null;
  return [
    "Zen Browser",
    "Firefox",
    "Chrome/Chromium",
    "Docker",
    "VS Code",
    "Slack",
    "Discord",
    "Spotify",
  ].includes(direct) ? direct : null;
}

function directProcessGroup(proc: Pick<ProcNow, "name" | "cmd">): string | null {
  const comm = proc.name;
  const c = `${proc.name} ${proc.cmd}`.toLowerCase();

  if (c.includes("zen-bin") || comm === "zen") return "Zen Browser";
  if (c.includes("firefox") || c.includes("librewolf") || c.includes("waterfox")) return "Firefox";
  if (c.includes("google-chrome") || c.includes("chrome --") || c.includes("chromium") || c.includes("brave-browser")) return "Chrome/Chromium";

  if (c.includes("docker") || c.includes("dockerd") || c.includes("containerd") || c.includes("runc") || c.includes("buildkit")) return "Docker";
  if (comm.startsWith("kworker")) return "Kernel workers";
  if (c.includes("code") && (c.includes("vscode") || c.includes("visual studio code") || comm === "code")) return "VS Code";
  if (c.includes("slack")) return "Slack";
  if (c.includes("discord")) return "Discord";
  if (c.includes("spotify")) return "Spotify";

  if (c.includes("wayland") || c.includes("kwin") || c.includes("gnome-shell") || c.includes("niri")) return "Desktop shell";
  if (c.includes("xorg") || c.includes("xwayland")) return "Display server";
  if (c.includes("node ") || comm === "node") return "Node.js";
  if (comm === "bun") return "Bun";
  return null;
}

function isBrowserHelper(proc: Pick<ProcNow, "name" | "cmd">): boolean {
  const c = `${proc.name} ${proc.cmd}`.toLowerCase();
  return c.includes("isolated web")
    || c.includes("web content")
    || c.includes("webextensions")
    || c.includes("web extension")
    || c.includes("socket process")
    || c.includes("rdd process")
    || c.includes("utility process")
    || c.includes("gpu process")
    || c.includes("privileged cont")
    || c.includes("preallocated");
}

function isElectronHelper(proc: Pick<ProcNow, "name" | "cmd">): boolean {
  const c = `${proc.name} ${proc.cmd}`.toLowerCase();
  return c.includes("--type=renderer")
    || c.includes("--type=gpu-process")
    || c.includes("--type=utility")
    || c.includes("--type=zygote");
}

function fallbackAppName(comm: string, cmd: string): string {
  return comm || firstWord(cmd) || "unknown";
}

function initDb() {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE IF NOT EXISTS battery_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    on_battery INTEGER NOT NULL,
    status TEXT NOT NULL,
    capacity REAL,
    energy_wh REAL,
    power_w REAL,
    source TEXT NOT NULL
  )`);
  // Legacy denormalized table. Kept readable until retention prunes old rows.
  db.run(`CREATE TABLE IF NOT EXISTS process_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    ppid INTEGER NOT NULL,
    name TEXT NOT NULL,
    app TEXT NOT NULL,
    cmd TEXT NOT NULL,
    cpu_percent REAL NOT NULL,
    cpu_seconds REAL NOT NULL,
    io_mb REAL NOT NULL,
    rss_mb REAL NOT NULL,
    score REAL NOT NULL,
    estimated_watts REAL NOT NULL,
    is_self INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS process_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app TEXT NOT NULL,
    name TEXT NOT NULL,
    cmd TEXT NOT NULL,
    UNIQUE(app, name, cmd)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS process_samples_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    ppid INTEGER NOT NULL,
    process_id INTEGER NOT NULL,
    cpu_percent REAL NOT NULL,
    cpu_seconds REAL NOT NULL,
    io_mb REAL NOT NULL,
    rss_mb REAL NOT NULL,
    score REAL NOT NULL,
    estimated_watts REAL NOT NULL,
    is_self INTEGER NOT NULL,
    FOREIGN KEY(process_id) REFERENCES process_identities(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sleep_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    duration_sec REAL NOT NULL,
    kind TEXT NOT NULL,
    start_capacity REAL,
    end_capacity REAL,
    capacity_delta REAL,
    start_energy_wh REAL,
    end_energy_wh REAL,
    energy_delta_wh REAL,
    avg_power_w REAL,
    avg_percent_per_hour REAL,
    UNIQUE(start_ts, end_ts)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sample_app_totals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    app TEXT NOT NULL,
    watts REAL NOT NULL,
    UNIQUE(sample_id, app)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sample_process_totals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    process_id INTEGER NOT NULL,
    watts REAL NOT NULL,
    cpu_seconds REAL NOT NULL,
    io_mb REAL NOT NULL,
    rss_mb_sum REAL NOT NULL,
    rss_rows INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    UNIQUE(sample_id, process_id),
    FOREIGN KEY(process_id) REFERENCES process_identities(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sample_group_totals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    app TEXT NOT NULL,
    child_name TEXT NOT NULL,
    cmd TEXT NOT NULL,
    watts REAL NOT NULL,
    cpu_seconds REAL NOT NULL,
    io_mb REAL NOT NULL,
    rss_mb_sum REAL NOT NULL,
    rss_rows INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    UNIQUE(sample_id, app, child_name)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS environment_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sample_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    theme TEXT NOT NULL,
    theme_detail TEXT NOT NULL,
    brightness_percent REAL,
    brightness_source TEXT NOT NULL,
    audio_playing INTEGER,
    audio_detail TEXT NOT NULL,
    video_streaming INTEGER,
    video_detail TEXT NOT NULL,
    net_rx_mbps REAL NOT NULL,
    net_tx_mbps REAL NOT NULL,
    focused_app TEXT NOT NULL DEFAULT '',
    focused_title TEXT NOT NULL DEFAULT '',
    focused_pid INTEGER,
    lid_closed INTEGER,
    lid_detail TEXT NOT NULL DEFAULT '',
    screen_locked INTEGER,
    screen_lock_detail TEXT NOT NULL DEFAULT '',
    fan_rpm REAL,
    fan_source TEXT NOT NULL DEFAULT ''
  )`);
  addColumnIfMissing("environment_samples", "focused_app", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing("environment_samples", "focused_title", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing("environment_samples", "focused_pid", "INTEGER");
  addColumnIfMissing("environment_samples", "lid_closed", "INTEGER");
  addColumnIfMissing("environment_samples", "lid_detail", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing("environment_samples", "screen_locked", "INTEGER");
  addColumnIfMissing("environment_samples", "screen_lock_detail", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing("environment_samples", "fan_rpm", "REAL");
  addColumnIfMissing("environment_samples", "fan_source", "TEXT NOT NULL DEFAULT ''");
  db.run("CREATE INDEX IF NOT EXISTS idx_battery_ts ON battery_samples(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_process_ts_app ON process_samples(ts, app)");
  db.run("CREATE INDEX IF NOT EXISTS idx_process_sample ON process_samples(sample_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_process_v2_ts ON process_samples_v2(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_process_v2_sample ON process_samples_v2(sample_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_process_v2_identity ON process_samples_v2(process_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_app_totals_ts_app ON sample_app_totals(ts, app)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_app_totals_sample ON sample_app_totals(sample_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_process_totals_ts ON sample_process_totals(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_process_totals_sample ON sample_process_totals(sample_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_process_totals_identity ON sample_process_totals(process_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_group_totals_ts ON sample_group_totals(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_group_totals_sample ON sample_group_totals(sample_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_group_totals_app_child ON sample_group_totals(app, child_name)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sample_group_totals_ts_app_child ON sample_group_totals(ts, app, child_name)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sleep_events_time ON sleep_events(start_ts, end_ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_environment_ts ON environment_samples(ts)");
}

function loadLatestBatteryFromDb(): BatterySample | null {
  try {
    const row = db.query("SELECT ts,on_battery,status,capacity,energy_wh,power_w,source FROM battery_samples ORDER BY ts DESC LIMIT 1").get() as {
      ts: number; on_battery: number; status: string; capacity: number | null; energy_wh: number | null; power_w: number | null; source: string;
    } | null;
    if (!row) return null;
    return {
      ts: row.ts,
      onBattery: Boolean(row.on_battery),
      status: row.status,
      capacity: row.capacity,
      energyWh: row.energy_wh,
      powerW: row.power_w,
      source: row.source,
    };
  } catch {
    return null;
  }
}

function addColumnIfMissing(table: string, column: string, definition: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function insertBattery(b: BatterySample): number {
  const res = db.run(
    "INSERT INTO battery_samples (ts,on_battery,status,capacity,energy_wh,power_w,source) VALUES (?,?,?,?,?,?,?)",
    b.ts,
    b.onBattery ? 1 : 0,
    b.status,
    b.capacity,
    b.energyWh,
    b.powerW,
    b.source,
  );
  return Number(res.lastInsertRowid);
}

const insertRowsTx = db.transaction((sampleId: number, ts: number, rows: ProcRow[]) => {
  const identityInsert = db.prepare("INSERT OR IGNORE INTO process_identities (app,name,cmd) VALUES (?,?,?)");
  const identitySelect = db.prepare("SELECT id FROM process_identities WHERE app=? AND name=? AND cmd=?");
  const sampleInsert = db.prepare(`INSERT INTO process_samples_v2
    (sample_id,ts,pid,ppid,process_id,cpu_percent,cpu_seconds,io_mb,rss_mb,score,estimated_watts,is_self)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const totalInsert = db.prepare(`INSERT INTO sample_app_totals (sample_id,ts,app,watts) VALUES (?,?,?,?)
    ON CONFLICT(sample_id, app) DO UPDATE SET watts=excluded.watts, ts=excluded.ts`);
  const procTotalInsert = db.prepare(`INSERT INTO sample_process_totals
    (sample_id,ts,process_id,watts,cpu_seconds,io_mb,rss_mb_sum,rss_rows,row_count)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sample_id, process_id) DO UPDATE SET
      watts=excluded.watts, cpu_seconds=excluded.cpu_seconds, io_mb=excluded.io_mb,
      rss_mb_sum=excluded.rss_mb_sum, rss_rows=excluded.rss_rows, row_count=excluded.row_count, ts=excluded.ts`);
  const groupTotalInsert = db.prepare(`INSERT INTO sample_group_totals
    (sample_id,ts,app,child_name,cmd,watts,cpu_seconds,io_mb,rss_mb_sum,rss_rows,row_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sample_id, app, child_name) DO UPDATE SET
      cmd=excluded.cmd, watts=excluded.watts, cpu_seconds=excluded.cpu_seconds, io_mb=excluded.io_mb,
      rss_mb_sum=excluded.rss_mb_sum, rss_rows=excluded.rss_rows, row_count=excluded.row_count, ts=excluded.ts`);
  const appTotals = new Map<string, number>();
  const procTotals = new Map<number, { watts: number; cpuSeconds: number; ioMb: number; rssMbSum: number; rssRows: number; rowCount: number }>();
  const groupTotals = new Map<string, { app: string; childName: string; cmd: string; watts: number; cpuSeconds: number; ioMb: number; rssMbSum: number; rssRows: number; rowCount: number }>();
  for (const r of rows) {
    identityInsert.run(r.app, r.name, r.cmd);
    const identity = identitySelect.get(r.app, r.name, r.cmd) as { id: number };
    sampleInsert.run(sampleId, ts, r.pid, r.ppid, identity.id, r.cpuPercent, r.cpuSeconds, r.ioMb, r.rssMb, r.score, r.estimatedWatts, r.isSelf ? 1 : 0);
    appTotals.set(r.app, (appTotals.get(r.app) ?? 0) + r.estimatedWatts);
    const procTotal = procTotals.get(identity.id) ?? { watts: 0, cpuSeconds: 0, ioMb: 0, rssMbSum: 0, rssRows: 0, rowCount: 0 };
    procTotal.watts += r.estimatedWatts;
    procTotal.cpuSeconds += r.cpuSeconds;
    procTotal.ioMb += r.ioMb;
    procTotal.rssMbSum += r.rssMb;
    procTotal.rssRows += 1;
    procTotal.rowCount += 1;
    procTotals.set(identity.id, procTotal);

    const childName = subprocessLabel(r.name, r.cmd);
    const groupKey = `${r.app}\u0000${childName}`;
    const groupTotal = groupTotals.get(groupKey) ?? { app: r.app, childName, cmd: r.cmd, watts: 0, cpuSeconds: 0, ioMb: 0, rssMbSum: 0, rssRows: 0, rowCount: 0 };
    groupTotal.watts += r.estimatedWatts;
    groupTotal.cpuSeconds += r.cpuSeconds;
    groupTotal.ioMb += r.ioMb;
    groupTotal.rssMbSum += r.rssMb;
    groupTotal.rssRows += 1;
    groupTotal.rowCount += 1;
    if (!groupTotal.cmd && r.cmd) groupTotal.cmd = r.cmd;
    groupTotals.set(groupKey, groupTotal);
  }
  for (const [app, watts] of appTotals) totalInsert.run(sampleId, ts, app, watts);
  for (const [processId, t] of procTotals) procTotalInsert.run(sampleId, ts, processId, t.watts, t.cpuSeconds, t.ioMb, t.rssMbSum, t.rssRows, t.rowCount);
  for (const t of groupTotals.values()) groupTotalInsert.run(sampleId, ts, t.app, t.childName, t.cmd, t.watts, t.cpuSeconds, t.ioMb, t.rssMbSum, t.rssRows, t.rowCount);
});

function insertProcessRows(sampleId: number, ts: number, rows: ProcRow[]) {
  insertRowsTx(sampleId, ts, rows);
}

function backfillSampleAppTotals() {
  const existing = (db.query("SELECT COUNT(*) AS n FROM sample_app_totals").get() as { n: number }).n;
  const legacyRows = (db.query("SELECT COUNT(*) AS n FROM process_samples").get() as { n: number }).n;
  const v2Rows = (db.query("SELECT COUNT(*) AS n FROM process_samples_v2").get() as { n: number }).n;
  if (existing === 0 && legacyRows + v2Rows > 0) {
    console.log("[battery-monitor] backfilling sample_app_totals from process samples");
    db.run(`INSERT OR IGNORE INTO sample_app_totals (sample_id,ts,app,watts)
      SELECT sample_id, MIN(ts) AS ts, app, SUM(estimated_watts) AS watts
      FROM (${processRowsViewSql})
      GROUP BY sample_id, app`);
  }
}

function backfillSampleProcessTotals() {
  const existing = (db.query("SELECT COUNT(*) AS n FROM sample_process_totals").get() as { n: number }).n;
  const legacyRows = (db.query("SELECT COUNT(*) AS n FROM process_samples").get() as { n: number }).n;
  const v2Rows = (db.query("SELECT COUNT(*) AS n FROM process_samples_v2").get() as { n: number }).n;
  if (existing > 0 || legacyRows + v2Rows === 0) return;
  console.log("[battery-monitor] backfilling sample_process_totals from process samples");
  db.run("INSERT OR IGNORE INTO process_identities (app,name,cmd) SELECT DISTINCT app,name,cmd FROM process_samples");
  db.run(`INSERT OR IGNORE INTO sample_process_totals (sample_id,ts,process_id,watts,cpu_seconds,io_mb,rss_mb_sum,rss_rows,row_count)
    SELECT p.sample_id, MIN(p.ts) AS ts, i.id AS process_id, SUM(p.estimated_watts), SUM(p.cpu_seconds), SUM(p.io_mb), SUM(p.rss_mb), COUNT(*), COUNT(*)
    FROM process_samples p JOIN process_identities i ON i.app=p.app AND i.name=p.name AND i.cmd=p.cmd
    GROUP BY p.sample_id, i.id`);
  db.run(`INSERT OR IGNORE INTO sample_process_totals (sample_id,ts,process_id,watts,cpu_seconds,io_mb,rss_mb_sum,rss_rows,row_count)
    SELECT sample_id, MIN(ts) AS ts, process_id, SUM(estimated_watts), SUM(cpu_seconds), SUM(io_mb), SUM(rss_mb), COUNT(*), COUNT(*)
    FROM process_samples_v2
    GROUP BY sample_id, process_id`);
}

function backfillSampleGroupTotals() {
  const existing = (db.query("SELECT COUNT(*) AS n FROM sample_group_totals").get() as { n: number }).n;
  const legacyRows = (db.query("SELECT COUNT(*) AS n FROM process_samples").get() as { n: number }).n;
  const v2Rows = (db.query("SELECT COUNT(*) AS n FROM process_samples_v2").get() as { n: number }).n;
  if (existing > 0 || legacyRows + v2Rows === 0) return;
  console.log("[battery-monitor] backfilling sample_group_totals from process samples");
  // SQL-only backfill groups by kernel/browser process name. New samples use the
  // richer subprocessLabel() rollup, but this keeps startup fast for existing DBs.
  db.run(`INSERT OR IGNORE INTO sample_group_totals
    (sample_id,ts,app,child_name,cmd,watts,cpu_seconds,io_mb,rss_mb_sum,rss_rows,row_count)
    SELECT sample_id, MIN(ts) AS ts, app, name AS child_name, MIN(cmd) AS cmd,
      SUM(estimated_watts), SUM(cpu_seconds), SUM(io_mb), SUM(rss_mb), COUNT(*), COUNT(*)
    FROM (${processRowsViewSql})
    GROUP BY sample_id, app, name`);
}

function insertEnvironment(e: EnvironmentSample) {
  db.run(`INSERT INTO environment_samples
    (sample_id,ts,theme,theme_detail,brightness_percent,brightness_source,audio_playing,audio_detail,video_streaming,video_detail,net_rx_mbps,net_tx_mbps,focused_app,focused_title,focused_pid,lid_closed,lid_detail,screen_locked,screen_lock_detail,fan_rpm,fan_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.sampleId,
    e.ts,
    e.theme,
    e.themeDetail,
    e.brightnessPercent,
    e.brightnessSource,
    e.audioPlaying == null ? null : e.audioPlaying ? 1 : 0,
    e.audioDetail,
    e.videoStreaming == null ? null : e.videoStreaming ? 1 : 0,
    e.videoDetail,
    e.netRxMbps,
    e.netTxMbps,
    e.focusedApp,
    e.focusedTitle,
    e.focusedPid,
    e.lidClosed == null ? null : e.lidClosed ? 1 : 0,
    e.lidDetail,
    e.screenLocked == null ? null : e.screenLocked ? 1 : 0,
    e.screenLockDetail,
    e.fanRpm,
    e.fanSource,
  );
}

function pruneOld(now: number) {
  const cutoff = now - cfg.retentionDays * 24 * 60 * 60 * 1000;
  db.run("DELETE FROM process_samples WHERE ts < ?", cutoff);
  db.run("DELETE FROM process_samples_v2 WHERE ts < ?", cutoff);
  db.run("DELETE FROM sample_app_totals WHERE ts < ?", cutoff);
  db.run("DELETE FROM sample_process_totals WHERE ts < ?", cutoff);
  db.run("DELETE FROM sample_group_totals WHERE ts < ?", cutoff);
  db.run("DELETE FROM process_identities WHERE id NOT IN (SELECT DISTINCT process_id FROM process_samples_v2 UNION SELECT DISTINCT process_id FROM sample_process_totals)");
  db.run("DELETE FROM sleep_events WHERE end_ts < ?", cutoff);
  db.run("DELETE FROM environment_samples WHERE ts < ?", cutoff);
  db.run("DELETE FROM battery_samples WHERE ts < ?", cutoff);
}

const processRowsViewSql = `
  SELECT sample_id,ts,pid,ppid,name,app,cmd,cpu_percent,cpu_seconds,io_mb,rss_mb,score,estimated_watts,is_self FROM process_samples
  UNION ALL
  SELECT s.sample_id,s.ts,s.pid,s.ppid,i.name,i.app,i.cmd,s.cpu_percent,s.cpu_seconds,s.io_mb,s.rss_mb,s.score,s.estimated_watts,s.is_self
    FROM process_samples_v2 s JOIN process_identities i ON i.id = s.process_id
`;

function apiStatus() {
  const latestBattery = db.query("SELECT id,ts,on_battery,status,capacity,energy_wh,power_w,source FROM battery_samples ORDER BY ts DESC LIMIT 1").get() as Record<string, unknown> | null;
  const latestEnvironment = db.query("SELECT ts,theme,theme_detail,brightness_percent,brightness_source,audio_playing,audio_detail,video_streaming,video_detail,net_rx_mbps,net_tx_mbps,focused_app,focused_title,focused_pid,lid_closed,lid_detail,screen_locked,screen_lock_detail,fan_rpm,fan_source FROM environment_samples ORDER BY ts DESC LIMIT 1").get() as Record<string, unknown> | null;
  const selfLatest = db.query(`SELECT ts,pid,app,cpu_percent,io_mb,rss_mb,estimated_watts FROM (${processRowsViewSql}) WHERE is_self=1 ORDER BY ts DESC LIMIT 1`).get() as Record<string, unknown> | null;
  const legacyRows = (db.query("SELECT COUNT(*) AS n FROM process_samples").get() as { n: number }).n;
  const v2Rows = (db.query("SELECT COUNT(*) AS n FROM process_samples_v2").get() as { n: number }).n;
  const processRows = legacyRows + v2Rows;
  return { latestBattery, latestEnvironment, selfLatest, dischargeEstimate: computeBatteryRateEstimate(), processRows, config: { pollSeconds: cfg.pollMs / 1000, baselineMode: cfg.baselineMode, baselineWatts: cfg.baselineWatts, baselineMinWatts: cfg.baselineMinWatts, baselineMaxWatts: cfg.baselineMaxWatts } };
}

function computeBatteryRateEstimate() {
  const latest = db.query("SELECT ts,on_battery,status,capacity FROM battery_samples WHERE capacity IS NOT NULL ORDER BY ts DESC LIMIT 1").get() as { ts: number; on_battery: number; status: string; capacity: number } | null;
  if (!latest) return { mode: "unknown", percentPerHour: null, hoursRemaining: null, hoursToFull: null, detail: "no battery samples" };

  const latestCharging = !latest.on_battery && latest.status.toLowerCase().includes("charging");
  const mode = latest.on_battery ? "discharging" : latestCharging ? "charging" : "plugged";

  for (const windowMinutes of [30, 120, 360]) {
    const since = Date.now() - windowMinutes * 60 * 1000;
    const rows = db.query("SELECT ts,on_battery,status,capacity FROM battery_samples WHERE capacity IS NOT NULL AND ts >= ? ORDER BY ts").all(since) as { ts: number; on_battery: number; status: string; capacity: number }[];
    const matching = rows.filter((r) => mode === "discharging" ? Boolean(r.on_battery) : mode === "charging" ? (!r.on_battery && r.status.toLowerCase().includes("charging")) : !r.on_battery);
    if (matching.length < 2) continue;
    const first = matching[0];
    const last = matching[matching.length - 1];
    const hours = Math.max(1 / 60, (last.ts - first.ts) / 3600000);
    const rawRate = (last.capacity - first.capacity) / hours;
    const percentPerHour = mode === "discharging" ? -rawRate : rawRate;
    if (percentPerHour <= 0) continue;
    return {
      mode,
      percentPerHour,
      hoursRemaining: mode === "discharging" ? latest.capacity / percentPerHour : null,
      hoursToFull: mode === "charging" ? Math.max(0, 100 - latest.capacity) / percentPerHour : null,
      detail: `${matching.length} samples over ${(hours * 60).toFixed(0)} min`,
    };
  }

  return { mode, percentPerHour: null, hoursRemaining: null, hoursToFull: null, detail: mode === "charging" ? "estimating charge rate" : mode === "discharging" ? "estimating discharge rate" : "plugged" };
}

function apiSeries(url: URL) {
  const hours = clamp(Number(url.searchParams.get("hours") ?? 8), 1, 24 * 30);
  const top = clamp(Number(url.searchParams.get("top") ?? 12), 1, 50);
  const since = Date.now() - hours * 60 * 60 * 1000;
  const afterTsRaw = Number(url.searchParams.get("after_ts"));
  const afterTs = Number.isFinite(afterTsRaw) && afterTsRaw > since ? afterTsRaw : null;
  const pointsSince = afterTs ?? since;

  const rawTopRows = db.query("SELECT app, SUM(watts) AS total FROM sample_app_totals WHERE ts >= ? GROUP BY app ORDER BY total DESC").all(since) as { app: string; total: number }[];
  const totals = new Map<string, number>();
  for (const r of rawTopRows) {
    const app = normalizeStoredApp(r.app);
    totals.set(app, (totals.get(app) ?? 0) + r.total);
  }
  const apps = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([app]) => app);
  for (const must of ["battery-monitor", "System / baseline"]) {
    if ((totals.get(must) ?? 0) > 0 && !apps.includes(must)) apps.push(must);
  }

  let batteryRows = db.query(`SELECT b.id,b.ts,b.capacity,b.power_w,b.on_battery,b.status,
      e.focused_app,e.focused_title,e.focused_pid,e.lid_closed,e.lid_detail,e.screen_locked,e.screen_lock_detail,
      e.brightness_percent,e.brightness_source,e.theme,e.theme_detail,e.video_streaming,e.video_detail,e.net_rx_mbps,e.net_tx_mbps
    FROM battery_samples b LEFT JOIN environment_samples e ON e.sample_id=b.id
    WHERE b.ts > ? ORDER BY b.ts`).all(pointsSince) as SeriesBatteryRow[];
  let dropFirstPoint = false;
  if (afterTs != null && batteryRows.length > 0) {
    const prevRow = db.query(`SELECT b.id,b.ts,b.capacity,b.power_w,b.on_battery,b.status,
        e.focused_app,e.focused_title,e.focused_pid,e.lid_closed,e.lid_detail,e.screen_locked,e.screen_lock_detail,
        e.brightness_percent,e.brightness_source,e.theme,e.theme_detail,e.video_streaming,e.video_detail,e.net_rx_mbps,e.net_tx_mbps
      FROM battery_samples b LEFT JOIN environment_samples e ON e.sample_id=b.id
      WHERE b.ts <= ? ORDER BY b.ts DESC LIMIT 1`).get(afterTs) as SeriesBatteryRow | null;
    if (prevRow) {
      batteryRows = [prevRow, ...batteryRows];
      dropFirstPoint = true;
    }
  } else if (afterTs == null) {
    batteryRows = db.query(`SELECT b.id,b.ts,b.capacity,b.power_w,b.on_battery,b.status,
        e.focused_app,e.focused_title,e.focused_pid,e.lid_closed,e.lid_detail,e.screen_locked,e.screen_lock_detail,
        e.brightness_percent,e.brightness_source,e.theme,e.theme_detail,e.video_streaming,e.video_detail,e.net_rx_mbps,e.net_tx_mbps
      FROM battery_samples b LEFT JOIN environment_samples e ON e.sample_id=b.id
      WHERE b.ts >= ? ORDER BY b.ts`).all(since) as SeriesBatteryRow[];
  }
  let points = batteryRows.map((b, idx) => {
    const prev = idx > 0 ? batteryRows[idx - 1] : null;
    const gapBefore = prev ? (b.ts - prev.ts) >= cfg.suspendGapMs : false;
    let batteryRatePctPerHour: number | null = null;
    if (prev?.capacity != null && b.capacity != null) {
      const hoursDelta = Math.max(1 / 3600, (b.ts - prev.ts) / 3600000);
      batteryRatePctPerHour = (b.capacity - prev.capacity) / hoursDelta;
    }
    return {
      sampleId: b.id,
      ts: b.ts,
      batteryPercent: b.capacity,
      batteryRatePctPerHour,
      gapBefore,
      gapDurationSec: gapBefore && prev ? (b.ts - prev.ts) / 1000 : 0,
      totalWatts: b.power_w,
      onBattery: Boolean(b.on_battery),
      charging: !b.on_battery && b.status.toLowerCase().includes("charging"),
      status: b.status,
      focusedApp: b.focused_app ?? "",
      focusedTitle: b.focused_title ?? "",
      focusedPid: b.focused_pid ?? null,
      lidClosed: b.lid_closed == null ? null : Boolean(b.lid_closed),
      lidDetail: b.lid_detail ?? "",
      screenLocked: b.screen_locked == null ? null : Boolean(b.screen_locked),
      screenLockDetail: b.screen_lock_detail ?? "",
      brightnessPercent: b.brightness_percent ?? null,
      brightnessSource: b.brightness_source ?? "",
      theme: b.theme ?? "unknown",
      themeDetail: b.theme_detail ?? "",
      videoStreaming: b.video_streaming == null ? null : Boolean(b.video_streaming),
      videoDetail: b.video_detail ?? "",
      netRxMbps: b.net_rx_mbps ?? null,
      netTxMbps: b.net_tx_mbps ?? null,
      apps: {} as Record<string, number>,
    };
  });
  if (dropFirstPoint) points = points.slice(1);
  const bySample = new Map(points.map((p) => [p.sampleId, p]));
  let otherTotal = 0;

  const aggRows = db.query("SELECT sample_id, app, watts FROM sample_app_totals WHERE ts > ? ORDER BY sample_id").all(pointsSince) as { sample_id: number; app: string; watts: number }[];
  for (const r of aggRows) {
    const p = bySample.get(r.sample_id);
    if (!p) continue;
    const app = normalizeStoredApp(r.app);
    if (apps.includes(app)) p.apps[app] = (p.apps[app] ?? 0) + r.watts;
    else { p.apps.Other = (p.apps.Other ?? 0) + r.watts; otherTotal += r.watts; }
  }
  const finalApps = otherTotal > 0 ? apps.concat("Other") : apps;
  const sleepEvents = db.query("SELECT start_ts,end_ts,duration_sec,kind,start_capacity,end_capacity,capacity_delta,start_energy_wh,end_energy_wh,energy_delta_wh,avg_power_w,avg_percent_per_hour FROM sleep_events WHERE end_ts > ? ORDER BY start_ts").all(pointsSince) as Record<string, unknown>[];
  return { apps: finalApps, points, sleepEvents, suspendGapSeconds: cfg.suspendGapMs / 1000, incremental: afterTs != null, since, afterTs };
}

function normalizeStoredApp(app: string): string {
  if (["zen-bin", "Isolated Web Co", "Isolated Servic", "Web Content", "WebExtensions", "Socket Process", "Privileged Cont", "forkserver"].includes(app)) return "Zen Browser";
  if (["containerd", "containerd-shim", "dockerd", "docker", "runc", "docker-proxy"].includes(app)) return "Docker";
  if (app.startsWith("kworker")) return "Kernel workers";
  return app;
}

function apiGroups(url: URL) {
  const hours = clamp(Number(url.searchParams.get("hours") ?? 8), 1, 24 * 30);
  const since = Date.now() - hours * 60 * 60 * 1000;
  const sampleCount = (db.query("SELECT COUNT(DISTINCT sample_id) AS n FROM sample_group_totals WHERE ts >= ?").get(since) as { n: number }).n || 1;
  const sampledHours = sampleCount * (cfg.pollMs / 1000) / 3600;
  const rows = db.query(`SELECT app,child_name AS name,MIN(cmd) AS cmd,SUM(watts) AS watts,SUM(cpu_seconds) AS cpu_seconds,SUM(io_mb) AS io_mb,
      SUM(rss_mb_sum) AS rss_mb_sum,SUM(rss_rows) AS rss_rows,SUM(row_count) AS rows,COUNT(DISTINCT sample_id) AS samples
    FROM sample_group_totals WHERE ts >= ? GROUP BY app,child_name`).all(since) as {
      app: string; name: string; cmd: string; watts: number; cpu_seconds: number; io_mb: number; rss_mb_sum: number; rss_rows: number; rows: number; samples: number;
    }[];

  type Child = { name: string; cmd: string; wattSamples: number; avgWatts: number; wh: number; cpuSeconds: number; ioMb: number; rssMb: number; rows: number; samples: number };
  const groups = new Map<string, { app: string; wattSamples: number; avgWatts: number; wh: number; cpuSeconds: number; ioMb: number; rssMbSum: number; rssRows: number; rows: number; samples: Set<number>; children: Map<string, Child> }>();

  for (const r of rows) {
    const app = normalizeStoredApp(r.app);
    let group = groups.get(app);
    if (!group) {
      group = { app, wattSamples: 0, avgWatts: 0, wh: 0, cpuSeconds: 0, ioMb: 0, rssMbSum: 0, rssRows: 0, rows: 0, samples: new Set(), children: new Map() };
      groups.set(app, group);
    }

    const childKey = r.name;
    let child = group.children.get(childKey);
    if (!child) {
      child = { name: childKey, cmd: r.cmd, wattSamples: 0, avgWatts: 0, wh: 0, cpuSeconds: 0, ioMb: 0, rssMb: 0, rows: 0, samples: 0 };
      group.children.set(childKey, child);
    }

    group.wattSamples += r.watts;
    group.cpuSeconds += r.cpu_seconds;
    group.ioMb += r.io_mb;
    group.rssMbSum += r.rss_mb_sum;
    group.rssRows += r.rss_rows;
    group.rows += r.rows;
    // Approximate distinct group samples from child sample counts. Good enough for UI presence.
    for (let i = 0; i < r.samples; i++) group.samples.add(group.samples.size + i);

    child.wattSamples += r.watts;
    child.cpuSeconds += r.cpu_seconds;
    child.ioMb += r.io_mb;
    child.rssMb = ((child.rssMb * child.rows) + r.rss_mb_sum) / Math.max(1, child.rows + r.rows);
    child.rows += r.rows;
    child.samples += r.samples;
  }

  const output = [...groups.values()].map((g) => {
    const children = [...g.children.values()]
      .map((c) => ({ ...c, avgWatts: c.wattSamples / sampleCount, wh: (c.wattSamples / sampleCount) * sampledHours }))
      .sort((a, b) => b.wattSamples - a.wattSamples);
    const avgWatts = g.wattSamples / sampleCount;
    return {
      app: g.app,
      wattSamples: g.wattSamples,
      avgWatts,
      wh: avgWatts * sampledHours,
      cpuSeconds: g.cpuSeconds,
      ioMb: g.ioMb,
      rssMb: g.rssRows ? g.rssMbSum / g.rssRows : 0,
      rows: g.rows,
      children,
    };
  }).sort((a, b) => b.wattSamples - a.wattSamples);

  return { hours, sampleCount, sampledHours, groups: output };
}

function subprocessLabel(name: string, cmd: string): string {
  if (name === "system-baseline") return "System / baseline";
  if (!cmd || cmd === name) return name;
  if (name.startsWith("Isolated") || name.includes("Web") || name.includes("Socket") || name.includes("Privileged")) return name;
  const lower = cmd.toLowerCase();
  if (lower.includes("-contentproc")) {
    if (lower.includes(" socket")) return "Socket Process";
    if (lower.includes(" rdd")) return "RDD Process";
    if (lower.includes(" utility")) return "Utility Process";
    if (lower.includes("-isforbrowser")) return "Web Content";
    return "Content process";
  }
  const first = firstWord(cmd);
  return first || name;
}

function apiProcesses(url: URL) {
  const requested = url.searchParams.get("sample_id");
  const sampleId = requested ? Number(requested) : ((db.query(`SELECT sample_id FROM (${processRowsViewSql}) ORDER BY ts DESC LIMIT 1`).get() as { sample_id: number } | null)?.sample_id ?? null);
  if (!sampleId) return { sampleId: null, rows: [] };
  const rows = db.query(`SELECT ts,pid,ppid,name,app,cmd,cpu_percent,cpu_seconds,io_mb,rss_mb,score,estimated_watts,is_self
    FROM (${processRowsViewSql}) WHERE sample_id = ? ORDER BY estimated_watts DESC LIMIT 200`).all(sampleId) as Record<string, unknown>[];
  return { sampleId, rows };
}

function readEnergyWh(dir: string, kind: "now" | "full"): number | null {
  const energy = readNum(path.join(dir, `energy_${kind}`));
  if (energy != null) return energy / 1_000_000;
  const charge = readNum(path.join(dir, `charge_${kind}`));
  const voltage = readNum(path.join(dir, "voltage_now"));
  if (charge != null && voltage != null) return (charge * voltage) / 1_000_000_000_000;
  return null;
}

function readPowerW(dir: string): number | null {
  const power = readNum(path.join(dir, "power_now"));
  if (power != null) return Math.abs(power) / 1_000_000;
  const current = readNum(path.join(dir, "current_now"));
  const voltage = readNum(path.join(dir, "voltage_now"));
  if (current != null && voltage != null) return Math.abs(current * voltage) / 1_000_000_000_000;
  return null;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function safeReadTrim(file: string): string {
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}

function readNum(file: string): number | null {
  const text = safeReadTrim(file);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function firstWord(s: string) {
  return s.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
}

function staticAsset(pathname: string) {
  const publicRoot = path.resolve(import.meta.dir, "..", "public");
  const filePath = path.resolve(publicRoot, "." + decodeURIComponent(pathname));
  if (!filePath.startsWith(publicRoot + path.sep)) return new Response("not found\n", { status: 404 });
  try {
    const body = readFileSync(filePath);
    const contentType = filePath.endsWith(".js") ? "text/javascript; charset=utf-8"
      : filePath.endsWith(".css") ? "text/css; charset=utf-8"
      : filePath.endsWith(".svg") ? "image/svg+xml"
      : "application/octet-stream";
    return new Response(body, { headers: { "content-type": contentType, "cache-control": "no-cache" } });
  } catch {
    return new Response("not found\n", { status: 404 });
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function env(name: string, fallback: string) {
  return process.env[name] || fallback;
}
function intEnv(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function numEnv(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}
function boolEnv(name: string, fallback: boolean) {
  const v = process.env[name];
  if (v == null) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function fmtW(w: number | null | undefined) { return w == null ? "?W" : `${w.toFixed(2)}W`; }
function fmtPct(p: number | null | undefined) { return p == null ? "?%" : `${p.toFixed(1)}%`; }

backfillSampleAppTotals();
backfillSampleProcessTotals();
backfillSampleGroupTotals();

console.log(`[battery-monitor] db=${dbPath}`);
console.log(`[battery-monitor] polling every ${cfg.pollMs / 1000}s; proc=${cfg.procRoot}; power=${cfg.powerRoot}; self pid=${selfPid}`);

await pollOnce().catch((err) => console.error("[battery-monitor] first poll failed", err));
setInterval(() => pollOnce().catch((err) => console.error("[battery-monitor] poll failed", err)), cfg.pollMs).unref?.();

Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/") return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname.startsWith("/assets/")) return staticAsset(url.pathname);
      if (url.pathname === "/api/status") return json(apiStatus());
      if (url.pathname === "/api/series") return json(apiSeries(url));
      if (url.pathname === "/api/groups") return json(apiGroups(url));
      if (url.pathname === "/api/processes") return json(apiProcesses(url));
      if (url.pathname === "/healthz") return new Response("ok\n");
      return new Response("not found\n", { status: 404 });
    } catch (err) {
      console.error("[battery-monitor] request failed", err);
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }
  },
});
console.log(`[battery-monitor] UI: http://${cfg.host}:${cfg.port}`);
