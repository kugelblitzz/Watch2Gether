'use strict';

/**
 * Global hotkeys for voice chat (push-to-talk, toggle mute, toggle deafen) that work
 * while another window (e.g. the fullscreen player) has focus.
 *
 * How: every 20 ms, ask Windows whether the bound key is held (GetAsyncKeyState, via
 * koffi). That's all. No input hook: the low-level hook used before (uiohook-napi)
 * kept ending up silently dead in the installed app (no events, no error) in ways that
 * never reproduced anywhere else, so push-to-talk and key assignment broke.
 *
 * Privacy: only the bound keys are looked at; while you choose a key in settings, all
 * keys are checked for a fresh press until one is picked. Nothing else is read.
 *
 * Binding: { vk: <Windows virtual-key code>, label }. Mouse middle / side buttons are
 * virtual keys too (4, 5, 6). Left / right click can't be bound.
 */

const { EventEmitter } = require('events');

const POLL_MS = 20;
const ACTIONS = ['ptt', 'mute', 'deafen'];
const VK_ESCAPE = 0x1b;
const NOT_BINDABLE = new Set([0x01, 0x02, 0x10, 0x11, 0x12]); // clicks; generic Shift/Ctrl/Alt (left/right ones are)

/** Names Windows gets wrong or leaves empty (navigation keys come back as numpad ones). */
const NAMES = {
  0x04: 'Middle mouse', 0x05: 'Mouse 4', 0x06: 'Mouse 5',
  0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x13: 'Pause', 0x14: 'Caps Lock', 0x1b: 'Esc', 0x20: 'Space',
  0x21: 'Page Up', 0x22: 'Page Down', 0x23: 'End', 0x24: 'Home',
  0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down',
  0x2c: 'Print Screen', 0x2d: 'Insert', 0x2e: 'Delete',
  0x5b: 'Left Win', 0x5c: 'Right Win', 0x5d: 'Menu',
  0x90: 'Num Lock', 0x91: 'Scroll Lock',
  0xa0: 'Left Shift', 0xa1: 'Right Shift', 0xa2: 'Left Ctrl', 0xa3: 'Right Ctrl', 0xa4: 'Left Alt', 0xa5: 'Right Alt',
};
for (let i = 1; i <= 24; i++) NAMES[0x6f + i] = 'F' + i; // F1 = 0x70 ... F24 = 0x87

/** The real keyboard, through user32 (Windows). Tests pass a fake one. */
function defaultKeyboard() {
  if (process.platform !== 'win32') throw new Error('Global hotkeys are only supported on Windows');
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  const GetAsyncKeyState = u.func('short __stdcall GetAsyncKeyState(int vk)');
  const MapVirtualKeyW = u.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t type)');
  const GetKeyNameTextW = u.func('int __stdcall GetKeyNameTextW(long lparam, _Out_ uint8_t *buf, int size)');
  return {
    isDown: (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0,
    keyName: (vk) => {
      const sc = MapVirtualKeyW(vk, 0); // MAPVK_VK_TO_VSC
      if (!sc) return '';
      const buf = Buffer.alloc(128);
      const n = GetKeyNameTextW(sc << 16, buf, 64);
      return buf.toString('utf16le', 0, n * 2);
    },
  };
}

function labelFor(vk, kb) {
  if (NAMES[vk]) return NAMES[vk];
  let name = '';
  try { name = kb.keyName(vk); } catch { /* fall through */ }
  return name || `Key ${vk}`;
}

function valid(b) {
  return !!b && Number.isInteger(b.vk) && b.vk > 0 && b.vk < 0xff && !NOT_BINDABLE.has(b.vk);
}

class Hotkeys extends EventEmitter {
  constructor({ keyboard = null, pollMs = POLL_MS } = {}) {
    super();
    this.kbFactory = keyboard ? () => keyboard : defaultKeyboard;
    this.kb = null;
    this.pollMs = pollMs;
    this.timer = null;
    this.bindings = {};
    this.enabled = false;
    this.held = new Set(); // actions whose key is down right now
    this.capture = null;   // { resolve, wasDown: Set } while choosing a key
  }

  /** True while polling (in voice with something bound, or choosing a key). */
  get running() {
    return !!this.timer;
  }

  /** @param bindings { ptt?, mute?, deafen? }  @param enabled  true while in voice */
  setBindings(bindings, enabled) {
    this.bindings = {};
    for (const a of ACTIONS) if (bindings && valid(bindings[a])) this.bindings[a] = bindings[a];
    this.enabled = !!enabled;
    if (!this.enabled) this._releaseAll();
    // a binding that changed while its key was held must not stay "held"
    for (const a of [...this.held]) if (!this.bindings[a]) this._release(a);
    this._sync();
  }

  /** Wait for the next fresh key / mouse-button press. Resolves null on Escape or cancel. */
  captureNext() {
    if (this.capture) this.capture.resolve(null);
    return new Promise((resolve) => {
      // keys already down when choosing starts (e.g. the shortcut that opened it) don't count
      const wasDown = new Set();
      if (this._keyboard()) for (let vk = 1; vk < 0xff; vk++) if (this._down(vk)) wasDown.add(vk);
      this.capture = { resolve, wasDown };
      this._sync();
    });
  }

  cancelCapture() {
    if (!this.capture) return;
    this.capture.resolve(null);
    this.capture = null;
    this._sync();
  }

  /** Out of voice: release everything and stop polling. */
  stop() {
    this.enabled = false;
    this._releaseAll();
    this.cancelCapture();
    this._sync();
  }

  /** App is quitting. */
  shutdown() {
    this.stop();
  }

  // ---------- internals ----------

  _keyboard() {
    if (this.kb) return this.kb;
    try {
      this.kb = this.kbFactory();
    } catch (e) {
      this.emit('error', e);
      this.kb = null;
    }
    return this.kb;
  }

  _down(vk) {
    try { return this.kb.isDown(vk); } catch { return false; }
  }

  _wanted() {
    return !!this.capture || (this.enabled && Object.keys(this.bindings).length > 0);
  }

  _sync() {
    const want = this._wanted() && !!this._keyboard();
    if (want && !this.timer) {
      this.timer = setInterval(() => this._tick(), this.pollMs);
      if (this.timer.unref) this.timer.unref();
    } else if (!want && this.timer) {
      clearInterval(this.timer); // polling (unlike a hook) is safe to stop and start again
      this.timer = null;
    }
  }

  _tick() {
    if (this.capture) return this._captureTick();
    if (!this.enabled) return;
    for (const [action, b] of Object.entries(this.bindings)) {
      const down = this._down(b.vk);
      if (down && !this.held.has(action)) {
        this.held.add(action);
        this.emit('action', action, true);
      } else if (!down && this.held.has(action)) {
        this._release(action);
      }
    }
  }

  _captureTick() {
    const c = this.capture;
    for (let vk = 1; vk < 0xff; vk++) {
      const down = this._down(vk);
      if (!down) {
        c.wasDown.delete(vk); // released: a new press of it counts now
        continue;
      }
      if (c.wasDown.has(vk) || NOT_BINDABLE.has(vk)) continue;
      this.capture = null;
      c.resolve(vk === VK_ESCAPE ? null : { vk, label: labelFor(vk, this.kb) });
      // wait for this key's release before it can act as a binding (it was just chosen)
      for (const [action, b] of Object.entries(this.bindings)) if (b.vk === vk) this.held.add(action);
      this._sync();
      return;
    }
  }

  _release(action) {
    if (!this.held.has(action)) return;
    this.held.delete(action);
    if (action === 'ptt') this.emit('action', 'ptt', false); // mute / deafen toggle on press only
  }

  _releaseAll() {
    for (const a of [...this.held]) this._release(a);
  }
}

module.exports = { Hotkeys, labelFor, NAMES };
