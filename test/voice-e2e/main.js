'use strict';

/**
 * Voice chat end-to-end: real HostServer + two hidden Electron windows running the
 * real VoiceEngine with Chromium's fake microphone (a periodic beep). Audio goes
 * mic -> Opus -> WebSocket -> server relay -> WebSocket -> Opus -> jitter buffer.
 * Run: npm run test:voice
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
const { HostServer } = require('../../src/main/server');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(50);
  }
  throw new Error('Timed out: ' + label);
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed++;
    console.error('  FAIL ' + name + '\n       ' + (e.stack || e));
  }
}

async function participant(server, name) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), partition: 'p-' + name, backgroundThrottling: false },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?k=${server.code}`);
  const p = { name, win, ws, id: null };
  await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name })));
    ws.on('message', (d, isBinary) => {
      if (isBinary) {
        if (!win.isDestroyed()) win.webContents.send('voice-audio', d);
        return;
      }
      const m = JSON.parse(d);
      if (m.type === 'welcome') {
        p.id = m.clientId;
        resolve();
      }
      if (String(m.type).startsWith('voice-') && !win.isDestroyed()) win.webContents.send('voice', m);
    });
  });
  ipcMain.on('to-server', (e, m) => {
    if (e.sender === win.webContents && ws.readyState === 1) ws.send(JSON.stringify(m));
  });
  ipcMain.on('to-server-audio', (e, bytes) => {
    if (e.sender === win.webContents && ws.readyState === 1) ws.send(Buffer.from(bytes), { binary: true });
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log(`  [${name}] ${msg}`);
  });
  await win.loadFile(path.join(__dirname, 'page.html'));
  p.js = (code) => win.webContents.executeJavaScript(code);
  p.peer = (other) => `engine.peers.get(${JSON.stringify(other.id)})`;
  return p;
}

/** Loudest level of `from` that `to` hears over a stretch of time. */
async function heard(to, from, ms) {
  let max = -200;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    max = Math.max(max, await to.js(`peerLevel(${JSON.stringify(from.id)})`));
    await wait(30);
  }
  return max;
}

app.whenReady().then(async () => {
  const server = new HostServer({ port: 18795 });
  await server.start();
  const a = await participant(server, 'Alice');
  const b = await participant(server, 'Bob');
  console.log('voice e2e');
  try {
    await test('both join and see each other', async () => {
      await a.js('engine.join()');
      await b.js('engine.join()');
      await until(async () => (await a.js(`!!${a.peer(b)}`)) && (await b.js(`!!${b.peer(a)}`)), 5000, 'peers');
    });

    await test('audio flows both ways (the fake mic beep is heard)', async () => {
      const ab = await heard(b, a, 3000);
      const ba = await heard(a, b, 3000);
      console.log(`       Bob hears Alice at ${ab.toFixed(1)} dB, Alice hears Bob at ${ba.toFixed(1)} dB`);
      assert(ab > -45 && ba > -45);
    });

    await test('speaking indicator lights up for the remote talker', async () => {
      await until(() => b.js(`!!${b.peer(a)}.speaking`), 3000, 'Bob sees Alice speaking');
    });

    await test('mute stops sending', async () => {
      await a.js('engine.setMuted(true)');
      await wait(400);
      const lvl = await heard(b, a, 2500);
      console.log(`       while Alice is muted Bob hears ${lvl.toFixed(1)} dB`);
      assert(lvl < -70, 'silence while muted');
      assert.strictEqual(server._membersMsg().list.find((m) => m.id === a.id).voice.muted, true, 'server knows');
      await a.js('engine.setMuted(false)');
      assert((await heard(b, a, 2500)) > -45, 'back after unmute');
    });

    await test('per-person volume: 0 silences just that person, 200% boosts', async () => {
      await b.js(`prefs[${JSON.stringify(a.id)}] = { volume: 0 }; engine.refreshPeerPrefs()`);
      await wait(200);
      assert((await heard(b, a, 2000)) < -70);
      await b.js(`prefs[${JSON.stringify(a.id)}] = { volume: 2 }; engine.refreshPeerPrefs()`);
      assert((await heard(b, a, 2500)) > -45, 'boosted to 200%');
      assert((await heard(a, b, 1500)) > -45, 'Alice still hears Bob');
    });

    await test('deafen silences output and stops sending', async () => {
      await b.js('engine.setDeafened(true)');
      await wait(300);
      assert.strictEqual(await b.js('engine.master.gain.value < 0.01'), true, 'output muted');
      assert((await heard(a, b, 2000)) < -70, 'Bob not sending while deafened');
      await b.js('engine.setDeafened(false)');
    });

    await test('leaving voice removes the peer on the other side', async () => {
      await b.js('engine.leave()');
      await until(() => a.js(`!engine.peers.has(${JSON.stringify(b.id)})`), 3000, 'peer removed');
    });

    await test('rejoining reconnects', async () => {
      await b.js('engine.join()');
      await until(() => a.js(`!!${a.peer(b)}`), 5000, 'peer back');
      assert((await heard(a, b, 3000)) > -45);
    });
  } finally {
    server.stop();
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    app.exit(failed ? 1 : 0);
  }
});
