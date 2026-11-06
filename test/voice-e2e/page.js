'use strict';
// One test participant: the real VoiceEngine wired to the harness bridge.
window.prefs = {};
window.engine = new VoiceEngine({
  send: (m) => window.bridge.send(m),
  sendAudio: (b) => window.bridge.sendAudio(b),
  getPeerPrefs: (id) => window.prefs[id] || { volume: 1, muted: false },
});
window.bridge.onVoice((m) => window.engine.handle(m));
window.bridge.onAudio((b) => window.engine.handleAudio(b));
window.peerLevel = (id) => {
  const p = window.engine.peers.get(id);
  if (!p || !p.analyser) return -200;
  const buf = new Float32Array(p.analyser.fftSize);
  p.analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const x of buf) s += x * x;
  return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
};
