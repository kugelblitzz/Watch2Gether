'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  send: (m) => ipcRenderer.send('to-server', m),
  onVoice: (cb) => ipcRenderer.on('voice', (_e, m) => cb(m)),
  sendAudio: (b) => ipcRenderer.send('to-server-audio', b),
  onAudio: (cb) => ipcRenderer.on('voice-audio', (_e, b) => cb(b)),
});
