// The password-protected stats page.
//
//   GET /stats             the page            (HTTP Basic auth; any user name, password = STATS_PASSWORD)
//   GET /stats/app.js      its script
//   GET /stats/api?days=N  the numbers, as JSON
//
// The password is a Worker secret: `npx wrangler@4 secret put STATS_PASSWORD` (12+ characters).
// Login attempts are capped by the LOGIN_LIMITER binding (wrangler.toml), keyed by one constant,
// not by visitor IP: we don't read addresses anywhere. 30 attempts a minute makes guessing a
// long password hopeless; the worst a stranger can do is make the page wait a minute.

import { PAGE_HTML, PAGE_JS } from './stats-page.js';

const MIN_PASSWORD = 12;
const DAY = 86400000;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function respond(body, status, type, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': type, ...SECURITY_HEADERS, ...extra } });
}

const text = (body, status) => respond(body, status, 'text/plain; charset=utf-8');

/** Compares without leaking where the strings differ: hash both, compare fixed-length digests. */
async function samePassword(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** null if allowed, otherwise the response to send. */
export async function checkAuth(request, env) {
  const expected = env.STATS_PASSWORD;
  if (!expected || expected.length < MIN_PASSWORD) {
    return text(`The stats page isn't set up yet. Set a password of ${MIN_PASSWORD}+ characters: npx wrangler@4 secret put STATS_PASSWORD`, 503);
  }
  const m = (request.headers.get('Authorization') || '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  const ask = () => respond('Password required', 401, 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="Watch2Gether stats", charset="UTF-8"' });
  if (!m) return ask();
  if (env.LOGIN_LIMITER) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: 'stats-login' });
    if (!success) return text('Too many attempts. Try again in a minute.', 429);
  }
  let given = '';
  try {
    const raw = atob(m[1]);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    given = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return ask();
  }
  return (await samePassword(given, expected)) ? null : ask();
}

const RANGES = [7, 30, 90, 365];

/** The numbers the page shows, for the last `days` days. */
export async function statsData(env, days, now = Date.now()) {
  const since = now - days * DAY;
  const q = (sql) => env.DB.prepare(sql).bind(since).all().then((r) => r.results || []);
  const [totals, byFormat, causes, perDay, cpuGpus, latest] = await Promise.all([
    q(`SELECT COUNT(*) AS videos, COUNT(DISTINCT install_id) AS installs,
              COALESCE(SUM(watch_sec), 0) AS watch_sec, COALESCE(SUM(stall_sec), 0) AS stall_sec
       FROM reports WHERE received_at > ?`),
    q(`SELECT COALESCE(codec, 'unknown') AS codec, CASE WHEN hwdec = 'no' THEN 1 ELSE 0 END AS cpu,
              COUNT(*) AS videos, COALESCE(SUM(watch_sec), 0) AS watch_sec, COALESCE(SUM(stall_sec), 0) AS stall_sec,
              COALESCE(SUM(stalls_decode), 0) AS decode_stalls, COALESCE(SUM(stalls_network), 0) AS network_stalls
       FROM reports WHERE received_at > ? GROUP BY 1, 2 ORDER BY videos DESC LIMIT 12`),
    q(`SELECT COALESCE(SUM(stalls_network), 0) AS network, COALESCE(SUM(stalls_decode), 0) AS decode,
              COALESCE(SUM(stalls_seek), 0) AS seek, COALESCE(SUM(stalls_load), 0) AS load,
              COALESCE(SUM(stalls_align), 0) AS align, COALESCE(SUM(stalls_other), 0) AS other
       FROM reports WHERE received_at > ?`),
    q(`SELECT date(received_at / 1000, 'unixepoch') AS day, COUNT(*) AS videos
       FROM reports WHERE received_at > ? GROUP BY 1 ORDER BY 1`),
    q(`SELECT COALESCE(gpu, 'unknown') AS gpu, COALESCE(codec, 'unknown') AS codec, height,
              COUNT(*) AS videos, COALESCE(SUM(watch_sec), 0) AS watch_sec, COALESCE(SUM(stall_sec), 0) AS stall_sec
       FROM reports WHERE received_at > ? AND hwdec = 'no' GROUP BY 1, 2, 3 ORDER BY videos DESC LIMIT 25`),
    q(`SELECT received_at, app_version, role, source, codec, width, height, hdr, hwdec, gpu,
              watch_sec, stall_sec, stalls_decode, stalls_network, drift_seeks
       FROM reports WHERE received_at > ? ORDER BY received_at DESC LIMIT 50`),
  ]);
  return { days, generatedAt: now, totals: totals[0], byFormat, causes: causes[0], perDay, cpuGpus, latest };
}

/** Handles /stats*, or returns null for other paths. */
export async function handleStats(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/stats')) return null;
  if (request.method !== 'GET') return text('Method not allowed', 405);
  const denied = await checkAuth(request, env);
  if (denied) return denied;

  if (url.pathname === '/stats' || url.pathname === '/stats/') {
    return respond(PAGE_HTML, 200, 'text/html; charset=utf-8', {
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
  }
  if (url.pathname === '/stats/app.js') return respond(PAGE_JS, 200, 'text/javascript; charset=utf-8');
  if (url.pathname === '/stats/api') {
    const d = Number(url.searchParams.get('days'));
    const days = RANGES.includes(d) ? d : 30;
    return respond(JSON.stringify(await statsData(env, days)), 200, 'application/json');
  }
  return text('Not found', 404);
}
