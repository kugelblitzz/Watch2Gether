'use strict';

/**
 * HostServer — runs on the host's PC.
 *  - GET  /media/<id>?k=CODE   serves the chosen file with HTTP range support (no transcoding)
 *  - GET  /info?k=CODE         small JSON health check
 *  - WS   /ws?k=CODE           sync channel (play / pause / seek / buffering / chat)
 *                                and voice chat: binary Opus frames from whoever is talking
 *                                are relayed to everyone else in voice (only while they talk)
 *
 * The server owns the authoritative room clock:
 *   { paused, position, updatedAt }  -> current position = position + (now - updatedAt) while playing.
 * Only loopback and Tailscale addresses are accepted unless allowLan is set.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { isAllowedAddress, normalizeAddress, formatTime, clamp } = require('./util');

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
};

/** A client that has been buffering this long while the room plays stops holding everyone up. */
const STALL_LIMIT_MS = 20000;
/** Sockets that never say hello are dropped after this long. */
const HELLO_TIMEOUT_MS = 10000;
/**
 * Apps ping every 2 s. One that has been silent this long is gone (PC asleep, Wi-Fi or
 * Tailscale dropped without a clean close): drop it, or it stays in the member list
 * and in voice forever.
 */
const SILENT_CLIENT_MS = 15000;
/** Voice frames: [1][4-byte seq][opus] in, [1][8-byte sender id][4-byte seq][opus] out. */
const VOICE_MAGIC = 1;
const MAX_VOICE_FRAME = 1500; // a 20 ms Opus frame at 128 kbps is ~320 bytes
/** Pressing play this close to the end starts the video over. */
const RESTART_WINDOW_SECS = 1;

/** Parse a request URL, or null if it's malformed (a throw here would crash the app). */
function parseUrl(raw) {
  try {
    return new URL(raw, 'http://x');
  } catch {
    return null;
  }
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

class HostServer extends EventEmitter {
  /**
   * code / hostToken: reopen an earlier lobby under the same room code (after the host's
   * app restarts for an update), so guests' apps, which keep retrying, reconnect by themselves.
   */
  constructor({ port = 8787, allowLan = false, pauseOnBuffer = true, helloTimeoutMs = HELLO_TIMEOUT_MS, silentMs = SILENT_CLIENT_MS, code = null, hostToken = null } = {}) {
    super();
    this.helloTimeoutMs = helloTimeoutMs;
    this.silentMs = silentMs;
    this.port = port;
    this.allowLan = allowLan;
    this.pauseOnBuffer = pauseOnBuffer;
    this.code = typeof code === 'string' && /^[A-Z2-9]{6}$/.test(code) ? code : makeCode();
    this.hostToken = typeof hostToken === 'string' && /^[a-f0-9]{32}$/.test(hostToken) ? hostToken : crypto.randomBytes(16).toString('hex');
    this.media = null;
    this.paused = true;
    this.position = 0;
    this.updatedAt = Date.now();
    this.clients = new Map();
    this.bytesSent = 0;
    this.lastBytes = 0;
    this.uploadMbps = 0;
    this.membersDirty = true;
    this.serverMutedNames = new Set(); // host mutes stick across leave/rejoin and reconnects
  }

  // ---------- lifecycle ----------

  start() {
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) {
      return Promise.reject(new Error(`Port ${this.port} is not valid. Use a number between 1024 and 65535.`));
    }
    this.http = http.createServer((req, res) => this._onRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.http.on('upgrade', (req, socket, head) => {
      socket.on('error', () => { /* a dropped connection mid-handshake is not our problem */ });
      const url = parseUrl(req.url);
      if (!url || url.pathname !== '/ws' || !this._authorize(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws, req));
    });
    this.tick = setInterval(() => this._onTick(), 1000);
    return new Promise((resolve, reject) => {
      this.http.once('error', (err) => {
        clearInterval(this.tick);
        if (err.code === 'EADDRINUSE') reject(new Error(`Port ${this.port} is already in use. Pick another port under Advanced.`));
        else reject(err);
      });
      this.http.listen(this.port, () => {
        // From here on, errors are logged instead of crashing the app (an 'error' event
        // with no listener is fatal in Node).
        this.http.on('error', (e) => console.error('[server]', e && e.message));
        resolve();
      });
    });
  }

  /**
   * @param restarting the host's app is restarting for an update and will reopen this lobby:
   *   tell guests so (1012 = service restart) and they keep reconnecting instead of leaving.
   */
  stop({ restarting = false } = {}) {
    clearInterval(this.tick);
    for (const c of this.clients.values()) {
      try {
        if (restarting) c.ws.close(1012, 'Host is restarting');
        else c.ws.close(1001, 'Host closed the lobby');
      } catch { /* ignore */ }
    }
    this.clients.clear();
    try { this.wss && this.wss.close(); } catch { /* ignore */ }
    if (this.http) {
      try { this.http.closeAllConnections(); } catch { /* ignore */ }
      this.http.close();
    }
  }

  /** opts.id / opts.position: restore the same video id and spot (lobby reopened after an update). */
  setMedia(filePath, opts = {}) {
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new Error('Not a file: ' + filePath);
    this.media = {
      id: typeof opts.id === 'string' && /^[a-f0-9]{16}$/.test(opts.id) ? opts.id : crypto.randomBytes(8).toString('hex'),
      path: filePath,
      name: path.basename(filePath),
      size: st.size,
      ext: path.extname(filePath).toLowerCase(),
      duration: null,
    };
    this.paused = true;
    this.position = Number.isFinite(opts.position) && opts.position > 0 ? opts.position : 0;
    this.updatedAt = Date.now();
    for (const c of this.clients.values()) {
      if (!c.helloed) continue;
      c.buffering = true; // everyone has to (re)load
      c.stalledSince = Date.now();
      c.ignoredStall = false;
    }
    this.membersDirty = true;
    this._broadcastState();
    this._event(`Now playing: ${this.media.name}`);
  }

  // ---------- room clock ----------

  _blockers() {
    if (!this.pauseOnBuffer) return [];
    return [...this.clients.values()].filter((c) => c.helloed && c.buffering && !c.ignoredStall);
  }

  _isWaiting() {
    return !!this.media && !this.paused && this._blockers().length > 0;
  }

  _currentPosition() {
    let p = this.position;
    if (this.media && !this.paused && !this._isWaiting()) p += (Date.now() - this.updatedAt) / 1000;
    if (this.media && this.media.duration) p = Math.min(p, this.media.duration);
    return Math.max(0, p);
  }

  /** Fold elapsed time into `position`. Must be called BEFORE anything that changes effective play state. */
  _rebase() {
    this.position = this._currentPosition();
    this.updatedAt = Date.now();
  }

  _stateMsg(extra = {}) {
    const m = this.media;
    return {
      type: 'state',
      paused: this.paused,
      position: this.position,
      updatedAt: this.updatedAt,
      waiting: this._isWaiting(),
      waitingFor: this._blockers().map((c) => c.name),
      media: m && { id: m.id, name: m.name, size: m.size, ext: m.ext, duration: m.duration },
      ...extra,
    };
  }

  _broadcastState(extra) {
    this._broadcast(this._stateMsg(extra));
  }

  _apply(client, action, position) {
    if (!this.media) return;
    const hasPos = typeof position === 'number' && Number.isFinite(position);
    const pos = hasPos ? clamp(position, 0, this.media.duration || Number.MAX_SAFE_INTEGER) : null;
    this._rebase();
    if (action === 'play') {
      if (!this.paused) return;
      this.paused = false;
      const d = this.media.duration;
      if (d && this.position >= d - RESTART_WINDOW_SECS) this.position = 0; // play at the end = watch again
      for (const c of this.clients.values()) if (c.buffering) c.stalledSince = Date.now();
      this._event(`${client.name} pressed play at ${formatTime(this.position)}`);
    } else if (action === 'pause') {
      // Already paused there (e.g. two people pressed pause at once): nothing to do.
      if (this.paused && (!hasPos || Math.abs(pos - this.position) < 0.25)) return;
      this.paused = true;
      if (hasPos) this.position = pos;
      this._event(`${client.name} paused at ${formatTime(this.position)}`);
    } else if (action === 'seek') {
      if (!hasPos) return;
      this.position = pos;
      this._event(`${client.name} jumped to ${formatTime(pos)}`);
    } else {
      return;
    }
    this.updatedAt = Date.now();
    this._broadcastState({ by: client.name, action });
  }

  _setBuffering(client, buffering) {
    if (client.buffering === buffering) return;
    const wasWaiting = this._isWaiting();
    this._rebase();
    client.buffering = buffering;
    if (buffering) {
      client.stalledSince = Date.now();
    } else {
      client.stalledSince = null;
      client.ignoredStall = false;
    }
    this.membersDirty = true;
    if (wasWaiting !== this._isWaiting()) this._broadcastState();
  }

  _onTick() {
    const sent = this.bytesSent - this.lastBytes;
    this.lastBytes = this.bytesSent;
    const mbps = Math.round((sent * 8) / 1e5) / 10;
    if (mbps !== this.uploadMbps) {
      this.uploadMbps = mbps;
      this.membersDirty = true;
    }

    // Reached the end: pause the room there once, instead of each player reporting its own pause.
    const d = this.media && this.media.duration;
    if (!this.paused && d && this._currentPosition() >= d) {
      this._rebase();
      this.paused = true;
      this.position = d;
      this._event('Reached the end. Press play to watch again.');
      this._broadcastState({ action: 'ended' });
    }

    if (!this.paused) {
      for (const c of this.clients.values()) {
        if (c.helloed && c.buffering && !c.ignoredStall && Date.now() - c.stalledSince > STALL_LIMIT_MS) {
          const wasWaiting = this._isWaiting();
          this._rebase();
          c.ignoredStall = true;
          this.membersDirty = true;
          this._event(`Stopped waiting for ${c.name}, who is still buffering. They'll catch up.`);
          if (wasWaiting !== this._isWaiting()) this._broadcastState();
        }
      }
    }

    // Drop apps that went silent without closing their connection.
    const now = Date.now();
    for (const c of this.clients.values()) {
      if (c.helloed && now - c.lastSeen > this.silentMs) c.ws.terminate(); // 'close' does the cleanup
    }

    if (this.membersDirty) {
      this.membersDirty = false;
      this._broadcast(this._membersMsg());
    }
  }

  _membersMsg() {
    const list = [...this.clients.values()]
      .filter((c) => c.helloed)
      .map((c) => ({
        id: c.id,
        name: c.name,
        isHost: c.isHost,
        buffering: c.buffering && !c.ignoredStall,
        lagging: c.ignoredStall,
        drift: c.drift,
        source: c.source,
        rtt: c.rtt,
        voice: c.voice && { muted: c.voice.muted, deafened: c.voice.deafened, serverMuted: c.voice.serverMuted },
      }));
    return { type: 'members', list, stats: { uploadMbps: this.uploadMbps, viewers: list.filter((c) => !c.isHost).length } };
  }

  // ---------- HTTP ----------

  _authorize(req) {
    if (!isAllowedAddress(req.socket.remoteAddress, this.allowLan)) return false;
    const url = parseUrl(req.url);
    if (!url) return false;
    const key = (url.searchParams.get('k') || '').toUpperCase();
    const a = Buffer.from(key);
    const b = Buffer.from(this.code);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _onRequest(req, res) {
    if (!this._authorize(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    const url = parseUrl(req.url); // valid: _authorize parsed it
    if (url.pathname === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'watch2gether', media: this._stateMsg().media }));
      return;
    }
    const m = url.pathname.match(/^\/media\/([a-f0-9]+)$/);
    if (m && this.media && m[1] === this.media.id && (req.method === 'GET' || req.method === 'HEAD')) {
      this._serveMedia(req, res, this.media);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  _serveMedia(req, res, media) {
    const size = media.size;
    const type = MIME[media.ext] || 'application/octet-stream';
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!r || (r[1] === '' && r[2] === '')) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      if (r[1] === '') {
        start = Math.max(0, size - Number(r[2]));
      } else {
        start = Number(r[1]);
        if (r[2] !== '') end = Math.min(Number(r[2]), size - 1);
      }
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
    }
    const headers = {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(media.path, { start, end, highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => { this.bytesSent += chunk.length; });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // ---------- WebSocket ----------

  _onConnection(ws, req) {
    const client = {
      id: crypto.randomBytes(4).toString('hex'),
      ws,
      ip: normalizeAddress(req.socket.remoteAddress),
      name: 'Guest',
      isHost: false,
      helloed: false,
      buffering: false,
      stalledSince: null,
      ignoredStall: false,
      drift: 0,
      source: null,
      rtt: null,
      voice: null, // { muted, deafened, serverMuted } while in voice chat
      lastSeen: Date.now(),
    };
    this.clients.set(client.id, client);
    const helloTimer = setTimeout(() => {
      if (!client.helloed) ws.terminate();
    }, this.helloTimeoutMs);

    ws.on('message', (data, isBinary) => {
      client.lastSeen = Date.now();
      if (isBinary) {
        this._onVoiceFrame(client, data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      this._onMessage(client, msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      const wasWaiting = this._isWaiting();
      this._rebase();
      this.clients.delete(client.id);
      if (client.voice) this._voiceLeave(client, true);
      if (client.helloed) {
        this.membersDirty = true;
        this._event(`${client.name} left`);
        if (wasWaiting !== this._isWaiting()) this._broadcastState();
      }
    });
    ws.on('error', () => { /* close follows */ });
  }

  _onMessage(client, msg) {
    switch (msg.type) {
      case 'hello': {
        if (client.helloed) return;
        const name = String(msg.name || '').trim().slice(0, 32) || 'Guest';
        client.name = name;
        client.isHost = typeof msg.hostToken === 'string' && msg.hostToken === this.hostToken;
        const wasWaiting = this._isWaiting();
        this._rebase();
        client.helloed = true;
        if (this.media) {
          client.buffering = true; // still has to load the file
          client.stalledSince = Date.now();
        }
        this._send(client, { type: 'welcome', clientId: client.id, state: this._stateMsg(), members: this._membersMsg().list });
        this.membersDirty = true;
        this._event(`${name} joined${client.isHost ? ' (host)' : ''}`);
        if (wasWaiting !== this._isWaiting()) this._broadcastState();
        break;
      }
      case 'ping':
        this._send(client, { type: 'pong', t0: msg.t0, ts: Date.now() });
        break;
      case 'cmd':
        if (client.helloed) this._apply(client, msg.action, msg.position);
        break;
      case 'status':
        if (!client.helloed) return;
        if (typeof msg.drift === 'number' && Number.isFinite(msg.drift)) client.drift = Math.round(msg.drift * 1000) / 1000;
        if (msg.source === 'local' || msg.source === 'stream') client.source = msg.source;
        if (typeof msg.rtt === 'number') client.rtt = Math.round(msg.rtt);
        this.membersDirty = true;
        if (typeof msg.buffering === 'boolean') this._setBuffering(client, msg.buffering);
        break;
      case 'media-info':
        // The host's player is authoritative; a guest's is used until the host reports
        // (e.g. the host closed their player window).
        if (client.helloed && this.media && msg.mediaId === this.media.id && Number.isFinite(msg.duration) && msg.duration > 0) {
          if ((client.isHost || !this.media.duration) && this.media.duration !== msg.duration) {
            this.media.duration = msg.duration;
            this._broadcastState();
          }
        }
        break;
      case 'chat': {
        if (!client.helloed) return;
        const text = String(msg.text || '').trim().slice(0, 500);
        if (text) this._broadcast({ type: 'chat', from: client.name, text, at: Date.now() });
        break;
      }
      case 'voice-join':
        if (client.helloed && !client.voice) this._voiceJoin(client);
        break;
      case 'voice-leave':
        if (client.voice) this._voiceLeave(client, false);
        break;
      case 'voice-mod': {
        // Host moderation: mute someone for everyone, or remove them from voice.
        const target = client.isHost && typeof msg.target === 'string' ? this.clients.get(msg.target) : null;
        if (!target || !target.voice || target === client) return;
        if (msg.action === 'mute' || msg.action === 'unmute') {
          target.voice.serverMuted = msg.action === 'mute';
          if (target.voice.serverMuted) this.serverMutedNames.add(target.name);
          else this.serverMutedNames.delete(target.name);
          this._event(`${client.name} ${target.voice.serverMuted ? 'muted' : 'unmuted'} ${target.name} for everyone`);
          this._flushMembers();
        } else if (msg.action === 'kick') {
          this._send(target, { type: 'voice-kicked', by: client.name });
          this._voiceLeave(target, true);
          this._event(`${client.name} disconnected ${target.name} from voice`);
          this._flushMembers();
        }
        break;
      }
      case 'voice-state':
        if (!client.voice) return;
        client.voice.muted = !!msg.muted;
        client.voice.deafened = !!msg.deafened;
        this._flushMembers(); // mute icons should change right away, not on the next tick
        break;
      default:
        break;
    }
  }

  // ---------- voice chat ----------

  /** Relay one talker's Opus frame to everyone else in voice who can hear it. */
  _onVoiceFrame(client, data) {
    const v = client.voice;
    if (!v || v.muted || v.deafened || v.serverMuted) return;
    if (data.length < 6 || data.length > MAX_VOICE_FRAME || data[0] !== VOICE_MAGIC) return;
    const out = Buffer.allocUnsafe(data.length + 8);
    out[0] = VOICE_MAGIC;
    out.write(client.id, 1, 8, 'latin1');
    data.copy(out, 9, 1);
    for (const c of this.clients.values()) {
      if (c === client || !c.voice || c.voice.deafened || c.ws.readyState !== 1) continue;
      if (c.ws.bufferedAmount > 256 * 1024) continue; // a stalled listener drops audio, not the lobby
      c.ws.send(out, { binary: true });
    }
  }

  _voicePeers(except) {
    return [...this.clients.values()].filter((c) => c.voice && c !== except);
  }

  _voiceJoin(client) {
    client.voice = { muted: false, deafened: false, serverMuted: this.serverMutedNames.has(client.name) };
    // The newcomer learns who's in voice; everyone else learns about the newcomer.
    this._send(client, { type: 'voice-peers', peers: this._voicePeers(client).map((c) => c.id) });
    for (const c of this._voicePeers(client)) this._send(c, { type: 'voice-peer-joined', id: client.id });
    this._event(`${client.name} joined voice`);
    this._flushMembers();
  }

  _voiceLeave(client, disconnected) {
    client.voice = null;
    for (const c of this._voicePeers(client)) this._send(c, { type: 'voice-peer-left', id: client.id });
    if (!disconnected) {
      this._event(`${client.name} left voice`);
      this._flushMembers();
    }
  }

  _flushMembers() {
    this.membersDirty = false;
    this._broadcast(this._membersMsg());
  }

  _event(text) {
    this._broadcast({ type: 'event', text, at: Date.now() });
  }

  _send(client, obj) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
  }

  _broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const c of this.clients.values()) {
      if (c.helloed && c.ws.readyState === 1) c.ws.send(data);
    }
  }
}

module.exports = { HostServer, makeCode };
