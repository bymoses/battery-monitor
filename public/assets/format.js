export const fmtW = (v) => v == null ? '—' : (Math.round(v * 100) / 100).toFixed(2) + ' W';
export const fmtPct = (v) => v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1) + '%';
export const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString() : '—';
export const fmtDuration = (h) => h == null ? '—' : (h >= 24 ? (h / 24).toFixed(1) + 'd' : Math.floor(h) + 'h ' + Math.round((h % 1) * 60) + 'm');

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/\u0060/g, '&#96;');
}
