'use strict';

/**
 * Voice chat engine (renderer).
 *
 *   mic -> [AI noise removal] -> input volume -> [level meter / voice activity or push-to-talk]
 *       -> gate -> capture -> Opus encoder -> lobby connection -> host relays to everyone in voice
 *   Opus decoder -> jitter buffer -> their volume (0-200 %) -> output volume -> speakers
 *
 * Audio rides the existing lobby connection (over Tailscale) instead of direct
 * WebRTC peer links: Chromium doesn't gather ICE candidates on the Tailscale
 * adapter, so peer-to-peer would only work on a shared LAN. Frames are only sent
 * while you talk, so silence costs nothing and the speaking ring is exact.
 *
 * Usage: const v = new VoiceEngine({ send, sendAudio, loadWasm, getPeerPrefs });
 *        v.onChange = fn; v.handle(jsonMsg); v.handleAudio(bytes)
 */

const VOICE_DEFAULTS = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputVolume: 1,          // 0..2
  outputVolume: 1,         // 0..2
  mode: 'vad',             // 'vad' (voice activity) | 'ptt' (push to talk)
  pttReleaseMs: 200,       // keep sending this long after the key is released
  autoSensitivity: true,
  threshold: -50,          // dBFS, used when autoSensitivity is off
  noiseCancel: 'gtcrn',    // 'off' | 'standard' (Chromium's) | 'gtcrn' (AI: ~45-50 dB off steady room noise)
  echoCancellation: true,
  autoGainControl: true,
  duck: true,              // lower the movie while friends talk
  duckAmount: 0.6,         // 0..0.9: how much quieter
  soundCues: true,
  bitrate: 64000,          // Opus, bits/s
  binds: { ptt: null, mute: null, deafen: null },
};

// GTCRN (via @sapphi-red/web-noise-suppressor). RNNoise was tried too, but on steady
// room noise it ranged from 1.5 to 24 dB of reduction between runs; GTCRN gave 44-49 dB
// every time at a similar, tiny CPU cost.
const NOISE_PROCESSORS = {
  gtcrn: '@sapphi-red/web-noise-suppressor/gtcrn',
};

const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 960;       // 20 ms
const VAD_TICK_MS = 20;
const VAD_RELEASE_MS = 300;      // keep sending this long after speech, so word endings survive
const SPEAKING_HOLD_MS = 250;
// Voice activity ignores short bursts (keyboard / mouse clicks, bumps): sound has to stay
// above the threshold for VAD_ATTACK_MS of real time before the mic opens (a click lasts
// a few ms, a syllable 100+ ms). The level is measured over ~11 ms windows so one click
// can't show up in two readings. The sent audio runs VAD_LOOKAHEAD_S behind the detector,
// so the start of a word isn't cut off.
const VAD_ATTACK_MS = 50;
const VAD_LOOKAHEAD_S = 0.08;
// A friend's ring lights only while what we receive from them is actually audible.
const REMOTE_SPEAKING_DB = -50;
const DENOISE_DEAD_TICKS = 75;
// Automatic sensitivity: open this far above the room's noise floor, but never below
// AUTO_MIN_DB. After AI noise removal the floor is very low, and a -62 dB minimum let
// faint echo of a friend's voice (leaking from speakers, ~-55 dB) open the mic and get
// sent back to them. A voice at the mic is typically -30 to -10 dBFS.
const AUTO_MARGIN_DB = 15;
const AUTO_MIN_DB = -50;
const AUTO_MAX_DB = -25;
// Echo guard: while someone else is talking, our mic must be this much louder to open,
// so their voice leaking from our speakers isn't sent back. Talking over them still works.
const ECHO_GUARD_DB = 8;   // 1.5 s of raw sound but digital silence after the model = model crashed
const SETTINGS_KEY = 'w2g.voice';
const AUDIO_MAGIC = 1;           // first byte of a binary voice frame
const SCRIPT_URL = document.currentScript.src;
const WORKLET_URL = new URL('voice-worklets.js', SCRIPT_URL).href;
const NOISE_WORKLET_URL = (name) => new URL(`../../node_modules/@sapphi-red/web-noise-suppressor/dist/${name}/workletProcessor.js`, SCRIPT_URL).href;

function loadVoiceSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* defaults */ }
  if (saved.noiseCancel == null && saved.noiseSuppression === false) saved.noiseCancel = 'off'; // v0.4.0 setting
  if (saved.noiseCancel && !['off', 'standard', 'gtcrn'].includes(saved.noiseCancel)) saved.noiseCancel = 'gtcrn';
  delete saved.noiseSuppression;
  return { ...VOICE_DEFAULTS, ...saved, binds: { ...VOICE_DEFAULTS.binds, ...(saved.binds || {}) } };
}

function levelDb(analyser, buf) {
  const win = buf.subarray(0, Math.min(buf.length, analyser.fftSize)); // exactly the analyser's window
  analyser.getFloatTimeDomainData(win);
  let sum = 0;
  for (let i = 0; i < win.length; i++) sum += win[i] * win[i];
  return 20 * Math.log10(Math.sqrt(sum / win.length) + 1e-9);
}

class VoiceEngine {
  /**
   * @param send          (msg) => void            JSON voice-* control message to the lobby server
   * @param sendAudio     (Uint8Array) => void     binary audio frame to the lobby server
   * @param loadWasm      (name) => Promise<ArrayBuffer|Uint8Array>  noise model bytes ('gtcrn')
   * @param getPeerPrefs  (peerId) => { volume, muted } remembered for that person
   */
  constructor({ send, sendAudio, loadWasm = null, getPeerPrefs = () => ({ volume: 1, muted: false }) }) {
    this.send = send;
    this.sendAudio = sendAudio;
    this.loadWasm = loadWasm;
    this.getPeerPrefs = getPeerPrefs;
    this.settings = loadVoiceSettings();
    this.onChange = () => {};

    this.joined = false;
    this.joining = false;
    this.micTest = false;
    this.muted = false;
    this.deafened = false;
    this.serverMuted = false;  // muted for everyone by the host
    this.micError = null;
    this.noiseError = null;
    this.level = -100;         // current mic level, dBFS (for the meter)
    this.thresholdNow = this.settings.threshold;
    this.speaking = false;     // the gate is open (we are heard / would be heard)
    this.pttHeld = false;
    this.pttReleaseAt = 0;
    this.peers = new Map();    // id -> peer

    this.ctx = null;
    this.noiseFloor = -70;
    this.lastLoud = 0;
    this.vadTimer = null;
    this.seq = 0;
    this.ts = 0;
    this.wasmCache = {};
  }

  // ---------- public API ----------

  async join() {
    if (this.joined || this.joining) return;
    this.joining = true;
    try {
      await this._ensureMic();
      this._startEncoder();
      this.joined = true;
      this.serverMuted = false;
      this.send({ type: 'voice-join' });
      this._sendState();
      this._cue('join');
    } finally {
      this.joining = false;
      this._changed();
    }
  }

  leave() {
    if (!this.joined) return;
    this._cue('leave');
    this.send({ type: 'voice-leave' });
    this._teardown();
  }

  /** The lobby connection dropped and came back under a new id: re-announce ourselves. */
  rejoin() {
    if (!this.joined) return;
    for (const id of [...this.peers.keys()]) this._closePeer(id);
    this.send({ type: 'voice-join' });
    this._sendState();
    this._changed();
  }

  /** Leaving the lobby: drop everything without telling a server that's gone. */
  shutdown() {
    this.micTest = false;
    if (this.joined) this._teardown();
    else this._releaseMic();
  }

  setMuted(muted) {
    if (this.deafened && !muted) this.deafened = false; // unmuting while deafened undeafens, like Discord
    this.muted = !!muted;
    this._cue(this.muted ? 'mute' : 'unmute');
    this._applyOutput();
    this._sendState();
    this._changed();
  }

  setDeafened(deafened) {
    this.deafened = !!deafened;
    this._cue(this.deafened ? 'deafen' : 'undeafen');
    this._applyOutput();
    this._sendState();
    this._changed();
  }

  /** The host muted / unmuted us for everyone (from the member list). */
  setServerMuted(on) {
    if (this.serverMuted === !!on) return;
    this.serverMuted = !!on;
    if (this.joined) this._cue(on ? 'mute' : 'unmute');
    this._changed();
  }

  /** Push-to-talk key went down / up. */
  setPttHeld(down) {
    if (down) this.pttHeld = true;
    else if (this.pttHeld) {
      this.pttHeld = false;
      this.pttReleaseAt = performance.now() + this.settings.pttReleaseMs;
    }
  }

  /** "Mic test": hear yourself exactly as others would (processing + gate), without joining. */
  async setMicTest(on) {
    this.micTest = !!on;
    if (this.micTest) await this._ensureMic();
    if (this.monitor) this.monitor.gain.setTargetAtTime(this.micTest ? 1 : 0, this.ctx.currentTime, 0.02);
    if (!this.micTest && !this.joined) this._releaseMic();
    this._changed();
  }

  /** Change settings; rebuilds only what the change affects. */
  async updateSettings(patch) {
    const before = this.settings;
    this.settings = { ...before, ...patch, binds: { ...before.binds, ...(patch.binds || {}) } };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    if (this.ctx) {
      const micKeys = ['inputDeviceId', 'noiseCancel', 'echoCancellation', 'autoGainControl'];
      if (this.mic && micKeys.some((k) => before[k] !== this.settings[k])) await this._startMic();
      if (before.outputDeviceId !== this.settings.outputDeviceId) await this._applySink();
      if (this.joined && before.bitrate !== this.settings.bitrate) this._startEncoder();
      this.inGain.gain.value = this.settings.inputVolume;
      this._applyOutput();
    }
    this._changed();
  }

  /** Re-read remembered volume / local mute for each person (after the user changed one). */
  refreshPeerPrefs() {
    for (const p of this.peers.values()) this._applyPeerPrefs(p);
  }

  async listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const pick = (kind) => all.filter((d) => d.kind === kind).map((d) => ({ id: d.deviceId, label: d.label || (kind === 'audioinput' ? 'Microphone' : 'Speakers') }));
    return { inputs: pick('audioinput'), outputs: pick('audiooutput') };
  }

  /** Best guess whether the chosen output is headphones (the movie can't leak into the mic then). */
  async outputLooksLikeHeadphones() {
    const { outputs } = await this.listDevices();
    const id = this.settings.outputDeviceId;
    const dev = outputs.find((d) => d.id === id) || outputs.find((d) => d.id === 'default');
    return !!dev && /head(phone|set)|earbud|earphone|airpods|buds|arctis|hyperx|kraken|cloud|blackshark/i.test(dev.label);
  }

  /** Snapshot for the UI. */
  peerInfo() {
    const out = {};
    for (const [id, p] of this.peers) out[id] = { speaking: p.speaking };
    return out;
  }

  /** Is anyone we can hear talking right now? (for ducking the movie) */
  othersTalking() {
    if (!this.joined || this.deafened) return false;
    for (const p of this.peers.values()) {
      if (!p.speaking) continue;
      const pref = this.getPeerPrefs(p.id) || {};
      if (!pref.muted && pref.volume !== 0) return true;
    }
    return false;
  }

  /** Can we be heard if we talk? */
  get canTalk() {
    return this.joined && !!this.micSrc && !this.muted && !this.deafened && !this.serverMuted;
  }

  /** JSON message from the lobby server. */
  handle(msg) {
    if (!this.joined) return;
    switch (msg.type) {
      case 'voice-peers':
        for (const id of msg.peers || []) this._peer(id);
        break;
      case 'voice-peer-joined':
        this._peer(msg.id);
        break;
      case 'voice-peer-left':
        this._closePeer(msg.id);
        break;
      case 'voice-kicked':
        this._cue('leave');
        this._teardown();
        this.onKicked && this.onKicked();
        return;
      default:
        return;
    }
    this._changed();
  }

  /** Binary frame from the lobby server: [1][8-byte sender id][4-byte seq][opus]. */
  handleAudio(bytes) {
    if (!this.joined || !bytes || bytes.length < 14 || bytes[0] !== AUDIO_MAGIC) return;
    const id = String.fromCharCode(...bytes.subarray(1, 9));
    const peer = this._peer(id);
    if (!peer.decoder || peer.decoder.state === 'closed') return;
    peer.ts += 20000;
    try {
      peer.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: peer.ts, data: bytes.subarray(13) }));
    } catch (e) {
      console.error('[voice] decode', e);
    }
  }

  // ---------- audio graph ----------

  async _ensureMic() {
    await this._buildGraph();
    if (!this.mic) await this._startMic(); // retried each time, e.g. after plugging a mic in
    if (!this.vadTimer) this.vadTimer = setInterval(() => this._tick(), VAD_TICK_MS);
  }

  async _buildGraph() {
    if (this.ctx) return;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    this.inGain = ctx.createGain();
    this.inGain.gain.value = this.settings.inputVolume;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.levelBuf = new Float32Array(1024);
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.capture = new AudioWorkletNode(ctx, 'w2g-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    this.capture.port.onmessage = (e) => this._encode(e.data);
    this.monitor = ctx.createGain(); // mic test: hear yourself after processing + gate
    this.monitor.gain.value = 0;
    this.inGain.connect(this.analyser);
    this.lookahead = ctx.createDelay(0.2);
    this.lookahead.delayTime.value = VAD_LOOKAHEAD_S;
    this.inGain.connect(this.lookahead).connect(this.gate);
    this.gate.connect(this.capture);
    this.gate.connect(this.monitor).connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.cueGain = ctx.createGain();
    this.cueGain.connect(ctx.destination);
    this._applyOutput();
    await this._applySink();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  }

  async _startMic() {
    const s = this.settings;
    this._disconnectMic();
    const constraints = {
      audio: {
        deviceId: s.inputDeviceId && s.inputDeviceId !== 'default' ? { exact: s.inputDeviceId } : undefined,
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseCancel === 'standard',
        autoGainControl: s.autoGainControl,
        channelCount: 1,
      },
    };
    try {
      this.mic = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (e && e.name === 'OverconstrainedError' && constraints.audio.deviceId) {
        // the saved mic was unplugged: fall back to the default one
        delete constraints.audio.deviceId;
        this.mic = await navigator.mediaDevices.getUserMedia(constraints).catch(() => null);
      }
      if (!this.mic) {
        // Listen-only: you can still hear everyone.
        this.micError = e && e.name === 'NotAllowedError' ? 'Microphone access was blocked.' : 'No microphone found. You can still listen.';
        return;
      }
    }
    this.micError = null;
    this.micSrc = this.ctx.createMediaStreamSource(this.mic);
    this.rawAnalyser = this.ctx.createAnalyser();
    this.rawAnalyser.fftSize = 1024;
    this.micSrc.connect(this.rawAnalyser);
    this.deadTicks = 0;
    this.denoise = await this._makeDenoiser(s.noiseCancel);
    if (this.denoise) this.micSrc.connect(this.denoise).connect(this.inGain);
    else this.micSrc.connect(this.inGain);
  }

  /** AI noise removal node, or null (off / standard / failed to load -> falls back to Chromium's). */
  async _makeDenoiser(kind) {
    this.noiseError = null;
    const proc = NOISE_PROCESSORS[kind];
    if (!proc) return null;
    try {
      if (!this.loadWasm) throw new Error('no model loader');
      const file = kind;
      if (!this.wasmCache[file]) {
        const bytes = await this.loadWasm(file);
        this.wasmCache[file] = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await this.ctx.audioWorklet.addModule(NOISE_WORKLET_URL(kind));
      }
      const node = new AudioWorkletNode(this.ctx, proc, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
        processorOptions: { maxChannels: 1, wasmBinary: this.wasmCache[file].slice(0) },
      });
      // If the model crashes on the audio thread its output goes silent: never leave the mic dead.
      node.onprocessorerror = () => this._denoiserFailed(node);
      return node;
    } catch (e) {
      console.error('[voice] noise model', e);
      this._useStandardNoiseSuppression();
      return null;
    }
  }

  _denoiserFailed(node) {
    if (this.denoise !== node || !this.micSrc) return;
    console.error('[voice] noise model crashed; bypassing it');
    this.micSrc.disconnect();
    node.disconnect();
    this.denoise = null;
    this.micSrc.connect(this.inGain);
    this._useStandardNoiseSuppression();
    this._changed();
  }

  _useStandardNoiseSuppression() {
    this.noiseError = 'AI noise cancellation could not start; using standard noise suppression.';
    if (this.mic) this.mic.getAudioTracks().forEach((t) => t.applyConstraints({ noiseSuppression: true }).catch(() => {}));
  }

  _disconnectMic() {
    if (this.mic) this.mic.getTracks().forEach((t) => t.stop());
    if (this.micSrc) this.micSrc.disconnect();
    if (this.denoise) {
      this.denoise.disconnect();
      this.denoise.port.postMessage('destroy');
    }
    this.mic = null;
    this.micSrc = null;
    this.denoise = null;
  }

  _releaseMic() {
    if (this.micTest) return;
    clearInterval(this.vadTimer);
    this.vadTimer = null;
    this._disconnectMic();
    this.micError = null;
    this.speaking = false;
    if (this.gate) this.gate.gain.value = 0;
    this.level = -100;
  }

  _startEncoder() {
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const out = new Uint8Array(5 + chunk.byteLength);
        out[0] = AUDIO_MAGIC;
        new DataView(out.buffer).setUint32(1, this.seq++);
        chunk.copyTo(out.subarray(5));
        this.sendAudio(out);
      },
      error: (e) => console.error('[voice] encoder', e),
    });
    this.encoder.configure({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: this.settings.bitrate,
      opus: { frameDuration: 20000, complexity: 10 },
    });
  }

  _encode(frame) {
    if (!this.joined || !this.encoder || this.encoder.state !== 'configured' || !this.canTalk) return;
    const data = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: FRAME_SAMPLES, numberOfChannels: 1, timestamp: this.ts, data: frame });
    this.ts += 20000;
    this.encoder.encode(data);
    data.close();
  }

  async _applySink() {
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return;
    const id = this.settings.outputDeviceId;
    await this.ctx.setSinkId(id && id !== 'default' ? id : '').catch(() => {
      this.settings.outputDeviceId = 'default';
      return this.ctx.setSinkId('').catch(() => {});
    });
  }

  _applyOutput() {
    if (!this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.deafened ? 0 : this.settings.outputVolume, t, 0.015);
    this.cueGain.gain.value = Math.min(1, this.settings.outputVolume) * 0.35;
  }

  /** Voice activity / push-to-talk + speaking detection, every 20 ms. */
  _tick() {
    if (!this.ctx) return;
    const now = performance.now();
    const db = this.micSrc ? levelDb(this.analyser, this.levelBuf) : -100;
    this.level = db;

    // Watchdog: a noise model that failed to start inside the audio thread outputs pure silence.
    if (this.denoise && db < -150 && levelDb(this.rawAnalyser, this.levelBuf) > -70) {
      if (++this.deadTicks >= DENOISE_DEAD_TICKS) this._denoiserFailed(this.denoise);
    } else {
      this.deadTicks = 0;
    }

    let threshold = this.settings.threshold;
    if (this.settings.autoSensitivity) {
      // Track the room's noise floor: drop to quiet moments at once, creep up slowly.
      if (db < this.noiseFloor) this.noiseFloor = db;
      else this.noiseFloor += 0.04;
      threshold = Math.max(AUTO_MIN_DB, Math.min(AUTO_MAX_DB, this.noiseFloor + AUTO_MARGIN_DB));
    }
    let othersTalking = false;
    for (const p of this.peers.values()) if (p.speaking) othersTalking = true;
    if (othersTalking) threshold += ECHO_GUARD_DB;
    this.thresholdNow = threshold;
    if (db > threshold) {
      if (this.aboveSince == null) this.aboveSince = now;
      // open after sustained sound; once open, any sound above the threshold keeps it open
      if (now - this.aboveSince >= VAD_ATTACK_MS || this.speaking) this.lastLoud = now;
    } else {
      this.aboveSince = null;
    }

    const keyOpen = this.settings.mode === 'ptt'
      ? this.pttHeld || now < this.pttReleaseAt
      : now - this.lastLoud < VAD_RELEASE_MS;
    const allowed = this.joined ? this.canTalk : this.micTest && !!this.micSrc;
    const open = allowed && keyOpen;
    if (open !== this.speaking) {
      this.speaking = open;
      this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, open ? 0.004 : 0.03);
      this.capture.port.postMessage({ tx: open && this.joined });
      this._changed();
    }

    for (const p of this.peers.values()) {
      if (levelDb(p.pre, p.buf) > REMOTE_SPEAKING_DB) p.lastLoud = now;
      const speaking = now - (p.lastLoud || 0) < SPEAKING_HOLD_MS;
      if (speaking !== p.speaking) {
        p.speaking = speaking;
        this._changed();
      }
    }
  }

  // ---------- peers ----------

  _peer(id) {
    let p = this.peers.get(id);
    if (p) return p;
    p = { id, speaking: false, lastLoud: 0, ts: 0 };
    this.peers.set(id, p);
    p.player = new AudioWorkletNode(this.ctx, 'w2g-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    p.gain = this.ctx.createGain();
    p.analyser = this.ctx.createAnalyser();
    p.analyser.fftSize = 512;
    p.pre = this.ctx.createAnalyser(); // before their volume: the ring shows even if you turned them down
    p.pre.fftSize = 512;
    p.buf = new Float32Array(p.pre.fftSize);
    p.player.connect(p.pre);
    p.player.connect(p.gain);
    p.gain.connect(p.analyser);
    p.gain.connect(this.master);
    p.decoder = new AudioDecoder({
      output: (data) => {
        const f = new Float32Array(data.numberOfFrames);
        data.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
        data.close();
        p.player.port.postMessage(f, [f.buffer]);
      },
      error: (e) => console.error('[voice] decoder', e),
    });
    p.decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    this._applyPeerPrefs(p);
    return p;
  }

  _applyPeerPrefs(peer) {
    const pref = this.getPeerPrefs(peer.id) || {};
    const vol = pref.muted ? 0 : Math.max(0, Math.min(2, pref.volume == null ? 1 : pref.volume));
    peer.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.015);
  }

  _closePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { if (p.decoder.state !== 'closed') p.decoder.close(); } catch { /* ignore */ }
    p.player.disconnect();
    p.gain.disconnect();
  }

  // ---------- misc ----------

  _sendState() {
    if (this.joined) this.send({ type: 'voice-state', muted: this.muted, deafened: this.deafened });
  }

  _teardown() {
    this.joined = false;
    this.serverMuted = false;
    this.pttHeld = false;
    for (const id of [...this.peers.keys()]) this._closePeer(id);
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = null;
    if (this.capture) this.capture.port.postMessage({ tx: false });
    this._releaseMic();
    this._changed();
  }

  /** Short synthesized sounds (no audio files): join/leave/mute/deafen. */
  _cue(kind) {
    if (!this.settings.soundCues || !this.ctx) return;
    const notes = {
      join: [523.25, 783.99],
      leave: [783.99, 523.25],
      mute: [440, 330],
      unmute: [330, 440],
      deafen: [392, 262],
      undeafen: [262, 392],
    }[kind];
    if (!notes) return;
    const t0 = this.ctx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      o.connect(g).connect(this.cueGain);
      o.start(t);
      o.stop(t + 0.18);
    });
  }

  _changed() {
    try { this.onChange(); } catch (e) { console.error('[voice] onChange', e); }
  }
}

window.VoiceEngine = VoiceEngine;
