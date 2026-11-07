'use strict';

/**
 * Global hotkeys against the REAL Windows keyboard state, inside Electron, replaying what
 * the app does: choose a key, use it as push-to-talk, leave / rejoin voice, rebind, again
 * and again. Keys are pressed with keybd_event using F23 / F24 only, which no normal
 * keyboard has and apps ignore, so nothing on screen reacts.
 * Run: npm run test:hotkeys-real
 */

const { app } = require('electron');
const assert = require('assert');
const koffi = require('koffi');
const { Hotkeys } = require('../../src/main/hotkeys');

process.on('uncaughtException', (e) => {
  console.error('  harness error:', e && e.stack);
  process.exitCode = 1;
});

const user32 = koffi.load('user32.dll');
const keybdEvent = user32.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)');
const KEYUP = 2;
const F23 = 0x86;
const F24 = 0x87;

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
  const hk = new Hotkeys();
  const events = [];
  hk.on('action', (a, down) => events.push(`${a}:${down ? 'down' : 'up'}`));
  hk.on('error', (e) => events.push('error:' + e.message));
  const press = async (vk, ms = 150) => {
    keybdEvent(vk, 0, 0, 0);
    await wait(ms);
    keybdEvent(vk, 0, KEYUP, 0);
    await wait(120);
  };
  const choose = async (vk) => {
    const p = hk.captureNext();
    await wait(80);
    await press(vk, 80);
    return Promise.race([p, wait(2000).then(() => 'TIMEOUT')]);
  };

  console.log('hotkeys (real Windows keyboard state)');
  try {
    await test('choose a key, then it works as push-to-talk; repeated rebind / leave / rejoin cycles', async () => {
      for (let round = 1; round <= 4; round++) {
        const vk = round % 2 ? F24 : F23;
        hk.setBindings({}, true); // in voice, nothing bound yet
        const b = await choose(vk);
        assert.notStrictEqual(b, 'TIMEOUT', `round ${round}: choosing a key timed out`);
        assert.strictEqual(b.vk, vk);
        assert.strictEqual(b.label, vk === F24 ? 'F24' : 'F23');
        hk.setBindings({ ptt: b }, true);
        events.length = 0;
        await press(vk);
        assert.deepStrictEqual(events, ['ptt:down', 'ptt:up'], `round ${round}: push-to-talk after choosing`);
        hk.setBindings({ ptt: b }, false); // leave voice
        events.length = 0;
        await press(vk);
        assert.deepStrictEqual(events, [], `round ${round}: ignored out of voice`);
        hk.stop(); // leave the lobby
      }
    });

    await test('cancelled choices do not break it', async () => {
      for (let i = 0; i < 3; i++) {
        const p = hk.captureNext();
        await wait(30);
        hk.cancelCapture();
        assert.strictEqual(await p, null);
      }
      hk.setBindings({ mute: { vk: F23, label: 'F23' } }, true);
      events.length = 0;
      await press(F23);
      assert.deepStrictEqual(events, ['mute:down']);
    });
  } finally {
    hk.shutdown();
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    app.exit(failed || process.exitCode ? 1 : 0);
  }
});
