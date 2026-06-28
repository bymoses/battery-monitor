PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS battery_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, on_battery INTEGER NOT NULL,
  status TEXT NOT NULL, capacity REAL, energy_wh REAL, power_w REAL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS process_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  pid INTEGER NOT NULL, ppid INTEGER NOT NULL, name TEXT NOT NULL, app TEXT NOT NULL, cmd TEXT NOT NULL,
  cpu_percent REAL NOT NULL, cpu_seconds REAL NOT NULL, io_mb REAL NOT NULL, rss_mb REAL NOT NULL,
  score REAL NOT NULL, estimated_watts REAL NOT NULL, is_self INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS process_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, name TEXT NOT NULL, cmd TEXT NOT NULL,
  UNIQUE(app, name, cmd)
);
CREATE TABLE IF NOT EXISTS process_samples_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  pid INTEGER NOT NULL, ppid INTEGER NOT NULL, process_id INTEGER NOT NULL,
  cpu_percent REAL NOT NULL, cpu_seconds REAL NOT NULL, io_mb REAL NOT NULL, rss_mb REAL NOT NULL,
  score REAL NOT NULL, estimated_watts REAL NOT NULL, is_self INTEGER NOT NULL,
  FOREIGN KEY(process_id) REFERENCES process_identities(id)
);
CREATE TABLE IF NOT EXISTS sleep_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  duration_sec REAL NOT NULL, kind TEXT NOT NULL, start_capacity REAL, end_capacity REAL,
  capacity_delta REAL, start_energy_wh REAL, end_energy_wh REAL, energy_delta_wh REAL,
  avg_power_w REAL, avg_percent_per_hour REAL, UNIQUE(start_ts, end_ts)
);
CREATE TABLE IF NOT EXISTS sample_app_totals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  app TEXT NOT NULL, watts REAL NOT NULL, UNIQUE(sample_id, app)
);
CREATE TABLE IF NOT EXISTS sample_process_totals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  process_id INTEGER NOT NULL, watts REAL NOT NULL, cpu_seconds REAL NOT NULL, io_mb REAL NOT NULL,
  rss_mb_sum REAL NOT NULL, rss_rows INTEGER NOT NULL, row_count INTEGER NOT NULL,
  UNIQUE(sample_id, process_id), FOREIGN KEY(process_id) REFERENCES process_identities(id)
);
CREATE TABLE IF NOT EXISTS sample_group_totals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  app TEXT NOT NULL, child_name TEXT NOT NULL, cmd TEXT NOT NULL, watts REAL NOT NULL,
  cpu_seconds REAL NOT NULL, io_mb REAL NOT NULL, rss_mb_sum REAL NOT NULL,
  rss_rows INTEGER NOT NULL, row_count INTEGER NOT NULL, UNIQUE(sample_id, app, child_name)
);
CREATE TABLE IF NOT EXISTS environment_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  theme TEXT NOT NULL, theme_detail TEXT NOT NULL, brightness_percent REAL, brightness_source TEXT NOT NULL,
  audio_playing INTEGER, audio_detail TEXT NOT NULL, video_streaming INTEGER, video_detail TEXT NOT NULL,
  net_rx_mbps REAL NOT NULL, net_tx_mbps REAL NOT NULL, focused_app TEXT NOT NULL DEFAULT '',
  focused_title TEXT NOT NULL DEFAULT '', focused_pid INTEGER, lid_closed INTEGER, lid_detail TEXT NOT NULL DEFAULT '',
  screen_locked INTEGER, screen_lock_detail TEXT NOT NULL DEFAULT '', fan_rpm REAL, fan_source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_battery_ts ON battery_samples(ts);
CREATE INDEX IF NOT EXISTS idx_process_ts_app ON process_samples(ts, app);
CREATE INDEX IF NOT EXISTS idx_process_sample ON process_samples(sample_id);
CREATE INDEX IF NOT EXISTS idx_process_v2_ts ON process_samples_v2(ts);
CREATE INDEX IF NOT EXISTS idx_process_v2_sample ON process_samples_v2(sample_id);
CREATE INDEX IF NOT EXISTS idx_process_v2_identity ON process_samples_v2(process_id);
CREATE INDEX IF NOT EXISTS idx_sample_app_totals_ts_app ON sample_app_totals(ts, app);
CREATE INDEX IF NOT EXISTS idx_sample_app_totals_sample ON sample_app_totals(sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_process_totals_ts ON sample_process_totals(ts);
CREATE INDEX IF NOT EXISTS idx_sample_process_totals_sample ON sample_process_totals(sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_process_totals_identity ON sample_process_totals(process_id);
CREATE INDEX IF NOT EXISTS idx_sample_group_totals_ts ON sample_group_totals(ts);
CREATE INDEX IF NOT EXISTS idx_sample_group_totals_sample ON sample_group_totals(sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_group_totals_app_child ON sample_group_totals(app, child_name);
CREATE INDEX IF NOT EXISTS idx_sample_group_totals_ts_app_child ON sample_group_totals(ts, app, child_name);
CREATE INDEX IF NOT EXISTS idx_sleep_events_time ON sleep_events(start_ts, end_ts);
CREATE INDEX IF NOT EXISTS idx_environment_ts ON environment_samples(ts);
