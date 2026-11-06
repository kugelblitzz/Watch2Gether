'use strict';

/**
 * Global hotkeys with the input hook faked out: no real key presses are made,
 * events are injected into the fake hook instead.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { Hotkeys } = require('../src/main/hotkeys');

const KEYS = { Escape: 1, Backquote: 41, F9: 67, CapsLock: 58, KeyA: 30 };
function fakeLoader() {
  const hook = new EventEmitter();
  hook.started = 0;
  hook.stopped = 0;
  hook.start = () => { hook.started++; };
  hook.stop = () => { hook.stopped++; };
  const names = Object.fromEntries(Object.entries(KEYS).map(([n, c]) => [c, n]));
  return { hook, keyName: (c) => names[c] || `Key ${c}` };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

(async () => {
  console.log('hotkeys');
  let lib;
  const hk = new Hotkeys({ loadHook: () => (lib = fakeLoader()) });
  const events = [];
  hk.on('action', (a, down) => events.push(`${a}:${down ? 'down' : 'up'}`));
  const key = (code, down) => lib.hook.emit(down ? 'keydown' : 'keyup', { keycode: code });
  const mouse = (button, down) => lib.hook.emit(down ? 'mousedown' : 'mouseup', { button });

  await test('the hook does not run until voice needs it', async () => {
    hk.setBindings({ ptt: { type: 'key', code: KEYS.Backquote, label: '`' } }, false);
    assert.strictEqual(hk.running, false);
    hk.setBindings({}, true);
    assert.strictEqual(hk.running, false, 'in voice but nothing bound');
  });

  await test('push-to-talk reports press and release, ignoring auto-repeat', async () => {
    hk.setBindings({ ptt: { type: 'key', code: KEYS.Backquote, label: '`' } }, true);
    assert.strictEqual(hk.running, true);
    key(KEYS.Backquote, true);
    key(KEYS.Backquote, true); // held: OS auto-repeat
    key(KEYS.Backquote, true);
    key(KEYS.Backquote, false);
    assert.deepStrictEqual(events.splice(0), ['ptt:down', 'ptt:up']);
  });

  await test('unbound keys are never reported', async () => {
    key(KEYS.KeyA, true);
    key(KEYS.KeyA, false);
    mouse(1, true);
    assert.deepStrictEqual(events.splice(0), []);
  });

  await test('mute / deafen toggle once per press; mouse side buttons work', async () => {
    hk.setBindings({ mute: { type: 'key', code: KEYS.F9, label: 'F9' }, deafen: { type: 'mouse', button: 5, label: 'Mouse 5' } }, true);
    key(KEYS.F9, true); key(KEYS.F9, true); key(KEYS.F9, false);
    mouse(5, true); mouse(5, false);
    assert.deepStrictEqual(events.splice(0), ['mute:down', 'deafen:down']);
  });

  await test('left/right click can never be bound', async () => {
    hk.setBindings({ ptt: { type: 'mouse', button: 1, label: 'x' } }, true);
    assert.deepStrictEqual(hk.bindings, {});
    assert.strictEqual(hk.running, false);
  });

  await test('leaving voice releases a held push-to-talk and stops the hook', async () => {
    hk.setBindings({ ptt: { type: 'key', code: KEYS.CapsLock, label: 'Caps Lock' } }, true);
    key(KEYS.CapsLock, true);
    hk.setBindings({ ptt: { type: 'key', code: KEYS.CapsLock, label: 'Caps Lock' } }, false);
    assert.deepStrictEqual(events.splice(0), ['ptt:down', 'ptt:up'], 'no stuck mic');
    assert.strictEqual(hk.running, false);
    key(KEYS.CapsLock, true);
    assert.deepStrictEqual(events.splice(0), [], 'ignored once out of voice');
  });

  await test('capturing a key: ignores left/right clicks, returns the next key, stops the hook again', async () => {
    const p = hk.captureNext();
    assert.strictEqual(hk.running, true, 'hook runs while choosing a key');
    mouse(1, true); mouse(2, true);
    key(KEYS.F9, true);
    assert.deepStrictEqual(await p, { type: 'key', code: KEYS.F9, label: 'F9' });
    assert.strictEqual(hk.running, false);
    assert.deepStrictEqual(events.splice(0), [], 'captured key is not also an action');
  });

  await test('capturing a mouse side button', async () => {
    const p = hk.captureNext();
    mouse(4, true);
    assert.deepStrictEqual(await p, { type: 'mouse', button: 4, label: 'Mouse 4' });
  });

  await test('Escape or cancel aborts capture', async () => {
    const p = hk.captureNext();
    key(KEYS.Escape, true);
    assert.strictEqual(await p, null);
    const q = hk.captureNext();
    hk.cancelCapture();
    assert.strictEqual(await q, null);
    assert.strictEqual(hk.running, false);
  });

  await test('a hook that fails to load reports an error instead of crashing', async () => {
    const bad = new Hotkeys({ loadHook: () => { throw new Error('no native module'); } });
    let err = null;
    bad.on('error', (e) => { err = e; });
    bad.setBindings({ mute: { type: 'key', code: 5, label: 'x' } }, true);
    assert(err && /native/.test(err.message));
    assert.strictEqual(bad.running, false);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
