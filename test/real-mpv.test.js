'use strict';

/**
 * Integration test with REAL mpv: host plays a local file, guest streams it over HTTP.
 * Opens two player windows for ~30 s.
 *   node test/real-mpv.test.js <video file>
 */

const assert = require('assert');
const { HostServer } = require('../src/main/server');
const { Session } = require('../src/main/session');
const { findMpv } = require('../src/main/env');

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/real-mpv.test.js <video file>');
  process.exit(2);
}
const mpvPath = findMpv([]);
if (!mpvPath) {
  console.error('mpv not found');
  process.exit(2);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(50);
  }
  throw new Error('Timed out: ' + label);
}

async function positions(a, b) {
  const [pa, pb] = await Promise.all([a.mpv.get('time-pos'), b.mpv.get('time-pos')]);
  return { pa, pb, diff: pa - pb };
}

(async () => {
  const port = 18788;
  const server = new HostServer({ port });
  await server.start();
  server.setMedia(file);
  const base = `http://127.0.0.1:${port}`;

  const host = new Session({ baseUrl: base, code: server.code, name: 'Host', hostToken: server.hostToken, mpvPath, resolveLocal: () => file });
  const guest = new Session({ baseUrl: base, code: server.code, name: 'Guest', mpvPath });
  await host.start();
  await guest.start();
  let failed = false;
  const step = async (name, fn) => {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failed = true;
      console.error('  FAIL ' + name + ': ' + e.message);
    }
  };

  try {
    await step('both players load (host local, guest via HTTP)', async () => {
      await until(() => !host.loading && !guest.loading && host.loadedMediaId && guest.loadedMediaId, 15000, 'load');
      assert.strictEqual(guest.source, 'stream');
      await until(() => server.media.duration > 0, 5000, 'duration');
      await until(() => !server._blockers().length, 10000, 'everyone ready');
    });

    await step('play from the app keeps players within 100 ms', async () => {
      guest.command('play');
      await wait(4000);
      const p = await positions(host, guest);
      console.log(`       host ${p.pa.toFixed(3)}  guest ${p.pb.toFixed(3)}  diff ${(p.diff * 1000).toFixed(0)} ms`);
      assert(p.pa > 2.5, 'playback advanced');
      assert(Math.abs(p.diff) < 0.1);
    });

    await step('pressing pause inside the host player pauses the guest', async () => {
      await host.mpv.set('pause', true); // same as pressing Space in the mpv window
      await until(() => server.paused, 3000, 'room paused');
      await until(async () => (await guest.mpv.get('pause')) === true, 3000, 'guest paused');
      await wait(1500);
      const p = await positions(host, guest);
      console.log(`       paused at host ${p.pa.toFixed(3)}  guest ${p.pb.toFixed(3)}`);
      assert(Math.abs(p.diff) < 0.15);
    });

    await step('seeking inside the guest player moves the host', async () => {
      await guest.mpv.command('seek', '45', 'absolute');
      await until(() => Math.abs(server.position - 45) < 1, 5000, 'room seek');
      await wait(2000);
      const p = await positions(host, guest);
      console.log(`       host ${p.pa.toFixed(3)}  guest ${p.pb.toFixed(3)}`);
      assert(Math.abs(p.pa - 45) < 0.5 && Math.abs(p.diff) < 0.15);
    });

    await step('resume after seek stays in sync', async () => {
      host.command('play');
      await wait(4000);
      const p = await positions(host, guest);
      console.log(`       host ${p.pa.toFixed(3)}  guest ${p.pb.toFixed(3)}  diff ${(p.diff * 1000).toFixed(0)} ms`);
      assert(p.pa > 47 && Math.abs(p.diff) < 0.1);
    });

    await step('activity log recorded the actions', async () => {
      const text = guest.log.map((l) => l.text).join('\n');
      assert(/Host paused at/.test(text) && /Guest jumped to 0:45/.test(text), text);
    });
  } finally {
    host.stop();
    guest.stop();
    server.stop();
    console.log(failed ? '\nSOME FAILED' : '\nall passed');
    setTimeout(() => process.exit(failed ? 1 : 0), 2500);
  }
})();
