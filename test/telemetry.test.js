'use strict';

/**
 * Anonymous playback stats: the stats collector, the consent + upload queue, and the
 * Cloudflare Worker's validation and request handling (with an in-memory stand-in for D1).
 * Run: npm test
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlaybackStats, containerName, paramsInfo, isHeavyVideo } = require('../src/main/playstats');
const { Telemetry } = require('../src/main/telemetry');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + (e.stack || e));
    process.exitCode = 1;
  }
}

/** Feed PlaybackStats samples 2 s apart (one clock per stats object, across calls). */
function run(st, samples) {
  let t = st._testClock || 1e6;
  for (const s of samples) {
    st.sample(s, t);
    t += 2000;
  }
  st._testClock = t;
}

const sampleReport = () => {
  const st = new PlaybackStats({ media: { size: 4e9, name: 'Secret Movie (2024).mkv' }, source: 'stream', role: 'guest' });
  st.setVideoInfo({ format: 'av1', params: { w: 3840, h: 2160, pixelformat: 'yuv420p10' }, fps: 24, fileFormat: 'matroska,webm', duration: 7200 });
  st.setHwdec('no');
  st.minWatchSec = 0;
  run(st, [{ playing: true, voDrops: 0 }, { playing: true, voDrops: 0 }]);
  return st.report(2e6);
};

(async () => {
  console.log('playback stats');

  await test('video details from mpv', () => {
    assert.strictEqual(containerName('matroska,webm'), 'mkv');
    assert.strictEqual(containerName('mov,mp4,m4a,3gp,3g2,mj2'), 'mp4');
    assert.deepStrictEqual(paramsInfo({ w: 3840, h: 2160, pixelformat: 'yuv420p10', gamma: 'pq' }), { width: 3840, height: 2160, bitDepth: 10, hdr: 'pq' });
    assert.strictEqual(paramsInfo({ w: 1920, h: 1080, pixelformat: 'yuv420p', 'hw-pixelformat': 'nv12' }).bitDepth, 8);
    assert.strictEqual(paramsInfo({ w: 1, h: 1, 'hw-pixelformat': 'p010' }).bitDepth, 10);
    assert(isHeavyVideo({ codec: 'av1', height: 2160 }));
    assert(!isHeavyVideo({ codec: 'h264', height: 2160 }));
    assert(!isHeavyVideo({ codec: 'hevc', height: 1080 }));
  });

  await test('dropping frames for a few seconds = decoder too slow; recovering clears it', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'host' });
    let drops = 0;
    const slow = () => ({ playing: true, voDrops: (drops += 20) }); // 10 / s
    const fine = () => ({ playing: true, voDrops: drops });
    run(st, [fine(), slow()]);
    assert(!st.decodeSlow, 'one bad sample is not enough');
    run(st, [slow()], 2e6);
    assert(st.decodeSlow, 'two in a row is');
    run(st, [fine(), fine()], 3e6);
    assert(st.decodeSlow, 'still slow until it has stayed fine for a while');
    run(st, [fine()], 4e6);
    assert(!st.decodeSlow);
  });

  await test('falling behind the room clock = too slow, even with few dropped frames; catching up is fine', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'stream', role: 'guest' });
    // real mpv, 4K60 AV1 on one CPU thread: ~0.5 s lost per second, even at 1.08x
    run(st, [{ playing: true, behindRate: 0.5, speed: 1.08 }, { playing: true, behindRate: 0.45, speed: 1.08 }]);
    assert(st.decodeSlow);
    const ok = new PlaybackStats({ media: { size: 1 }, source: 'stream', role: 'host' });
    run(ok, [{ playing: true, behindRate: -0.07, speed: 1.08 }, { playing: true, behindRate: 0.02 }, { playing: true, behindRate: 0 }]);
    assert(!ok.decodeSlow, 'catching up (negative) or holding steady is healthy');
  });

  await test('drops from the catch-up speed-up are not "too slow" (real mpv: a fast host got flagged)', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'host' });
    st.setVideoInfo({ fps: 60 });
    let drops = 0;
    // 1.08x on 60 fps: ~5 drops/s are expected, here 5/s for a while
    run(st, Array.from({ length: 6 }, () => ({ playing: true, speed: 1.08, voDrops: (drops += 10) })));
    assert(!st.decodeSlow);
    // the same drops at normal speed are a struggling decoder
    run(st, Array.from({ length: 3 }, () => ({ playing: true, speed: 1, voDrops: (drops += 10) })), 2e6);
    assert(st.decodeSlow);
    // and a real struggle (12/s) is caught even while sped up
    const st2 = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'guest' });
    st2.setVideoInfo({ fps: 60 });
    drops = 0;
    run(st2, Array.from({ length: 3 }, () => ({ playing: true, speed: 1.08, voDrops: (drops += 24) })));
    assert(st2.decodeSlow);
  });

  await test('samples right after a seek / resume are not judged (but still count as watched)', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'host' });
    let drops = 0;
    run(st, Array.from({ length: 5 }, () => ({ playing: true, settled: false, voDrops: (drops += 30) })));
    assert(!st.decodeSlow);
    assert.strictEqual(st.watchSec, 8);
    assert.strictEqual(st.drops.vo, 120, 'drops are still counted for the report');
  });

  await test('audio running ahead of the video also counts as too slow', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'host' });
    run(st, [{ playing: true, avsync: 0.6 }, { playing: true, avsync: 0.9 }, { playing: true, avsync: 1.2 }]);
    assert(st.decodeSlow);
  });

  await test('paused time is not watch time and is not judged', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'host' });
    let drops = 0;
    run(st, Array.from({ length: 10 }, () => ({ playing: false, voDrops: (drops += 100) })));
    assert.strictEqual(st.watchSec, 0);
    assert(!st.decodeSlow);
    assert.strictEqual(st.drops.vo, 0);
  });

  await test('a restarted player (counters back at 0) is not a negative drop count', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'host' });
    run(st, [{ playing: true, voDrops: 500 }, { playing: true, voDrops: 510 }, { playing: true, voDrops: 3 }]);
    assert.strictEqual(st.drops.vo, 10);
  });

  await test('stalls are counted by cause; the first load takes no stall time', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'stream', role: 'guest' });
    st.stallStart('load', 0); st.stallEnd(5000);
    st.stallStart('network', 10000); st.stallEnd(13000);
    st.stallStart('network', 20000);
    st.stallStart('seek', 20500); // already stalling: same stall
    st.stallEnd(21000);
    st.stallStart('bogus', 30000); st.stallEnd(30500);
    assert.deepStrictEqual(st.stalls, { network: 2, seek: 0, load: 1, decode: 0, align: 0, other: 1 });
    assert.strictEqual(st.stallSec, 4.5);
  });

  await test('drift seeks while the decoder is slow are counted separately', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'local', role: 'host' });
    st.driftSeek();
    assert(!st.decodeSlow, 'one jump on its own proves nothing');
    st.decodeSlow = true;
    st.driftSeek();
    assert.strictEqual(st.driftSeeks, 2);
    assert.strictEqual(st.driftSeeksSlow, 1);
  });

  await test('a "falling behind" reading followed by a forced jump settles it at once', () => {
    const st = new PlaybackStats({ media: { size: 1 }, source: 'stream', role: 'guest' });
    run(st, [{ playing: true, behindRate: 0.5, speed: 1.08 }]);
    assert(!st.decodeSlow);
    st.driftSeek();
    assert(st.decodeSlow);
    assert.strictEqual(st.driftSeeksSlow, 1, 'and that jump counts as a slow one');
  });

  await test('report: nothing under 30 s watched; no file name; bitrate from size and duration', () => {
    const st = new PlaybackStats({ media: { size: 4e9, name: 'x.mkv' }, source: 'stream', role: 'guest' });
    run(st, Array.from({ length: 10 }, () => ({ playing: true })));
    assert.strictEqual(st.report(), null, '18 s is too little');
    const r = sampleReport();
    assert.strictEqual(r.video.bitrateMbps, 4.4);
    assert.strictEqual(r.video.durationMin, 120);
    assert(!JSON.stringify(r).includes('Secret'), 'file name never in a report');
  });

  console.log('upload queue');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2g-stats-'));
  let store = {};
  const calls = [];
  let reply = () => ({ ok: true, status: 200 });
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    const r = reply(url, opts);
    if (r instanceof Error) throw r;
    return r;
  };
  const make = () => new Telemetry({
    dir,
    getSettings: () => store,
    saveSettings: (p) => { store = { ...store, ...p }; },
    machine: () => ({ gpu: 'Test GPU', cpu: 'Test CPU', cores: 8, ramGb: 16 }),
    appVersion: '9.9.9',
    endpoint: 'https://stats.example/',
    fetchImpl: fakeFetch,
  });

  await test('nothing is kept or sent before the user agrees', async () => {
    const t = make();
    assert.strictEqual(t.consent, null);
    t.record(sampleReport());
    assert.strictEqual(t.status().queued, 0);
    assert.strictEqual(await t.flush(), 0);
    assert.strictEqual(calls.length, 0);
  });

  await test('after "yes": reports queue up and upload in one batch with the install id', async () => {
    const t = make();
    t.setConsent(true);
    clearTimeout(t.flushTimer);
    assert.match(t.installId, /^[0-9a-f-]{36}$/);
    t.record(sampleReport());
    t.record(sampleReport());
    clearTimeout(t.flushTimer);
    assert.strictEqual(t.status().queued, 2);
    assert.strictEqual(await t.flush(), 2);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://stats.example/v1/report');
    assert.strictEqual(calls[0].body.installId, t.installId);
    assert.strictEqual(calls[0].body.reports[0].app, '9.9.9');
    assert.strictEqual(calls[0].body.reports[0].machine.gpu, 'Test GPU');
    assert.strictEqual(t.status().queued, 0);
  });

  await test('an empty check (the one 30 s after start) does not block later uploads', async () => {
    // v0.10.0 bug: the empty start-up flush left a settled promise behind and nothing was sent after it
    const t = make();
    reply = () => ({ ok: true, status: 200 });
    assert.strictEqual(await t.flush(), 0, 'nothing queued yet');
    assert.strictEqual(await t.flush(), 0);
    t.record(sampleReport());
    clearTimeout(t.flushTimer);
    assert.strictEqual(await t.flush(), 1, 'the report is sent');
    assert.strictEqual(t.status().queued, 0);
  });

  await test('offline: reports stay queued for later; the queue is capped', async () => {
    const t = make();
    reply = () => new Error('offline');
    for (let i = 0; i < 105; i++) t.record(sampleReport());
    clearTimeout(t.flushTimer);
    assert.strictEqual(await t.flush(), 0);
    clearTimeout(t.flushTimer);
    assert.strictEqual(t.status().queued, 100);
    reply = () => ({ ok: true, status: 200 });
    const before = calls.length;
    assert.strictEqual(await t.flush(), 100);
    assert.strictEqual(calls.slice(before).filter((c) => c.method === 'POST').length, 5, 'batches of 20');
  });

  await test('reports the server rejects (400) are dropped, not retried forever', async () => {
    const t = make();
    reply = () => ({ ok: false, status: 400 });
    t.record(sampleReport());
    clearTimeout(t.flushTimer);
    await t.flush();
    clearTimeout(t.flushTimer);
    assert.strictEqual(t.status().queued, 0);
    reply = () => ({ ok: true, status: 200 });
  });

  await test('"See what\'s sent" shows an example before the first video, then the real report', () => {
    const t = make();
    const ex = t.preview();
    assert(ex.example && ex.report.video.codec === 'av1' && ex.report.machine.gpu === 'Test GPU');
    t.record(sampleReport());
    clearTimeout(t.flushTimer);
    const real = t.preview();
    assert(!real.example);
    assert.strictEqual(real.report.decode.hwdec, 'no');
  });

  await test('"Delete my data" asks the server, then starts over with a new id', async () => {
    const t = make();
    const old = t.installId;
    calls.length = 0;
    await t.deleteMyData();
    assert.deepStrictEqual(calls.map((c) => [c.method, c.url]), [['DELETE', `https://stats.example/v1/install/${old}`]]);
    assert.notStrictEqual(t.installId, old);
    assert.strictEqual(t.status().queued, 0);
    assert.strictEqual(t.consent, 'yes', 'consent is a separate choice');
    reply = () => ({ ok: false, status: 503 });
    await assert.rejects(() => t.deleteMyData(), /HTTP 503/);
    reply = () => ({ ok: true, status: 200 });
  });

  await test('"No" (or turning it off later) empties the queue', () => {
    const t = make();
    reply = () => new Error('offline');
    t.record(sampleReport());
    clearTimeout(t.flushTimer);
    t.setConsent(false);
    assert.strictEqual(t.status().queued, 0);
    t.record(sampleReport());
    assert.strictEqual(t.status().queued, 0);
    reply = () => ({ ok: true, status: 200 });
  });

  await test('machine info: GPU name plus its PCI ids, no name if Windows has none', async () => {
    const { machineInfo } = require('../src/main/telemetry');
    const gpu = async () => ({ gpuDevice: [{ active: false, vendorId: 0x8086, deviceId: 0x1 }, { active: true, vendorId: 0x10de, deviceId: 0x2d04, driverVersion: '32.0' }] });
    const m = await machineInfo(gpu, async (v, d) => (v === 0x10de && d === 0x2d04 ? 'NVIDIA GeForce RTX 5060 Ti' : null));
    assert.strictEqual(m.gpu, 'NVIDIA GeForce RTX 5060 Ti (10de:2d04)', 'the active GPU, not the first');
    assert.strictEqual(m.gpuDriver, '32.0');
    assert(m.cores > 0 && m.ramGb >= 0 && typeof m.cpu === 'string');
    assert.strictEqual((await machineInfo(gpu, async () => null)).gpu, '10de:2d04');
    assert.strictEqual((await machineInfo(async () => { throw new Error('no gpu info'); })).gpu, null);
  });

  console.log('worker');
  const worker = await import('../telemetry-worker/src/index.js');
  const { validateBatch, COLUMNS } = await import('../telemetry-worker/src/validate.js');

  /** Just enough of D1 for the worker's statements. */
  function fakeD1() {
    const rows = [];
    const db = {
      rows,
      prepare(sql) {
        return {
          bind(...args) {
            return {
              sql, args,
              async first() { // SELECT COUNT(*) ... WHERE install_id = ? AND received_at > ?
                return { n: rows.filter((r) => r.install_id === args[0] && r.received_at > args[1]).length };
              },
              async run() {
                if (/^DELETE FROM reports WHERE install_id/.test(sql)) {
                  const before = rows.length;
                  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].install_id === args[0]) rows.splice(i, 1);
                  return { meta: { changes: before - rows.length } };
                }
                if (/^DELETE FROM reports WHERE received_at/.test(sql)) {
                  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].received_at < args[0]) rows.splice(i, 1);
                  return { meta: {} };
                }
                if (/^INSERT/.test(sql)) {
                  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(', ');
                  rows.push(Object.fromEntries(cols.map((c, i) => [c, args[i]])));
                  return { meta: {} };
                }
                throw new Error('unexpected SQL ' + sql);
              },
            };
          },
        };
      },
      async batch(stmts) { for (const s of stmts) await s.run(); },
    };
    return db;
  }
  const req = (method, p, body) => new Request('https://telemetry.example' + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const id = '0b9c3f0e-8f6a-4d2b-9c1e-2a7d5e6f8a90';

  await test('validation keeps only known fields, cut to size', () => {
    const rep = { ...sampleReport(), fileName: 'Secret.mkv', video: { ...sampleReport().video, codec: 'x'.repeat(500), height: 1e9 } };
    const v = validateBatch({ installId: id, reports: [rep] });
    assert(v.ok);
    const row = v.rows[0];
    assert.deepStrictEqual(Object.keys(row).sort(), Object.keys(COLUMNS).sort());
    assert.strictEqual(row.codec.length, 24);
    assert.strictEqual(row.height, 16384);
    assert(!JSON.stringify(row).includes('Secret'));
    assert(!validateBatch({ installId: 'not-a-uuid', reports: [rep] }).ok);
    assert(!validateBatch({ installId: id, reports: Array(21).fill(rep) }).ok);
    assert(!validateBatch({ installId: id, reports: [{ hello: 1 }] }).ok);
  });

  await test('worker stores a batch, rate-limits, deletes on request, purges old rows', async () => {
    const env = { DB: fakeD1() };
    const ok = await worker.handle(req('POST', '/v1/report', { installId: id, reports: [sampleReport(), sampleReport()] }), env);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(env.DB.rows.length, 2);
    assert.strictEqual(env.DB.rows[0].codec, 'av1');
    assert.strictEqual(env.DB.rows[0].hwdec, 'no');
    assert.strictEqual(env.DB.rows[0].install_id, id);

    assert.strictEqual((await worker.handle(req('POST', '/v1/report', '{oops'), env)).status, 400);
    assert.strictEqual((await worker.handle(req('POST', '/v1/report', 'x'.repeat(70000)), env)).status, 413);
    assert.strictEqual((await worker.handle(req('GET', '/v1/report'), env)).status, 404);
    assert.strictEqual((await worker.handle(req('GET', '/v1/health'), env)).status, 200);

    for (let i = 0; i < 14; i++) await worker.handle(req('POST', '/v1/report', { installId: id, reports: Array(20).fill(sampleReport()) }), env);
    const limited = await worker.handle(req('POST', '/v1/report', { installId: id, reports: Array(20).fill(sampleReport()) }), env);
    assert.strictEqual(limited.status, 429, 'more than 300 a day from one install');

    const other = '1c9c3f0e-8f6a-4d2b-9c1e-2a7d5e6f8a91';
    await worker.handle(req('POST', '/v1/report', { installId: other, reports: [sampleReport()] }), env);
    const del = await worker.handle(req('DELETE', `/v1/install/${id}`), env);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).deleted, 282);
    assert.deepStrictEqual(env.DB.rows.map((r) => r.install_id), [other], 'only that install is deleted');
    assert.strictEqual((await worker.handle(req('DELETE', '/v1/install/../../x'), env)).status, 404);

    await worker.purgeOld(env, Date.now() + 366 * 86400000);
    assert.strictEqual(env.DB.rows.length, 0, 'older than a year is gone');
  });

  console.log('stats page');

  /** D1 on top of Node's built-in SQLite, with the real migration: the page's real SQL runs. */
  function sqliteD1() {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
    const db = new DatabaseSync(':memory:');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'telemetry-worker', 'migrations', '0001_reports.sql'), 'utf8'));
    const stmt = (sql, args = []) => ({
      bind: (...a) => stmt(sql, a),
      async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
      async first() { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
      async run() { return { meta: { changes: db.prepare(sql).run(...args).changes } }; },
    });
    return { prepare: (sql) => stmt(sql), async batch(list) { return Promise.all(list.map((s) => s.run())); } };
  }
  const stats = await import('../telemetry-worker/src/stats.js');
  const { PAGE_JS } = await import('../telemetry-worker/src/stats-page.js');
  const PASSWORD = 'correct horse battery';
  const basic = (pw) => ({ Authorization: 'Basic ' + Buffer.from('anyone:' + pw).toString('base64') });
  const get = (p, headers = {}) => new Request('https://telemetry.example' + p, { headers });

  await test('the page script is valid JavaScript (it lives inside a template string)', () => {
    new Function(PAGE_JS); // eslint-disable-line no-new-func
    assert(!PAGE_JS.includes('${'), 'no interpolation slipped in');
  });

  await test('stats page: no password set -> not set up; asks for the password; wrong one refused', async () => {
    const db = sqliteD1() || fakeD1();
    let r = await worker.handle(get('/stats'), { DB: db });
    assert.strictEqual(r.status, 503);
    r = await worker.handle(get('/stats'), { DB: db, STATS_PASSWORD: 'short' });
    assert.strictEqual(r.status, 503, 'a short password is refused, not used');
    const env = { DB: db, STATS_PASSWORD: PASSWORD };
    r = await worker.handle(get('/stats'), env);
    assert.strictEqual(r.status, 401);
    assert.match(r.headers.get('WWW-Authenticate'), /^Basic realm="Watch2Gether stats"/);
    assert.strictEqual((await worker.handle(get('/stats', basic('nope')), env)).status, 401);
    assert.strictEqual((await worker.handle(get('/stats/api', basic('nope')), env)).status, 401, 'the data too');
    assert.strictEqual((await worker.handle(get('/stats', { Authorization: 'Basic !!!' }), env)).status, 401);
  });

  await test('stats page: right password -> page, script and data; strict security headers', async () => {
    const env = { DB: sqliteD1() || fakeD1(), STATS_PASSWORD: PASSWORD };
    const page = await worker.handle(get('/stats', basic(PASSWORD)), env);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('Content-Type'), /text\/html/);
    assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'; script-src 'self'/);
    assert.strictEqual(page.headers.get('Cache-Control'), 'no-store');
    assert.match(await page.text(), /<script src="\/stats\/app.js"/);
    const js = await worker.handle(get('/stats/app.js', basic(PASSWORD)), env);
    assert.match(js.headers.get('Content-Type'), /javascript/);
    const nope = await worker.handle(new Request('https://telemetry.example/stats', { method: 'POST', headers: basic(PASSWORD) }), env);
    assert.strictEqual(nope.status, 405);
  });

  await test('stats page: login attempts are capped (limiter says no -> 429, even with the right password)', async () => {
    const env = { DB: fakeD1(), STATS_PASSWORD: PASSWORD, LOGIN_LIMITER: { limit: async ({ key }) => ({ success: key !== 'stats-login' }) } };
    assert.strictEqual((await worker.handle(get('/stats', basic(PASSWORD)), env)).status, 429);
    assert.strictEqual((await worker.handle(get('/stats'), env)).status, 401, 'no attempt made, nothing counted');
  });

  const sdb = sqliteD1();
  if (!sdb) {
    console.log('  skip stats numbers (this Node has no node:sqlite)');
  } else {
    await test('stats numbers from real SQL: totals, formats split by CPU/GPU, causes, days, CPU GPUs, latest', async () => {
      const env = { DB: sdb, STATS_PASSWORD: PASSWORD };
      const rep = (o) => ({ v: 1, app: '0.10.0', role: 'guest', source: 'stream', video: { codec: 'av1', height: 2160 }, decode: { hwdec: 'no' }, machine: { gpu: 'GTX 1060 (10de:1c03)' }, sync: { watchSec: 600, stallSec: 60, stalls: { decode: 4, network: 0, seek: 1, load: 1 } }, ...o });
      const a = '0b9c3f0e-8f6a-4d2b-9c1e-2a7d5e6f8a90';
      const b = '1c9c3f0e-8f6a-4d2b-9c1e-2a7d5e6f8a91';
      await worker.handle(req('POST', '/v1/report', { installId: a, reports: [rep(), rep()] }), env);
      await worker.handle(req('POST', '/v1/report', { installId: b, reports: [rep({ video: { codec: 'av1', height: 2160 }, decode: { hwdec: 'd3d11va' }, machine: { gpu: 'RTX 4070' }, sync: { watchSec: 1200, stallSec: 6, stalls: { network: 2 } } })] }), env);
      // an old report, outside a 30-day range
      await sdb.prepare('UPDATE reports SET received_at = ? WHERE id = 1').bind(Date.now() - 40 * 86400000).run();

      const res = await worker.handle(get('/stats/api?days=30', basic(PASSWORD)), env);
      assert.strictEqual(res.status, 200);
      const d = await res.json();
      assert.strictEqual(d.days, 30);
      assert.deepStrictEqual(d.totals, { videos: 2, installs: 2, watch_sec: 1800, stall_sec: 66 });
      const cpu = d.byFormat.find((f) => f.codec === 'av1' && f.cpu === 1);
      const gpu = d.byFormat.find((f) => f.codec === 'av1' && f.cpu === 0);
      assert.deepStrictEqual([cpu.videos, cpu.stall_sec, cpu.decode_stalls], [1, 60, 4]);
      assert.deepStrictEqual([gpu.videos, gpu.stall_sec, gpu.network_stalls], [1, 6, 2]);
      assert.deepStrictEqual(d.causes, { network: 2, decode: 4, seek: 1, load: 1, align: 0, other: 0 });
      assert.strictEqual(d.perDay.reduce((s, x) => s + x.videos, 0), 2);
      assert.deepStrictEqual(d.cpuGpus.map((g) => [g.gpu, g.codec, g.height, g.videos]), [['GTX 1060 (10de:1c03)', 'av1', 2160, 1]]);
      assert.strictEqual(d.latest.length, 2);
      assert(d.latest[0].received_at >= d.latest[1].received_at, 'newest first');

      const year = await (await worker.handle(get('/stats/api?days=365', basic(PASSWORD)), env)).json();
      assert.strictEqual(year.totals.videos, 3, 'the old one is inside a year');
      const odd = await (await worker.handle(get('/stats/api?days=9999', basic(PASSWORD)), env)).json();
      assert.strictEqual(odd.days, 30, 'unknown ranges fall back to 30 days');
    });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
