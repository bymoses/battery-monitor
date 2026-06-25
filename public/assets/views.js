import { colors, drawCharts } from './charts.js';
import { escapeAttr, escapeHtml, fmtDuration, fmtPct, fmtTime, fmtW } from './format.js';

const expandedGroups = new Set();
let groupsData = null;

export function renderStatus(status) {
  const b = status.latestBattery;
  setText('battery', b ? fmtPct(b.capacity) : '—');
  setText('status', b ? (b.on_battery ? 'unplugged / ' : 'plugged / ') + (b.status || 'unknown') : 'no sample yet');
  setText('watts', b ? fmtW(b.power_w) : '—');

  const d = status.dischargeEstimate;
  setText('rateLabel', d?.mode === 'charging' ? 'Charge rate' : d?.mode === 'discharging' ? 'Drain rate' : 'Battery rate');
  setText('drain', d?.percentPerHour ? (d.mode === 'charging' ? '+' : '-') + d.percentPerHour.toFixed(2) + '%/h' : '—');
  setText('lasts', d?.hoursToFull ? 'full ~' + fmtDuration(d.hoursToFull) + ' / ' + d.detail : d?.hoursRemaining ? 'lasts ~' + fmtDuration(d.hoursRemaining) + ' / ' + d.detail : (d?.detail || 'estimating'));

  setText('poll', b ? fmtTime(b.ts) : '—');
  setText('samples', (status.processRows || 0) + ' process rows stored');

  const e = status.latestEnvironment;
  const screenState = e ? [e.screen_locked ? 'locked' : '', e.lid_closed ? 'lid closed' : ''].filter(Boolean).join(' / ') : '';
  setText('screen', e ? (e.brightness_percent == null ? 'brightness ?' : fmtPct(e.brightness_percent)) : '—');
  setText('theme', e ? ((e.theme || 'unknown') + ' theme / ' + (e.brightness_source || 'no backlight') + (screenState ? ' / ' + screenState : '')) : '—');
  setText('media', e ? ((e.audio_playing ? 'audio' : 'silent') + ' / ' + (e.video_streaming ? 'video?' : 'no video')) : '—');
  setText('network', e ? ('RX ' + (e.net_rx_mbps || 0).toFixed(2) + ' Mbps / TX ' + (e.net_tx_mbps || 0).toFixed(2) + ' Mbps') : '—');
  setText('fan', e?.fan_rpm == null ? '—' : Math.round(e.fan_rpm) + ' RPM');
  setText('fanSource', e?.fan_source || 'no hwmon fan sensor');
  setText('focusApp', e?.focused_app || '—');
  setText('focusTitle', e?.focused_title || 'optional niri helper not running');
}

export function renderLegend(apps) {
  document.getElementById('legend').innerHTML = (apps || []).map((a,i) => '<span class="pill"><span class="swatch" style="background:' + colors[i % colors.length] + '"></span>' + escapeHtml(a) + '</span>').join('');
}

export function renderProcessTable(rows) {
  document.getElementById('rows').innerHTML = (rows || []).map(r => '<tr>' +
    '<td>' + escapeHtml(r.app) + (r.is_self ? ' ⭐' : '') + '</td>' +
    '<td>' + r.pid + '</td>' +
    '<td>' + fmtW(r.estimated_watts) + '</td>' +
    '<td>' + (r.cpu_percent || 0).toFixed(1) + '</td>' +
    '<td>' + (r.io_mb || 0).toFixed(2) + '</td>' +
    '<td>' + (r.rss_mb || 0).toFixed(0) + '</td>' +
    '<td class="muted" title="' + escapeAttr(r.cmd || '') + '">' + escapeHtml((r.cmd || '').slice(0, 120)) + '</td>' +
    '</tr>').join('');
}

export function renderGroups(data) {
  groupsData = data;
  setText('groupHours', data.hours || document.getElementById('hours').value);
  const groups = data.groups || [];
  const max = Math.max(0.001, ...groups.map(g => g.avgWatts || 0));
  const rows = [];
  for (const g of groups) {
    const open = expandedGroups.has(g.app);
    rows.push('<tr class="expand" data-group="' + escapeAttr(g.app) + '">' +
      '<td>' + (open ? '▾ ' : '▸ ') + '<b>' + escapeHtml(g.app) + '</b></td>' +
      '<td>' + fmtW(g.avgWatts) + '</td>' +
      '<td>' + (g.wh || 0).toFixed(3) + '</td>' +
      '<td>' + (g.cpuSeconds || 0).toFixed(1) + '</td>' +
      '<td>' + (g.ioMb || 0).toFixed(1) + '</td>' +
      '<td>' + (g.rssMb || 0).toFixed(0) + '</td>' +
      '<td><div class="bar"><span style="width:' + Math.min(100, (g.avgWatts || 0) / max * 100).toFixed(1) + '%"></span></div></td>' +
      '</tr>');
    if (open) addChildren(rows, g);
  }
  document.getElementById('groupRows').innerHTML = rows.join('') || '<tr><td colspan="7" class="muted">No process samples yet.</td></tr>';
  document.querySelectorAll('#groupRows tr[data-group]').forEach(tr => tr.onclick = () => {
    const g = tr.getAttribute('data-group');
    expandedGroups.has(g) ? expandedGroups.delete(g) : expandedGroups.add(g);
    renderGroups(groupsData);
  });
}

export function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('#latestPanel,#groupsPanel').forEach(p => p.classList.add('hidden'));
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
    drawCharts();
  });
}

function addChildren(rows, group) {
  const total = Math.max(0.001, group.wattSamples || 0);
  for (const c of (group.children || []).slice(0, 40)) {
    rows.push('<tr class="child">' +
      '<td title="' + escapeAttr(c.cmd || '') + '">' + escapeHtml(c.name) + '</td>' +
      '<td>' + fmtW(c.avgWatts) + '</td>' +
      '<td>' + (c.wh || 0).toFixed(3) + '</td>' +
      '<td>' + (c.cpuSeconds || 0).toFixed(1) + '</td>' +
      '<td>' + (c.ioMb || 0).toFixed(1) + '</td>' +
      '<td>' + (c.rssMb || 0).toFixed(0) + '</td>' +
      '<td>' + (((c.wattSamples || 0) / total) * 100).toFixed(1) + '%</td>' +
      '</tr>');
  }
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}
