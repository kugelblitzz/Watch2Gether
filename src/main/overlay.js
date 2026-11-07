'use strict';

/**
 * Fullscreen play bar. HTML can't be drawn over the native video, so in fullscreen the
 * controls live in their own small transparent window that floats over the bottom of the
 * video (owned by the main window, never takes focus). It shows when the mouse moves,
 * while the sidebar is out or the movie is paused, and hides after a few still seconds
 * (unless the pointer rests on it).
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
    this.active = false;   // app is fullscreen with the in-app player
    this.keep = false;     // sidebar out, or paused: stay visible
    this.lastMove = 0;
    this.lastPoint = null;
    this.win = new BrowserWindow({
      parent: owner,
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
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    owner.on('closed', () => this.destroy());
  }

  /** Fullscreen with the in-app player on / off. */
  setActive(on) {
    this.active = !!on;
    this.lastMove = Date.now(); // entering fullscreen counts as activity: show it briefly
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

  /** Is the pointer over the bar right now? (the pointer doesn't auto-hide there) */
  contains(p) {
    if (this.win.isDestroyed() || !this.win.isVisible()) return false;
    const b = this.win.getBounds();
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  /** Forward state (play position, volume, ...) to the bar. */
  send(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  _update() {
    if (this.win.isDestroyed()) return;
    const host = this.videoHost;
    const rect = host && host.rect;
    const recent = Date.now() - this.lastMove < HIDE_AFTER_MS;
    const hovered = this.lastPoint && this.contains(this.lastPoint);
    const show = this.active && !!rect && host.win.isVisible() && (recent || this.keep || hovered);
    if (!show) {
      if (this.win.isVisible()) this.win.hide();
      return;
    }
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
    if (!this.win.isVisible()) {
      this.win.showInactive();
      this.win.moveTop(); // above the video window
    }
  }

  destroy() {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { ControlsOverlay };
