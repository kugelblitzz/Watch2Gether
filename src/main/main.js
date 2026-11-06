'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { HostServer } = require('./server');
const { Session } = require('./session');
const { getTailscaleInfo, findMpv, installMpvWithWinget, lanIp } = require('./env');
const { parseInvite } = require('./util');
const { initUpdater, installUpdate } = require('./updater');

const VIDEO_FILTERS = [
  { name: 'Videos', extensions: ['mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'wmv'] },
  { name: 'All files', extensions: ['*'] },
];
const DEFAULT_PORT = 8787;

let win = null;
let server = null;
let session = null;
let lobbyInfo = null;
let settings = { name: '', port: DEFAULT_PORT, mpvPath: null, lastInvite: '', allowLan: false };

// ---------- settings ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch { /* first run */ }
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch { /* non-fatal */ }
  return settings;
}

function mpvSearchDirs() {
  return [
    path.join(process.resourcesPath || '', 'mpv'),
    path.join(__dirname, '..', '..', 'vendor', 'mpv'),
  ];
}

function resolveMpv() {
  return findMpv(mpvSearchDirs(), settings.mpvPath);
}

// ---------- session plumbing ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function wireSession(s) {
  s.on('update', (u) => send('update', { ...u, lobby: lobbyInfo }));
  s.on('ended', (reason) => {
    leave();
    send('ended', reason);
  });
}

async function leave() {
  if (session) {
    session.removeAllListeners();
    session.stop();
    session = null;
  }
  if (server) {
    server.stop();
    server = null;
  }
  lobbyInfo = null;
}

function requireMpv() {
  const mpvPath = resolveMpv();
  if (!mpvPath) throw new Error('mpv was not found. Use "Install mpv" on the home screen, or point the app at mpv.exe.');
  return mpvPath;
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_e, patch) => saveSettings(patch || {}));

  ipcMain.handle('env:check', async () => ({
    mpvPath: resolveMpv(),
    tailscale: await getTailscaleInfo(),
  }));

  ipcMain.handle('mpv:install', async () => {
    const r = await installMpvWithWinget();
    return { ...r, mpvPath: resolveMpv() };
  });

  ipcMain.handle('mpv:browse', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Locate mpv.exe',
      filters: [{ name: 'mpv', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    saveSettings({ mpvPath: r.filePaths[0] });
    return r.filePaths[0];
  });

  ipcMain.handle('file:pick', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a video', filters: VIDEO_FILTERS, properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    return { path: p, name: path.basename(p), size: fs.statSync(p).size };
  });

  ipcMain.handle('host:start', async (_e, { name, filePath, port, allowLan }) => {
    await leave();
    const mpvPath = requireMpv();
    port = Number(port) || DEFAULT_PORT;
    saveSettings({ name, port, allowLan: !!allowLan });
    const ts = await getTailscaleInfo();

    const srv = new HostServer({ port, allowLan: !!allowLan });
    await srv.start();
    server = srv;
    try {
      srv.setMedia(filePath);
      const addr = ts.ip || (allowLan ? lanIp() : null) || '127.0.0.1';
      lobbyInfo = {
        role: 'host',
        code: srv.code,
        invite: `${addr}:${port}/${srv.code}`,
        inviteDns: ts.dnsName ? `${ts.dnsName}:${port}/${srv.code}` : null,
        tailscale: ts,
        port,
      };
      session = new Session({
        baseUrl: `http://127.0.0.1:${port}`,
        code: srv.code,
        name,
        hostToken: srv.hostToken,
        mpvPath,
        resolveLocal: (m) => (server && server.media && m.id === server.media.id ? server.media.path : null),
      });
      wireSession(session);
      await session.start();
      return lobbyInfo;
    } catch (e) {
      await leave();
      throw e;
    }
  });

  ipcMain.handle('host:change', async (_e, filePath) => {
    if (!server) throw new Error('You are not hosting a lobby.');
    server.setMedia(filePath);
    return true;
  });

  ipcMain.handle('join', async (_e, { name, invite, localPath }) => {
    await leave();
    const mpvPath = requireMpv();
    const inv = parseInvite(invite, DEFAULT_PORT);
    saveSettings({ name, lastInvite: invite });
    lobbyInfo = { role: 'guest', code: inv.code, invite: `${inv.host}:${inv.port}/${inv.code}`, host: inv.host, port: inv.port };
    session = new Session({
      baseUrl: inv.baseUrl,
      code: inv.code,
      name,
      mpvPath,
      resolveLocal: (m) => {
        if (!localPath) return null;
        try { return fs.statSync(localPath).size === m.size ? localPath : null; } catch { return null; }
      },
    });
    wireSession(session);
    try {
      await session.start();
    } catch (e) {
      await leave();
      throw e;
    }
    return lobbyInfo;
  });

  ipcMain.handle('session:cmd', (_e, { action, position }) => {
    if (session) session.command(action, position);
  });
  ipcMain.handle('session:chat', (_e, text) => {
    if (session) session.chat(text);
  });
  ipcMain.handle('player:reopen', async () => {
    if (session) await session.reopenPlayer();
  });
  ipcMain.handle('session:leave', () => leave());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:installUpdate', async () => {
    await leave();
    installUpdate();
  });
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'Watch2Gether',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    loadSettings();
    registerIpc();
    createWindow();
    initUpdater((u) => send('app-update', u));
  });
  app.on('before-quit', () => { leave(); });
  app.on('window-all-closed', () => {
    leave();
    app.quit();
  });
}
