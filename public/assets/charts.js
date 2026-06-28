import { escapeHtml, fmtDateTime, fmtDuration, fmtPct, fmtTime, fmtW } from './format.js';

export const colors = ['#0070f3','#50e3c2','#7928ca','#ff0080','#f5a623','#eb367f','#00dfd8','#ff4d4d','#0761d1','#f9cb28','#8f8f8f','#4d4d4d','#d3e5ff','#ee0000','#171717'];

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const PAD = { l: 56, r: 52, t: 14, b: 26 };
const LANES = [
  { key: 'rate', label: 'Rate', h: 84 },
  { key: 'brightness', label: 'Brightness', h: 72 },
  { key: 'video', label: 'Video', h: 38 },
  { key: 'usb', label: 'USB power', h: 38 },
  { key: 'focus', label: 'Focus', h: 50 },
];
const GAP = 10;

let series = null;
let view = { t0: null, t1: null };       // zoom window (null = full extent)
let hoverTs = null;
let hoverApp = null;
let brush = null;                          // { x0, x1 } in css px while dragging
let tip = null;
let canvas = null;
let enabled = loadLanes();

function loadLanes() {
  try {
    const raw = JSON.parse(localStorage.getItem('bms.lanes') || 'null');
    if (Array.isArray(raw)) return new Set([...raw, 'usb']);
  } catch {}
  return new Set(LANES.map(l => l.key));
}
function saveLanes() { localStorage.setItem('bms.lanes', JSON.stringify([...enabled])); }

export function setSeries(next) { series = next; }

export function drawCharts() {
  if (!canvas) canvas = document.getElementById('chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  canvas.width = Math.max(600, w * dpr); canvas.height = h * dpr;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = cssVar('--chart-bg', '#ffffff'); ctx.fillRect(0, 0, w, h);

  const extent = dataExtent();
  if (!extent) { ctx.fillStyle = cssVar('--chart-muted', '#8f8f8f'); ctx.font = '13px Geist, system-ui'; ctx.fillText('Waiting for at least two samples…', 20, 30); return; }

  const bands = computeBands(h);
  const [vt0, vt1] = viewWindow();
  const plotW = w - PAD.l - PAD.r;
  const x = ts => PAD.l + (ts - vt0) / Math.max(1, vt1 - vt0) * plotW;

  drawWattsBand(ctx, bands.main, x, w);
  if (bands.rate) drawRateBand(ctx, bands.rate, x);
  if (bands.brightness) drawBrightnessBand(ctx, bands.brightness, x);
  if (bands.video) drawVideoBand(ctx, bands.video, x);
  if (bands.usb) drawUsbPowerBand(ctx, bands.usb, x);
  if (bands.focus) drawFocusBand(ctx, bands.focus, x);

  drawGapLabels(ctx, x, PAD.t + 3);
  drawTimeAxis(ctx, x, w, h, vt0, vt1);
  drawCrosshair(ctx, x, PAD.t, h - PAD.b);
  drawBrush(ctx, PAD.t, h - PAD.b);
}

/* ---------- layout ---------- */

function computeBands(h) {
  const active = LANES.filter(l => enabled.has(l.key));
  const fixed = active.reduce((s, l) => s + l.h + GAP, 0);
  let y = PAD.t;
  const mainH = Math.max(150, h - PAD.t - PAD.b - fixed);
  const bands = { main: [y, y + mainH] };
  y += mainH + GAP;
  for (const l of active) { bands[l.key] = [y, y + l.h]; y += l.h + GAP; }
  return bands;
}

function dataExtent() {
  const pts = series?.points;
  if (!pts || pts.length < 2) return null;
  return [pts[0].ts, pts[pts.length - 1].ts];
}

function viewWindow() {
  const ext = dataExtent();
  let [t0, t1] = ext;
  if (view.t0 != null && view.t1 != null) { t0 = Math.max(t0, view.t0); t1 = Math.min(t1, view.t1); }
  if (t1 <= t0) [t0, t1] = ext;
  return [t0, t1];
}

function laneLabel(ctx, y0, text) {
  ctx.fillStyle = cssVar('--chart-body', '#4d4d4d'); ctx.font = '11px Geist, system-ui';
  ctx.fillText(text, PAD.l, y0 + 11);
}

function clipBand(ctx, [y0, y1], w) {
  ctx.beginPath(); ctx.rect(PAD.l - 1, y0 - 2, w - PAD.l - PAD.r + 2, y1 - y0 + 4); ctx.clip();
}

/* ---------- bands ---------- */

function drawWattsBand(ctx, [y0, y1], x, w) {
  const pts = series.points, apps = series.apps || [];
  const sums = pts.map(p => apps.reduce((s, a) => s + (p.apps[a] || 0), 0));
  const maxY = Math.max(1, ...sums) * 1.15;
  const y = v => y1 - (v / maxY) * (y1 - y0);
  ctx.strokeStyle = cssVar('--chart-grid', '#ebebeb'); ctx.lineWidth = 1; ctx.fillStyle = cssVar('--chart-muted', '#8f8f8f'); ctx.font = '12px Geist, system-ui';
  for (let i = 0; i <= 4; i++) { const yy = y(maxY * i / 4); ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(w - PAD.r, yy); ctx.stroke(); ctx.fillText((maxY * i / 4).toFixed(1) + 'W', 6, yy + 4); }

  ctx.save(); clipBand(ctx, [y0, y1], w);
  drawSleepBands(ctx, x, y0, y1);
  const chunks = timelineChunks(pts);
  let base = new Array(pts.length).fill(0);
  apps.forEach((app, ai) => {
    const top = pts.map((p, i) => base[i] + (p.apps[app] || 0));
    for (const [start, end] of chunks) {
      if (end <= start) continue;
      ctx.beginPath();
      for (let i = start; i <= end; i++) i === start ? ctx.moveTo(x(pts[i].ts), y(top[i])) : ctx.lineTo(x(pts[i].ts), y(top[i]));
      for (let i = end; i >= start; i--) ctx.lineTo(x(pts[i].ts), y(base[i]));
      ctx.closePath(); ctx.fillStyle = colors[ai % colors.length] + 'cc'; ctx.fill();
    }
    base = top;
  });
  drawBatteryLine(ctx, pts, x, chunks, y0, y1);
  ctx.restore();

  drawBatteryAxis(ctx, w, y0, y1);
  ctx.fillStyle = cssVar('--chart-ink', '#171717'); ctx.font = '11px Geist Mono, monospace'; ctx.fillText('estimated watts by app', PAD.l, y0 + 11);
}

function drawBatteryAxis(ctx, w, y0, y1) {
  const by = pct => y1 - (pct / 100) * (y1 - y0);
  ctx.strokeStyle = cssVar('--chart-axis', '#a1a1a1'); ctx.lineWidth = 1; ctx.fillStyle = cssVar('--chart-body', '#4d4d4d'); ctx.font = '11px Geist, system-ui';
  ctx.beginPath(); ctx.moveTo(w - PAD.r, y0); ctx.lineTo(w - PAD.r, y1); ctx.stroke();
  for (const pct of [0, 25, 50, 75, 100]) { const yy = by(pct); ctx.beginPath(); ctx.moveTo(w - PAD.r, yy); ctx.lineTo(w - PAD.r + 5, yy); ctx.stroke(); ctx.fillText(pct + '%', w - PAD.r + 8, yy + 4); }
  ctx.fillStyle = cssVar('--chart-ink', '#171717'); ctx.fillText('battery %', w - PAD.r - 56, y0 + 11);
}

function drawBatteryLine(ctx, pts, x, chunks, y0, y1) {
  const by = pct => y1 - ((pct || 0) / 100) * (y1 - y0);
  ctx.strokeStyle = cssVar('--chart-ink', '#171717'); ctx.lineWidth = 2;
  for (const [start, end] of chunks) {
    ctx.beginPath();
    for (let i = start; i <= end; i++) { const yy = by(pts[i].batteryPercent || 0); i === start ? ctx.moveTo(x(pts[i].ts), yy) : ctx.lineTo(x(pts[i].ts), yy); }
    ctx.stroke();
  }
  ctx.setLineDash([5, 5]); ctx.strokeStyle = cssVar('--chart-ink', '#171717') + '99';
  for (let i = 1; i < pts.length; i++) if (pts[i].gapBefore) { ctx.beginPath(); ctx.moveTo(x(pts[i - 1].ts), by(pts[i - 1].batteryPercent || 0)); ctx.lineTo(x(pts[i].ts), by(pts[i].batteryPercent || 0)); ctx.stroke(); }
  ctx.setLineDash([]);
}

function drawRateBand(ctx, [y0, y1], x) {
  const pts = series.points, w = canvas.getBoundingClientRect().width;
  laneLabel(ctx, y0, 'charge / discharge rate');
  const rates = pts.map(p => p.batteryRatePctPerHour).filter(v => typeof v === 'number' && isFinite(v));
  const maxRate = Math.max(1, ...rates.map(v => Math.abs(v))) * 1.2;
  const mid = (y0 + y1) / 2;
  const y = v => mid - (v / maxRate) * ((y1 - y0) / 2 - 4);
  ctx.strokeStyle = cssVar('--chart-grid', '#ebebeb'); ctx.fillStyle = cssVar('--chart-muted', '#8f8f8f'); ctx.font = '11px Geist, system-ui'; ctx.lineWidth = 1;
  for (const v of [-maxRate, 0, maxRate]) { const yy = y(v); ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(w - PAD.r, yy); ctx.stroke(); ctx.fillText((v >= 0 ? '+' : '') + v.toFixed(1), 6, yy + 4); }
  ctx.save(); clipBand(ctx, [y0, y1], w);
  drawSleepBands(ctx, x, y0, y1);
  ctx.strokeStyle = (rates.at(-1) ?? 0) >= 0 ? cssVar('--accent', '#0070f3') : cssVar('--rose', '#ee0000'); ctx.lineWidth = 2;
  for (const [start, end] of timelineChunks(pts)) {
    ctx.beginPath();
    for (let i = start; i <= end; i++) { const yy = y(pts[i].batteryRatePctPerHour ?? 0); i === start ? ctx.moveTo(x(pts[i].ts), yy) : ctx.lineTo(x(pts[i].ts), yy); }
    ctx.stroke();
  }
  ctx.restore();
}

function drawBrightnessBand(ctx, [y0, y1], x) {
  const pts = series.points, w = canvas.getBoundingClientRect().width;
  const y = pct => y1 - ((pct ?? 0) / 100) * (y1 - y0);
  ctx.save(); clipBand(ctx, [y0, y1], w);
  drawThemeBands(ctx, pts, x, y0, y1);
  drawSleepBands(ctx, x, y0, y1);
  ctx.strokeStyle = cssVar('--chart-grid', '#ebebeb'); ctx.fillStyle = cssVar('--chart-muted', '#8f8f8f'); ctx.font = '11px Geist, system-ui'; ctx.lineWidth = 1;
  for (const pct of [0, 50, 100]) { const yy = y(pct); ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(w - PAD.r, yy); ctx.stroke(); }
  ctx.strokeStyle = cssVar('--amber', '#f5a623'); ctx.lineWidth = 2;
  for (const [start, end] of timelineChunks(pts)) {
    ctx.beginPath(); let started = false;
    for (let i = start; i <= end; i++) {
      if (pts[i].brightnessPercent == null) continue;
      const yy = y(pts[i].brightnessPercent);
      started ? ctx.lineTo(x(pts[i].ts), yy) : ctx.moveTo(x(pts[i].ts), yy); started = true;
    }
    if (started) ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = cssVar('--chart-muted', '#8f8f8f'); ctx.font = '11px Geist, system-ui'; ctx.fillText('0', 44, y(0) + 4); ctx.fillText('100', 30, y(100) + 8);
  laneLabel(ctx, y0, 'screen brightness / theme');
}

function drawVideoBand(ctx, [y0, y1], x) {
  const pts = series.points, w = canvas.getBoundingClientRect().width;
  ctx.save(); clipBand(ctx, [y0, y1], w);
  drawSleepBands(ctx, x, y0, y1);
  const top = y0 + 15, barH = y1 - top - 1;
  ctx.strokeStyle = cssVar('--chart-grid', '#ebebeb'); ctx.lineWidth = 1; ctx.strokeRect(PAD.l, top, w - PAD.l - PAD.r, barH);
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], next = pts[i + 1];
    if (next.gapBefore) continue;
    const sx = x(p.ts), width = Math.max(1, x(next.ts) - sx);
    if (p.videoStreaming === true) { ctx.fillStyle = cssVar('--chart-video-fill', 'rgba(80,227,194,0.45)'); ctx.fillRect(sx, top, width, barH); }
    else if (p.videoStreaming === false) { ctx.fillStyle = cssVar('--chart-neutral-fill', 'rgba(242,242,242,0.85)'); ctx.fillRect(sx, top, width, barH); }
  }
  ctx.restore();
  laneLabel(ctx, y0, 'video streaming heuristic');
}

function drawUsbPowerBand(ctx, [y0, y1], x) {
  const pts = series.points, w = canvas.getBoundingClientRect().width;
  ctx.save(); clipBand(ctx, [y0, y1], w);
  drawSleepBands(ctx, x, y0, y1);
  const top = y0 + 15, barH = y1 - top - 1;
  ctx.strokeStyle = cssVar('--chart-grid', '#ebebeb'); ctx.lineWidth = 1; ctx.strokeRect(PAD.l, top, w - PAD.l - PAD.r, barH);
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], next = pts[i + 1];
    if (next.gapBefore) continue;
    const sx = x(p.ts), width = Math.max(1, x(next.ts) - sx);
    if (p.usbPowerSource === true) {
      const watts = Number(p.usbPowerW || 0);
      const alpha = watts > 0 ? Math.min(0.9, 0.45 + watts / 20) : 0.58;
      ctx.fillStyle = `rgba(${cssVar('--chart-usb-fill-rgb', '0,112,243')},${Math.min(0.55, alpha)})`;
      ctx.fillRect(sx, top, width, barH);
    } else if (p.usbPowerSource === false) {
      ctx.fillStyle = cssVar('--chart-neutral-fill', 'rgba(242,242,242,0.85)');
      ctx.fillRect(sx, top, width, barH);
    } else if (p.usbPowerDetail) {
      ctx.fillStyle = cssVar('--chart-unknown-fill', 'rgba(161,161,161,0.20)');
      ctx.fillRect(sx, top, width, barH);
    }
  }
  ctx.restore();
  laneLabel(ctx, y0, 'charging external device / USB source');
}

function drawFocusBand(ctx, [y0, y1], x) {
  const pts = series.points, w = canvas.getBoundingClientRect().width;
  ctx.save(); clipBand(ctx, [y0, y1], w);
  drawSleepBands(ctx, x, y0, y1);
  const top = y0 + 15, barH = y1 - top - 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], next = pts[i + 1];
    if (next.gapBefore) continue;
    const sx = x(p.ts), ex = x(next.ts);
    ctx.fillStyle = focusColor(focusSegmentLabel(p));
    ctx.fillRect(sx, top, Math.max(1, ex - sx), barH);
  }
  let start = 0;
  for (let i = 1; i <= pts.length; i++) {
    const changed = i === pts.length || focusSegmentLabel(pts[i]) !== focusSegmentLabel(pts[start]) || pts[i].gapBefore;
    if (!changed) continue;
    const sx = x(pts[start].ts), ex = x(pts[Math.max(start, i - 1)].ts);
    if (ex - sx > 80 && !pts[start + 1]?.gapBefore) {
      ctx.fillStyle = cssVar('--chart-ink', '#171717'); ctx.font = '11px Geist, system-ui';
      ctx.fillText(focusSegmentLabel(pts[start]).slice(0, 24), sx + 5, top + barH - 5);
    }
    start = i;
  }
  ctx.restore();
  laneLabel(ctx, y0, 'focused window');
}

/* ---------- shared overlays ---------- */

function drawTimeAxis(ctx, x, w, h, vt0, vt1) {
  ctx.fillStyle = cssVar('--chart-muted', '#8f8f8f'); ctx.font = '11px Geist, system-ui';
  ctx.fillText(fmtTime(vt0), PAD.l, h - 6);
  const endLabel = fmtTime(vt1);
  ctx.fillText(endLabel, w - PAD.r - ctx.measureText(endLabel).width, h - 6);
  const mid = vt0 + (vt1 - vt0) / 2;
  const midLabel = fmtTime(mid);
  ctx.fillText(midLabel, x(mid) - ctx.measureText(midLabel).width / 2, h - 6);
}

function drawCrosshair(ctx, x, y1, y2) {
  if (hoverTs == null) return;
  const xx = x(hoverTs);
  ctx.beginPath(); ctx.moveTo(xx, y1); ctx.lineTo(xx, y2); ctx.strokeStyle = cssVar('--accent', '#0070f3'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
}

function drawBrush(ctx, y1, y2) {
  if (!brush) return;
  const a = Math.min(brush.x0, brush.x1), b = Math.max(brush.x0, brush.x1);
  ctx.fillStyle = cssVar('--chart-brush-fill', 'rgba(0,112,243,0.08)'); ctx.fillRect(a, y1, b - a, y2 - y1);
  ctx.strokeStyle = cssVar('--chart-brush-stroke', 'rgba(0,112,243,0.45)'); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(a, y1); ctx.lineTo(a, y2); ctx.moveTo(b, y1); ctx.lineTo(b, y2); ctx.stroke(); ctx.setLineDash([]);
}

function timelineChunks(pts) {
  if (!pts.length) return [];
  const chunks = []; let start = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].gapBefore) { chunks.push([start, i - 1]); start = i; }
  chunks.push([start, pts.length - 1]);
  return chunks;
}

function timelineGapEvents() {
  if (!series?.points?.length) return [];
  const events = [...(series.sleepEvents || [])];
  for (let i = 1; i < series.points.length; i++) {
    const p = series.points[i], prev = series.points[i - 1];
    if (!p.gapBefore) continue;
    if (events.some(e => Math.abs(Number(e.end_ts) - p.ts) < 2000)) continue;
    events.push({ start_ts: prev.ts, end_ts: p.ts, duration_sec: (p.ts - prev.ts) / 1000, kind: 'sample gap', avg_power_w: null, avg_percent_per_hour: p.batteryRatePctPerHour });
  }
  return events;
}

function drawSleepBands(ctx, x, y1, y2) {
  if (!series?.points?.length) return;
  const events = timelineGapEvents();
  if (!events.length) return;
  const [t0, t1] = viewWindow();
  for (const e of events) {
    const start = Math.max(Number(e.start_ts), t0), end = Math.min(Number(e.end_ts), t1);
    if (!(end > start)) continue;
    const sx = x(start), ex = x(end), width = Math.max(2, ex - sx);
    ctx.fillStyle = cssVar('--chart-sleep-fill', 'rgba(245,166,35,0.10)'); ctx.fillRect(sx, y1, width, y2 - y1);
    ctx.strokeStyle = cssVar('--chart-sleep-stroke', 'rgba(245,166,35,0.42)'); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(sx, y1); ctx.lineTo(sx, y2); ctx.moveTo(ex, y1); ctx.lineTo(ex, y2); ctx.stroke(); ctx.setLineDash([]);
  }
}

function gapDurationLabel(secs) {
  const s = Number(secs);
  if (!isFinite(s)) return '';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
  return fmtDuration(s / 3600);
}

function drawGapLabels(ctx, x, yTop) {
  const events = timelineGapEvents();
  if (!events.length) return;
  const [t0, t1] = viewWindow();
  ctx.font = '11px system-ui'; ctx.textBaseline = 'alphabetic';
  for (const e of events) {
    const start = Math.max(Number(e.start_ts), t0), end = Math.min(Number(e.end_ts), t1);
    if (!(end > start)) continue;
    const sx = x(start), ex = x(end), width = ex - sx;
    const label = gapDurationLabel(e.duration_sec);
    const tw = ctx.measureText(label).width;
    if (width < tw + 10) continue;
    const cx = sx + width / 2;
    ctx.fillStyle = cssVar('--chart-gap-label-bg', 'rgba(23,23,23,0.92)'); ctx.fillRect(cx - tw / 2 - 5, yTop, tw + 10, 16);
    ctx.fillStyle = cssVar('--chart-gap-label-fg', '#ffffff'); ctx.fillText(label, cx - tw / 2, yTop + 12);
  }
}

function drawThemeBands(ctx, pts, x, y1, y2) {
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], next = pts[i + 1];
    if (next.gapBefore) continue;
    const theme = String(p.theme || 'unknown').toLowerCase();
    if (theme === 'unknown') continue;
    ctx.fillStyle = theme.includes('light') ? cssVar('--theme-light-band', 'rgba(245,166,35,0.08)') : cssVar('--theme-dark-band', 'rgba(0,112,243,0.06)');
    ctx.fillRect(x(p.ts), y1, Math.max(1, x(next.ts) - x(p.ts)), y2 - y1);
  }
}

function focusSegmentLabel(point) {
  if (!point) return 'unknown';
  if (point.lidClosed) return 'lid closed';
  if (point.screenLocked) return 'locked';
  return point.focusedApp || 'unknown';
}
function focusColor(app) {
  if (!app) return cssVar('--chart-muted', '#8f8f8f');
  if (app === 'locked') return cssVar('--amber', '#f5a623') + 'aa';
  if (app === 'lid closed') return cssVar('--chart-axis', '#a1a1a1') + 'aa';
  return colors[Math.abs(hashString(app)) % colors.length] + 'aa';
}
function hashString(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; }

/* ---------- interaction ---------- */

export function setupTimelineHover() {
  tip = document.getElementById('tip');
  canvas = document.getElementById('chart');
  if (!canvas) return;
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('dblclick', resetZoom);

  document.querySelectorAll('.lane-chip').forEach(chip => {
    const key = chip.dataset.lane;
    chip.classList.toggle('active', enabled.has(key));
    chip.onclick = () => {
      enabled.has(key) ? enabled.delete(key) : enabled.add(key);
      chip.classList.toggle('active', enabled.has(key));
      saveLanes(); drawCharts();
    };
  });
  const reset = document.getElementById('zoomReset');
  if (reset) reset.onclick = resetZoom;
}

function plotX(ev) { return ev.clientX - canvas.getBoundingClientRect().left; }
function tsAtX(px) {
  const [vt0, vt1] = viewWindow();
  const plotW = canvas.getBoundingClientRect().width - PAD.l - PAD.r;
  const rel = Math.max(0, Math.min(1, (px - PAD.l) / Math.max(1, plotW)));
  return vt0 + rel * (vt1 - vt0);
}

function onDown(ev) { if (!dataExtent()) return; brush = { x0: plotX(ev), x1: plotX(ev) }; hoverTs = null; if (tip) tip.style.display = 'none'; }

function onUp() {
  if (!brush) return;
  const a = Math.min(brush.x0, brush.x1), b = Math.max(brush.x0, brush.x1);
  const dragged = b - a > 6;
  brush = null;
  if (dragged) {
    const t0 = tsAtX(a), t1 = tsAtX(b);
    if (t1 - t0 > 1000) { view = { t0, t1 }; toggleResetButton(true); }
  }
  drawCharts();
}

function resetZoom() { view = { t0: null, t1: null }; toggleResetButton(false); drawCharts(); }
function toggleResetButton(on) { const r = document.getElementById('zoomReset'); if (r) r.classList.toggle('hidden', !on); }

function onLeave() { hoverTs = null; hoverApp = null; if (tip) tip.style.display = 'none'; if (!brush) drawCharts(); }

function nearestPointIndexByTime(ts) {
  const pts = series?.points || [];
  if (!pts.length) return 0;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].ts < ts) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(pts[lo - 1].ts - ts) < Math.abs(pts[lo].ts - ts)) return lo - 1;
  return lo;
}

function onMove(ev) {
  if (!series?.points?.length) return;
  const px = plotX(ev);
  if (brush) { brush.x1 = px; drawCharts(); return; }
  const [vt0, vt1] = viewWindow();
  hoverTs = Math.max(vt0, Math.min(vt1, tsAtX(px)));
  const idx = nearestPointIndexByTime(hoverTs);
  const p = series.points[idx];
  const sleep = sleepEventForTs(hoverTs);
  const apps = series.apps || [];

  hoverApp = null;
  const rect = canvas.getBoundingClientRect();
  const bands = computeBands(rect.height);
  const py = ev.clientY - rect.top;
  if (!sleep && py >= bands.main[0] && py <= bands.main[1]) {
    const sums = series.points.map(pt => apps.reduce((s, a) => s + (pt.apps[a] || 0), 0));
    const maxY = Math.max(1, ...sums) * 1.15;
    const [my0, my1] = bands.main;
    const yValue = (1 - (py - my0) / Math.max(1, my1 - my0)) * maxY;
    let acc = 0;
    for (const app of apps) { const next = acc + (p.apps[app] || 0); if (yValue >= acc && yValue <= next) hoverApp = app; acc = next; }
  }
  drawCharts();
  renderTooltip(ev, p, sleep, apps);
}

function sleepEventForTs(ts) { if (ts == null) return null; return timelineGapEvents().find(e => ts >= Number(e.start_ts) && ts <= Number(e.end_ts)) || null; }

function appColor(app) { const idx = (series.apps || []).indexOf(app); return colors[(idx >= 0 ? idx : Math.abs(hashString(app))) % colors.length]; }

function tipTimestamp(ts) {
  const text = fmtDateTime(ts);
  const m = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s+(.+))?$/);
  if (!m) return escapeHtml(text);
  return '<div class="tip-clock"><span class="tip-time">' + escapeHtml(m[2]) + '</span>' + (m[3] ? '<span class="tip-tz">' + escapeHtml(m[3]) + '</span>' : '') + '</div><div class="tip-date">' + escapeHtml(m[1]) + '</div>';
}
function tipMetric(label, value, sub = '') { return '<div class="tip-metric"><span>' + escapeHtml(label) + '</span><b>' + value + '</b><small>' + sub + '</small></div>'; }
function tipLine(label, value) { return '<div class="tip-line"><span>' + escapeHtml(label) + '</span><b>' + value + '</b></div>'; }

function renderTooltip(ev, p, sleep, apps) {
  const lines = sleep ? [] : apps.map(a => [a, p.apps[a] || 0]).filter(x => x[1] > 0.005).sort((a, b) => b[1] - a[1]).slice(0, 10);
  tip.style.display = 'block';
  const rate = p.batteryRatePctPerHour;
  const rateValue = typeof rate === 'number' && isFinite(rate) ? (rate >= 0 ? '+' : '') + rate.toFixed(2) + '%/h' : '—';
  const stateText = [p.lidClosed ? 'lid closed' : '', p.screenLocked ? 'screen locked' : ''].filter(Boolean).join(' / ');
  const sleepAvg = sleep ? (sleep.avg_power_w == null ? '?' : Math.abs(Number(sleep.avg_power_w)).toFixed(2) + 'W') + ' / ' + (sleep.avg_percent_per_hour == null ? '?' : Number(sleep.avg_percent_per_hour).toFixed(2) + '%/h') : '';
  const videoState = p.videoStreaming == null ? 'unknown' : p.videoStreaming ? '<span class="tip-good">streaming?</span>' : 'no';
  const usbState = p.usbPowerSource == null ? 'unknown' : p.usbPowerSource ? 'sourcing' : 'not sourcing';
  const usbText = p.usbPowerW == null ? usbState : usbState + ' / ' + fmtW(p.usbPowerW);
  const appRows = lines.length
    ? lines.map(([a, v]) => '<div class="tip-app ' + (a === hoverApp ? 'is-hovered' : '') + '"><span><i style="background:' + appColor(a) + '"></i>' + (a === hoverApp ? '▸ ' : '') + escapeHtml(a) + '</span><b>' + fmtW(v) + '</b></div>').join('')
    : '<div class="tip-empty">gap interval</div>';

  tip.innerHTML =
    '<div class="tip-title">' + tipTimestamp(hoverTs) + '</div>' +
    (sleep ? '<div class="tip-note">No process samples during sleep/gap; values use nearest battery sample.</div>' : '') +
    '<div class="tip-grid">' +
      tipMetric('Battery', fmtPct(p.batteryPercent), escapeHtml(p.status || 'unknown')) +
      tipMetric('Draw', fmtW(p.totalWatts), 'sensor') +
      tipMetric('Rate', rateValue, 'battery %/h') +
      tipMetric('Network', p.netRxMbps == null ? '—' : Number(p.netRxMbps).toFixed(2) + ' Mbps', 'RX') +
    '</div>' +
    '<div class="tip-section"><div class="tip-section-title">Screen &amp; media</div>' +
      tipLine('Brightness', p.brightnessPercent == null ? '—' : fmtPct(p.brightnessPercent)) +
      tipLine('Theme', escapeHtml(p.theme || 'unknown')) +
      tipLine('Video', videoState) +
      tipLine('USB power', escapeHtml(usbText)) +
      (p.usbPowerDetail ? '<div class="tip-detail">'+escapeHtml(p.usbPowerDetail)+'</div>' : '') +
    '</div>' +
    (sleep ? '<div class="tip-section"><div class="tip-section-title tip-warn">' + escapeHtml(sleep.kind || 'sleep gap') + '</div>' + tipLine('Duration', fmtDuration(Number(sleep.duration_sec) / 3600)) + tipLine('Average', sleepAvg) + '</div>' : '') +
    (!sleep && (stateText || p.focusedApp || p.focusedTitle) ? '<div class="tip-section"><div class="tip-section-title">Focus</div>' +
      (stateText ? tipLine('State', '<b>' + escapeHtml(stateText) + '</b>') : '') +
      (p.focusedApp ? tipLine('App', '<b>' + escapeHtml(p.focusedApp) + '</b>') : '') +
      (p.focusedTitle ? '<div class="tip-detail">' + escapeHtml(p.focusedTitle) + '</div>' : '') +
    '</div>' : '') +
    (hoverApp ? '<div class="tip-hover">Hover: ' + escapeHtml(hoverApp) + '</div>' : '') +
    '<div class="tip-section"><div class="tip-section-title">Estimated watts by app</div><div class="tip-apps">' + appRows + '</div></div>';

  positionTip(ev);
}

function positionTip(ev) {
  const margin = 12, rect = tip.getBoundingClientRect();
  let left = ev.clientX + 16, top = ev.clientY + 16;
  if (left + rect.width + margin > window.innerWidth) left = ev.clientX - rect.width - 16;
  if (top + rect.height + margin > window.innerHeight) top = window.innerHeight - rect.height - margin;
  tip.style.left = Math.max(margin, left) + 'px';
  tip.style.top = Math.max(margin, top) + 'px';
}
