'use strict';

/**
 * Voice chat engine (renderer).
 *
 *   mic -> input volume -> [level meter / voice activity] -> gate -> capture -> Opus encoder
 *        -> lobby connection -> host relays to everyone else in voice ->
 *   Opus decoder -> jitter buffer -> their volume (0-200 %) -> output volume -> speakers
 *
 * Audio rides the existing lobby connection (over Tailscale) instead of direct
 * WebRTC peer links: Chromium doesn't gather ICE candidates on the Tailscale
 * adapter, so peer-to-peer would only work on a shared LAN. Frames are only sent
 * while you talk, so silence costs nothing and the speaking ring is exact.
 *
 * Usage: const v = new VoiceEngine({ send, sendAudio, getPeerPrefs });
 *        v.onChange = fn; v.handle(jsonMsg); v.handleAudio(bytes)
 */

const VOICE_DEFAULTS = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputVolume: 1,          // 0..2
  outputVolume: 1,         // 0..2
  autoSensitivity: true,
  threshold: -50,          // dBFS, used when autoSensitivity is off
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  soundCues: true,
  bitrate: 64000,          // Opus, bits/s
};

const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 960;       // 20 ms
const VAD_TICK_MS = 20;
const VAD_RELEASE_MS = 300;      // keep sending this long after speech, so word endings survive
const SPEAKING_HOLD_MS = 250;
const SETTINGS_KEY = 'w2g.voice';
const AUDIO_MAGIC = 1;           // first byte of a binary voice frame
const WORKLET_URL = new URL('voice-worklets.js', document.currentScript.src).href;

function loadVoiceSettings() {
  try { return { ...VOICE_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...VOICE_DEFAULTS }; }
}

function levelDb(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
}

class VoiceEngine {
  /**
   * @param send          (msg) => void            JSON voice-* control message to the lobby server
   * @param sendAudio     (Uint8Array) => void     binary audio frame to the lobby server
   * @param getPeerPrefs  (peerId) => { volume, muted } remembered for that person
   */
  constructor({ send, sendAudio, getPeerPrefs = () => ({ volume: 1, muted: false }) }) {
    this.send = send;
    this.sendAudio = sendAudio;
    this.getPeerPrefs = getPeerPrefs;
    this.settings = loadVoiceSettings();
    this.onChange = () => {};

    this.joined = false;
    this.joining = false;
    this.muted = false;
    this.deafened = false;
    this.micError = null;
    this.level = -100;        // current mic level, dBFS (for the meter)
    this.thresholdNow = this.settings.threshold;
    this.speaking = false;    // we are transmitting
    this.peers = new Map();   // id -> peer

    this.ctx = null;
    this.noiseFloor = -70;
    this.lastLoud = 0;
    this.vadTimer = null;
    this.seq = 0;
    this.ts = 0;
  }

  // ---------- public API ----------

  async join() {
    if (this.joined || this.joining) return;
    this.joining = true;
    try {
      await this._buildGraph();
      await this._startMic();
      this._startEncoder();
      this.joined = true;
      this.send({ type: 'voice-join' });
      this._sendState();
      this.vadTimer = setInterval(() => this._tick(), VAD_TICK_MS);
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
    if (this.joined) this._teardown();
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

  /** Change settings; restarts the mic only if a mic-side option changed. */
  async updateSettings(patch) {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    if (!this.ctx) return this._changed();
    const micKeys = ['inputDeviceId', 'noiseSuppression', 'echoCancellation', 'autoGainControl'];
    if (this.joined && micKeys.some((k) => before[k] !== this.settings[k])) await this._startMic();
    if (before.outputDeviceId !== this.settings.outputDeviceId) await this._applySink();
    if (this.joined && before.bitrate !== this.settings.bitrate) this._startEncoder();
    this.inGain.gain.value = this.settings.inputVolume;
    this._applyOutput();
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

  /** JSON message from the lobby server (voice-peers / voice-peer-joined / voice-peer-left). */
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
    peer.lastFrame = performance.now();
    peer.ts += 20000;
    try {
      peer.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: peer.ts, data: bytes.subarray(13) }));
    } catch (e) {
      console.error('[voice] decode', e);
    }
  }

  // ---------- audio graph ----------

  async _buildGraph() {
    if (this.ctx) return;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    this.inGain = ctx.createGain();
    this.inGain.gain.value = this.settings.inputVolume;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.capture = new AudioWorkletNode(ctx, 'w2g-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    this.capture.port.onmessage = (e) => this._encode(e.data);
    this.inGain.connect(this.analyser);
    this.inGain.connect(this.gate).connect(this.capture);

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
    if (this.mic) this.mic.getTracks().forEach((t) => t.stop());
    if (this.micSrc) this.micSrc.disconnect();
    this.mic = null;
    this.micSrc = null;
    const constraints = {
      audio: {
        deviceId: s.inputDeviceId && s.inputDeviceId !== 'default' ? { exact: s.inputDeviceId } : undefined,
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
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
    this.micSrc.connect(this.inGain);
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
    if (!this.encoder || this.encoder.state !== 'configured' || !this.speaking) return;
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

  /** Voice activity + speaking detection, every 20 ms. */
  _tick() {
    if (!this.ctx) return;
    const now = performance.now();
    const db = this.micSrc ? levelDb(this.analyser, this.levelBuf) : -100;
    this.level = db;

    let threshold = this.settings.threshold;
    if (this.settings.autoSensitivity) {
      // Track the room's noise floor: drop to quiet moments at once, creep up slowly.
      if (db < this.noiseFloor) this.noiseFloor = db;
      else this.noiseFloor += 0.04;
      threshold = Math.max(-62, Math.min(-25, this.noiseFloor + 14));
    }
    this.thresholdNow = threshold;
    if (db > threshold) this.lastLoud = now;
    const transmit = this.joined && !!this.micSrc && !this.muted && !this.deafened && now - this.lastLoud < VAD_RELEASE_MS;
    if (transmit !== this.speaking) {
      this.speaking = transmit;
      this.gate.gain.setTargetAtTime(transmit ? 1 : 0, this.ctx.currentTime, transmit ? 0.004 : 0.03);
      this.capture.port.postMessage({ tx: transmit });
      this._changed();
    }

    for (const p of this.peers.values()) {
      const speaking = now - p.lastFrame < SPEAKING_HOLD_MS;
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
    p = { id, speaking: false, lastFrame: 0, ts: 0 };
    this.peers.set(id, p);
    p.player = new AudioWorkletNode(this.ctx, 'w2g-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    p.gain = this.ctx.createGain();
    p.analyser = this.ctx.createAnalyser();
    p.analyser.fftSize = 512;
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
    clearInterval(this.vadTimer);
    this.vadTimer = null;
    for (const id of [...this.peers.keys()]) this._closePeer(id);
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = null;
    if (this.mic) this.mic.getTracks().forEach((t) => t.stop());
    this.mic = null;
    if (this.micSrc) this.micSrc.disconnect();
    this.micSrc = null;
    this.speaking = false;
    if (this.gate) this.gate.gain.value = 0;
    if (this.capture) this.capture.port.postMessage({ tx: false });
    this.level = -100;
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
