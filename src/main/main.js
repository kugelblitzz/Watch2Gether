'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { HostServer } = require('./server');
const { Session } = require('./session');
const { getTailscaleInfo, findMpv, installMpvWithWinget, lanIp } = require('./env');
const { parseInvite } = require('./util');
const { initUpdater, installUpdate, checkNow, checkAfterLobby } = require('./updater');
const { Hotkeys } = require('./hotkeys');

// Echo cancellation must hear everything the app plays (voice is played through Web
// Audio, not a WebRTC call), otherwise friends on speakers send our own voice back.
app.commandLine.appendSwitch('enable-features', 'ChromeWideEchoCancellation');

const hotkeys = new Hotkeys();
hotkeys.on('action', (action, down) => send('hotkey', { action, down }));
hotkeys.on('error', (e) => console.error('[hotkeys]', e && e.message));

/** Noise-suppression model shipped with @sapphi-red/web-noise-suppressor. */
const NOISE_WASM = { gtcrn: 'gtcrn.wasm' };



const VIDEO_FILTERS = [
  { name: 'Videos', extensions: ['mkv', 'mp4', 'm4v', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'wmv'] },
  { name: 'All files', extensions: ['*'] },
];
const DEFAULT_PORT = 8787;

let win = null;
let server = null;
let session = null;
let lobbyInfo = null;
let settings = { name: '', port: DEFAULT_PORT, mpvPath: null, lastInvite: '', allowLan: false, playerMode: 'embedded', volume: 100 };
let videoHost = null; // native window the in-app player draws into
let lastJoin = null;  // { invite, localPath } of the lobby we joined as a guest

/** A lobby saved before "Restart to update" is only picked up again within this window. */
const RESUME_MAX_AGE_MS = 15 * 60 * 1000;

/** Remember the current lobby (and voice state) so the updated app can go straight back. */
function saveResume(voice) {
  if (!lobbyInfo) return;
  const rec = {
    at: Date.now(),
    name: settings.name,
    role: lobbyInfo.role,
    voice: voice && typeof voice === 'object'
      ? { inVoice: !!voice.inVoice, muted: !!voice.muted, deafened: !!voice.deafened }
      : null,
  };
  if (lobbyInfo.role === 'host' && server) {
    rec.host = {
      port: lobbyInfo.port,
      allowLan: !!settings.allowLan,
      code: server.code,
      hostToken: server.hostToken,
      filePath: server.media ? server.media.path : null,
      mediaId: server.media ? server.media.id : null,
      position: server.media ? server._currentPosition() : 0,
    };
  } else if (lastJoin) {
    rec.guest = { invite: lastJoin.invite, localPath: lastJoin.localPath || null };
  } else {
    return;
  }
  saveSettings({ resume: rec });
}

/** Where the player draws: inside the app (embedded) or in mpv's own window (popout). */
function playerWid() {
  return settings.playerMode === 'embedded' && videoHost ? videoHost.wid : null;
}

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

let volumeTimer = null;
/** Remember the volume, but don't write the settings file on every slider step. */
function saveVolumeSoon(v) {
  settings.volume = v;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => saveSettings({ volume: settings.volume }), 800);
}

function wireSession(s) {
  s.on('update', (u) => send('update', { ...u, lobby: lobbyInfo }));
  s.on('voice', (msg) => send('voice', msg));
  s.on('voice-audio', (buf) => send('voice-audio', buf));
  s.on('volume', (v) => {
    if (v !== settings.volume) saveVolumeSoon(v);
  });
  s.on('player-request', (r) => {
    if (!win) return;
    if (r === 'fullscreen') win.setFullScreen(!win.isFullScreen());
    if (r === 'exit-fullscreen' && win.isFullScreen()) win.setFullScreen(false);
  });
  s.on('ended', (reason) => {
    leave();
    send('ended', reason);
    setTimeout(checkAfterLobby, 3000);
  });
}

/** @param restarting  restarting for an update: guests keep reconnecting instead of leaving */
async function leave({ restarting = false } = {}) {
  hotkeys.stop();
  if (session) {
    session.removeAllListeners();
    session.stop();
    session = null;
  }
  if (server) {
    server.stop({ restarting });
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

  ipcMain.handle('host:start', async (_e, { name, filePath, port, allowLan, resume }) => {
    // resume: { code, hostToken, mediaId, position } to reopen the lobby we had before an update
    await leave();
    const mpvPath = requireMpv();
    port = Number(port) || DEFAULT_PORT;
    saveSettings({ name, port, allowLan: !!allowLan });
    const ts = await getTailscaleInfo();

    const r = resume && typeof resume === 'object' ? resume : {};
    const srv = new HostServer({ port, allowLan: !!allowLan, code: r.code, hostToken: r.hostToken });
    await srv.start();
    server = srv;
    try {
      if (filePath) {
        try {
          srv.setMedia(filePath, { id: r.mediaId, position: r.position }); // optional: the host can pick one later
        } catch (e) {
          if (!resume) throw e; // reopening after an update and the file moved: open the lobby without it
        }
      }
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
        getWid: playerWid,
        getVolume: () => settings.volume,
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
    lastJoin = { invite, localPath: localPath || null };
    lobbyInfo = { role: 'guest', code: inv.code, invite: `${inv.host}:${inv.port}/${inv.code}`, host: inv.host, port: inv.port };
    session = new Session({
      getWid: playerWid,
      getVolume: () => settings.volume,
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
  ipcMain.handle('video:rect', (_e, rect) => {
    if (videoHost) videoHost.setRect(rect && Number.isFinite(rect.x) ? rect : null);
  });
  ipcMain.handle('player:mode', async (_e, mode) => {
    if (mode !== 'embedded' && mode !== 'popout') return settings.playerMode;
    if (mode !== settings.playerMode) {
      saveSettings({ playerMode: mode });
      if (mode === 'popout' && win && win.isFullScreen()) win.setFullScreen(false);
      if (session) await session.restartPlayer();
    }
    return mode;
  });
  ipcMain.handle('player:volume', (_e, v) => {
    if (!Number.isFinite(Number(v))) return;
    saveVolumeSoon(Math.max(0, Math.min(130, Math.round(Number(v)))));
    if (session) session.setVolume(settings.volume);
  });
  ipcMain.handle('player:mute', (_e, on) => {
    if (session) session.setMute(!!on);
  });
  ipcMain.handle('window:fullscreen', (_e, on) => {
    if (win) win.setFullScreen(typeof on === 'boolean' ? on : !win.isFullScreen());
  });
  ipcMain.handle('voice:send', (_e, msg) => {
    if (session) session.voiceSend(msg);
  });
  ipcMain.handle('voice:wasm', (_e, name) => {
    const file = NOISE_WASM[name];
    if (!file) throw new Error('Unknown model');
    const dir = path.dirname(require.resolve('@sapphi-red/web-noise-suppressor'));
    return fs.readFileSync(path.join(dir, file));
  });
  ipcMain.handle('hotkeys:set', (_e, bindings, enabled) => hotkeys.setBindings(bindings, enabled));
  ipcMain.handle('hotkeys:capture', () => hotkeys.captureNext());
  ipcMain.handle('hotkeys:cancel', () => hotkeys.cancelCapture());
  ipcMain.handle('player:duck', (_e, level) => {
    if (session) session.duck(Number(level));
  });
  ipcMain.on('voice:audio', (_e, bytes) => {
    if (session && bytes instanceof Uint8Array) session.voiceAudio(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
  ipcMain.handle('session:chat', (_e, text) => {
    if (session) session.chat(text);
  });
  ipcMain.handle('player:reopen', async () => {
    if (session) await session.reopenPlayer();
  });
  ipcMain.handle('session:leave', async () => {
    await leave();
    setTimeout(checkAfterLobby, 3000);
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:checkUpdates', () => checkNow());
  ipcMain.handle('app:installUpdate', async (_e, voice) => {
    saveResume(voice); // come straight back to this lobby after the update
    await leave({ restarting: true });
    installUpdate();
  });
  /** A lobby saved just before an update restart (used once, then forgotten). */
  ipcMain.handle('app:resume', () => {
    const rec = settings.resume;
    if (rec) saveSettings({ resume: null });
    return rec && Date.now() - rec.at < RESUME_MAX_AGE_MS ? rec : null;
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
    backgroundColor: '#0b0b0d',
    title: 'Watch2Gether',
    autoHideMenuBar: true,
    // Unified title bar: the app's top bar is the title bar; Windows draws only the
    // min/max/close buttons over it. Colors must match .topbar in styles.css.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#161618', symbolColor: '#f5f5f7', height: 52 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The window usually sits behind the fullscreen player; voice activity
      // detection and speaking indicators must keep running at full rate.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  win.on('closed', () => { win = null; videoHost = null; });

  // In-app player: a native window mpv draws into, kept over the video area.
  try {
    const { VideoHost } = require('./videohost');
    videoHost = new VideoHost(win);
  } catch (e) {
    console.error('[videohost] unavailable, using the separate player window', e && e.message);
  }

  // Fullscreen: the sidebar slides in when the mouse reaches the left edge. The mouse is
  // over the native video most of the time, which the page can't see, so poll it here.
  let edgeTimer = null;
  let lastX = null;
  win.on('enter-full-screen', () => {
    send('fullscreen', true);
    clearInterval(edgeTimer);
    edgeTimer = setInterval(() => {
      if (!win) return;
      const p = screen.getCursorScreenPoint();
      const b = win.getContentBounds();
      const x = p.y >= b.y && p.y < b.y + b.height ? p.x - b.x : null;
      if (x !== lastX) {
        lastX = x;
        send('cursor-x', x);
      }
    }, 80);
  });
  win.on('leave-full-screen', () => {
    clearInterval(edgeTimer);
    lastX = null;
    send('fullscreen', false);
  });
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
    // Only the microphone (voice chat) may be requested; deny everything else.
    const { session: electronSession } = require('electron');
    electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      cb(permission === 'media' && (!details.mediaTypes || details.mediaTypes.every((t) => t === 'audio')));
    });
    electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    loadSettings();
    registerIpc();
    createWindow();
    initUpdater((u) => send('app-update', u), () => !!session);
  });
  app.on('before-quit', () => { leave(); });
  app.on('will-quit', () => hotkeys.shutdown());
  app.on('window-all-closed', () => {
    leave();
    app.quit();
  });
}
