let timezoneOffsetHours = Number(localStorage.getItem('battery-monitor.timezoneOffsetHours') ?? '3');

export function setTimezoneOffsetHours(offset) {
  timezoneOffsetHours = Number(offset);
  localStorage.setItem('battery-monitor.timezoneOffsetHours', String(timezoneOffsetHours));
}

export function getTimezoneOffsetHours() {
  return timezoneOffsetHours;
}

export function timezoneLabel(offset = timezoneOffsetHours) {
  const n = Number(offset);
  if (!Number.isFinite(n)) return 'Local';
  if (n === 0) return 'UTC';
  return 'UTC' + (n > 0 ? '+' : '') + n;
}

export function formatTimestamp(ts, { date = false } = {}) {
  if (!ts) return '—';
  if (!Number.isFinite(timezoneOffsetHours)) {
    return date ? new Date(ts).toLocaleString() : new Date(ts).toLocaleTimeString();
  }
  const d = new Date(ts + timezoneOffsetHours * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  if (!date) return `${hh}:${mm}:${ss}`;
  const yyyy = d.getUTCFullYear();
  const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mon}-${day} ${hh}:${mm}:${ss} ${timezoneLabel()}`;
}

export const fmtW = (v) => v == null ? '—' : (Math.round(v * 100) / 100).toFixed(2) + ' W';
export const fmtPct = (v) => v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1) + '%';
export const fmtTime = (ts) => formatTimestamp(ts);
export const fmtDateTime = (ts) => formatTimestamp(ts, { date: true });
export const fmtDuration = (h) => h == null ? '—' : (h >= 24 ? (h / 24).toFixed(1) + 'd' : Math.floor(h) + 'h ' + Math.round((h % 1) * 60) + 'm');

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/\u0060/g, '&#96;');
}
