'use strict';

/**
 * End-to-end test of the sync logic: real HostServer + two real Sessions talking over
 * WebSockets, with mpv replaced by a simulated player. Run: npm test
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

// ---------- fake mpv ----------
class FakeMpv extends EventEmitter {
  constructor() {
    super();
    this.props = { pause: true, speed: 1, duration: null, seeking: false, 'paused-for-cache': false, 'demuxer-cache-duration': 0, 'demuxer-cache-idle': true };
    this.pos = 0;
    this.lastTick = Date.now();
    this.observed = new Set();
    this.loaded = null;
    FakeMpv.instances.push(this);
  }
  _advance() {
    const now = Date.now();
    if (this.loaded && !this.props.pause && !this.props['paused-for-cache']) this.pos += ((now - this.lastTick) / 1000) * this.props.speed;
    this.lastTick = now;
  }
  _setProp(name, value) {
    this._advance();
    this.props[name] = value;
    if (this.observed.has(name)) setImmediate(() => this.emit('property', name, value));
  }
  async start(opts) { this.startOpts = opts; }
  async command(cmd, ...args) {
    this._advance();
    switch (cmd) {
      case 'get_property':
        if (args[0] === 'time-pos') return this.loaded ? this.pos : Promise.reject(new Error('property unavailable'));
        return this.props[args[0]];
      case 'set_property': this._setProp(args[0], args[1]); return null;
      case 'observe_property': this.observed.add(args[1]); setImmediate(() => this.emit('property', args[1], this.props[args[1]])); return null;
      case 'loadfile':
        this.loaded = args[0];
        this.pos = 0;
        setTimeout(() => { this._setProp('duration', 600); this.emit('event', { event: 'file-loaded' }); }, 50);
        return null;
      case 'seek': this._seekTo(Number(args[0])); return null;
      case 'af-command': (this.afCommands = this.afCommands || []).push(args); return null;
      case 'keybind': (this.keybinds = this.keybinds || {})[args[0]] = args[1]; return null;
      default: return null;
    }
  }
  _seekTo(t) {
    this.pos = t;
    this.emit('event', { event: 'seek' });
    this._setProp('seeking', true);
    setTimeout(() => { this._setProp('seeking', false); this.emit('event', { event: 'playback-restart' }); }, 30);
  }
  // simulate the user acting inside the mpv window
  userPause(v) { this._setProp('pause', v); }
  userSeek(t) { this._seekTo(t); }
  get(p) { return this.command('get_property', p); }
  set(p, v) { return this.command('set_property', p, v); }
  observe(p) { return this.command('observe_property', 0, p); }
  quit() { this.quitCalled = true; }
}
FakeMpv.instances = [];
require.cache[require.resolve('../src/main/mpv')] = { exports: { Mpv: FakeMpv } };

const { HostServer } = require('../src/main/server');
const { Session } = require('../src/main/session');
const { parseInvite, isAllowedAddress, cursorXInWindow } = require('../src/main/util');
const WebSocket = require('ws');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error('Timed out waiting for ' + label);
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

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

(async () => {
  console.log('util');
  await test('parseInvite', () => {
    assert.deepStrictEqual(parseInvite('100.101.1.2:9000/abc123'), { host: '100.101.1.2', port: 9000, code: 'ABC123', baseUrl: 'http://100.101.1.2:9000' });
    assert.strictEqual(parseInvite('w2g://pc.tail.ts.net/XYZ').port, 8787);
    assert.throws(() => parseInvite('nonsense'));
  });
  await test('fullscreen sidebar: only the left edge INSIDE the window counts (monitor to the left = away)', () => {
    const right = { x: 1920, y: 0, width: 1920, height: 1080 }; // fullscreen on the right monitor
    assert.strictEqual(cursorXInWindow({ x: 1922, y: 500 }, right), 2, 'at the left edge');
    assert.strictEqual(cursorXInWindow({ x: 1000, y: 500 }, right), null, 'on the main monitor to the left');
    assert.strictEqual(cursorXInWindow({ x: 1919, y: 500 }, right), null, 'one pixel over the border');
    assert.strictEqual(cursorXInWindow({ x: 2500, y: 1200 }, right), null, 'below the window');
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }; // monitor placed left of the primary
    assert.strictEqual(cursorXInWindow({ x: -1915, y: 10 }, left), 5);
  });
  await test('changelog: the section for a version (What is new + release notes)', () => {
    const { sectionFor } = require('../src/main/changelog');
    const md = ['# Changelog', '', '## 1.2.0', '', '- **New** thing', '- fix', '', '## 1.1.0', '', '- old'].join('\n');
    assert.strictEqual(sectionFor('1.2.0', md), '- **New** thing\n- fix');
    assert.strictEqual(sectionFor('1.1.0', md), '- old');
    assert.strictEqual(sectionFor('9.9.9', md), null);
    const pkg = require('../package.json');
    assert(sectionFor(pkg.version), `CHANGELOG.md has a section for the current version ${pkg.version}`);
  });
  await test('address filter', () => {
    assert(isAllowedAddress('::ffff:100.64.0.1', false));
    assert(isAllowedAddress('100.127.255.1', false));
    assert(!isAllowedAddress('100.128.0.1', false));
    assert(!isAllowedAddress('192.168.1.5', false));
    assert(isAllowedAddress('192.168.1.5', true));
    assert(isAllowedAddress('fd7a:115c:a1e0::1', false));
    assert(!isAllowedAddress('8.8.8.8', true));
  });

  // a fake 3 MB "video"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2g-test-'));
  const file = path.join(dir, 'movie.mkv');
  const data = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(file, data);

  const port = 18787;
  const server = new HostServer({ port });
  await server.start();
  server.setMedia(file);
  const base = `http://127.0.0.1:${port}`;

  console.log('http');
  await test('rejects wrong room code', async () => {
    const r = await get(`${base}/media/${server.media.id}?k=WRONG1`);
    assert.strictEqual(r.status, 403);
  });
  await test('serves full file', async () => {
    const r = await get(`${base}/media/${server.media.id}?k=${server.code}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, data.length);
    assert.strictEqual(r.headers['accept-ranges'], 'bytes');
  });
  await test('serves byte ranges', async () => {
    const r = await get(`${base}/media/${server.media.id}?k=${server.code}`, { Range: 'bytes=1000-1999' });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers['content-range'], `bytes 1000-1999/${data.length}`);
    assert(r.body.equals(data.subarray(1000, 2000)));
    const tail = await get(`${base}/media/${server.media.id}?k=${server.code}`, { Range: 'bytes=-10' });
    assert(tail.body.equals(data.subarray(data.length - 10)));
    const bad = await get(`${base}/media/${server.media.id}?k=${server.code}`, { Range: `bytes=${data.length}-` });
    assert.strictEqual(bad.status, 416);
  });

  console.log('sync');
  const host = new Session({ baseUrl: base, code: server.code, name: 'Host', hostToken: server.hostToken, mpvPath: 'fake', resolveLocal: () => file });
  await host.start();
  const guest = new Session({ baseUrl: base, code: server.code.toLowerCase(), name: 'Guest', mpvPath: 'fake' });
  await guest.start();
  const [hm, gm] = FakeMpv.instances;

  await test('guest streams over HTTP, host plays local file', async () => {
    await until(() => hm.loaded && gm.loaded, 2000, 'both loaded');
    assert.strictEqual(hm.loaded, file);
    assert(gm.loaded.startsWith(`${base}/media/${server.media.id}?k=`));
    await until(() => server.media.duration === 600, 2000, 'duration reported');
  });

  await test('guest presses play -> both play', async () => {
    await until(() => !server._isWaiting() || server.paused, 2000);
    guest.command('play');
    await until(() => !hm.props.pause && !gm.props.pause, 2000, 'both playing');
  });

  await test('players stay within 100 ms', async () => {
    await wait(1200);
    hm._advance(); gm._advance();
    assert(Math.abs(hm.pos - gm.pos) < 0.1, `drift ${hm.pos - gm.pos}`);
    assert(hm.pos > 0.9, 'time advanced: ' + hm.pos);
  });

  await test('drifted player is pulled back by speed nudging', async () => {
    gm.pos -= 0.5; // guest falls 500 ms behind
    await until(() => gm.props.speed > 1, 1500, 'guest speeds up');
    await until(() => { gm._advance(); hm._advance(); return Math.abs(gm.pos - hm.pos) < 0.05; }, 10000, 'drift corrected');
    await until(() => gm.props.speed === 1, 3000, 'speed back to 1');
  });

  await test('large drift triggers a seek', async () => {
    gm.pos += 10;
    await until(() => { gm._advance(); hm._advance(); return Math.abs(gm.pos - hm.pos) < 0.2; }, 3000, 'resynced');
  });

  await test('user pauses in host mpv window -> guest pauses at same frame', async () => {
    hm.userPause(true);
    await until(() => server.paused && gm.props.pause, 2000, 'guest paused');
    await wait(400);
    hm._advance(); gm._advance();
    assert(Math.abs(hm.pos - gm.pos) < 0.31, `paused drift ${hm.pos - gm.pos}`);
  });

  await test('user seeks in guest mpv window -> host follows', async () => {
    gm.userSeek(123.4);
    await until(() => Math.abs(hm.pos - 123.4) < 0.3, 2000, 'host at 123.4');
    assert(server.paused, 'still paused after seek');
  });

  await test('buffering guest makes the room wait', async () => {
    host.command('play');
    await until(() => !hm.props.pause && !gm.props.pause, 2000, 'playing');
    gm._setProp('paused-for-cache', true);
    await until(() => server._isWaiting() && hm.props.pause, 2000, 'host waits');
    assert.deepStrictEqual(server._stateMsg().waitingFor, ['Guest']);
    gm._setProp('paused-for-cache', false);
    await until(() => !server._isWaiting() && !hm.props.pause && !gm.props.pause, 3000, 'resumed');
    await wait(500);
    hm._advance(); gm._advance();
    assert(Math.abs(hm.pos - gm.pos) < 0.15, `drift after resume ${hm.pos - gm.pos}`);
  });

  await test('reaching the end pauses the room once', async () => {
    const before = guest.log.length;
    host.command('seek', 598);
    await until(() => Math.abs(hm.pos - 598) < 0.3 && Math.abs(gm.pos - 598) < 0.3, 2000, 'at 598');
    host.command('play');
    await until(() => server.paused && server.position === 600, 5000, 'room paused at end');
    await wait(600);
    const lines = guest.log.slice(before).map((l) => l.text);
    assert(lines.some((t) => /Reached the end/.test(t)), lines.join(' | '));
    assert(!lines.some((t) => /paused at/.test(t)), 'no per-player pause spam: ' + lines.join(' | '));
  });

  await test('play at the end starts over from 0', async () => {
    guest.command('play');
    await until(() => !server.paused && server._currentPosition() < 5, 2000, 'restarted');
    await until(() => { hm._advance(); gm._advance(); return hm.pos < 5 && gm.pos < 5 && !hm.props.pause; }, 3000, 'players restarted');
    host.command('pause');
    await until(() => server.paused, 2000, 'paused');
  });

  await test('a second pause at the same spot is a no-op', async () => {
    const before = guest.log.length;
    guest.command('pause', server.position + 0.1);
    await wait(300);
    assert.strictEqual(guest.log.length, before, 'no extra log line');
  });

  await test('invalid port gives a friendly error', async () => {
    const bad = new HostServer({ port: 70000 });
    await assert.rejects(bad.start(), /not valid/);
    assert(!bad.tick, 'no timer left running');
  });

  await test('sockets that never say hello are dropped', async () => {
    const s2 = new HostServer({ port: port + 1, helloTimeoutMs: 200 });
    await s2.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port + 1}/ws?k=${s2.code}`);
    const closed = new Promise((r) => ws.on('close', r));
    await new Promise((r) => ws.on('open', r));
    assert.strictEqual(s2.clients.size, 1);
    await closed;
    await until(() => s2.clients.size === 0, 1000, 'server dropped the socket');
    s2.stop();
  });

  await test('guest whose lobby is gone after a reconnect gets sent home', async () => {
    const p2 = port + 2;
    const s3 = new HostServer({ port: p2 });
    await s3.start();
    const g = new Session({ baseUrl: `http://127.0.0.1:${p2}`, code: s3.code, name: 'G2', mpvPath: 'fake' });
    let ended = null;
    g.on('ended', (r) => { ended = r; });
    await g.start();
    // host crashes (no polite close) and starts a new lobby on the same port
    for (const c of s3.clients.values()) c.ws.terminate();
    s3.stop();
    const s4 = new HostServer({ port: p2 });
    await s4.start();
    await until(() => ended, 6000, 'session ended');
    assert(/no longer exists/.test(ended), ended);
    g.stop();
    s4.stop();
  });

  console.log('voice');
  await test('voice audio is relayed only between people in voice', async () => {
    const vp = port + 3;
    const vs = new HostServer({ port: vp });
    await vs.start();
    const connect = (name) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${vp}/ws?k=${vs.code}`);
      const c = { ws, msgs: [], audio: [], id: null };
      ws.on('message', (d, bin) => {
        if (bin) { c.audio.push(Buffer.from(d)); return; }
        const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'welcome') { c.id = m.clientId; resolve(c); }
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name })));
    });
    const send = (c, m) => c.ws.send(JSON.stringify(m));
    const got = (c, type) => c.msgs.filter((m) => m.type === type);
    const a = await connect('A');
    const b = await connect('B');
    const c = await connect('C'); // never joins voice

    send(a, { type: 'voice-join' });
    await until(() => got(a, 'voice-peers').length === 1, 1000, 'A peers');
    assert.deepStrictEqual(got(a, 'voice-peers')[0].peers, []);
    send(b, { type: 'voice-join' });
    await until(() => got(b, 'voice-peers').length === 1 && got(a, 'voice-peer-joined').length === 1, 1000, 'B joined');
    assert.deepStrictEqual(got(b, 'voice-peers')[0].peers, [a.id], 'newcomer gets the list and makes the offers');
    assert.strictEqual(got(a, 'voice-peer-joined')[0].id, b.id);

    const frame = (seq, body) => Buffer.concat([Buffer.from([1, 0, 0, 0, seq]), Buffer.from(body)]);
    b.ws.send(frame(7, 'opus!'), { binary: true });
    await until(() => a.audio.length === 1, 1000, 'relayed');
    const f = a.audio[0];
    assert.strictEqual(f[0], 1);
    assert.strictEqual(f.subarray(1, 9).toString('latin1'), b.id, 'tagged with the sender');
    assert.strictEqual(f.readUInt32BE(9), 7);
    assert.strictEqual(f.subarray(13).toString(), 'opus!');

    c.ws.send(frame(1, 'x'), { binary: true });                  // C isn't in voice
    b.ws.send(frame(2, 'x'.repeat(2000)), { binary: true });     // too big
    b.ws.send(Buffer.from([9, 0, 0, 0, 0, 0]), { binary: true }); // not a voice frame
    await wait(200);
    assert.strictEqual(c.audio.length, 0, 'not in voice: hears nothing');
    assert.strictEqual(b.audio.length, 0, 'talker does not get an echo');
    assert.strictEqual(a.audio.length, 1, 'nothing else relayed');

    send(a, { type: 'voice-state', muted: true, deafened: false });
    await until(() => { const m = got(b, 'members').pop(); return m && m.list.find((x) => x.id === a.id).voice.muted; }, 500, 'mute shows up at once');
    a.ws.send(frame(3, 'muted'), { binary: true });
    send(b, { type: 'voice-state', muted: false, deafened: true });
    await wait(100);
    a.ws.send(frame(4, 'x'), { binary: true });
    await wait(200);
    assert.strictEqual(b.audio.length, 0, 'muted talkers are not relayed, deafened listeners get nothing');
    const list = got(c, 'members').pop().list;
    assert.strictEqual(list.find((x) => x.id === c.id).voice, null, 'C shown as not in voice');

    b.ws.terminate();
    await until(() => got(a, 'voice-peer-left').some((m) => m.id === b.id), 1000, 'peer-left on disconnect');
    send(a, { type: 'voice-leave' });
    await until(() => !vs._voicePeers(null).length, 1000, 'left');
    a.ws.close(); c.ws.close();
    vs.stop();
  });

  await test('sessions carry voice control + audio between the app and the server', async () => {
    const hostGot = [];
    const guestMsgs = [];
    host.on('voice-audio', (b) => hostGot.push(Buffer.from(b)));
    guest.on('voice', (m) => guestMsgs.push(m));
    host.voiceSend({ type: 'voice-join' });
    guest.voiceSend({ type: 'voice-join' });
    guest.voiceSend({ type: 'bogus', evil: true }); // dropped, never reaches the server
    await until(() => guestMsgs.some((m) => m.type === 'voice-peers' && m.peers.length === 1), 1000, 'guest sees host in voice');
    guest.voiceAudio(Buffer.from([1, 0, 0, 0, 1, 42, 43]));
    await until(() => hostGot.length === 1, 1000, 'host session receives the frame');
    assert.deepStrictEqual([...hostGot[0].subarray(13)], [42, 43]);
    guest.voiceAudio(Buffer.alloc(5000)); // oversized: never sent
    host.voiceSend({ type: 'voice-leave' });
    guest.voiceSend({ type: 'voice-leave' });
    await until(() => guestMsgs.some((m) => m.type === 'voice-peer-left'), 1000, 'host left voice');
    assert.strictEqual(hostGot.length, 1);
  });

  await test('host moderation: mute for everyone (sticks across rejoin) and disconnect from voice', async () => {
    const mp = port + 4;
    const ms = new HostServer({ port: mp });
    await ms.start();
    const connect = (name, hostToken) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mp}/ws?k=${ms.code}`);
      const c = { ws, msgs: [], audio: [], id: null };
      ws.on('message', (d, bin) => {
        if (bin) { c.audio.push(Buffer.from(d)); return; }
        const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'welcome') { c.id = m.clientId; resolve(c); }
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name, hostToken })));
    });
    const send = (c, m) => c.ws.send(JSON.stringify(m));
    const frame = Buffer.from([1, 0, 0, 0, 1, 7, 7]);
    const voiceOf = (c, who) => (c.msgs.filter((m) => m.type === 'members').pop() || { list: [] }).list.find((x) => x.id === who.id)?.voice;
    const h = await connect('Host', ms.hostToken);
    const g = await connect('Gus');
    const t = await connect('Tia');
    for (const c of [h, g, t]) send(c, { type: 'voice-join' });
    await until(() => ms._voicePeers(null).length === 3, 1000, 'all in voice');

    send(g, { type: 'voice-mod', target: t.id, action: 'mute' }); // not the host: ignored
    await wait(150);
    assert.strictEqual(ms.clients.get(t.id).voice.serverMuted, false, 'guests cannot moderate');

    send(h, { type: 'voice-mod', target: t.id, action: 'mute' });
    await until(() => voiceOf(g, t) && voiceOf(g, t).serverMuted, 1000, 'everyone sees Tia muted by host');
    t.ws.send(frame, { binary: true });
    await wait(150);
    assert.strictEqual(g.audio.length, 0, 'server drops a host-muted talker');

    send(t, { type: 'voice-leave' });
    send(t, { type: 'voice-join' });
    await until(() => voiceOf(g, t) && voiceOf(g, t).serverMuted, 1000, 'still muted after rejoining');

    send(h, { type: 'voice-mod', target: t.id, action: 'unmute' });
    await until(() => voiceOf(g, t) && !voiceOf(g, t).serverMuted, 1000, 'unmuted');
    t.ws.send(frame, { binary: true });
    await until(() => g.audio.length === 1, 1000, 'Tia heard again');

    send(h, { type: 'voice-mod', target: g.id, action: 'kick' });
    await until(() => g.msgs.some((m) => m.type === 'voice-kicked' && m.by === 'Host'), 1000, 'Gus told');
    await until(() => !ms.clients.get(g.id).voice, 1000, 'Gus out of voice');
    assert(t.msgs.some((m) => m.type === 'voice-peer-left' && m.id === g.id), 'others drop Gus');
    assert(g.ws.readyState === 1, 'Gus is still in the lobby, just not in voice');
    for (const c of [h, g, t]) c.ws.close();
    ms.stop();
  });

  await test('ducking the movie ramps the player\'s duck filter, separate from the user volume', async () => {
    hm.afCommands = [];
    host.duck(0.4);
    await wait(300);
    const last = hm.afCommands[hm.afCommands.length - 1];
    assert.deepStrictEqual(last, ['w2gduck', 'volume', '0.400', 'volume']);
    assert(hm.afCommands.length >= 3, 'ramped in steps, not one jump');
    host.duck(1);
    await wait(300);
    assert.deepStrictEqual(hm.afCommands[hm.afCommands.length - 1], ['w2gduck', 'volume', '1.000', 'volume']);
  });

  await test('lobby without a video: talk first, players open only once the host picks one', async () => {
    const ep = port + 5;
    const es = new HostServer({ port: ep });
    await es.start();
    const base2 = `http://127.0.0.1:${ep}`;
    const before = FakeMpv.instances.length;
    const h2 = new Session({ baseUrl: base2, code: es.code, name: 'H', hostToken: es.hostToken, mpvPath: 'fake', resolveLocal: (m) => (es.media && m.id === es.media.id ? es.media.path : null) });
    const g2 = new Session({ baseUrl: base2, code: es.code, name: 'G', mpvPath: 'fake' });
    await h2.start();
    await g2.start();
    await wait(300);
    assert.strictEqual(FakeMpv.instances.length, before, 'no empty player windows');
    assert.strictEqual(g2.room.media, null);
    g2.command('play'); // nothing to play: ignored
    await wait(100);
    assert.strictEqual(es.paused, true);

    es.setMedia(file);
    await until(() => FakeMpv.instances.length === before + 2, 2000, 'both players open');
    const [hp, gp] = FakeMpv.instances.slice(before);
    await until(() => hp.loaded === file && gp.loaded && gp.loaded.includes(es.media.id), 2000, 'and load the video');

    gp.emit('exit'); // the guest closes their player window
    await until(() => !g2.playerOpen, 1000, 'closed');
    es._broadcastState(); // more state updates for the same video...
    await wait(300);
    assert.strictEqual(FakeMpv.instances.length, before + 2, '...do not pop it open again');

    const file3 = path.join(dir, 'third.mkv');
    fs.writeFileSync(file3, data.subarray(0, 2000));
    es.setMedia(file3); // a new video does
    await until(() => FakeMpv.instances.length === before + 3, 2000, 'reopened for the new video');
    await until(() => FakeMpv.instances[before + 2].loaded && FakeMpv.instances[before + 2].loaded.includes(es.media.id), 2000, 'new video loaded');

    await Promise.all([g2.reopenPlayer(), g2.reopenPlayer()]); // already open: no-op, never two players
    assert.strictEqual(FakeMpv.instances.length, before + 3);
    h2.stop(); g2.stop(); es.stop();
  });

  await test('in-app player: mpv draws into the app window; f / double-click ask for app fullscreen; pop out restarts it', async () => {
    const xp = port + 6;
    const xs = new HostServer({ port: xp });
    await xs.start();
    xs.setMedia(file);
    let wid = '123456';
    const before = FakeMpv.instances.length;
    const g3 = new Session({ baseUrl: `http://127.0.0.1:${xp}`, code: xs.code, name: 'G3', mpvPath: 'fake', getWid: () => wid });
    const requests = [];
    g3.on('player-request', (r) => requests.push(r));
    await g3.start();
    await until(() => FakeMpv.instances.length === before + 1 && FakeMpv.instances[before].loaded, 2000, 'player open');
    const p1 = FakeMpv.instances[before];
    assert(p1.startOpts.extraArgs.includes('--wid=123456'), 'drawn into the app window');
    assert.strictEqual(p1.keybinds.f, 'script-message w2g-fullscreen');
    assert.strictEqual(p1.keybinds.MBTN_LEFT_DBL, 'script-message w2g-fullscreen');
    assert.strictEqual(p1.keybinds.ESC, 'script-message w2g-exit-fullscreen');
    assert.strictEqual(p1.keybinds.TAB, 'script-message w2g-sidebar', 'Tab toggles the fullscreen sidebar');
    p1.emit('event', { event: 'client-message', args: ['w2g-fullscreen'] });
    p1.emit('event', { event: 'client-message', args: ['something-else'] });
    assert.deepStrictEqual(requests, ['fullscreen']);

    wid = null; // pop out
    await g3.restartPlayer();
    assert(p1.quitCalled, 'old player closed');
    const p2 = FakeMpv.instances[before + 1];
    assert(p2, 'new player started');
    assert(!p2.startOpts.extraArgs.some((a) => a.startsWith('--wid')), 'its own window');
    assert.strictEqual(p2.keybinds, undefined, 'mpv keeps its own f / double-click in its own window');
    await until(() => p2.loaded && p2.loaded.includes(xs.media.id), 2000, 'same video reloaded');
    p1.emit('exit'); // the old player's exit arrives late: must not count as "player closed"
    await wait(100);
    assert.strictEqual(g3.playerOpen, true);
    g3.stop(); xs.stop();
  });

  await test('volume: starts at the saved level, the slider sets it, the player\'s own keys update the app', async () => {
    const vp2 = port + 7;
    const vs2 = new HostServer({ port: vp2 });
    await vs2.start();
    vs2.setMedia(file);
    const before = FakeMpv.instances.length;
    const saved = [];
    const g4 = new Session({ baseUrl: `http://127.0.0.1:${vp2}`, code: vs2.code, name: 'G4', mpvPath: 'fake', getVolume: () => 65 });
    g4.on('volume', (v) => saved.push(v));
    let lastUpdate = null;
    g4.on('update', (u) => { lastUpdate = u; });
    await g4.start();
    await until(() => FakeMpv.instances.length === before + 1 && FakeMpv.instances[before].loaded, 2000, 'player open');
    const p = FakeMpv.instances[before];
    assert(p.startOpts.extraArgs.includes('--volume=65'), 'starts at the saved volume');
    g4.setVolume(40);
    assert.strictEqual(p.props.volume, 40, 'slider sets the player volume');
    g4.setVolume(500);
    assert.strictEqual(p.props.volume, 130, 'capped at 130');
    g4.setMute(true);
    assert.strictEqual(p.props.mute, true);
    g4.setVolume(20);
    assert.strictEqual(p.props.mute, false, 'moving the slider up unmutes');
    await wait(50); // let the player's own reports of those changes arrive first
    p.emit('property', 'volume', 85); // user pressed 0 / scrolled inside the player
    await wait(50);
    assert.strictEqual(lastUpdate.player.volume, 85, 'app slider follows');
    assert.deepStrictEqual(saved.slice(-1), [85], 'and it is remembered');
    g4.stop(); vs2.stop();
  });

  await test('host restarts for an update: same lobby comes back, guests reconnect by themselves, no video reload', async () => {
    const rp = port + 8;
    const s1 = new HostServer({ port: rp });
    await s1.start();
    s1.setMedia(file);
    const before = FakeMpv.instances.length;
    let ended = null;
    const g5 = new Session({ baseUrl: `http://127.0.0.1:${rp}`, code: s1.code, name: 'G5', mpvPath: 'fake' });
    g5.on('ended', (r) => { ended = r; });
    await g5.start();
    await until(() => FakeMpv.instances.length === before + 1 && FakeMpv.instances[before].loaded, 2000, 'guest player');
    const gp = FakeMpv.instances[before];
    const loadsBefore = gp.loaded;
    s1._apply({ name: 'Host' }, 'seek', 42);
    await until(() => Math.abs(g5._expectedPosition() - 42) < 0.5, 2000, 'at 42 s');
    // what the host's app saves before "Restart to update"
    const saved = { code: s1.code, hostToken: s1.hostToken, mediaId: s1.media.id, position: s1._currentPosition() };

    s1.stop({ restarting: true });
    await until(() => !g5.connected, 2000, 'guest notices');
    await wait(500);
    assert.strictEqual(ended, null, 'guest did NOT leave the lobby');
    assert(g5.log.some((l) => /restarting the app for an update/.test(l.text)), 'guest is told why');

    // the updated app reopens the same lobby
    const s2 = new HostServer({ port: rp, code: saved.code, hostToken: saved.hostToken });
    await s2.start();
    s2.setMedia(file, { id: saved.mediaId, position: saved.position });
    assert.strictEqual(s2.code, saved.code);
    assert.strictEqual(s2.hostToken, saved.hostToken, 'host keeps host rights');
    await until(() => g5.connected, 6000, 'guest reconnects by itself');
    await wait(300);
    assert.strictEqual(ended, null);
    assert.strictEqual(gp.loaded, loadsBefore, 'same video id: the guest did not reload it');
    assert.strictEqual(FakeMpv.instances.length, before + 1, 'no new player');
    assert(Math.abs(g5._expectedPosition() - 42) < 0.5, 'still at 42 s');
    assert.strictEqual(s2.paused, true, 'reopens paused so everyone can get ready');
    g5.stop(); s2.stop();
  });

  await test('a normal "close the lobby" still sends guests home', async () => {
    const rp = port + 9;
    const s3 = new HostServer({ port: rp });
    await s3.start();
    let ended = null;
    const g6 = new Session({ baseUrl: `http://127.0.0.1:${rp}`, code: s3.code, name: 'G6', mpvPath: 'fake' });
    g6.on('ended', (r) => { ended = r; });
    await g6.start();
    s3.stop();
    await until(() => ended, 2000, 'ended');
    assert.match(ended, /closed the lobby/);
    g6.stop();
  });

  await test('bad restore values are ignored (fresh code / token / id)', async () => {
    const s4 = new HostServer({ port: port + 10, code: 'lower!', hostToken: 'nothex' });
    assert.match(s4.code, /^[A-Z2-9]{6}$/);
    assert.notStrictEqual(s4.code, 'lower!');
    assert.match(s4.hostToken, /^[a-f0-9]{32}$/);
    s4.setMedia(file, { id: '../../etc', position: -5 });
    assert.match(s4.media.id, /^[a-f0-9]{16}$/);
    assert.strictEqual(s4.position, 0);
  });

  await test('a guest whose connection silently died is dropped (no ghost members / voice)', async () => {
    const sp = port + 11;
    const ss = new HostServer({ port: sp, silentMs: 400 });
    await ss.start();
    const ws = new WebSocket(`ws://127.0.0.1:${sp}/ws?k=${ss.code}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', name: 'Ghost' }));
    ws.send(JSON.stringify({ type: 'voice-join' }));
    await until(() => ss._membersMsg().list.length === 1, 1000, 'joined');
    // then: nothing (no pings), like a laptop that went to sleep without closing the socket
    await until(() => ss._membersMsg().list.length === 0 && !ss._voicePeers(null).length, 4000, 'dropped');
    ws.terminate();
    ss.stop();
  });

  await test('a guest notices a host that went silent and reconnects', async () => {
    const { WebSocketServer } = require('ws');
    const hp = port + 12;
    let connections = 0;
    const fake = new WebSocketServer({ port: hp });
    fake.on('connection', (sock) => {
      connections++;
      sock.on('message', (d) => {
        const m = JSON.parse(d);
        // welcome, then never answer anything again (but keep the socket open)
        if (m.type === 'hello') sock.send(JSON.stringify({ type: 'welcome', clientId: 'abcd1234', state: { paused: true, position: 0, updatedAt: Date.now(), media: null }, members: [] }));
      });
    });
    const g = new Session({ baseUrl: `http://127.0.0.1:${hp}`, code: 'ABCDEF', name: 'G', mpvPath: 'fake' });
    g.silentHostMs = 1500;
    await g.start();
    await until(() => g.log.some((l) => /No answer from the host/.test(l.text)), 8000, 'noticed');
    await until(() => connections >= 2, 6000, 'reconnected');
    g.stop();
    fake.close();
  });

  await test('a malformed request is refused without crashing the host', async () => {
    const net = require('net');
    const res = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n'));
      let out = '';
      sock.on('data', (d) => { out += d; });
      sock.on('close', () => resolve(out));
      sock.on('error', () => resolve(out));
      setTimeout(() => sock.destroy(), 1000);
    });
    assert(!/^HTTP\/1\.1 200/.test(res), 'not served');
    const ok = await get(`${base}/info?k=${server.code}`);
    assert.strictEqual(ok.status, 200, 'host still up');
  });

  await test('switching in-app <-> popped out keeps mute and a lowered movie', async () => {
    const kp = port + 13;
    const ks = new HostServer({ port: kp });
    await ks.start();
    ks.setMedia(file);
    let wid = '1';
    const before = FakeMpv.instances.length;
    const g7 = new Session({ baseUrl: `http://127.0.0.1:${kp}`, code: ks.code, name: 'G7', mpvPath: 'fake', getWid: () => wid, getVolume: () => 80 });
    await g7.start();
    await until(() => FakeMpv.instances.length === before + 1 && FakeMpv.instances[before].loaded, 2000, 'open');
    g7.setMute(true);
    g7.duck(0.4);
    await wait(300);
    wid = null;
    await g7.restartPlayer();
    const p2 = FakeMpv.instances[before + 1];
    assert(p2.startOpts.extraArgs.includes('--mute=yes'), 'still muted');
    assert(p2.startOpts.extraArgs.includes('--volume=80'));
    assert.deepStrictEqual(p2.afCommands && p2.afCommands[0], ['w2gduck', 'volume', '0.400', 'volume'], 'still lowered');
    g7.stop(); ks.stop();
  });

  await test('host changes video -> everyone reloads, paused at 0', async () => {
    const file2 = path.join(dir, 'other.mp4');
    fs.writeFileSync(file2, data.subarray(0, 1000));
    host.resolveLocal = (m) => (m.id === server.media.id ? server.media.path : null);
    server.setMedia(file2);
    await until(() => hm.loaded === file2 && gm.loaded.includes(server.media.id), 2000, 'reloaded');
    await until(() => hm.props.pause && gm.props.pause, 2000, 'paused');
    assert.strictEqual(server.position, 0);
  });

  await test('guest leaving does not block the room', async () => {
    guest.stop();
    await until(() => server._membersMsg().list.length === 1, 2000, 'guest gone');
    assert(!server._isWaiting());
  });

  host.stop();
  server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
