'use strict';

/**
 * Fullscreen play bar. HTML can't be drawn over the native video, so in fullscreen the
 * controls live in their own small transparent window that floats over the bottom of the
 * video (owned by the main window, never takes focus). It appears when the mouse moves,
 * while the sidebar is out or the movie is paused, and fades after a few still seconds
 * (unless the pointer rests on it).
 *
 * The window is never hidden and shown again: after a hide() / show() a non-focusable
 * Electron window stops receiving mouse clicks (0 of 3 after a few cycles, measured), which
 * made every button on the bar dead in v0.9.0. Instead, "hidden" = fully transparent and
 * click-through, "shown" = opaque and clickable; the window itself is created on entering
 * fullscreen and destroyed on leaving it.
 */

const path = require('path');
const { BrowserWindow } = require('electron');

const HIDE_AFTER_MS = 2500;
const BAR_HEIGHT = 84;
const MARGIN = 24;
const MAX_WIDTH = 1100;

class ControlsOverlay {
  /** @param owner main BrowserWindow  @param videoHost the VideoHost (knows where the video is) */
  constructor(owner, videoHost) {
    this.owner = owner;
    this.videoHost = videoHost;
    this.win = null;         // exists only while fullscreen
    this.ready = false;      // page loaded and window shown (invisibly)
    this.shown = false;      // opaque and clickable right now
    this.active = false;     // fullscreen with the in-app player
    this.keep = false;       // sidebar out, or paused: stay visible
    this.lastMove = 0;
    this.lastPoint = null;
    this.lastUpdate = null;  // latest lobby update, for a freshly created bar
    owner.on('closed', () => this.destroy());
  }

  /** Fullscreen with the in-app player on / off. */
  setActive(on) {
    this.active = !!on;
    if (this.active) {
      this.lastMove = Date.now(); // entering fullscreen counts as activity: show it briefly
      this._create();
    } else {
      this.destroy();
    }
    this._update();
  }

  /** The video area moved or resized (e.g. the sidebar slid in): follow it. */
  refresh() {
    this._update();
  }

  /** Sidebar out or movie paused: keep the bar up. */
  setKeep(on) {
    if (this.keep === !!on) return;
    this.keep = !!on;
    this._update();
  }

  /** Called with the cursor position while fullscreen (from the main process' poll). */
  onCursor(p) {
    const moved = !this.lastPoint || p.x !== this.lastPoint.x || p.y !== this.lastPoint.y;
    this.lastPoint = p;
    if (moved) this.lastMove = Date.now();
    this._update();
  }

  /** Is the pointer over the visible bar? (the pointer doesn't auto-hide there) */
  contains(p) {
    if (!this.win || this.win.isDestroyed() || !this.shown) return false;
    const b = this.win.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  /** Forward state (play position, volume, ...) to the bar. */
  send(channel, payload) {
    if (channel === 'update') this.lastUpdate = payload;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  _create() {
    if (this.win && !this.win.isDestroyed()) return;
    this.ready = false;
    this.shown = false;
    const win = new BrowserWindow({
      parent: this.owner,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false, // clicks work, but the video / app keep the keyboard
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win = win;
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      if (this.lastUpdate) win.webContents.send('update', this.lastUpdate); // no stale times
      // shown once, invisible and click-through; from now on only faded in / out
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      this._place();
      win.showInactive();
      this.ready = true;
      this._update();
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  }

  _update() {
    if (!this.win || this.win.isDestroyed() || !this.ready) return;
    const host = this.videoHost;
    const rect = host && host.rect;
    const recent = Date.now() - this.lastMove < HIDE_AFTER_MS;
    const hovered = this.lastPoint && this.contains(this.lastPoint);
    const want = this.active && !!rect && host.win.isVisible() && (recent || this.keep || hovered);
    if (want) this._place();
    if (want === this.shown) return;
    this.shown = want;
    this.win.setOpacity(want ? 1 : 0);
    this.win.setIgnoreMouseEvents(!want); // invisible = clicks go through to the video
    if (want) this.win.moveTop(); // above the video window
  }

  /** Over the bottom of the video, centred. Only moves it when the position changed. */
  _place() {
    const rect = this.videoHost && this.videoHost.rect;
    if (!rect) return;
    const c = this.owner.getContentBounds();
    const width = Math.min(MAX_WIDTH, Math.round(rect.width - 2 * MARGIN));
    const bounds = {
      x: Math.round(c.x + rect.x + (rect.width - width) / 2),
      y: Math.round(c.y + rect.y + rect.height - BAR_HEIGHT - MARGIN),
      width,
      height: BAR_HEIGHT,
    };
    const now = this.win.getBounds();
    if (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height) {
      this.win.setBounds(bounds); // only when it moved: this runs on every 40 ms cursor poll
    }
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
    this.shown = false;
  }
}

module.exports = { ControlsOverlay };
