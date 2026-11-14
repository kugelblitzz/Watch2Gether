-- One row per video per viewer. Columns mirror telemetry-worker/src/validate.js COLUMNS.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  install_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,          -- ms since epoch, set by the server
  schema_v INTEGER,
  app_version TEXT,
  os TEXT,
  cpu TEXT,
  cpu_cores INTEGER,
  ram_gb INTEGER,
  gpu TEXT,
  gpu_driver TEXT,
  mpv_version TEXT,
  role TEXT,                             -- host | guest
  source TEXT,                           -- local | stream
  viewers INTEGER,
  codec TEXT,                            -- av1, hevc, h264, vp9, ...
  width INTEGER,
  height INTEGER,
  fps REAL,
  bit_depth INTEGER,
  hdr TEXT,                              -- sdr | pq | hlg
  container TEXT,
  bitrate_mbps REAL,
  duration_min INTEGER,
  hwdec TEXT,                            -- d3d11va, nvdec, ... or 'no' (CPU decoding)
  dropped_frames INTEGER,
  decoder_dropped_frames INTEGER,
  decode_slow_sec INTEGER,               -- seconds the decoder couldn't keep up
  rtt_ms INTEGER,
  throughput_mbps REAL,
  min_cache_sec REAL,
  watch_sec INTEGER,
  stall_sec INTEGER,
  stalls_network INTEGER,
  stalls_seek INTEGER,
  stalls_load INTEGER,
  stalls_decode INTEGER,
  stalls_align INTEGER,
  stalls_other INTEGER,
  drift_seeks INTEGER,
  drift_seeks_slow INTEGER,
  max_drift_ms INTEGER
);
CREATE INDEX IF NOT EXISTS reports_install ON reports (install_id, received_at);
CREATE INDEX IF NOT EXISTS reports_received ON reports (received_at);
CREATE INDEX IF NOT EXISTS reports_codec ON reports (codec, hwdec);
