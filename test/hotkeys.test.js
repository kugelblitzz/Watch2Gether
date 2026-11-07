'use strict';

/**
 * Global hotkeys with the keyboard faked out: "held" keys are a Set the test edits, the
 * way GetAsyncKeyState would report them. No real key presses are made.
 */

const assert = require('assert');
const { Hotkeys, labelFor } = require('../src/main/hotkeys');

const VK = { ESC: 0x1b, BACKQUOTE: 0xc0, F9: 0x78, F24: 0x87, CAPS: 0x14, A: 0x41, MOUSE5: 0x06, LCLICK: 0x01, SHIFT: 0x10, LSHIFT: 0xa0 };

function fakeKeyboard() {
  const held = new Set();
  return { held, isDown: (vk) => held.has(vk), keyName: (vk) => (vk === VK.A ? 'A' : vk === VK.BACKQUOTE ? '`' : '') };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

(async () => {
  console.log('hotkeys');
  const kb = fakeKeyboard();
  const hk = new Hotkeys({ keyboard: kb, pollMs: 5 });
  const events = [];
  hk.on('action', (a, down) => events.push(`${a}:${down ? 'down' : 'up'}`));
  const press = async (vk, ms = 40) => { kb.held.add(vk); await wait(ms); kb.held.delete(vk); await wait(30); };

  await test('nothing is polled until voice needs it', async () => {
    hk.setBindings({ ptt: { vk: VK.BACKQUOTE, label: '`' } }, false);
    assert.strictEqual(hk.running, false);
    hk.setBindings({}, true);
    assert.strictEqual(hk.running, false, 'in voice but nothing bound');
  });

  await test('push-to-talk reports press and release once, however long it is held', async () => {
    hk.setBindings({ ptt: { vk: VK.BACKQUOTE, label: '`' } }, true);
    assert.strictEqual(hk.running, true);
    await press(VK.BACKQUOTE, 120); // many polls while held
    assert.deepStrictEqual(events.splice(0), ['ptt:down', 'ptt:up']);
  });

  await test('unbound keys are ignored', async () => {
    await press(VK.A);
    await press(VK.LCLICK);
    assert.deepStrictEqual(events.splice(0), []);
  });

  await test('mute / deafen toggle once per press; mouse side buttons work', async () => {
    hk.setBindings({ mute: { vk: VK.F9, label: 'F9' }, deafen: { vk: VK.MOUSE5, label: 'Mouse 5' } }, true);
    await press(VK.F9, 80);
    await press(VK.MOUSE5);
    assert.deepStrictEqual(events.splice(0), ['mute:down', 'deafen:down']);
  });

  await test('left / right click and the generic Shift / Ctrl / Alt can never be bound', async () => {
    hk.setBindings({ ptt: { vk: VK.LCLICK, label: 'x' }, mute: { vk: VK.SHIFT, label: 'x' } }, true);
    assert.deepStrictEqual(hk.bindings, {});
  });

  await test('keys from an older version (no vk) are ignored', async () => {
    hk.setBindings({ ptt: { type: 'key', code: 41, label: '`' } }, true);
    assert.deepStrictEqual(hk.bindings, {});
  });

  await test('leaving voice while the key is held releases push-to-talk (no stuck mic) and stops polling', async () => {
    hk.setBindings({ ptt: { vk: VK.CAPS, label: 'Caps Lock' } }, true);
    kb.held.add(VK.CAPS);
    await wait(30);
    hk.setBindings({ ptt: { vk: VK.CAPS, label: 'Caps Lock' } }, false);
    kb.held.delete(VK.CAPS);
    assert.deepStrictEqual(events.splice(0), ['ptt:down', 'ptt:up']);
    assert.strictEqual(hk.running, false);
    await press(VK.CAPS);
    assert.deepStrictEqual(events.splice(0), [], 'ignored out of voice');
  });

  await test('choosing a key: ignores clicks and keys already held, returns the next fresh press', async () => {
    kb.held.add(VK.LSHIFT); // held since before (e.g. part of the shortcut that got here)
    const p = hk.captureNext();
    assert.strictEqual(hk.running, true);
    await wait(30);
    await press(VK.LCLICK); // clicking the box itself
    await press(VK.A);
    assert.deepStrictEqual(await p, { vk: VK.A, label: 'A' });
    kb.held.delete(VK.LSHIFT);
    assert.strictEqual(hk.running, false, 'polling stops again (out of voice)');
    assert.deepStrictEqual(events.splice(0), [], 'choosing a key is not also an action');
  });

  await test('a key held since before counts once released and pressed again', async () => {
    kb.held.add(VK.F24);
    const p = hk.captureNext();
    await wait(30);
    kb.held.delete(VK.F24);
    await wait(20);
    await press(VK.F24);
    assert.deepStrictEqual(await p, { vk: VK.F24, label: 'F24' });
  });

  await test('Escape or cancel aborts choosing', async () => {
    const p = hk.captureNext();
    await wait(20);
    await press(VK.ESC);
    assert.strictEqual(await p, null);
    const q = hk.captureNext();
    hk.cancelCapture();
    assert.strictEqual(await q, null);
    assert.strictEqual(hk.running, false);
  });

  await test('polling can stop and start again any number of times (unlike the old hook)', async () => {
    for (let i = 0; i < 5; i++) {
      hk.setBindings({ ptt: { vk: VK.F9, label: 'F9' } }, true);
      await press(VK.F9);
      hk.stop();
    }
    assert.deepStrictEqual(events.splice(0), Array(5).fill(['ptt:down', 'ptt:up']).flat());
  });

  await test('friendly names, including the ones Windows gets wrong', async () => {
    assert.strictEqual(labelFor(0x25, kb), 'Left'); // Windows says "Num 4"
    assert.strictEqual(labelFor(0x87, kb), 'F24');  // Windows says nothing
    assert.strictEqual(labelFor(0x05, kb), 'Mouse 4');
    assert.strictEqual(labelFor(0xa2, kb), 'Left Ctrl');
    assert.strictEqual(labelFor(0xc0, kb), '`');
  });

  await test('without a usable keyboard API it reports an error instead of crashing', async () => {
    const bad = new Hotkeys({ keyboard: null });
    bad.kbFactory = () => { throw new Error('no koffi'); };
    let err = null;
    bad.on('error', (e) => { err = e; });
    bad.setBindings({ mute: { vk: VK.F9, label: 'F9' } }, true);
    assert(err && /koffi/.test(err.message));
    assert.strictEqual(bad.running, false);
  });

  hk.shutdown();
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
