'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('w2g', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  checkEnv: () => ipcRenderer.invoke('env:check'),
  installMpv: () => ipcRenderer.invoke('mpv:install'),
  browseMpv: () => ipcRenderer.invoke('mpv:browse'),
  pickFile: (title) => ipcRenderer.invoke('file:pick', title),
  host: (opts) => ipcRenderer.invoke('host:start', opts),
  changeVideo: (filePath) => ipcRenderer.invoke('host:change', filePath),
  join: (opts) => ipcRenderer.invoke('join', opts),
  cmd: (action, position) => ipcRenderer.invoke('session:cmd', { action, position }),
  chat: (text) => ipcRenderer.invoke('session:chat', text),
  reopenPlayer: () => ipcRenderer.invoke('player:reopen'),
  leave: () => ipcRenderer.invoke('session:leave'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, u) => cb(u)),
  onEnded: (cb) => ipcRenderer.on('ended', (_e, reason) => cb(reason)),
});
