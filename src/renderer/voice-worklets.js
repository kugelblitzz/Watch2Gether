'use strict';

/* Audio-thread helpers for voice chat (loaded with audioWorklet.addModule).
 *
 * w2g-capture: collects the (gated) mic signal into 20 ms frames and hands them
 *              to the page for Opus encoding, only while we're transmitting.
 * w2g-player:  per-person playback with a small jitter buffer: waits for ~60 ms
 *              before starting a talk spurt, plays silence on underrun, and skips
 *              ahead if it ever falls more than ~200 ms behind (clock drift, bursts).
 */

const FRAME = 960; // 20 ms at 48 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tx = false;
    this.buf = new Float32Array(FRAME);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (typeof e.data.tx === 'boolean') {
        this.tx = e.data.tx;
        if (!this.tx) this.n = 0;
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!this.tx || !ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, FRAME - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === FRAME) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(FRAME);
        this.n = 0;
      }
    }
    return true;
  }
}

const PREBUFFER = 2880; // 60 ms
const MAX_BUFFER = 9600; // 200 ms

class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; // Float32Array chunks
    this.offset = 0; // read position inside queue[0]
    this.buffered = 0; // samples queued
    this.playing = false;
    this.port.onmessage = (e) => {
      const f = e.data;
      if (!(f instanceof Float32Array)) return;
      this.queue.push(f);
      this.buffered += f.length;
      while (this.buffered > MAX_BUFFER && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.buffered -= dropped.length - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.playing && this.buffered >= PREBUFFER) this.playing = true;
    if (!this.playing) return true; // output stays silent
    let i = 0;
    while (i < out.length && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(out.length - i, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + take), i);
      i += take;
      this.offset += take;
      this.buffered -= take;
      if (this.offset === head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (i < out.length) this.playing = false; // underrun: wait for a fresh prebuffer
    return true;
  }
}

registerProcessor('w2g-capture', CaptureProcessor);
registerProcessor('w2g-player', PlayerProcessor);
