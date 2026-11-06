'use strict';

/**
 * Embedded player: the real VideoHost + real mpv (--wid) inside an Electron window.
 * Takes screen captures and checks the video area really shows the test pattern
 * (not black), including after the window moves and resizes.
 * A window appears on screen for a few seconds (silent: no audio output).
 * Run: npm run test:embed
 */

const { app, BrowserWindow, nativeImage, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { VideoHost, childWindows } = require('../../src/main/videohost');
const { findMpv } = require('../../src/main/env');

dialog.showErrorBox = (t, c) => console.error('ERROR', t, c);
process.on('uncaughtException', (e) => {
  console.error('  harness error:', e && e.stack);
  app.exit(1);
});

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

/** Screen capture of a screen rect (DIP == px at 100% scaling), returned as a bitmap. */
function capture(b) {
  const file = path.join(os.tmpdir(), `w2g-embed-${Date.now()}.png`);
  const ps = 'Add-Type -AssemblyName System.Drawing; '
    + `$bmp = New-Object System.Drawing.Bitmap(${b.width}, ${b.height}); `
    + '$g = [System.Drawing.Graphics]::FromImage($bmp); '
    + `$g.CopyFromScreen(${b.x}, ${b.y}, 0, 0, $bmp.Size); `
    + `$bmp.Save('${fwd(file)}'); $g.Dispose(); $bmp.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps]);
  const img = nativeImage.createFromPath(file);
  fs.unlinkSync(file);
  return { bmp: img.toBitmap(), size: img.getSize() };
}

/** How colorful a capture is: share of pixels that are clearly not black/grey. */
function colorfulness({ bmp, size }) {
  let colorful = 0;
  let n = 0;
  for (let y = 0; y < size.height; y += 4) {
    for (let x = 0; x < size.width; x += 4) {
      const i = (y * size.width + x) * 4; // BGRA
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) colorful++;
      n++;
    }
  }
  return colorful / n;
}

app.whenReady().then(async () => {
  const mpvPath = findMpv([path.join(__dirname, '..', '..', 'vendor', 'mpv')]);
  const main = new BrowserWindow({ x: 120, y: 120, width: 960, height: 560, backgroundColor: '#202024', autoHideMenuBar: true });
  await main.loadURL('data:text/html,<body style="margin:0;background:%23202024"></body>');
  const host = new VideoHost(main);
  const SIDEBAR = 300;
  const layout = () => {
    const c = main.getContentBounds();
    host.setRect({ x: SIDEBAR, y: 0, width: c.width - SIDEBAR, height: c.height - 60 });
  };
  layout();
  main.on('resize', layout);
  const mpv = spawn(mpvPath, ['--wid=' + host.wid, '--ao=null', '--no-terminal', '--keep-open=yes', 'av://lavfi:testsrc2=size=1280x720:rate=30'], { stdio: 'ignore' });
  const stage = () => {
    const c = main.getContentBounds();
    return { x: c.x + SIDEBAR + 20, y: c.y + 20, width: c.width - SIDEBAR - 40, height: c.height - 100 };
  };
  const sidebar = () => {
    const c = main.getContentBounds();
    return { x: c.x + 20, y: c.y + 20, width: SIDEBAR - 40, height: c.height - 100 };
  };

  console.log('embedded player');
  try {
    await wait(2500);
    await test('mpv draws inside the app window (test pattern visible, not black)', async () => {
      const kids = childWindows(host.hwnd).map((k) => k.cls);
      assert(kids.includes('mpv'), 'mpv window is a child of the video host: ' + kids.join(', '));
      const v = colorfulness(capture(stage()));
      console.log(`       video area colorful: ${(v * 100).toFixed(0)}%`);
      assert(v > 0.3, 'video area shows the test pattern');
      assert(colorfulness(capture(sidebar())) < 0.02, 'nothing drawn over the sidebar');
    });

    await test('the video follows the window when it moves and resizes', async () => {
      main.setBounds({ x: 260, y: 180, width: 820, height: 480 });
      await wait(1200);
      const v = colorfulness(capture(stage()));
      console.log(`       after move+resize, video area colorful: ${(v * 100).toFixed(0)}%`);
      assert(v > 0.3);
      assert(colorfulness(capture(sidebar())) < 0.02, 'still not over the sidebar');
    });

    await test('hiding the video area hides the video (e.g. while a dialog is open)', async () => {
      host.setRect(null);
      await wait(500);
      assert(colorfulness(capture(stage())) < 0.02);
      layout();
      await wait(800);
      assert(colorfulness(capture(stage())) > 0.3, 'and it comes back');
    });
  } finally {
    mpv.kill();
    host.destroy();
    main.destroy();
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    app.exit(failed ? 1 : 0);
  }
});
