'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const wasmDir = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor'));
const WASM = { gtcrn: 'gtcrn.wasm' };

contextBridge.exposeInMainWorld('bridge', {
  send: (m) => ipcRenderer.send('to-server', m),
  onVoice: (cb) => ipcRenderer.on('voice', (_e, m) => cb(m)),
  sendAudio: (b) => ipcRenderer.send('to-server-audio', b),
  onAudio: (cb) => ipcRenderer.on('voice-audio', (_e, b) => cb(b)),
  loadWasm: async (name) => new Uint8Array(fs.readFileSync(path.join(wasmDir, WASM[name]))),
  speechWav: async () => new Uint8Array(fs.readFileSync(process.argv.find((a) => a.startsWith('--w2g-speech=')).slice(13))),
});
