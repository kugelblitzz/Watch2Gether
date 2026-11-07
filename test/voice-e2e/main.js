'use strict';

/**
 * Voice chat end-to-end: real HostServer + hidden Electron windows running the
 * real VoiceEngine. Audio goes mic -> [AI noise removal] -> Opus -> WebSocket ->
 * server relay -> WebSocket -> Opus -> jitter buffer. Completely silent: pages
 * render to no output device and levels are measured inside the audio graph.
 * Input is Chromium's fake mic (a beep) or a controlled buffer (noise / speech
 * made with Windows text-to-speech, written to a file, never played).
 * Run: npm run test:voice
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const { HostServer } = require('../../src/main/server');

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// A harness error must fail the run in the terminal, never pop an error dialog on screen.
process.on('uncaughtException', (e) => {
  console.error('  harness error:', e && e.stack);
  process.exitCode = 1;
});

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
let skipped = 0;
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

/** Speech sample via Windows SAPI text-to-speech, straight to a WAV file. */
function makeSpeech() {
  const file = path.join(os.tmpdir(), 'w2g-test-speech.wav');
  if (fs.existsSync(file)) return file;
  const text = 'Hey, can you hear me? The movie is about to start, so grab some popcorn and sit down. This part is really good.';
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; `
    + `$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); `
    + `$s.SetOutputToWaveFile('${file}', $f); $s.Speak('${text}'); $s.Dispose()`;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 30000 });
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

async function participant(server, name, speechFile, { host = false } = {}) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'p-' + name,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [`--w2g-speech=${speechFile || ''}`],
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?k=${server.code}`);
  const p = { name, win, ws, id: null };
  await new Promise((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', name, hostToken: host ? server.hostToken : undefined }));
      // ping like the real app does, or the server drops us as a dead connection after 15 s
      const t = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }));
        else clearInterval(t);
      }, 2000);
    });
    ws.on('message', (d, isBinary) => {
      if (win.isDestroyed()) return;
      if (isBinary) {
        win.webContents.send('voice-audio', d);
        return;
      }
      const m = JSON.parse(d);
      if (m.type === 'welcome') {
        p.id = m.clientId;
        resolve();
      }
      if (m.type === 'members') {
        const me = m.list.find((x) => x.id === p.id);
        win.webContents.executeJavaScript(`engine.setServerMuted(${!!(me && me.voice && me.voice.serverMuted)})`).catch(() => {});
      }
      if (String(m.type).startsWith('voice-')) win.webContents.send('voice', m);
    });
  });
  const mine = (e) => !win.isDestroyed() && e.sender === win.webContents && ws.readyState === 1;
  ipcMain.on('to-server', (e, m) => {
    if (mine(e)) ws.send(JSON.stringify(m));
  });
  ipcMain.on('to-server-audio', (e, bytes) => {
    if (mine(e)) ws.send(Buffer.from(bytes), { binary: true });
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

/** Average of the sender's own processed mic level (after noise removal, before the gate). */
async function micLevel(p, ms) {
  const vals = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    vals.push(await p.js('engine.level'));
    await wait(30);
  }
  vals.sort((x, y) => x - y);
  return { median: vals[Math.floor(vals.length / 2)], max: vals[vals.length - 1] };
}

app.whenReady().then(async () => {
  const speech = makeSpeech();
  const server = new HostServer({ port: 18795 });
  await server.start();
  const a = await participant(server, 'Alice', speech, { host: true });
  const b = await participant(server, 'Bob', speech);
  const c = await participant(server, 'Cara', speech);
  console.log('voice e2e');
  try {
    // ---------- phase 1 basics (looping speech, AI noise removal off) ----------
    // Chromium's fake mic is a short click-like beep, which voice activity rightly ignores,
    // so the basics talk with real (text-to-speech) speech instead.
    if (!speech) throw new Error('These tests need Windows text-to-speech for a speech sample');
    for (const p of [a, b, c]) await p.js(`fakeInput = 'speech'; engine.updateSettings({ noiseCancel: 'off' })`);

    await test('both join and see each other', async () => {
      await a.js('engine.join()');
      await b.js('engine.join()');
      await until(async () => (await a.js(`!!${a.peer(b)}`)) && (await b.js(`!!${b.peer(a)}`)), 5000, 'peers');
    });

    await test('a sound plays when someone else joins or leaves voice', async () => {
      await a.js('cues.length = 0');
      await c.js('engine.join()');
      await until(() => a.js(`!!${a.peer(c)}`), 3000, 'Cara in voice');
      await c.js('engine.leave(); 0');
      await until(() => a.js(`!${a.peer(c)}`), 3000, 'Cara gone');
      const cues = await a.js('cues.slice()');
      assert.deepStrictEqual(cues.filter((k) => k.startsWith('peer')), ['peerJoin', 'peerLeave']);
    });

    await test('audio flows both ways', async () => {
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
      assert((await heard(b, a, 2500)) < -70, 'silence while muted');
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
    });

    await test('deafen silences output and stops sending', async () => {
      await b.js('engine.setDeafened(true)');
      await wait(300);
      assert.strictEqual(await b.js('engine.master.gain.value < 0.01'), true, 'output muted');
      assert((await heard(a, b, 2000)) < -70, 'Bob not sending while deafened');
      await b.js('engine.setDeafened(false)');
    });

    // ---------- phase 2: push to talk, mic test ----------

    await test('push to talk: silent until the key is held, stops after the release delay', async () => {
      await a.js(`engine.updateSettings({ mode: 'ptt', pttReleaseMs: 200 })`);
      await wait(300);
      assert((await heard(b, a, 1500)) < -70, 'nothing while the key is up');
      await a.js('engine.setPttHeld(true)');
      assert((await heard(b, a, 2500)) > -45, 'heard while held');
      await a.js('engine.setPttHeld(false)');
      await wait(150);
      assert.strictEqual(await a.js('engine.speaking'), true, 'still open during the release delay');
      await wait(400);
      assert.strictEqual(await a.js('engine.speaking'), false, 'closed after the delay');
      assert((await heard(b, a, 1500)) < -70);
      await a.js(`engine.updateSettings({ mode: 'vad' })`);
    });

    await test('mic test plays your processed mic back to you without joining or sending', async () => {
      // speech through the default chain (AI noise cancellation on); the fake beep would be removed as noise
      await c.js(`fakeInput = ${speech ? "'speech'" : 'null'}; engine.updateSettings({ noiseCancel: ${speech ? "'gtcrn'" : "'off'"} })`);
      await c.js('engine.setMicTest(true)');
      await until(() => c.js('engine.speaking'), 4000, 'gate opens on speech');
      let max = -200;
      for (let i = 0; i < 60; i++) { max = Math.max(max, await c.js('monitorLevel()')); await wait(30); }
      assert(max > -45, `monitor hears the mic (${max.toFixed(1)} dB)`);
      assert.strictEqual(await c.js('engine.joined'), false);
      assert.strictEqual(await a.js(`engine.peers.has(${JSON.stringify(c.id)})`), false, 'nothing reached others');
      await c.js('engine.setMicTest(false)');
      assert.strictEqual(await c.js('engine.mic'), null, 'mic released after the test');
    });

    // ---------- phase 3: AI noise cancellation ----------

    // GTCRN reliably takes 44-49 dB off steady room noise in this test.
    const MIN_REDUCTION = { gtcrn: 30 };
    for (const model of ['gtcrn']) {
      await test(`${model}: removes background noise`, async () => {
        try {
          await c.js(`fakeInput = 'noise'; engine.updateSettings({ noiseCancel: 'off', autoSensitivity: true })`);
          await c.js('engine.setMicTest(true)');
          await wait(800);
          const off = await micLevel(c, 1500);
          await c.js(`engine.updateSettings({ noiseCancel: '${model}' })`);
          await wait(2000);
          const on = await micLevel(c, 2000);
          assert.strictEqual(await c.js('engine.noiseError'), null, 'model loaded and running');
          assert.strictEqual(await c.js('!!engine.denoise'), true, 'model is in the chain');
          console.log(`       room noise: ${off.median.toFixed(1)} dB raw -> ${on.median.toFixed(1)} dB with ${model} (${(off.median - on.median).toFixed(1)} dB less)`);
          assert(off.median - on.median >= MIN_REDUCTION[model], `at least ${MIN_REDUCTION[model]} dB quieter`);
          assert(on.median > -170, 'not dead silence (that would mean the model crashed)');
        } finally {
          await c.js('engine.setMicTest(false); engine.updateSettings({ noiseCancel: "off" })');
        }
      });

      if (!speech) { skipped++; console.log(`  skip ${model}: speech passes through (no Windows text-to-speech)`); continue; }
      await test(`${model}: speech in noise still gets through, and is sent`, async () => {
        try {
          await c.js(`fakeInput = 'speech+noise'; engine.updateSettings({ noiseCancel: '${model}' })`);
          await c.js('engine.join()');
          await until(() => a.js(`!!${a.peer(c)}`), 3000, 'Cara in voice');
          await wait(1000);
          const lvl = await micLevel(c, 3000);
          const got = await heard(a, c, 3000);
          console.log(`       speech+noise with ${model}: Cara's mic peaks ${lvl.max.toFixed(1)} dB, Alice hears ${got.toFixed(1)} dB`);
          assert(lvl.max > -35, 'speech survives');
          assert(got > -45, 'voice activity opens on speech and it is relayed');
        } finally {
          await c.js('engine.leave(); engine.updateSettings({ noiseCancel: "off" })');
        }
      });
    }

    if (speech) {
      await test('faint sound (echo leaking from speakers, ~-55 dB) does not open the mic', async () => {
        try {
          await c.js(`fakeInput = 'faint'; engine.updateSettings({ noiseCancel: 'off', autoSensitivity: true })`);
          await c.js('engine.setMicTest(true)');
          await wait(800);
          const lvl = await micLevel(c, 3000);
          let opened = false;
          for (let i = 0; i < 40; i++) { if (await c.js('engine.speaking')) opened = true; await wait(50); }
          console.log(`       faint speech peaks at ${lvl.max.toFixed(1)} dB; mic opened: ${opened}`);
          assert(lvl.max > -70 && lvl.max < -45, 'test input really is faint but present');
          assert.strictEqual(opened, false);
        } finally {
          await c.js('engine.setMicTest(false); 0');
        }
      });
    }

    await test('keyboard / mouse clicks do not open the mic or light the speaking ring', async () => {
      try {
        await c.js(`fakeInput = 'clicks'; engine.updateSettings({ noiseCancel: 'off', autoSensitivity: true })`);
        await c.js('engine.join()');
        await until(() => a.js(`!!${a.peer(c)}`), 3000, 'Cara in voice');
        await wait(800);
        const lvl = await micLevel(c, 2000);
        let opened = false;
        let ring = false;
        for (let i = 0; i < 60; i++) {
          if (await c.js('engine.speaking')) opened = true;
          if (await a.js(`!!${a.peer(c)} && ${a.peer(c)}.speaking`)) ring = true;
          await wait(50);
        }
        console.log(`       clicks peak at ${lvl.max.toFixed(1)} dB; mic opened: ${opened}; Alice saw a ring: ${ring}`);
        assert(lvl.max > -30, 'the clicks are loud');
        assert.strictEqual(opened, false, 'mic stays closed');
        assert.strictEqual(ring, false, 'no false speaking ring');
      } finally {
        await c.js('engine.leave(); 0');
      }
    });

    await test('a broken noise model never leaves the mic dead: it falls back to standard suppression', async () => {
      try {
        await c.js(`fakeInput = 'noise'; badWasm = true; engine.wasmCache = {}; engine.updateSettings({ noiseCancel: 'gtcrn' })`);
        await c.js('engine.setMicTest(true)');
        await until(() => c.js('!!engine.noiseError'), 5000, 'failure detected');
        assert.strictEqual(await c.js('engine.denoise'), null, 'model bypassed');
        const lvl = await micLevel(c, 1000);
        assert(lvl.median > -45, `mic alive again (${lvl.median.toFixed(1)} dB)`);
      } finally {
        await c.js('engine.setMicTest(false); badWasm = false; engine.wasmCache = {}; 0');
      }
    });

    // ---------- phase 4: host moderation ----------

    await test('host mutes Bob for everyone: his audio stops even though he is not muted himself', async () => {
      a.ws.send(JSON.stringify({ type: 'voice-mod', target: b.id, action: 'mute' }));
      await until(() => b.js('engine.serverMuted'), 2000, 'Bob learns he is muted');
      assert.strictEqual(await b.js('engine.muted'), false);
      await wait(300);
      assert((await heard(a, b, 2000)) < -70);
      a.ws.send(JSON.stringify({ type: 'voice-mod', target: b.id, action: 'unmute' }));
      await until(async () => !(await b.js('engine.serverMuted')), 2000, 'unmuted');
      assert((await heard(a, b, 2500)) > -45);
    });

    await test('host disconnects Bob from voice', async () => {
      await b.js('window.kicked = false; engine.onKicked = () => { window.kicked = true; }; 0');
      a.ws.send(JSON.stringify({ type: 'voice-mod', target: b.id, action: 'kick' }));
      await until(() => b.js('window.kicked && !engine.joined && engine.mic === null'), 2000, 'Bob out, mic released');
      await until(() => a.js(`!engine.peers.has(${JSON.stringify(b.id)})`), 2000, 'Alice drops Bob');
    });

    await test('rejoining after being disconnected works', async () => {
      await b.js('engine.join()');
      await until(() => a.js(`!!${a.peer(b)}`), 5000, 'peer back');
      assert((await heard(a, b, 3000)) > -45);
    });
  } finally {
    for (const p of [a, b, c]) {
      p.ws.terminate();
      if (!p.win.isDestroyed()) p.win.destroy();
    }
    server.stop();
    console.log(`\n${passed} passed${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} FAILED` : ''}`);
    app.exit(failed ? 1 : 0);
  }
});
