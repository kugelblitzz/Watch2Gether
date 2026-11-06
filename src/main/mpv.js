'use strict';

/**
 * Thin wrapper around an mpv process controlled via its JSON IPC named pipe.
 * Emits:
 *   'property' (name, value)   for observed properties
 *   'event'    (msg)           for mpv events (seek, playback-restart, file-loaded, end-file, ...)
 *   'exit'     (code)          when the player window is closed / process ends
 */

const { spawn } = require('child_process');
const net = require('net');
const { EventEmitter } = require('events');

class Mpv extends EventEmitter {
  constructor(exe) {
    super();
    this.exe = exe;
    this.reqId = 0;
    this.obsId = 0;
    this.pending = new Map();
    this.buf = '';
    this.sock = null;
    this.proc = null;
    this.exited = false;
  }

  async start({ title = 'Watch2Gether' } = {}) {
    this.pipe = `\\\\.\\pipe\\w2g-mpv-${process.pid}-${Date.now().toString(36)}`;
    const args = [
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=yes',
      // At the end, stay on the last frame without toggling pause; the room clock decides.
      '--keep-open-pause=no',
      '--input-ipc-server=' + this.pipe,
      '--hwdec=auto-safe',
      // Big read-ahead so 4K over the network survives hiccups.
      '--cache=yes',
      '--demuxer-max-bytes=1024MiB',
      '--demuxer-max-back-bytes=256MiB',
      '--demuxer-readahead-secs=300',
      '--cache-pause-wait=2',
      '--network-timeout=60',
      '--save-position-on-quit=no',
      '--resume-playback=no',
      '--title=' + title + ' - ${media-title}',
      '--no-terminal',
    ];
    this.proc = spawn(this.exe, args, { stdio: 'ignore', windowsHide: false });
    this.proc.on('error', (err) => {
      this.exited = true;
      this.startError = err;
    });
    this.proc.on('exit', (code) => {
      this.exited = true;
      this._failAll(new Error('Player closed'));
      this.emit('exit', code);
    });
    await this._connectPipe();
  }

  _connectPipe() {
    const deadline = Date.now() + 15000;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this.exited) {
          reject(new Error(this.startError ? `Could not start mpv: ${this.startError.message}` : 'mpv exited during startup'));
          return;
        }
        const sock = net.connect(this.pipe);
        sock.once('connect', () => {
          this.sock = sock;
          sock.setEncoding('utf8');
          sock.on('data', (d) => this._onData(d));
          sock.on('error', () => { /* close follows */ });
          sock.on('close', () => { this.sock = null; });
          resolve();
        });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() > deadline) reject(new Error('Could not connect to the mpv player'));
          else setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const p = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        if (msg.error === 'success') p.resolve(msg.data);
        else p.reject(new Error(msg.error));
      } else if (msg.event === 'property-change') {
        this.emit('property', msg.name, msg.data);
      } else if (msg.event) {
        this.emit('event', msg);
      }
    }
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  command(...args) {
    if (!this.sock) return Promise.reject(new Error('Player not running'));
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('mpv did not respond'));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.sock.write(JSON.stringify({ command: args, request_id: id }) + '\n');
    });
  }

  get(prop) { return this.command('get_property', prop); }
  set(prop, value) { return this.command('set_property', prop, value); }
  observe(prop) { return this.command('observe_property', ++this.obsId, prop); }

  quit() {
    if (this.exited) return;
    try { if (this.sock) this.sock.write(JSON.stringify({ command: ['quit'] }) + '\n'); } catch { /* ignore */ }
    setTimeout(() => {
      if (!this.exited && this.proc) {
        try { this.proc.kill(); } catch { /* ignore */ }
      }
    }, 1500);
  }
}

module.exports = { Mpv };
