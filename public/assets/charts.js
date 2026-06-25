import { escapeHtml, fmtDateTime, fmtDuration, fmtPct, fmtTime, fmtW } from './format.js';

export const colors = ['#60a5fa','#34d399','#fbbf24','#f472b6','#a78bfa','#fb7185','#22d3ee','#c084fc','#4ade80','#f97316','#93c5fd','#e879f9','#d9f99d','#facc15','#38bdf8'];

let series = null;
let hoverTs = null;
let hoverIndex = null;
let tip = null;

export function setSeries(nextSeries) {
  series = nextSeries;
}

export function drawCharts() {
  drawMainChart();
}

export function setupTimelineHover() {
  tip = document.getElementById('tip');
  for (const id of ['chart', 'rateChart', 'brightnessChart', 'focusChart']) {
    document.getElementById(id).addEventListener('mousemove', handleTimelineHover);
    document.getElementById(id).addEventListener('mouseleave', clearTimelineHover);
  }
}

function drawMainChart() {
  const canvas = document.getElementById('chart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(600, rect.width * dpr); canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, padL = 52, padR = 46, padT = 18, padB = 34;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = '#0d1424'; ctx.fillRect(0,0,w,h);
  if (!series || !series.points || series.points.length < 2) {
    ctx.fillStyle='#94a3b8'; ctx.fillText('Waiting for at least two samples…', 20, 30); drawRateChart(); drawBrightnessChart(); drawFocusChart(); return;
  }
  const pts = series.points, apps = series.apps;
  const t0 = pts[0].ts, t1 = pts[pts.length-1].ts;
  const sums = pts.map(p => apps.reduce((s,a)=>s+(p.apps[a]||0),0));
  const maxY = Math.max(1, ...sums) * 1.15;
  const x = ts => padL + (ts - t0) / Math.max(1, t1 - t0) * (w - padL - padR);
  const y = v => padT + (1 - v / maxY) * (h - padT - padB);
  ctx.strokeStyle = '#233044'; ctx.lineWidth = 1; ctx.fillStyle = '#94a3b8'; ctx.font = '12px system-ui';
  for (let i=0;i<=4;i++) { const yy = y(maxY*i/4); ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w-padR, yy); ctx.stroke(); ctx.fillText((maxY*i/4).toFixed(1)+'W', 6, yy+4); }
  drawSleepBands(ctx, x, padT, h-padB);
  const chunks = timelineChunks(pts);
  let base = new Array(pts.length).fill(0);
  apps.forEach((app, ai) => {
    const top = pts.map((p,i) => base[i] + (p.apps[app] || 0));
    for (const [start, end] of chunks) {
      if (end <= start) continue;
      ctx.beginPath();
      for (let i=start;i<=end;i++) i === start ? ctx.moveTo(x(pts[i].ts), y(top[i])) : ctx.lineTo(x(pts[i].ts), y(top[i]));
      for (let i=end;i>=start;i--) ctx.lineTo(x(pts[i].ts), y(base[i]));
      ctx.closePath(); ctx.fillStyle = colors[ai % colors.length] + 'cc'; ctx.fill();
    }
    base = top;
  });
  drawBatteryPercent(ctx, pts, x, chunks, w, h, padR, padT, padB);
  drawHoverLine(ctx, x, padT, h-padB);
  drawRateChart();
  drawBrightnessChart();
  drawFocusChart();
}

function drawBatteryPercent(ctx, pts, x, chunks, w, h, padR, padT, padB) {
  const batteryY = pct => padT + (1 - pct / 100) * (h - padT - padB);
  ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1; ctx.fillStyle = '#cbd5e1'; ctx.font = '11px system-ui';
  ctx.beginPath(); ctx.moveTo(w-padR, padT); ctx.lineTo(w-padR, h-padB); ctx.stroke();
  for (const pct of [0, 25, 50, 75, 100]) {
    const yy = batteryY(pct);
    ctx.beginPath(); ctx.moveTo(w-padR, yy); ctx.lineTo(w-padR+5, yy); ctx.stroke();
    ctx.fillText(pct + '%', w-padR+8, yy+4);
  }
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2;
  for (const [start, end] of chunks) {
    ctx.beginPath();
    for (let i=start;i<=end;i++) { const yy = batteryY(pts[i].batteryPercent || 0); i === start ? ctx.moveTo(x(pts[i].ts), yy) : ctx.lineTo(x(pts[i].ts), yy); }
    ctx.stroke();
  }
  ctx.setLineDash([5,5]); ctx.strokeStyle = '#e2e8f099';
  for (let i=1;i<pts.length;i++) if (pts[i].gapBefore) {
    ctx.beginPath(); ctx.moveTo(x(pts[i-1].ts), batteryY(pts[i-1].batteryPercent || 0)); ctx.lineTo(x(pts[i].ts), batteryY(pts[i].batteryPercent || 0)); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = '#e2e8f0'; ctx.fillText('battery %', w-102, padT+12);
}

function drawRateChart() {
  const canvas = document.getElementById('rateChart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(600, rect.width * dpr); canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, padL = 52, padR = 46, padT = 12, padB = 20;
  ctx.clearRect(0,0,w,h); ctx.fillStyle = '#0d1424'; ctx.fillRect(0,0,w,h);
  if (!series || !series.points || series.points.length < 2) return;
  const pts = series.points, t0 = pts[0].ts, t1 = pts[pts.length-1].ts;
  const x = ts => padL + (ts - t0) / Math.max(1, t1 - t0) * (w - padL - padR);
  drawSleepBands(ctx, x, padT, h-padB);
  const rates = pts.map(p => p.batteryRatePctPerHour).filter(v => typeof v === 'number' && isFinite(v));
  const maxRate = Math.max(1, ...rates.map(v => Math.abs(v))) * 1.2;
  const y = v => padT + (0.5 - (v / maxRate) * 0.5) * (h - padT - padB);
  ctx.strokeStyle = '#233044'; ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (const v of [-maxRate, 0, maxRate]) { const yy = y(v); ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w-padR, yy); ctx.stroke(); ctx.fillText((v>=0?'+':'')+v.toFixed(1)+'%/h', 3, yy+4); }
  ctx.strokeStyle = (rates.at(-1) ?? 0) >= 0 ? '#22c55e' : '#fb7185'; ctx.lineWidth = 2;
  for (const [start, end] of timelineChunks(pts)) {
    ctx.beginPath();
    for (let i=start;i<=end;i++) { const yy = y(pts[i].batteryRatePctPerHour ?? 0); i === start ? ctx.moveTo(x(pts[i].ts), yy) : ctx.lineTo(x(pts[i].ts), yy); }
    ctx.stroke();
  }
  ctx.setLineDash([5,5]); ctx.strokeStyle = '#fb718599';
  for (let i=1;i<pts.length;i++) if (pts[i].gapBefore) { ctx.beginPath(); ctx.moveTo(x(pts[i-1].ts), y(pts[i-1].batteryRatePctPerHour ?? 0)); ctx.lineTo(x(pts[i].ts), y(pts[i].batteryRatePctPerHour ?? 0)); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.fillStyle = '#cbd5e1'; ctx.fillText('charge / discharge rate', padL, 12);
  drawHoverLine(ctx, x, padT, h-padB);
}

function drawBrightnessChart() {
  const canvas = document.getElementById('brightnessChart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(600, rect.width * dpr); canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, padL = 52, padR = 46, padT = 12, padB = 20;
  ctx.clearRect(0,0,w,h); ctx.fillStyle = '#0d1424'; ctx.fillRect(0,0,w,h);
  if (!series || !series.points || series.points.length < 2) return;
  const pts = series.points, t0 = pts[0].ts, t1 = pts[pts.length-1].ts;
  const x = ts => padL + (ts - t0) / Math.max(1, t1 - t0) * (w - padL - padR);
  const y = pct => padT + (1 - (pct ?? 0) / 100) * (h - padT - padB);
  drawThemeBands(ctx, pts, x, padT, h-padB);
  drawSleepBands(ctx, x, padT, h-padB);
  ctx.strokeStyle = '#233044'; ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (const pct of [0, 50, 100]) { const yy = y(pct); ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w-padR, yy); ctx.stroke(); ctx.fillText(pct + '%', 12, yy + 4); }
  ctx.strokeStyle = '#facc15'; ctx.lineWidth = 2;
  for (const [start, end] of timelineChunks(pts)) {
    ctx.beginPath();
    let started = false;
    for (let i=start;i<=end;i++) {
      if (pts[i].brightnessPercent == null) continue;
      const yy = y(pts[i].brightnessPercent);
      started ? ctx.lineTo(x(pts[i].ts), yy) : ctx.moveTo(x(pts[i].ts), yy);
      started = true;
    }
    if (started) ctx.stroke();
  }
  ctx.fillStyle = '#cbd5e1'; ctx.font = '11px system-ui'; ctx.fillText('screen brightness / theme', padL, 12);
  drawHoverLine(ctx, x, padT, h-padB);
}

function drawThemeBands(ctx, pts, x, y1, y2) {
  for (let i=0;i<pts.length-1;i++) {
    const p = pts[i], next = pts[i+1];
    if (next.gapBefore) continue;
    const theme = String(p.theme || 'unknown').toLowerCase();
    if (theme === 'unknown') continue;
    ctx.fillStyle = theme.includes('light') ? 'rgba(250,204,21,0.10)' : 'rgba(59,130,246,0.08)';
    ctx.fillRect(x(p.ts), y1, Math.max(1, x(next.ts) - x(p.ts)), y2 - y1);
  }
}

function drawFocusChart() {
  const canvas = document.getElementById('focusChart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(600, rect.width * dpr); canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, padL = 52, padR = 46, padT = 12, padB = 20;
  ctx.clearRect(0,0,w,h); ctx.fillStyle = '#0d1424'; ctx.fillRect(0,0,w,h);
  if (!series || !series.points || series.points.length < 2) return;
  const pts = series.points, t0 = pts[0].ts, t1 = pts[pts.length-1].ts;
  const x = ts => padL + (ts - t0) / Math.max(1, t1 - t0) * (w - padL - padR);
  drawSleepBands(ctx, x, padT, h-padB);
  ctx.fillStyle = '#cbd5e1'; ctx.font = '11px system-ui'; ctx.fillText('focused window', padL, 12);
  const y = padT + 16, barH = Math.max(12, h - padT - padB - 18);
  for (let i=0;i<pts.length-1;i++) {
    const p = pts[i], next = pts[i+1];
    if (next.gapBefore) continue;
    const sx = x(p.ts), ex = x(next.ts);
    const label = focusSegmentLabel(p);
    ctx.fillStyle = focusColor(label);
    ctx.fillRect(sx, y, Math.max(1, ex - sx), barH);
  }
  // Draw labels for long contiguous focused app runs.
  let start = 0;
  for (let i=1;i<=pts.length;i++) {
    const changed = i === pts.length || focusSegmentLabel(pts[i]) !== focusSegmentLabel(pts[start]) || pts[i].gapBefore;
    if (!changed) continue;
    const sx = x(pts[start].ts), ex = x(pts[Math.max(start, i-1)].ts);
    if (ex - sx > 80 && !pts[start + 1]?.gapBefore) {
      ctx.fillStyle = '#e2e8f0'; ctx.font = '11px system-ui';
      ctx.fillText(focusSegmentLabel(pts[start]).slice(0, 22), sx + 4, y + barH - 4);
    }
    start = i;
  }
  drawHoverLine(ctx, x, padT, h-padB);
  ctx.fillStyle = '#94a3b8'; ctx.font = '11px system-ui';
  ctx.fillText(fmtTime(t0), padL, h-5);
  ctx.fillText(fmtTime(t1), w-130, h-5);
}

function focusSegmentLabel(point) {
  if (!point) return 'unknown';
  if (point.lidClosed) return 'lid closed';
  if (point.screenLocked) return 'locked';
  return point.focusedApp || 'unknown';
}

function focusColor(app) {
  if (!app) return '#334155';
  if (app === 'locked') return '#f97316aa';
  if (app === 'lid closed') return '#64748baa';
  return colors[Math.abs(hashString(app)) % colors.length] + 'aa';
}

function hashString(s) {
  let h = 0;
  for (let i=0;i<s.length;i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function drawHoverLine(ctx, x, y1, y2) {
  if (hoverTs == null) return;
  const xx = x(hoverTs);
  ctx.beginPath(); ctx.moveTo(xx, y1); ctx.lineTo(xx, y2); ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1; ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]);
}

function timelineChunks(pts) {
  if (!pts.length) return [];
  const chunks = [];
  let start = 0;
  for (let i=1;i<pts.length;i++) {
    if (pts[i].gapBefore) { chunks.push([start, i-1]); start = i; }
  }
  chunks.push([start, pts.length - 1]);
  return chunks;
}

function timelineGapEvents() {
  if (!series?.points?.length) return [];
  const events = [...(series.sleepEvents || [])];
  for (let i=1;i<series.points.length;i++) {
    const p = series.points[i], prev = series.points[i-1];
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
  const t0 = series.points[0].ts, t1 = series.points[series.points.length - 1].ts;
  ctx.save();
  for (const e of events) {
    const start = Math.max(Number(e.start_ts), t0), end = Math.min(Number(e.end_ts), t1);
    if (!(end > start)) continue;
    const sx = x(start), ex = x(end), width = Math.max(2, ex - sx);
    ctx.fillStyle = 'rgba(251,191,36,0.10)'; ctx.fillRect(sx, y1, width, y2-y1);
    ctx.strokeStyle = 'rgba(251,191,36,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(sx, y1); ctx.lineTo(sx, y2); ctx.moveTo(ex, y1); ctx.lineTo(ex, y2); ctx.stroke(); ctx.setLineDash([]);
    if (width > 70) {
      const avg = e.avg_power_w == null ? (e.avg_percent_per_hour == null ? '?' : Number(e.avg_percent_per_hour).toFixed(2) + '%/h') : Math.abs(Number(e.avg_power_w)).toFixed(2) + 'W';
      const kind = String(e.kind || 'sleep').includes('gap') ? 'gap' : 'sleep';
      ctx.fillStyle = '#fbbf24'; ctx.font = '11px system-ui';
      ctx.fillText(kind + ' ' + fmtDuration(Number(e.duration_sec) / 3600) + ' ' + avg, sx + 5, y1 + 14);
    }
  }
  ctx.restore();
}

function sleepEventForTs(ts) {
  if (ts == null) return null;
  return timelineGapEvents().find(e => ts >= Number(e.start_ts) && ts <= Number(e.end_ts)) || null;
}

function nearestPointIndexByTime(ts) {
  const pts = series?.points || [];
  if (!pts.length) return 0;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pts[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(pts[lo - 1].ts - ts) < Math.abs(pts[lo].ts - ts)) return lo - 1;
  return lo;
}

function handleTimelineHover(ev) {
  if (!series?.points?.length) return;
  const rect = ev.target.getBoundingClientRect();
  const padL = 52, padR = 46;
  const rel = Math.max(0, Math.min(1, (ev.clientX - rect.left - padL) / Math.max(1, rect.width - padL - padR)));
  const pts = series.points;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
  hoverTs = t0 + rel * Math.max(1, t1 - t0);
  const idx = nearestPointIndexByTime(hoverTs);
  hoverIndex = idx;
  const p = pts[idx];
  const sleep = sleepEventForTs(hoverTs);
  const apps = series.apps || [];
  let hovered = null;
  if (ev.target.id === 'chart' && !sleep) {
    const sums = series.points.map(point => apps.reduce((s,a)=>s+(point.apps[a]||0),0));
    const maxY = Math.max(1, ...sums) * 1.15;
    const padT = 18, padB = 34;
    const yValue = (1 - ((ev.clientY - rect.top - padT) / Math.max(1, rect.height - padT - padB))) * maxY;
    let acc = 0;
    for (const app of apps) {
      const next = acc + (p.apps[app] || 0);
      if (yValue >= acc && yValue <= next) hovered = app;
      acc = next;
    }
  }
  drawCharts();
  const lines = sleep ? [] : apps.map(a => [a, p.apps[a] || 0]).filter(x=>x[1]>0.005).sort((a,b)=>b[1]-a[1]).slice(0,10);
  tip.style.display='block'; tip.style.left=(ev.clientX+14)+'px'; tip.style.top=(ev.clientY+14)+'px';
  const rate = p.batteryRatePctPerHour;
  const rateText = typeof rate === 'number' && isFinite(rate) ? ' / rate ' + (rate >= 0 ? '+' : '') + rate.toFixed(2) + '%/h' : '';
  const sleepText = sleep ? '<br><b style="color:#fbbf24">'+escapeHtml(sleep.kind || 'sleep gap')+': '+fmtDuration(Number(sleep.duration_sec)/3600)+', avg '+(sleep.avg_power_w == null ? '?' : Math.abs(Number(sleep.avg_power_w)).toFixed(2)+'W')+', '+(sleep.avg_percent_per_hour == null ? '?' : Number(sleep.avg_percent_per_hour).toFixed(2)+'%/h')+'</b>' : '';
  const stateText = [p.lidClosed ? 'lid closed' : '', p.screenLocked ? 'screen locked' : ''].filter(Boolean).join(' / ');
  const brightnessText = p.brightnessPercent == null ? '' : '<br>brightness: '+fmtPct(p.brightnessPercent)+' / theme: '+escapeHtml(p.theme || 'unknown');
  const focusedText = sleep ? '' : (stateText ? '<br><b>'+escapeHtml(stateText)+'</b>' : '') + (p.focusedApp || p.focusedTitle ? '<br><b>focused: '+escapeHtml(p.focusedApp || 'unknown')+'</b>' + (p.focusedTitle ? '<br>'+escapeHtml(p.focusedTitle) : '') : '');
  tip.innerHTML = '<b>'+fmtDateTime(hoverTs)+'</b><br>' +
    (sleep ? 'no process samples during sleep/gap<br>nearest battery sample: ' : '') +
    'battery '+fmtPct(p.batteryPercent)+' / '+escapeHtml(p.status || '')+' / draw '+fmtW(p.totalWatts)+rateText + brightnessText + sleepText + focusedText +
    (hovered ? '<br><b style="color:#fbbf24">hover: '+escapeHtml(hovered)+'</b>' : '') + '<br>' +
    (lines.length ? lines.map(([a,v]) => (a === hovered ? '<b style="color:#fbbf24">▸ '+escapeHtml(a)+': '+fmtW(v)+'</b>' : escapeHtml(a)+': '+fmtW(v))).join('<br>') : '<span class="muted">gap interval</span>');
}

function clearTimelineHover() {
  hoverIndex = null;
  hoverTs = null;
  if (tip) tip.style.display='none';
  drawCharts();
}
