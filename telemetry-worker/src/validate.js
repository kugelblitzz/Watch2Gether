// Turns an untrusted upload into rows for the `reports` table. Anything not listed here is
// dropped, strings are cut short and numbers clamped, so a bad or hostile client can't store
// arbitrary data (file names, long text) or break queries.

export const MAX_BATCH = 20;
export const MAX_BODY_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const str = (max) => (v) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const num = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const int = (lo, hi) => (v) => {
  const n = num(lo, hi)(v);
  return n == null ? null : Math.round(n);
};
const oneOf = (...vals) => (v) => (vals.includes(v) ? v : null);

const get = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

/** column -> [path in the report, sanitizer] */
export const COLUMNS = {
  schema_v: ['v', int(1, 99)],
  app_version: ['app', str(24)],
  os: ['os', str(40)],
  cpu: ['machine.cpu', str(64)],
  cpu_cores: ['machine.cores', int(1, 512)],
  ram_gb: ['machine.ramGb', int(0, 4096)],
  gpu: ['machine.gpu', str(64)],
  gpu_driver: ['machine.gpuDriver', str(32)],
  mpv_version: ['mpv', str(40)],
  role: ['role', oneOf('host', 'guest')],
  source: ['source', oneOf('local', 'stream')],
  viewers: ['viewers', int(0, 64)],
  codec: ['video.codec', str(24)],
  width: ['video.width', int(0, 16384)],
  height: ['video.height', int(0, 16384)],
  fps: ['video.fps', num(0, 1000)],
  bit_depth: ['video.bitDepth', int(1, 16)],
  hdr: ['video.hdr', oneOf('sdr', 'pq', 'hlg')],
  container: ['video.container', str(16)],
  bitrate_mbps: ['video.bitrateMbps', num(0, 10000)],
  duration_min: ['video.durationMin', int(0, 100000)],
  hwdec: ['decode.hwdec', str(24)],
  dropped_frames: ['decode.droppedFrames', int(0, 1e9)],
  decoder_dropped_frames: ['decode.decoderDroppedFrames', int(0, 1e9)],
  decode_slow_sec: ['decode.slowSec', int(0, 1e7)],
  rtt_ms: ['net.rttMs', int(0, 60000)],
  throughput_mbps: ['net.throughputMbps', num(0, 100000)],
  min_cache_sec: ['net.minCacheSec', num(0, 100000)],
  watch_sec: ['sync.watchSec', int(0, 1e7)],
  stall_sec: ['sync.stallSec', int(0, 1e7)],
  stalls_network: ['sync.stalls.network', int(0, 1e6)],
  stalls_seek: ['sync.stalls.seek', int(0, 1e6)],
  stalls_load: ['sync.stalls.load', int(0, 1e6)],
  stalls_decode: ['sync.stalls.decode', int(0, 1e6)],
  stalls_align: ['sync.stalls.align', int(0, 1e6)],
  stalls_other: ['sync.stalls.other', int(0, 1e6)],
  drift_seeks: ['sync.driftSeeks', int(0, 1e6)],
  drift_seeks_slow: ['sync.driftSeeksSlow', int(0, 1e6)],
  max_drift_ms: ['sync.maxDriftMs', int(0, 1e8)],
};

export function sanitizeReport(rep) {
  if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return null;
  const row = {};
  for (const [col, [path, clean]] of Object.entries(COLUMNS)) row[col] = clean(get(rep, path));
  if (row.schema_v == null || row.watch_sec == null) return null; // not one of ours
  return row;
}

/** { ok: true, installId, rows } or { ok: false, error } */
export function validateBatch(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON object' };
  const installId = typeof body.installId === 'string' ? body.installId.toLowerCase() : '';
  if (!UUID.test(installId)) return { ok: false, error: 'installId must be a random (v4) UUID' };
  if (!Array.isArray(body.reports) || body.reports.length === 0) return { ok: false, error: 'reports must be a non-empty array' };
  if (body.reports.length > MAX_BATCH) return { ok: false, error: `At most ${MAX_BATCH} reports per request` };
  const rows = body.reports.map(sanitizeReport).filter(Boolean);
  if (!rows.length) return { ok: false, error: 'No valid reports' };
  return { ok: true, installId, rows };
}

export function isInstallId(s) {
  return typeof s === 'string' && UUID.test(s.toLowerCase());
}
