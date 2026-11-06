'use strict';

/**
 * Whole-app test with the real UI and real mpv: host a lobby, pick a video, and check
 * with screen captures that the in-app player shows the movie exactly in the stage,
 * in normal, fullscreen and fullscreen-with-sidebar layouts, that pop out / bring back
 * work, and that the video steps aside for the settings dialog.
 * Visible on screen for about a minute; the test video has no audio track.
 * Run: npm run test:app -- <silent video file>
 */

const { app, BrowserWindow, BaseWindow, nativeImage, dialog, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { execFileSync } = require('child_process');

dialog.showErrorBox = (t, c) => console.error('ERROR', t, c);
process.on('uncaughtException', (e) => {
  console.error('  harness error:', e && e.stack);
  app.exit(1);
});

const videoFile = process.argv.find((a) => /\.(mkv|mp4)$/i.test(a));
if (!videoFile) {
  console.error('usage: npm run test:app -- <silent video file>');
  process.exit(2);
}

// Voice uses Chromium's fake microphone (no real mic, no permission prompt).
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

// Separate settings / single-instance lock from the user's installed app.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'w2g-app-e2e-')));
require('../../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The real mouse pointer (for the auto-hide check; it's put back afterwards).
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const CURSORINFO = koffi.struct('W2GTestCursorInfo', { cbSize: 'uint32', flags: 'uint32', hCursor: 'intptr_t', x: 'long', y: 'long' });
const GetCursorInfo = user32.func('bool __stdcall GetCursorInfo(_Inout_ W2GTestCursorInfo *ci)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const cursorShowing = () => {
  const ci = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: 0, x: 0, y: 0 };
  GetCursorInfo(ci);
  return ci.flags === 1;
};
const fwd = (p) => p.split(path.sep).join('/');
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
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error('Timed out: ' + label);
}

function capture(b) {
  const file = path.join(os.tmpdir(), `w2g-app-${Date.now()}.png`);
  const ps = 'Add-Type -AssemblyName System.Drawing; '
    + `$bmp = New-Object System.Drawing.Bitmap(${Math.round(b.width)}, ${Math.round(b.height)}); `
    + '$g = [System.Drawing.Graphics]::FromImage($bmp); '
    + `$g.CopyFromScreen(${Math.round(b.x)}, ${Math.round(b.y)}, 0, 0, $bmp.Size); `
    + `$bmp.Save('${fwd(file)}'); $g.Dispose(); $bmp.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps]);
  const img = nativeImage.createFromPath(file);
  fs.unlinkSync(file);
  return { bmp: img.toBitmap(), size: img.getSize() };
}
/** Share of clearly colored pixels: the test pattern is very colorful, the UI is not. */
function colorful(b) {
  const { bmp, size } = capture(b);
  let c = 0;
  let n = 0;
  for (let y = 0; y < size.height; y += 4) {
    for (let x = 0; x < size.width; x += 4) {
      const i = (y * size.width + x) * 4;
      if (Math.max(bmp[i], bmp[i + 1], bmp[i + 2]) - Math.min(bmp[i], bmp[i + 1], bmp[i + 2]) > 80) c++;
      n++;
    }
  }
  return c / n;
}
/** W2G_SHOT_DIR=<dir>: also save screenshots of the window, for a human to look at. */
function snapshot(name, b) {
  if (!process.env.W2G_SHOT_DIR) return;
  const file = fwd(path.join(process.env.W2G_SHOT_DIR, name + '.png'));
  const ps = 'Add-Type -AssemblyName System.Drawing; '
    + `$bmp = New-Object System.Drawing.Bitmap(${Math.round(b.width)}, ${Math.round(b.height)}); `
    + '$g = [System.Drawing.Graphics]::FromImage($bmp); '
    + `$g.CopyFromScreen(${Math.round(b.x)}, ${Math.round(b.y)}, 0, 0, $bmp.Size); `
    + `$bmp.Save('${file}'); $g.Dispose(); $bmp.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps]);
}
const inset = (r, d = 24) => ({ x: r.x + d, y: r.y + d, width: r.width - 2 * d, height: r.height - 2 * d });

app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows().length > 0, 10000, 'app window');
  const win = BrowserWindow.getAllWindows()[0];
  await until(() => !win.webContents.isLoading(), 10000, 'page loaded');
  win.setBounds({ x: 80, y: 60, width: 1200, height: 760 });
  const js = (code) => win.webContents.executeJavaScript(code);
  /** A page element's rect on screen. */
  const screenRect = async (sel) => {
    const r = await js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    const c = win.getContentBounds();
    return { x: c.x + r.x, y: c.y + r.y, width: r.width, height: r.height };
  };
  const videoWindow = () => BaseWindow.getAllWindows().find((w) => !(w instanceof BrowserWindow));
  // Any uncaught error in the page fails the run (a startup crash once hid the status badges).
  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 3 || /Uncaught/.test(msg)) pageErrors.push(msg);
  });
  win.webContents.reload(); // start fresh so errors from startup are caught too
  await until(() => !win.webContents.isLoading(), 10000, 'page reloaded');

  console.log('whole app (real UI + real mpv)');
  try {
    await test('the app starts cleanly: status badges shown, no page errors', async () => {
      await until(() => js('document.querySelectorAll("#envBadges .badge").length >= 2'), 15000, 'Tailscale / player badges');
      await wait(500);
      assert.deepStrictEqual(pageErrors, []);
    });

    await test('host an empty lobby: no video window, a message on the stage', async () => {
      await js(`document.getElementById('name').value = 'Tester'; document.getElementById('hostBtn').click(); 0`);
      await until(() => js('!!lobby && !document.getElementById("screen-lobby").classList.contains("hidden")'), 10000, 'lobby');
      await wait(1000);
      assert.strictEqual(videoWindow().isVisible(), false);
      assert.match(await js('document.getElementById("stagePhText").textContent'), /No video yet/);
    });

    await test('choose a video: it plays inside the stage, not over the sidebar', async () => {
      await js(`api.changeVideo(${JSON.stringify(videoFile)}); 0`);
      await until(() => js('!!(last && last.player && last.player.open && last.room.media)'), 15000, 'player open');
      await wait(2500);
      const stage = await screenRect('#stage');
      const v = colorful(inset(stage));
      console.log(`       stage ${Math.round(stage.width)}x${Math.round(stage.height)}: ${(v * 100).toFixed(0)}% colorful`);
      assert(v > 0.3, 'movie visible in the stage');
      assert(colorful(inset(await screenRect('#sidebar'), 30)) < 0.05, 'sidebar not covered');
      snapshot('1-lobby', win.getBounds());
      assert(colorful(inset(await screenRect('.stage-col .controls'), 8)) < 0.1, 'controls bar not covered');
    });

    await test('volume slider and mute button control the real player, and follow it back', async () => {
      await js('changeVolume(40); 0');
      await until(() => js('last.player.volume === 40'), 3000, 'player at 40');
      await js('document.getElementById("volBtn").click(); 0');
      await until(() => js('last.player.muted === true'), 3000, 'muted');
      await js('document.getElementById("volBtn").click(); 0');
      await until(() => js('last.player.muted === false'), 3000, 'unmuted');
      await js('changeVolume(100); 0');
      await until(() => js('last.player.volume === 100'), 3000, 'back to 100');
    });

    await test('fullscreen: the movie fills the screen and the sidebar is tucked away', async () => {
      await js('api.fullscreen(true); 0');
      await until(() => js('document.body.classList.contains("fullscreen")'), 5000, 'fullscreen');
      await wait(2500); // let Windows' fullscreen animation finish before capturing
      // The real mouse may rest at the left edge, which (correctly) slides the sidebar in.
      // After the app's own cursor poller has reported, simulate the mouse in the middle.
      win.webContents.send('cursor-x', 1500);
      await wait(1300); // the sidebar hides 0.7 s after the mouse leaves, then slides away
      const c = win.getContentBounds();
      const v = colorful(inset(c, 60));
      console.log(`       fullscreen ${c.width}x${c.height}: ${(v * 100).toFixed(0)}% colorful`);
      assert(v > 0.3);
      const side = await screenRect('#sidebar');
      assert(side.x + side.width <= c.x + 2, 'sidebar off screen');
    });

    await test('mouse at the left edge slides the sidebar in, beside the movie; moving away hides it', async () => {
      win.webContents.send('cursor-x', 2); // what the cursor poller sends at the left edge
      await until(() => js('document.body.classList.contains("peek")'), 2000, 'peek');
      await wait(900);
      const side = await screenRect('#sidebar');
      const stage = await screenRect('#stage');
      assert(side.x >= win.getContentBounds().x - 1, 'sidebar on screen');
      assert(stage.x >= side.x + side.width - 2, 'movie moved over, not covering it');
      snapshot('2-fullscreen-peek', win.getContentBounds());
      assert(colorful(inset(side, 30)) < 0.05, 'sidebar readable (video not over it)');
      assert(colorful(inset(stage, 60)) > 0.3, 'movie still visible next to it');
      win.webContents.send('cursor-x', 1500);
      await until(() => js('!document.body.classList.contains("peek")'), 3000, 'hides again');
    });

    await test('mouse on another monitor to the left hides the sidebar (it used to stay open)', async () => {
      win.webContents.send('cursor-x', 3);
      await until(() => js('document.body.classList.contains("peek")'), 2000, 'peek');
      win.webContents.send('cursor-x', null); // what the poller sends when the cursor is outside the window
      await until(() => js('!document.body.classList.contains("peek")'), 3000, 'hidden again');
    });

    await test('Tab pins the sidebar open in fullscreen, and Tab again closes it', async () => {
      await js('toggleSidebar(); 0');
      assert.strictEqual(await js('document.body.classList.contains("peek")'), true);
      win.webContents.send('cursor-x', 1500); // mouse far away: a pinned sidebar stays
      await wait(1200);
      assert.strictEqual(await js('document.body.classList.contains("peek")'), true, 'stays while pinned');
      await js('toggleSidebar(); 0');
      assert.strictEqual(await js('document.body.classList.contains("peek")'), false);
    });

    await test('the mouse pointer hides over the video after 2 s still, and comes back when it moves', async () => {
      const home = screen.getCursorScreenPoint();
      try {
        const stage = await screenRect('#stage');
        const cx = Math.round(stage.x + stage.width / 2);
        const cy = Math.round(stage.y + stage.height / 2);
        SetCursorPos(cx, cy);
        await wait(300);
        assert.strictEqual(cursorShowing(), true, 'visible right after moving');
        await wait(2600);
        assert.strictEqual(cursorShowing(), false, 'hidden after 2 s without movement');
        SetCursorPos(cx + 30, cy + 10);
        await wait(300);
        assert.strictEqual(cursorShowing(), true, 'back as soon as it moves');
      } finally {
        SetCursorPos(home.x, home.y);
        await wait(200);
      }
      assert.strictEqual(cursorShowing(), true, 'never left hidden');
    });

    await test('Esc leaves fullscreen', async () => {
      await js('api.fullscreen(false); 0');
      await until(async () => (await js('!document.body.classList.contains("fullscreen")')) && !win.isFullScreen(), 5000, 'windowed');
      await wait(1200);
      assert(colorful(inset(await screenRect('#stage'))) > 0.3);
    });

    await test('the settings dialog is never covered by the video', async () => {
      await js('openVoiceSettings(); 0');
      await wait(800);
      assert.strictEqual(videoWindow().isVisible(), false, 'video steps aside');
      await js('closeVoiceSettings(); 0');
      await wait(1500);
      assert.strictEqual(videoWindow().isVisible(), true, 'and comes back');
      assert(colorful(inset(await screenRect('#stage'))) > 0.3);
    });

    await test('pop out: the movie moves to its own window; bring it back', async () => {
      await js('document.getElementById("popOut").click(); 0');
      await until(() => js('document.getElementById("stagePhText").textContent.includes("separate window")'), 5000, 'placeholder');
      await until(() => js('!!(last && last.player.open)'), 10000, 'player reopened');
      await wait(1500);
      assert.strictEqual(videoWindow().isVisible(), false, 'nothing over the stage');
      // (no screen check here: mpv's own window opens mid-screen, right over the app)
      await js('document.getElementById("bringBack").click(); 0');
      await until(async () => (await js('!!(last && last.player.open)')) && videoWindow().isVisible(), 10000, 'back in the app');
      await wait(2500);
      assert(colorful(inset(await screenRect('#stage'))) > 0.3, 'movie back in the stage');
    });

    await test('"Restart to update" comes straight back: same lobby, video and spot; voice rejoined, still muted', async () => {
      await js(`voice.updateSettings({ soundCues: false, outputVolume: 0 }).then(() => document.getElementById('voiceJoin').click()); 0`);
      await until(() => js('voice.joined'), 8000, 'in voice');
      await js('voice.setMuted(true); 0');
      await js('api.cmd("seek", 30); 0');
      await until(() => js('Math.abs(last.room.current - 30) < 1'), 5000, 'at 30 s');
      const before = JSON.parse(await js('JSON.stringify({ invite: lobby.invite, media: last.room.media.id })'));

      await js('api.installUpdate({ inVoice: voice.joined, muted: voice.muted, deafened: voice.deafened }); 0');
      await wait(1500); // saved + left the lobby (a dev build doesn't actually install)
      win.webContents.reload(); // = the updated app starting
      await until(() => js('typeof lobby !== "undefined" && !!lobby && !!(last && last.room && last.room.media)').catch(() => false), 20000, 'back in the lobby');
      await until(() => js('voice.joined'), 10000, 'back in voice');
      const after = JSON.parse(await js('JSON.stringify({ invite: lobby.invite, media: last.room.media.id, current: last.room.current, paused: last.room.paused, muted: voice.muted })'));
      console.log(`       back at ${after.current.toFixed(1)} s, same invite: ${after.invite === before.invite}, muted: ${after.muted}`);
      assert.strictEqual(after.invite, before.invite, 'same invite code: friends reconnect by themselves');
      assert.strictEqual(after.media, before.media, 'same video');
      assert(Math.abs(after.current - 30) < 2, 'same spot');
      assert.strictEqual(after.paused, true);
      assert.strictEqual(after.muted, true, 'still muted');
      assert.strictEqual(await js('api.resumeInfo()'), null, 'used once, then forgotten');
      await until(async () => (await js('!!last.player.open')) && videoWindow().isVisible(), 10000, 'player back in the app');
    });

    await test('the member list is not rebuilt when nothing changed (tooltips stay put)', async () => {
      await js('window.__li = document.querySelector("#members li"); 0');
      await wait(1600); // three or more lobby updates
      assert.strictEqual(await js('document.querySelector("#members li") === window.__li'), true);
    });

    await test('the window cannot be navigated away from the app (e.g. by a dropped file)', async () => {
      await js('location.href = "file:///C:/"; 0').catch(() => {});
      await wait(800);
      assert.match(win.webContents.getURL(), /renderer\/index\.html$/);
      assert.strictEqual(await js('!!lobby'), true, 'still in the lobby');
    });

    await test('no page errors during the whole run', async () => {
      assert.deepStrictEqual(pageErrors, []);
    });
  } finally {
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    await js('api.leave(); 0').catch(() => {});
    await wait(1500);
    app.exit(failed ? 1 : 0);
  }
});
