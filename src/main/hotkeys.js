'use strict';

/**
 * Global hotkeys for voice chat (push-to-talk, toggle mute, toggle deafen) that
 * work while another window (e.g. the fullscreen player) has focus.
 *
 * Electron's globalShortcut only reports key *presses*, and push-to-talk needs
 * the release too, so this uses a low-level input hook (uiohook-napi).
 * Privacy: the hook starts the first time voice needs it, and only bound keys (or the
 * one key being chosen in settings) are ever reported to the window; everything else
 * is dropped right here.
 *
 * The native hook is started once and then left running until the app quits.
 * Stopping and restarting it (e.g. stopping inside a key event when a key was just
 * chosen, then starting again to watch the new key) left it silently dead in the
 * installed app (v0.5.0): no events, no error. Whether input does anything is
 * decided here instead (`enabled`, `capture`).
 *
 * Binding: { type: 'key', code: <uiohook keycode>, label } | { type: 'mouse', button: 3..5, label }
 */

const { EventEmitter } = require('events');

/** Mouse buttons that may be bound: middle and the two side buttons, never left/right click. */
const BINDABLE_MOUSE = new Set([3, 4, 5]);
const MOUSE_LABELS = { 3: 'Middle mouse', 4: 'Mouse 4', 5: 'Mouse 5' };
const ACTIONS = ['ptt', 'mute', 'deafen'];

function defaultLoadHook() {
  const { uIOhook, UiohookKey } = require('uiohook-napi');
  const names = {};
  for (const [name, code] of Object.entries(UiohookKey)) if (names[code] == null) names[code] = name;
  return { hook: uIOhook, keyName: (code) => names[code] || `Key ${code}` };
}

function prettyKey(name) {
  const map = { Backquote: '`', Ctrl: 'Left Ctrl', CtrlRight: 'Right Ctrl', Alt: 'Left Alt', AltRight: 'Right Alt', Shift: 'Left Shift', ShiftRight: 'Right Shift', Meta: 'Win', CapsLock: 'Caps Lock' };
  return map[name] || name.replace(/^Numpad/, 'Num ');
}

class Hotkeys extends EventEmitter {
  constructor({ loadHook = defaultLoadHook } = {}) {
    super();
    this.loadHook = loadHook;
    this.lib = null;
    this.running = false;
    this.bindings = {};
    this.enabled = false;
    this.held = new Set(); // actions whose input is currently down (suppresses auto-repeat)
    this.capture = null;   // pending capture { resolve }
  }

  /** @param bindings { ptt?, mute?, deafen? }  @param enabled  true while in voice */
  setBindings(bindings, enabled) {
    this.bindings = {};
    for (const a of ACTIONS) if (bindings && valid(bindings[a])) this.bindings[a] = bindings[a];
    this.enabled = !!enabled;
    this._sync();
  }

  /** Wait for the next key or bindable mouse button. Resolves null on Escape or cancel. */
  captureNext() {
    if (this.capture) this.capture.resolve(null);
    return new Promise((resolve) => {
      this.capture = { resolve };
      this._sync();
    });
  }

  cancelCapture() {
    if (this.capture) {
      this.capture.resolve(null);
      this.capture = null;
      this._sync();
    }
  }

  /** Out of voice: ignore everything (the native hook stays up; see above). */
  stop() {
    this.enabled = false;
    this.cancelCapture();
    this._sync();
  }

  /** App is quitting: remove the native hook. */
  shutdown() {
    this.stop();
    if (this.running) this._stopHook();
  }

  // ---------- internals ----------

  _wanted() {
    return !!this.capture || (this.enabled && Object.keys(this.bindings).length > 0);
  }

  _sync() {
    if (this._wanted() && !this.running) this._start();
    if (!this.enabled) this._releaseAll();
  }

  _start() {
    try {
      if (!this.lib) {
        this.lib = this.loadHook();
        const h = this.lib.hook;
        h.on('keydown', (e) => this._input({ type: 'key', code: e.keycode }, true));
        h.on('keyup', (e) => this._input({ type: 'key', code: e.keycode }, false));
        h.on('mousedown', (e) => this._input({ type: 'mouse', button: e.button }, true));
        h.on('mouseup', (e) => this._input({ type: 'mouse', button: e.button }, false));
      }
      this.lib.hook.start();
      this.running = true;
    } catch (e) {
      this.running = false;
      this.emit('error', e);
    }
  }

  _stopHook() {
    try { this.lib.hook.stop(); } catch { /* ignore */ }
    this.running = false;
  }

  _releaseAll() {
    for (const a of this.held) if (a === 'ptt') this.emit('action', 'ptt', false);
    this.held.clear();
  }

  _input(inp, down) {
    if (this.capture) {
      if (!down) return;
      if (inp.type === 'mouse' && !BINDABLE_MOUSE.has(inp.button)) return; // ignore clicks while choosing
      const { resolve } = this.capture;
      this.capture = null;
      const escape = inp.type === 'key' && this.lib && this.lib.keyName(inp.code) === 'Escape';
      resolve(escape ? null : this._describe(inp));
      this._sync();
      return;
    }
    if (!this.enabled) return;
    for (const [action, b] of Object.entries(this.bindings)) {
      if (!same(b, inp)) continue;
      if (down) {
        if (this.held.has(action)) continue; // key auto-repeat
        this.held.add(action);
        this.emit('action', action, true);
      } else if (this.held.has(action)) {
        this.held.delete(action);
        if (action === 'ptt') this.emit('action', action, false);
      }
    }
  }

  _describe(inp) {
    if (inp.type === 'mouse') return { type: 'mouse', button: inp.button, label: MOUSE_LABELS[inp.button] };
    return { type: 'key', code: inp.code, label: prettyKey(this.lib.keyName(inp.code)) };
  }
}

function valid(b) {
  return !!b && ((b.type === 'key' && Number.isInteger(b.code)) || (b.type === 'mouse' && BINDABLE_MOUSE.has(b.button)));
}

function same(b, inp) {
  return b.type === inp.type && (b.type === 'key' ? b.code === inp.code : b.button === inp.button);
}

module.exports = { Hotkeys };
