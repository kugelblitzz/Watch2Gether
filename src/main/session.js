'use strict';

/**
 * Session — one per running app (host or guest). Connects to the host's sync server,
 * drives the local mpv player to match the room clock, and turns the user's own
 * actions in mpv (space, arrow keys, seek bar) into room commands.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { Mpv } = require('./mpv');
const { clamp } = require('./util');

const SYNC_INTERVAL_MS = 250;
const HARD_SEEK_THRESHOLD = 1.5; // seconds off -> seek
const PAUSED_SEEK_THRESHOLD = 0.1; // while paused, line up frames tightly (cheap: it's in cache)
const SPEED_GAIN = 0.5; // speed offset per second of drift
const SOFT_START = 0.08; // start nudging speed above this drift
const SOFT_STOP = 0.03; // stop nudging below this drift
const MAX_SPEED_NUDGE = 0.08; // +/- 8%
const RESUME_CACHE_SECS = 5; // after a network stall, wait for this much buffer
// The host answers our pings every 2 s. Silence this long means the connection died without
// closing (host PC asleep, Wi-Fi / Tailscale dropped): drop it and start reconnecting.
const SILENT_HOST_MS = 10000;

class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.baseUrl = opts.baseUrl;
    this.code = opts.code;
    this.name = opts.name;
    this.hostToken = opts.hostToken || null;
    this.isHost = !!opts.hostToken;
    this.mpvPath = opts.mpvPath;
    this.resolveLocal = opts.resolveLocal || (() => null);
    // Native window to draw into (mpv --wid) for the in-app player, or null for mpv's own window.
    this.getWid = opts.getWid || (() => null);
    // The user's own player volume (0-130, mpv's scale), remembered across videos and sessions.
    this.getVolume = opts.getVolume || (() => 100);

    this.ws = null;
    this.closed = false;
    this.connected = false;
    this.me = null;
    this.offset = 0;
    this.rtt = null;
    this.clockSamples = [];

    this.room = null;
    this.members = [];
    this.stats = null;
    this.log = [];

    this.mpv = null;
    this.playerOpen = false;
    this.ps = { paused: true, timePos: null, duration: null, seeking: false, pausedForCache: false, cacheDur: 0, cacheIdle: false };
    this.loadedMediaId = null;
    this.loading = false;
    this.loadedAt = 0;
    this.source = null;

    this.lastPauseCmdAt = 0;
    this.ourSeekUntil = 0;
    this.ourSeeks = 0;
    this.lastOurSeekAt = 0;
    this.pendingUserSeek = false;
    this.userActionPending = false;
    this.speed = 1;
    this.correcting = false;
    this.drift = 0;
    this.stallLatched = false;
    this.reportedBuffering = null;
    this.bufferTimer = null;
    this.syncing = false;
    this.timers = [];
    this.lastEmit = 0;
  }

  // ---------- lifecycle ----------

  async start() {
    await this._connect();
    // The player only opens once there's a video: a lobby can start empty (talk first,
    // pick later), and nobody gets an empty black window meanwhile.
    if (this.openPromise) await this.openPromise;
    this.timers.push(setInterval(() => this._sync(), SYNC_INTERVAL_MS));
    this.timers.push(setInterval(() => {
      if (this.connected && Date.now() - this.lastRx > (this.silentHostMs || SILENT_HOST_MS)) {
        this._log('No answer from the host. Reconnecting...');
        try { this.ws.terminate(); } catch { /* ignore */ } // 'close' starts the reconnect
        return;
      }
      this._ping();
    }, 2000));
    this.timers.push(setInterval(() => this._sendStatus(), 2000));
    this.timers.push(setInterval(() => this._emitUpdate(), 500));
  }

  stop() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.bufferTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.duckTimer);
    try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
    if (this.mpv) this.mpv.quit();
  }

  /**
   * Switch between the in-app player and mpv's own window: restart the player in the
   * new mode. The sync loop puts it back on the room's position within a second.
   */
  async restartPlayer() {
    if (!this.playerOpen || !this.mpv) return;
    const old = this.mpv;
    this.playerOpen = false;
    this.loadedMediaId = null;
    old.quit(); // its 'exit' is ignored: this.mpv points at the new player by then
    await this.reopenPlayer();
  }

  /** A short message drawn by the player over the video (HTML can't be shown on top of it). */
  osd(text, ms = 2500) {
    if (this.mpv && this.playerOpen) this.mpv.command('show-text', String(text), String(ms)).catch(() => {});
  }

  /** Player volume, 0-130 (100 = the file's own level). Only affects this user. */
  setVolume(v) {
    const vol = Math.max(0, Math.min(130, Math.round(Number(v))));
    if (!Number.isFinite(vol)) return;
    this.ps.volume = vol;
    if (this.mpv && this.playerOpen) this.mpv.set('volume', vol).catch(() => {});
    if (vol > 0 && this.ps.muted) this.setMute(false); // dragging the slider up unmutes
  }

  setMute(on) {
    this.ps.muted = !!on;
    if (this.mpv && this.playerOpen) this.mpv.set('mute', !!on).catch(() => {});
    this._emitUpdate(true);
  }

  /** Close the player because there's nothing to play (not the user closing it). */
  _closePlayer() {
    const mpv = this.mpv;
    this.playerOpen = false;
    this.loadedMediaId = null;
    this.loading = false;
    this.quietExit = mpv;
    if (mpv) mpv.quit();
    this._updateBuffering();
    this._emitUpdate(true);
  }

  /** Open the player and load the current video. Concurrent calls share one attempt. */
  reopenPlayer() {
    if (this.playerOpen) return Promise.resolve();
    if (!this.openPromise) {
      this.openPromise = (async () => {
        try {
          await this._startPlayer();
          this.loadedMediaId = null;
          await this._loadMedia();
        } finally {
          this.openPromise = null;
        }
      })();
    }
    return this.openPromise;
  }

  // ---------- network ----------

  _connect() {
    return new Promise((resolve, reject) => {
      const url = this.baseUrl.replace(/^http/i, 'ws') + '/ws?k=' + encodeURIComponent(this.code);
      const ws = new WebSocket(url, { handshakeTimeout: 8000, perMessageDeflate: false });
      this.ws = ws;
      let welcomed = false;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      ws.on('open', () => this._send({ type: 'hello', name: this.name, hostToken: this.hostToken }));
      ws.on('message', (data, isBinary) => {
        this.lastRx = Date.now();
        if (isBinary) {
          this.emit('voice-audio', data);
          return;
        }
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'welcome' && !welcomed) {
          welcomed = true;
          this.connected = true;
          this.lastRx = Date.now();
          settled = true;
          resolve();
        }
        this._onMessage(msg);
      });
      ws.on('unexpected-response', (req, res) => {
        req.destroy();
        const err = new Error(res.statusCode === 403
          ? 'The host refused the connection. Check the room code, and make sure you are connecting over Tailscale (a 100.x.y.z address).'
          : `The host answered with HTTP ${res.statusCode}.`);
        err.status = res.statusCode;
        fail(err);
      });
      ws.on('error', (err) => fail(friendlyNetError(err, this.baseUrl)));
      ws.on('close', (code, reason) => {
        this.connected = false;
        if (!welcomed) fail(new Error('Connection closed before joining the lobby.'));
        if (welcomed && !this.closed) {
          if (code === 1001 && String(reason) === 'Host closed the lobby') {
            this._log('The host closed the lobby.');
            this.emit('ended', 'The host closed the lobby.');
            return;
          }
          this._log(code === 1012
            ? 'The host is restarting the app for an update. Reconnecting when it is back...'
            : 'Connection lost. Reconnecting...');
          this._scheduleReconnect();
        }
        this._emitUpdate(true);
      });
    });
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closed) return;
      try {
        await this._connect();
        this._log('Reconnected.');
      } catch (e) {
        if (this.closed) return;
        if (e && e.status === 403) {
          // The host is back but with a different lobby (it restarted): this room is gone.
          this.emit('ended', 'The lobby no longer exists. The host may have restarted it; ask for a new invite.');
          return;
        }
        this._scheduleReconnect();
      }
    }, 2000);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.me = msg.clientId;
        this.members = msg.members || [];
        this.clockSamples = [];
        this._ping();
        for (let i = 1; i <= 4; i++) setTimeout(() => this._ping(), i * 150);
        this._onState(msg.state);
        this.reportedBuffering = null; // force re-report to the (new) server-side client
        this._updateBuffering();
        break;
      case 'pong':
        this._onPong(msg);
        break;
      case 'state':
        this._onState(msg);
        break;
      case 'members':
        this.members = msg.list || [];
        this.stats = msg.stats || null;
        this._emitUpdate(true);
        break;
      case 'event':
        this._log(msg.text);
        this.emit('event', msg.text);
        break;
      case 'chat':
        this._log(`${msg.from}: ${msg.text}`, 'chat');
        this.emit('chat', msg);
        break;
      case 'voice-peers':
      case 'voice-peer-joined':
      case 'voice-peer-left':
      case 'voice-kicked':
        this.emit('voice', msg); // handled by the renderer's voice engine
        break;
      default:
        break;
    }
  }

  _ping() {
    this._send({ type: 'ping', t0: Date.now() });
  }

  _onPong({ t0, ts }) {
    if (typeof t0 !== 'number' || typeof ts !== 'number') return;
    const t1 = Date.now();
    const rtt = t1 - t0;
    this.rtt = rtt;
    this.clockSamples.push({ rtt, offset: ts - (t0 + rtt / 2) });
    if (this.clockSamples.length > 12) this.clockSamples.shift();
    // The sample with the lowest round trip is the most trustworthy.
    const best = this.clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  // ---------- room state ----------

  _onState(state) {
    if (!state) return;
    this.room = state;
    const id = state.media ? state.media.id : null;
    if (id && !this.playerOpen) {
      // A (new) video and no player yet: open it. Not again for the same video if the
      // user closed the window themselves; "Open player" brings it back.
      if (id !== this.autoOpenedFor) {
        this.autoOpenedFor = id;
        this.reopenPlayer().catch((e) => this._log('Could not open the player: ' + e.message));
      }
    } else if (!id && this.playerOpen) {
      // The host unloaded the video: close the player (no empty black window), quietly.
      this._closePlayer();
      this.autoOpenedFor = null;
    } else if (id !== this.loadedMediaId) {
      this._loadMedia();
    }
    this._sync();
    this._emitUpdate(true);
  }

  _expectedPosition() {
    const r = this.room;
    if (!r) return 0;
    const playing = !r.paused && !r.waiting;
    let p = r.position + (playing ? Math.max(0, (this.serverNow() - r.updatedAt) / 1000) : 0);
    const dur = this.ps.duration || (r.media && r.media.duration);
    if (dur) p = Math.min(p, dur);
    return Math.max(0, p);
  }

  /** Called by the UI. action: play | pause | toggle | seek */
  command(action, position) {
    if (!this.room || !this.room.media) return;
    if (action === 'toggle') action = this.room.paused ? 'play' : 'pause';
    if (action === 'pause' && position == null) position = this.ps.timePos != null ? this.ps.timePos : this._expectedPosition();
    if (action === 'seek' && !(typeof position === 'number' && Number.isFinite(position))) return;
    this._userCmd(action, position);
  }

  /** Voice-chat messages from the renderer; only these types go to the server. */
  voiceSend(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'voice-join':
      case 'voice-leave':
        this._send({ type: msg.type });
        break;
      case 'voice-state':
        this._send({ type: 'voice-state', muted: !!msg.muted, deafened: !!msg.deafened });
        break;
      case 'voice-mod':
        if (typeof msg.target === 'string' && ['mute', 'unmute', 'kick'].includes(msg.action)) {
          this._send({ type: 'voice-mod', target: msg.target, action: msg.action });
        }
        break;
      default:
        break;
    }
  }

  /**
   * Lower the movie while friends talk (1 = normal). Ramps over ~200 ms so it
   * doesn't click, and leaves the user's own mpv volume untouched.
   */
  duck(level) {
    if (!Number.isFinite(level)) return;
    const target = Math.max(0, Math.min(1, level));
    const from = this.duckLevel == null ? 1 : this.duckLevel;
    this.duckLevel = target;
    clearInterval(this.duckTimer);
    let step = 0;
    const steps = 5;
    const apply = () => {
      step++;
      const v = from + ((target - from) * step) / steps;
      if (this.mpv && this.playerOpen) this.mpv.command('af-command', 'w2gduck', 'volume', v.toFixed(3), 'volume').catch(() => {});
      if (step >= steps) clearInterval(this.duckTimer);
    };
    apply();
    this.duckTimer = setInterval(apply, 40);
  }

  /** One encoded voice frame from the renderer (binary, relayed by the host). */
  voiceAudio(bytes) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && bytes && bytes.length <= 1500) {
      this.ws.send(bytes, { binary: true });
    }
  }

  chat(text) {
    this._send({ type: 'chat', text: String(text || '').slice(0, 500) });
  }

  _userCmd(action, position) {
    const r = { ...this.room };
    const cur = this._expectedPosition();
    if (action === 'play') {
      r.position = cur;
      r.paused = false;
    } else if (action === 'pause') {
      r.position = position != null ? position : cur;
      r.paused = true;
    } else if (action === 'seek') {
      r.position = position;
    }
    r.updatedAt = this.serverNow();
    this.room = r; // optimistic; the server's broadcast will replace it
    this._send({ type: 'cmd', action, position });
    this._sync();
    this._emitUpdate(true);
  }

  // ---------- player ----------

  async _startPlayer() {
    const mpv = new Mpv(this.mpvPath);
    this.mpv = mpv;
    mpv.on('property', (name, value) => this._onProp(name, value));
    mpv.on('event', (e) => this._onMpvEvent(e));
    mpv.on('exit', () => {
      if (this.mpv !== mpv) return;
      this.playerOpen = false;
      this.loadedMediaId = null;
      this.loading = false;
      if (this.quietExit === mpv) return; // we closed it (video unloaded), not the user
      if (!this.closed) {
        this._log('Player closed. Click "Open player" on the video area to get it back.');
        this._updateBuffering();
        this._emitUpdate(true);
      }
    });
    const wid = this.getWid();
    this.embedded = !!wid;
    const volume = Math.max(0, Math.min(130, Math.round(Number(this.getVolume()) || 0)));
    const keep = [`--volume=${volume}`];
    if (this.ps && this.ps.muted) keep.push('--mute=yes'); // e.g. switching between in-app and popped out
    await mpv.start({ title: 'Watch2Gether', extraArgs: [...(wid ? ['--wid=' + wid] : []), ...keep] });
    // keep the movie lowered if friends are talking right now
    if (this.duckLevel != null && this.duckLevel < 1) {
      mpv.command('af-command', 'w2gduck', 'volume', this.duckLevel.toFixed(3), 'volume').catch(() => {});
    }
    if (wid) {
      // Inside the app, fullscreen is the app's: f / double-click toggle it, Esc leaves it.
      for (const [key, msg] of [['f', 'w2g-fullscreen'], ['MBTN_LEFT_DBL', 'w2g-fullscreen'], ['ESC', 'w2g-exit-fullscreen'], ['TAB', 'w2g-sidebar']]) {
        await mpv.command('keybind', key, 'script-message ' + msg).catch(() => {});
      }
    }
    this.playerOpen = true;
    this.ps = { paused: true, timePos: null, duration: null, seeking: false, pausedForCache: false, cacheDur: 0, cacheIdle: false, volume, muted: keep.includes('--mute=yes') };
    this.speed = 1;
    for (const p of ['pause', 'duration', 'seeking', 'paused-for-cache', 'demuxer-cache-duration', 'demuxer-cache-idle', 'volume', 'mute']) {
      await mpv.observe(p).catch(() => {});
    }
  }

  async _loadMedia() {
    const media = this.room && this.room.media;
    if (!this.mpv || !this.playerOpen) return;
    if (!media) {
      this.loadedMediaId = null;
      this.loading = false;
      this.mpv.command('stop').catch(() => {});
      return;
    }
    const local = this.resolveLocal(media);
    const target = local || `${this.baseUrl}/media/${media.id}?k=${encodeURIComponent(this.code)}`;
    this.source = local ? 'local' : 'stream';
    this.loadedMediaId = media.id;
    this.loading = true;
    this.stallLatched = false;
    this.ps.timePos = null;
    this.ps.duration = null;
    this._updateBuffering();
    if (!this.isHost) this._log(local ? `Playing your local copy of ${media.name}.` : `Streaming ${media.name} from the host.`);
    try {
      this.lastPauseCmdAt = Date.now();
      this.ps.paused = true;
      await this.mpv.set('pause', true);
      await this.mpv.set('speed', 1);
      this.speed = 1;
      await this.mpv.command('loadfile', target, 'replace');
    } catch (e) {
      this.loading = false;
      this._log('Player error: ' + e.message);
    }
  }

  _onProp(name, value) {
    switch (name) {
      case 'pause':
        this.ps.paused = !!value;
        this._onPauseChange(!!value);
        break;
      case 'duration':
        this.ps.duration = typeof value === 'number' ? value : null;
        if (this.ps.duration && this.loadedMediaId) {
          this._send({ type: 'media-info', mediaId: this.loadedMediaId, duration: this.ps.duration });
        }
        break;
      case 'seeking':
        this.ps.seeking = !!value;
        break;
      case 'paused-for-cache':
        this.ps.pausedForCache = !!value;
        break;
      case 'demuxer-cache-duration':
        this.ps.cacheDur = typeof value === 'number' ? value : 0;
        break;
      case 'demuxer-cache-idle':
        this.ps.cacheIdle = !!value;
        break;
      case 'volume':
        // also follows the user's own volume keys / wheel inside the player
        if (typeof value === 'number') {
          this.ps.volume = Math.round(value);
          this.emit('volume', this.ps.volume);
        }
        this._emitUpdate(true);
        return;
      case 'mute':
        this.ps.muted = !!value;
        this._emitUpdate(true);
        return;
      default:
        return;
    }
    this._updateBuffering();
  }

  _onMpvEvent(e) {
    switch (e.event) {
      case 'file-loaded':
        this.loading = false;
        this.loadedAt = Date.now();
        this._updateBuffering();
        this._sync();
        break;
      case 'end-file':
        if (e.reason === 'error') {
          this.loading = false;
          this._log(`The player could not open the video (${e.file_error || 'unknown error'}).`);
          this._updateBuffering();
        }
        break;
      case 'seek': {
        const now = Date.now();
        // Each seek we issue produces one 'seek' event; consume those first.
        if (this.ourSeeks > 0 && now - this.lastOurSeekAt < 3000) {
          this.ourSeeks--;
          return;
        }
        this.ourSeeks = 0;
        if (this.loading || now - this.loadedAt < 1500) return;
        this.pendingUserSeek = true; // user seeked inside mpv; report once it settles
        break;
      }
      case 'client-message': {
        const name = e.args && e.args[0];
        if (typeof name === 'string' && name.startsWith('w2g-')) this.emit('player-request', name.slice(4));
        break;
      }
      case 'playback-restart':
        if (this.pendingUserSeek) {
          this.mpv.get('time-pos')
            .then((pos) => {
              if (typeof pos === 'number') this._userCmd('seek', pos);
            })
            .catch(() => {})
            .finally(() => { this.pendingUserSeek = false; });
        }
        break;
      default:
        break;
    }
  }

  /** Pause toggled. Ignore our own echoes, and forward real user toggles from the mpv window. */
  _onPauseChange(paused) {
    const r = this.room;
    if (!r || !r.media || this.loading || this.loadedMediaId !== r.media.id) return;
    if (Date.now() - this.lastPauseCmdAt < 500) return;
    const desiredPaused = r.paused || r.waiting;
    if (paused === desiredPaused) return;
    if (paused) {
      this.userActionPending = true;
      this.mpv.get('time-pos')
        .then((pos) => this._userCmd('pause', typeof pos === 'number' ? pos : undefined))
        .catch(() => this._userCmd('pause'))
        .finally(() => { this.userActionPending = false; });
    } else if (!r.waiting) {
      this._userCmd('play');
    }
    // Unpausing while the room waits for a buffering friend is undone by the next sync tick.
  }

  _computeBuffering() {
    if (!this.playerOpen || !this.room || !this.room.media) return false;
    if (this.loading) return true;
    const p = this.ps;
    if (p.seeking || p.pausedForCache) {
      if (this.source === 'stream') this.stallLatched = true;
      return true;
    }
    if (this.stallLatched) {
      if (p.cacheIdle || p.cacheDur >= RESUME_CACHE_SECS) this.stallLatched = false;
      else return true;
    }
    // While the room is held, don't declare ourselves ready until we're lined up on the same frame.
    if (this.room.waiting && p.timePos != null && Math.abs(p.timePos - this._expectedPosition()) > PAUSED_SEEK_THRESHOLD) {
      return true;
    }
    return false;
  }

  _updateBuffering() {
    const b = this._computeBuffering();
    if (b === this.reportedBuffering) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
      return;
    }
    if (b) {
      // Debounce: tiny local seeks shouldn't make the whole room blink.
      if (!this.bufferTimer) {
        this.bufferTimer = setTimeout(() => {
          this.bufferTimer = null;
          if (this._computeBuffering()) this._reportBuffering(true);
        }, 300);
      }
    } else {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
      this._reportBuffering(false);
    }
  }

  _reportBuffering(b) {
    this.reportedBuffering = b;
    this._sendStatus();
    this._emitUpdate(true);
  }

  _sendStatus() {
    this._send({ type: 'status', buffering: !!this.reportedBuffering, drift: this.drift, source: this.source, rtt: this.rtt });
  }

  // ---------- the sync loop ----------

  async _sync() {
    const r = this.room;
    if (this.syncing || this.closed) return;
    if (!r || !r.media || !this.playerOpen || this.loading || this.loadedMediaId !== r.media.id) return;
    if (this.pendingUserSeek || this.userActionPending) return;
    this.syncing = true;
    try {
      const pos = await this.mpv.get('time-pos').catch(() => null);
      this.ps.timePos = typeof pos === 'number' ? pos : null;
      this._updateBuffering();

      const room = this.room; // may have changed while awaiting
      const desiredPaused = room.paused || room.waiting;
      const expected = this._expectedPosition();
      const now = Date.now();

      if (this.ps.paused !== desiredPaused) {
        this.lastPauseCmdAt = now;
        this.ps.paused = desiredPaused;
        await this.mpv.set('pause', desiredPaused).catch(() => {});
      }

      if (this.ps.timePos == null || this.ps.seeking || now < this.ourSeekUntil || this.pendingUserSeek) return;
      const diff = this.ps.timePos - expected;
      this.drift = diff;

      if (desiredPaused) {
        this.correcting = false;
        await this._setSpeed(1);
        if (Math.abs(diff) > PAUSED_SEEK_THRESHOLD) await this._seek(expected);
      } else if (Math.abs(diff) > HARD_SEEK_THRESHOLD) {
        this.correcting = false;
        await this._setSpeed(1);
        await this._seek(expected);
      } else {
        const a = Math.abs(diff);
        if (a > SOFT_START) this.correcting = true;
        else if (a < SOFT_STOP) this.correcting = false;
        const speed = this.correcting ? 1 - clamp(diff * SPEED_GAIN, -MAX_SPEED_NUDGE, MAX_SPEED_NUDGE) : 1;
        await this._setSpeed(Math.round(speed * 1000) / 1000);
      }
    } finally {
      this.syncing = false;
    }
  }

  async _seek(t) {
    const now = Date.now();
    this.ourSeeks = (now - this.lastOurSeekAt < 3000 ? this.ourSeeks : 0) + 1;
    this.lastOurSeekAt = now;
    this.ourSeekUntil = now + 1000; // don't re-seek again straight away
    await this.mpv.command('seek', t.toFixed(3), 'absolute+exact').catch(() => {});
  }

  async _setSpeed(s) {
    if (s === this.speed) return;
    this.speed = s;
    await this.mpv.set('speed', s).catch(() => {});
  }

  // ---------- UI ----------

  _log(text, kind = 'event') {
    this.logSeq = (this.logSeq || 0) + 1;
    this.log.push({ seq: this.logSeq, at: Date.now(), text, kind });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this._emitUpdate(true);
  }

  _emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 200) return;
    this.lastEmit = now;
    const r = this.room;
    this.emit('update', {
      connected: this.connected,
      isHost: this.isHost,
      me: this.me,
      room: r && { ...r, current: this._expectedPosition() },
      members: this.members,
      stats: this.stats,
      log: this.log.slice(-150),
      rtt: this.rtt,
      player: {
        open: this.playerOpen,
        timePos: this.ps.timePos,
        duration: this.ps.duration,
        paused: this.ps.paused,
        buffering: !!this.reportedBuffering,
        source: this.source,
        drift: this.drift,
        speed: this.speed,
        volume: this.ps.volume == null ? null : this.ps.volume,
        muted: !!this.ps.muted,
      },
    });
  }
}

function friendlyNetError(err, baseUrl) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') return new Error(`Nothing is listening at ${baseUrl}. Is the host's lobby running, and is the port right?`);
  if (code === 'ETIMEDOUT' || /timed out/i.test(err.message || '')) {
    return new Error(`Timed out reaching ${baseUrl}. Check that Tailscale is connected on both PCs and that the host's Windows Firewall allows Watch2Gether.`);
  }
  if (code === 'ENOTFOUND') return new Error(`Could not find host ${baseUrl}. Try the host's 100.x.y.z Tailscale IP instead.`);
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new Error(`Can't reach ${baseUrl}. Is Tailscale connected?`);
  return err instanceof Error ? err : new Error(String(err));
}

module.exports = { Session };
