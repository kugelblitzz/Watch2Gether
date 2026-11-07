'use strict';
// One test participant: the real VoiceEngine wired to the harness bridge.

// Silent: every AudioContext renders to no device, so tests never play through
// the speakers. Levels are measured with analysers inside the graph instead.
const RealAudioContext = window.AudioContext;
window.AudioContext = class SilentAudioContext extends RealAudioContext {
  constructor(opts = {}) { super({ ...opts, sinkId: { type: 'none' } }); }
  setSinkId() { return Promise.resolve(); }
};

// Controlled microphone input: null = Chromium's fake device (a beep),
// or 'noise' | 'speech' | 'speech+noise' from a looping buffer.
window.fakeInput = null;
const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  if (!window.fakeInput) return realGetUserMedia(constraints);
  const ctx = window.fakeCtx || (window.fakeCtx = new AudioContext({ sampleRate: 48000 }));
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = await makeInput(ctx, window.fakeInput);
  src.loop = true;
  src.connect(dest);
  src.start();
  return dest.stream;
};

async function makeInput(ctx, kind) {
  let speech = null;
  if (kind.includes('speech') || kind === 'faint') speech = await ctx.decodeAudioData((await window.bridge.speechWav()).buffer.slice(0));
  const len = speech ? speech.length : ctx.sampleRate * 3;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const out = buf.getChannelData(0);
  if (speech) out.set(speech.getChannelData(0).subarray(0, len));
  if (kind === 'clicks') { // keyboard-like clicks: 8 ms loud bursts every 400 ms
    const burst = Math.round(ctx.sampleRate * 0.008);
    for (let start = 0; start < len; start += Math.round(ctx.sampleRate * 0.4)) {
      for (let i = start; i < Math.min(len, start + burst); i++) out[i] = (Math.random() * 2 - 1) * 0.4;
    }
  }
  if (kind === 'faint') { // speech at ~-55 dB: like a friend's voice leaking back from speakers
    const s = speech || (await ctx.decodeAudioData((await window.bridge.speechWav()).buffer.slice(0)));
    const d = s.getChannelData(0);
    for (let i = 0; i < len; i++) out[i] = d[i % d.length] * 0.006;
  }
  if (kind.includes('noise')) {
    const amp = speech ? 0.03 : 0.05; // loud room noise (~-31 dBFS): fan, keyboard, traffic
    for (let i = 0; i < len; i++) out[i] += (Math.random() * 2 - 1) * amp;
  }
  return buf;
}

window.prefs = {};
window.engine = new VoiceEngine({
  send: (m) => window.bridge.send(m),
  sendAudio: (b) => window.bridge.sendAudio(b),
  loadWasm: (name) => (window.badWasm ? Promise.resolve(new Uint8Array([0, 97, 115, 109, 9, 9])) : window.bridge.loadWasm(name)),
  getPeerPrefs: (id) => window.prefs[id] || { volume: 1, muted: false },
});
window.engine.settings.soundCues = false;
// which sound cues the engine asked for (they stay silent: soundCues is off)
window.cues = [];
const realCue = window.engine._cue.bind(window.engine);
window.engine._cue = (kind) => { window.cues.push(kind); realCue(kind); };
window.bridge.onVoice((m) => window.engine.handle(m));
window.bridge.onAudio((b) => window.engine.handleAudio(b));

function rms(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const x of buf) s += x * x;
  return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
}
window.peerLevel = (id) => {
  const p = window.engine.peers.get(id);
  return p && p.analyser ? rms(p.analyser) : -200;
};
window.monitorLevel = () => {
  const e = window.engine;
  if (!e.monitorTap) {
    e.monitorTap = e.ctx.createAnalyser();
    e.monitorTap.fftSize = 1024;
    e.monitor.connect(e.monitorTap);
  }
  return rms(e.monitorTap);
};
