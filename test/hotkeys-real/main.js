'use strict';

/**
 * Global hotkeys with the REAL native hook (uiohook-napi) inside Electron, replaying
 * what the app does: choose a key, use it as push-to-talk, leave/rejoin voice, rebind,
 * over and over. Keys are sent with uiohook's keyToggle using F23/F24, which no normal
 * keyboard has and apps ignore, so nothing on screen reacts.
 * Run: npm run test:hotkeys-real
 */

const { app } = require('electron');
const assert = require('assert');
const { Hotkeys } = require('../../src/main/hotkeys');

process.on('uncaughtException', (e) => {
  console.error('  harness error:', e && e.stack);
  process.exitCode = 1;
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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

app.whenReady().then(async () => {
  const { uIOhook, UiohookKey } = require('uiohook-napi');
  const hk = new Hotkeys();
  const events = [];
  hk.on('action', (a, down) => events.push(`${a}:${down ? 'down' : 'up'}`));
  hk.on('error', (e) => events.push('error:' + e.message));
  const press = async (code, ms = 120) => {
    uIOhook.keyToggle(code, 'down');
    await wait(ms);
    uIOhook.keyToggle(code, 'up');
    await wait(150);
  };
  const choose = async (code) => {
    const p = hk.captureNext();
    await wait(150);
    uIOhook.keyTap(code);
    return Promise.race([p, wait(2000).then(() => 'TIMEOUT')]);
  };

  console.log('hotkeys (real native hook)');
  try {
    await test('choose a key, then it works as push-to-talk; repeated rebind / leave / rejoin cycles', async () => {
      for (let round = 1; round <= 4; round++) {
        const code = round % 2 ? UiohookKey.F24 : UiohookKey.F23;
        hk.setBindings({}, true); // in voice, nothing bound yet
        const b = await choose(code);
        assert.notStrictEqual(b, 'TIMEOUT', `round ${round}: key capture timed out (hook dead)`);
        assert.strictEqual(b.code, code);
        hk.setBindings({ ptt: b }, true); // the app saves the key right after (inside the same tick)
        events.length = 0;
        await press(code);
        assert.deepStrictEqual(events, ['ptt:down', 'ptt:up'], `round ${round}: push-to-talk after choosing`);
        hk.setBindings({ ptt: b }, false); // leave voice
        events.length = 0;
        await press(code);
        assert.deepStrictEqual(events, [], `round ${round}: ignored out of voice`);
        hk.stop(); // leave the lobby
      }
    });

    await test('cancelled captures do not break it', async () => {
      for (let i = 0; i < 3; i++) {
        const p = hk.captureNext();
        await wait(50);
        hk.cancelCapture();
        assert.strictEqual(await p, null);
      }
      hk.setBindings({ mute: { type: 'key', code: UiohookKey.F23, label: 'F23' } }, true);
      events.length = 0;
      await press(UiohookKey.F23);
      assert.deepStrictEqual(events, ['mute:down']);
    });
  } finally {
    hk.shutdown();
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    app.exit(failed || process.exitCode ? 1 : 0);
  }
});
