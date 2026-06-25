export async function fetchStatus() {
  return fetch('/api/status').then(r => r.json());
}

export async function fetchSeries({ hours, top, afterTs = null }) {
  const params = new URLSearchParams({ hours: String(hours), top: String(top) });
  if (afterTs) params.set('after_ts', String(afterTs));
  return fetch('/api/series?' + params).then(r => r.json());
}

export async function fetchProcesses() {
  return fetch('/api/processes').then(r => r.json());
}

export async function fetchGroups({ hours }) {
  return fetch('/api/groups?hours=' + hours).then(r => r.json());
}
