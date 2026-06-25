export async function fetchDashboard({ hours, top }) {
  const [status, series, latest, groups] = await Promise.all([
    fetch('/api/status').then(r => r.json()),
    fetch('/api/series?hours=' + hours + '&top=' + top).then(r => r.json()),
    fetch('/api/processes').then(r => r.json()),
    fetch('/api/groups?hours=' + hours).then(r => r.json()),
  ]);
  return { status, series, latest, groups };
}
