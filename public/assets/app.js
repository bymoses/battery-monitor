import { fetchGroups, fetchProcesses, fetchSeries, fetchStatus } from './api.js';
import { drawCharts, setSeries, setupTimelineHover } from './charts.js';
import { renderGroups, renderLegend, renderProcessTable, renderStatus, setupTabs } from './views.js';

let currentSeries = null;
let currentKey = '';
let lastFullSeriesAt = 0;

async function refresh({ full = false } = {}) {
  const hours = document.getElementById('hours').value;
  const top = document.getElementById('top').value;
  const key = hours + ':' + top;
  if (key !== currentKey) {
    full = true;
    currentKey = key;
  }

  const afterTs = !full && currentSeries?.points?.length ? currentSeries.points.at(-1).ts : null;
  const shouldRefreshHeavyPanels = full || !currentSeries || Date.now() - lastFullSeriesAt > 5 * 60 * 1000;

  const [status, nextSeries, latest, groups] = await Promise.all([
    fetchStatus(),
    fetchSeries({ hours, top, afterTs }),
    shouldRefreshHeavyPanels ? fetchProcesses() : Promise.resolve(null),
    shouldRefreshHeavyPanels ? fetchGroups({ hours }) : Promise.resolve(null),
  ]);

  currentSeries = mergeSeries(currentSeries, nextSeries, { hours, top, full });
  setSeries(currentSeries);
  renderStatus(status);
  drawCharts();
  renderLegend(currentSeries.apps || []);
  if (latest) renderProcessTable(latest.rows || []);
  if (groups) renderGroups(groups);
  if (full || shouldRefreshHeavyPanels) lastFullSeriesAt = Date.now();
}

function mergeSeries(existing, incoming, { hours, full }) {
  if (full || !existing || !incoming.incremental) return incoming;
  if (!sameList(existing.apps || [], incoming.apps || [])) {
    // Top app set changed; request a full window so historical stacks stay correct.
    setTimeout(() => refresh({ full: true }).catch(console.error), 0);
  }
  const cutoff = Date.now() - Number(hours) * 60 * 60 * 1000;
  const pointsByTs = new Map((existing.points || []).filter(p => p.ts >= cutoff).map(p => [p.ts, p]));
  for (const p of incoming.points || []) pointsByTs.set(p.ts, p);
  const sleepByKey = new Map((existing.sleepEvents || []).filter(e => Number(e.end_ts) >= cutoff).map(e => [Number(e.start_ts) + ':' + Number(e.end_ts), e]));
  for (const e of incoming.sleepEvents || []) sleepByKey.set(Number(e.start_ts) + ':' + Number(e.end_ts), e);
  return {
    ...incoming,
    apps: incoming.apps || existing.apps || [],
    points: [...pointsByTs.values()].sort((a, b) => a.ts - b.ts),
    sleepEvents: [...sleepByKey.values()].sort((a, b) => Number(a.start_ts) - Number(b.start_ts)),
  };
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function boot() {
  setupTabs();
  setupTimelineHover();
  window.addEventListener('resize', drawCharts);
  document.getElementById('refresh').onclick = () => refresh({ full: true });
  document.getElementById('hours').onchange = () => refresh({ full: true });
  document.getElementById('top').onchange = () => refresh({ full: true });
  setInterval(() => refresh().catch(console.error), 30000);
  refresh({ full: true }).catch(e => { console.error(e); alert(e.message); });
}

boot();
