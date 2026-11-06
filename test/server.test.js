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
const { parseInvite, isAllowedAddress } = require('../src/main/util');
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
    assert.deepStrictEqual(p1.startOpts.extraArgs, ['--wid=123456'], 'drawn into the app window');
    assert.strictEqual(p1.keybinds.f, 'script-message w2g-fullscreen');
    assert.strictEqual(p1.keybinds.MBTN_LEFT_DBL, 'script-message w2g-fullscreen');
    assert.strictEqual(p1.keybinds.ESC, 'script-message w2g-exit-fullscreen');
    p1.emit('event', { event: 'client-message', args: ['w2g-fullscreen'] });
    p1.emit('event', { event: 'client-message', args: ['something-else'] });
    assert.deepStrictEqual(requests, ['fullscreen']);

    wid = null; // pop out
    await g3.restartPlayer();
    assert(p1.quitCalled, 'old player closed');
    const p2 = FakeMpv.instances[before + 1];
    assert(p2, 'new player started');
    assert.deepStrictEqual(p2.startOpts.extraArgs, [], 'its own window');
    assert.strictEqual(p2.keybinds, undefined, 'mpv keeps its own f / double-click in its own window');
    await until(() => p2.loaded && p2.loaded.includes(xs.media.id), 2000, 'same video reloaded');
    p1.emit('exit'); // the old player's exit arrives late: must not count as "player closed"
    await wait(100);
    assert.strictEqual(g3.playerOpen, true);
    g3.stop(); xs.stop();
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
