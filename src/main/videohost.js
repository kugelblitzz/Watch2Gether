'use strict';

/**
 * VideoHost: a native window that mpv draws into (mpv --wid), kept exactly over
 * the video area of the main window, so the movie plays inside the app.
 *
 * It's an Electron BaseWindow (no web content) owned by the main window, so it
 * moves/minimizes with it and stays above it. Chromium still gives every window
 * its own compositor child ("Intermediate D3D Window"), which would paint over
 * mpv's video; that child is hidden via a tiny Win32 call (koffi, no compiling).
 * Chromium re-shows it shortly after the window appears or changes size, so it is
 * hidden again as things settle and checked every couple of seconds while visible.
 */

const { BaseWindow, screen } = require('electron');

/** Hide the mouse pointer after this long without movement over the video. */
const CURSOR_IDLE_MS = 2000;
const CURSOR_POLL_MS = 100;

let win32 = null;
function user32() {
  if (win32 || process.platform !== 'win32') return win32;
  const koffi = require('koffi');
  const lib = koffi.load('user32.dll');
  const EnumProc = koffi.proto('bool __stdcall W2GEnumProc(intptr_t hwnd, intptr_t lparam)');
  win32 = {
    koffi,
    EnumProc,
    EnumChildWindows: lib.func('bool __stdcall EnumChildWindows(intptr_t parent, W2GEnumProc *cb, intptr_t lparam)'),
    GetClassNameW: lib.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint8_t *buf, int maxChars)'),
    ShowWindow: lib.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
    // Cursor visibility for the calling (UI) thread. mpv's window is a child of ours, so the
    // two share input state and this hides the pointer over the video too. (mpv can't do it
    // itself when embedded: the parent window keeps resetting the cursor to an arrow.)
    ShowCursor: lib.func('int __stdcall ShowCursor(bool show)'),
  };
  return win32;
}

/** Child windows of a native window: [{ hwnd, cls }]. */
function childWindows(parent) {
  const w = user32();
  if (!w) return [];
  const out = [];
  const cb = w.koffi.register((hwnd) => {
    const buf = Buffer.alloc(512);
    const n = w.GetClassNameW(hwnd, buf, 256);
    out.push({ hwnd, cls: buf.toString('utf16le', 0, n * 2) });
    return true;
  }, w.koffi.pointer(w.EnumProc));
  try {
    w.EnumChildWindows(parent, cb, 0);
  } finally {
    w.koffi.unregister(cb);
  }
  return out;
}

class VideoHost {
  /** @param owner the main BrowserWindow */
  constructor(owner) {
    this.owner = owner;
    this.rect = null; // video area in the owner's content, CSS px (= DIP)
    this.win = new BaseWindow({
      parent: owner,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      backgroundColor: '#000000',
    });
    this.hwnd = this.win.getNativeWindowHandle().readBigUInt64LE(0);
    const follow = () => this._place();
    for (const ev of ['move', 'moved', 'resize', 'resized', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'restore']) owner.on(ev, follow);
    owner.on('minimize', () => this.win.hide());
    owner.on('closed', () => this.destroy());
    this.settleTimers = [];
    this.watchdog = setInterval(() => {
      if (!this.win.isDestroyed() && this.win.isVisible()) this._hideCompositor();
    }, 2000);
    this.watchdog.unref();

    // Auto-hide the mouse pointer over the video when it hasn't moved for a while.
    this.cursorHidden = false;
    this.lastPoint = null;
    this.lastMove = Date.now();
    this.cursorTimer = setInterval(() => this._cursorTick(), CURSOR_POLL_MS);
    this.cursorTimer.unref();
  }

  _cursorTick() {
    if (this.win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const moved = !this.lastPoint || p.x !== this.lastPoint.x || p.y !== this.lastPoint.y;
    this.lastPoint = p;
    if (moved) this.lastMove = Date.now();
    let over = false;
    if (this.win.isVisible()) {
      const b = this.win.getBounds();
      over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    }
    this._setCursorHidden(over && !moved && Date.now() - this.lastMove >= CURSOR_IDLE_MS);
  }

  /** Hide / show exactly once each way, so the pointer can never get stuck hidden. */
  _setCursorHidden(hide) {
    if (hide === this.cursorHidden) return;
    const w = user32();
    if (!w) return;
    try {
      w.ShowCursor(!hide);
      this.cursorHidden = hide;
    } catch (e) {
      console.error('[videohost] cursor', e && e.message);
    }
  }

  /** Value for mpv's --wid. */
  get wid() {
    return this.hwnd.toString();
  }

  /** Show over this rect of the main window's content, or hide (null). */
  setRect(rect) {
    this.rect = rect && rect.width > 1 && rect.height > 1 ? rect : null;
    this._place();
  }

  _place() {
    if (this.win.isDestroyed()) return;
    if (!this.rect || this.owner.isMinimized() || !this.owner.isVisible()) {
      if (this.win.isVisible()) this.win.hide();
      return;
    }
    const c = this.owner.getContentBounds();
    this.win.setBounds({
      x: Math.round(c.x + this.rect.x),
      y: Math.round(c.y + this.rect.y),
      width: Math.round(this.rect.width),
      height: Math.round(this.rect.height),
    });
    if (!this.win.isVisible()) this.win.showInactive();
    this._hideSoon();
  }

  /** Hide the compositor now and a few more times as Chromium settles. */
  _hideSoon() {
    for (const t of this.settleTimers) clearTimeout(t);
    this._hideCompositor();
    this.settleTimers = [60, 250, 700, 1500].map((ms) => setTimeout(() => this._hideCompositor(), ms));
  }

  /** Hide Chromium's compositor child so mpv's own child window is what you see. */
  _hideCompositor() {
    try {
      for (const c of childWindows(this.hwnd)) {
        if (c.cls === 'Intermediate D3D Window') user32().ShowWindow(c.hwnd, 0);
      }
    } catch (e) {
      console.error('[videohost]', e && e.message);
    }
  }

  destroy() {
    clearInterval(this.cursorTimer);
    this._setCursorHidden(false);
    clearInterval(this.watchdog);
    for (const t of this.settleTimers) clearTimeout(t);
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { VideoHost, childWindows };
