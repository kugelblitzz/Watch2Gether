'use strict';

/**
 * Whole-app test with the real UI and real mpv: host a lobby, pick a video, and check
 * with screen captures that the in-app player shows the movie exactly in the stage,
 * in normal, fullscreen and fullscreen-with-sidebar layouts, that pop out / bring back
 * work, and that the video steps aside for the settings dialog.
 * Visible on screen for about a minute; the test video has no audio track.
 * Run: npm run test:app -- <silent video file>
 */

const { app, BrowserWindow, BaseWindow, nativeImage, dialog } = require('electron');
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

// Separate settings / single-instance lock from the user's installed app.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'w2g-app-e2e-')));
require('../../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

  console.log('whole app (real UI + real mpv)');
  try {
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

    await test('fullscreen: the movie fills the screen and the sidebar is tucked away', async () => {
      await js('api.fullscreen(true); 0');
      await until(() => js('document.body.classList.contains("fullscreen")'), 5000, 'fullscreen');
      await wait(1500);
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

    await test('Esc leaves fullscreen', async () => {
      await js('api.fullscreen(false); 0');
      await until(() => js('!document.body.classList.contains("fullscreen")') && !win.isFullScreen(), 5000, 'windowed');
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
      await until(() => js('!!(last && last.player.open)') && videoWindow().isVisible(), 10000, 'back in the app');
      await wait(2500);
      assert(colorful(inset(await screenRect('#stage'))) > 0.3, 'movie back in the stage');
    });
  } finally {
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    await js('api.leave(); 0').catch(() => {});
    await wait(1500);
    app.exit(failed ? 1 : 0);
  }
});
