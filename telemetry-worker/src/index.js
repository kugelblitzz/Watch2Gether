// Watch2Gether anonymous playback stats.
//
//   POST   /v1/report           { installId, reports: [...] }  -> stores sanitized rows
//   DELETE /v1/install/<id>      deletes everything stored for that install ("Delete my data")
//   GET    /v1/health
//
// No IP addresses are stored or logged: the request's address and headers are never read,
// and Workers logs are off (wrangler.toml). Reports older than RETENTION_DAYS are deleted daily.

import { validateBatch, isInstallId, COLUMNS, MAX_BODY_BYTES } from './validate.js';

const RETENTION_DAYS = 365;
const MAX_REPORTS_PER_DAY = 300; // per install; a real viewer sends a handful

const COLS = Object.keys(COLUMNS);
const INSERT = `INSERT INTO reports (install_id, received_at, ${COLS.join(', ')}) VALUES (?, ?, ${COLS.map(() => '?').join(', ')})`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handle(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/v1/health') return json({ ok: true });

  if (request.method === 'POST' && url.pathname === '/v1/report') {
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json({ error: 'Too large' }, 413);
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'Too large' }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const v = validateBatch(body);
    if (!v.ok) return json({ error: v.error }, 400);

    const now = Date.now();
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE install_id = ? AND received_at > ?')
      .bind(v.installId, now - 86400000)
      .first();
    if ((recent ? recent.n : 0) + v.rows.length > MAX_REPORTS_PER_DAY) return json({ error: 'Too many reports today' }, 429);

    await env.DB.batch(v.rows.map((row) => env.DB.prepare(INSERT).bind(v.installId, now, ...COLS.map((c) => row[c]))));
    return json({ ok: true, stored: v.rows.length });
  }

  const del = url.pathname.match(/^\/v1\/install\/([^/]+)$/);
  if (request.method === 'DELETE' && del) {
    if (!isInstallId(del[1])) return json({ error: 'Not an install id' }, 400);
    const r = await env.DB.prepare('DELETE FROM reports WHERE install_id = ?').bind(del[1].toLowerCase()).run();
    return json({ ok: true, deleted: (r && r.meta && r.meta.changes) || 0 });
  }

  return json({ error: 'Not found' }, 404);
}

export async function purgeOld(env, now = Date.now()) {
  await env.DB.prepare('DELETE FROM reports WHERE received_at < ?').bind(now - RETENTION_DAYS * 86400000).run();
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch {
      return json({ error: 'Server error' }, 500);
    }
  },
  async scheduled(_event, env) {
    await purgeOld(env);
  },
};
