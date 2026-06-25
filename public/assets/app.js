import { fetchDashboard } from './api.js';
import { drawCharts, setSeries, setupTimelineHover } from './charts.js';
import { renderGroups, renderLegend, renderProcessTable, renderStatus, setupTabs } from './views.js';

async function refresh() {
  const hours = document.getElementById('hours').value;
  const top = document.getElementById('top').value;
  const { status, series, latest, groups } = await fetchDashboard({ hours, top });

  setSeries(series);
  renderStatus(status);
  drawCharts();
  renderLegend(series.apps || []);
  renderProcessTable(latest.rows || []);
  renderGroups(groups);
}

function boot() {
  setupTabs();
  setupTimelineHover();
  window.addEventListener('resize', drawCharts);
  document.getElementById('refresh').onclick = refresh;
  document.getElementById('hours').onchange = refresh;
  document.getElementById('top').onchange = refresh;
  setInterval(refresh, 30000);
  refresh().catch(e => { console.error(e); alert(e.message); });
}

boot();
