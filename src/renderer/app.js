'use strict';

const $ = (id) => document.getElementById(id);
const api = window.w2g;

let settings = {};
let env = null;
let hostFile = null;
let localFile = null;
let lobby = null;
let last = null;
let dragging = false;
let renderedLogCount = 0;

// ---------- helpers ----------

function fmt(sec) {
  if (sec == null || !Number.isFinite(sec)) return '0:00';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0) + ' ' + u[i];
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function showError(msg) {
  const box = $('homeError');
  box.classList.remove('info');
  box.textContent = msg;
  box.classList.toggle('hidden', !msg);
}

/** Neutral message in the same spot, optionally with buttons. */
function showInfo(msg, ...buttons) {
  const box = $('homeError');
  box.classList.add('info');
  box.replaceChildren(el('span', { text: msg }), ...buttons);
  box.classList.remove('hidden');
}

function cleanError(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function myName() {
  const n = $('name').value.trim();
  if (!n) throw new Error('Enter your name first.');
  return n;
}

/** Fill a range slider's track up to its value (CSS reads --pct). Used by app.js and voice-ui.js. */
function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
  }
}

// ---------- environment ----------

async function refreshEnv() {
  env = await api.checkEnv();
  const badges = $('envBadges');
  badges.replaceChildren();
  const ts = env.tailscale;
  badges.append(el('span', {
    class: 'badge ' + (ts.running ? 'ok' : 'warn'),
    text: ts.running ? `Tailscale ${ts.ip || 'connected'}` : ts.installed ? 'Tailscale not connected' : 'Tailscale not installed',
  }));
  badges.append(el('span', { class: 'badge ' + (env.mpvPath ? 'ok' : 'warn'), text: env.mpvPath ? 'Player ready' : 'mpv missing' }));

  const setup = $('setup');
  setup.replaceChildren();
  if (!env.mpvPath) {
    const install = el('button', { class: 'primary', text: 'Install mpv (winget)' });
    install.addEventListener('click', async () => {
      busy(install, true, 'Installing… (can take a minute)');
      try {
        const r = await api.installMpv();
        if (!r.mpvPath) showError('mpv install did not finish:\n' + (r.output || 'unknown error'));
      } catch (e) {
        showError(cleanError(e));
      }
      busy(install, false);
      refreshEnv();
    });
    const browse = el('button', { text: 'I have mpv: locate mpv.exe…' });
    browse.addEventListener('click', async () => { await api.browseMpv(); refreshEnv(); });
    setup.append(el('div', { class: 'notice' },
      el('b', { text: 'The video player (mpv) is not installed.' }),
      el('div', { class: 'muted', text: 'Watch2Gether plays video with mpv, which handles 4K HEVC, MKV, HDR and surround audio with hardware decoding.' }),
      el('div', { class: 'row' }, install, browse)));
  }
  if (!ts.running) {
    const get = el('button', { text: 'Get Tailscale' });
    get.addEventListener('click', () => api.openExternal('https://tailscale.com/download/windows'));
    const re = el('button', { text: 'Check again' });
    re.addEventListener('click', refreshEnv);
    setup.append(el('div', { class: 'notice' },
      el('b', { text: ts.installed ? 'Tailscale is installed but not connected.' : 'Tailscale is not installed.' }),
      el('div', { class: 'muted', text: 'You and your friends need Tailscale on the same tailnet (or a machine shared with you) so you can reach each other directly. Open Tailscale and log in, then click "Check again".' }),
      el('div', { class: 'row' }, get, re)));
  }
}

// ---------- home ----------

$('pickFile').addEventListener('click', async () => {
  const f = await api.pickFile('Choose a video to host');
  if (!f) return;
  hostFile = f;
  $('pickedFile').textContent = `${f.name} (${fmtBytes(f.size)})`;
  $('pickedFile').title = f.path;
});

$('pickLocal').addEventListener('click', async () => {
  const f = await api.pickFile('Choose your local copy');
  if (!f) return;
  localFile = f;
  $('localFile').textContent = `${f.name} (${fmtBytes(f.size)})`;
  $('localFile').title = f.path;
});

$('hostBtn').addEventListener('click', async () => {
  showError('');
  const btn = $('hostBtn');
  try {
    const name = myName();
    busy(btn, true, 'Starting…');
    // The video is optional: start empty, talk, and pick one in the lobby.
    lobby = await api.host({ name, filePath: hostFile ? hostFile.path : null, port: Number($('port').value) || 8787, allowLan: $('allowLan').checked });
    enterLobby();
  } catch (e) {
    showError(cleanError(e));
  } finally {
    busy(btn, false);
  }
});

$('joinBtn').addEventListener('click', async () => {
  showError('');
  const btn = $('joinBtn');
  try {
    const name = myName();
    const invite = $('invite').value.trim();
    if (!invite) throw new Error('Paste the invite from your friend.');
    busy(btn, true, 'Connecting…');
    lobby = await api.join({ name, invite, localPath: localFile ? localFile.path : null });
    enterLobby();
  } catch (e) {
    showError(cleanError(e));
  } finally {
    busy(btn, false);
  }
});

$('invite').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

// ---------- screens ----------

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let screenTimer = null;

/** Cross-fade between screens: the old one lifts away, the new one rises in. */
function showScreen(id) {
  const next = $(id);
  const prev = document.querySelector('main > section:not(.hidden)');
  clearTimeout(screenTimer);
  const enter = () => {
    document.querySelectorAll('main > section').forEach((s) => {
      s.classList.remove('screen-out', 'screen-in');
      s.classList.toggle('hidden', s !== next);
    });
    document.querySelector('main').scrollTop = 0;
    void next.offsetWidth; // restart the animation
    next.classList.add('screen-in');
    screenTimer = setTimeout(() => next.classList.remove('screen-in'), 900);
  };
  if (!prev || prev === next || reducedMotion.matches) return enter();
  prev.classList.add('screen-out');
  screenTimer = setTimeout(enter, 170);
}

// ---------- lobby ----------

function enterLobby() {
  document.body.classList.add('in-lobby');
  showScreen('screen-lobby');
  setTimeout(syncStage, 700); // after the screen transition settles
  renderedLogCount = 0;
  $('log').replaceChildren();
  const isHost = lobby.role === 'host';
  document.querySelectorAll('.host-only').forEach((n) => n.classList.toggle('hidden', !isHost));
  $('inviteCode').textContent = lobby.invite;
  const alt = [];
  if (isHost && lobby.inviteDns) alt.push(`or ${lobby.inviteDns}`);
  if (isHost && lobby.tailscale && !lobby.tailscale.ip) alt.push('Tailscale isn\'t connected, so friends can\'t reach this address.');
  if (!isHost) alt.push('You joined with this address.');
  $('inviteAlt').textContent = alt.join(' ');
}

function exitLobby(reason) {
  lobby = null;
  last = null;
  api.videoRect(null);
  if (document.body.classList.contains('fullscreen')) api.fullscreen(false);
  document.body.classList.remove('in-lobby');
  voiceUi.onExitLobby();
  showScreen('screen-home');
  if (reason) showError(reason);
  refreshEnv();
}

$('copyInvite').addEventListener('click', async () => {
  const b = $('copyInvite');
  await api.copy($('inviteCode').textContent);
  b.textContent = 'Copied ✓';
  b.classList.add('copied');
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('copied'); }, 1600);
});

$('playPause').addEventListener('click', () => api.cmd('toggle'));

function paintSeek() {
  const s = $('seek');
  const max = Number(s.max) || 1;
  s.style.setProperty('--pct', `${Math.min(100, (Number(s.value) / max) * 100)}%`);
}

$('seek').addEventListener('input', () => {
  dragging = true;
  paintSeek();
  $('timeCur').textContent = fmt(Number($('seek').value));
});
$('seek').addEventListener('change', () => {
  dragging = false;
  api.cmd('seek', Number($('seek').value));
});

// Space toggles play/pause anywhere in the lobby except while typing. Holding it
// down doesn't repeat, and a focused button (e.g. play/pause after a click) isn't
// also "clicked" by the keyup, which would toggle twice.
const isTyping = (t) => t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.closest('.modal') || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox');
document.addEventListener('keydown', (e) => {
  if (!lobby || e.code !== 'Space' || isTyping(e.target)) return;
  e.preventDefault();
  if (!e.repeat) api.cmd('toggle');
});
document.addEventListener('keyup', (e) => {
  if (lobby && e.code === 'Space' && !isTyping(e.target)) e.preventDefault();
});

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('chatInput').value.trim();
  if (t) api.chat(t);
  $('chatInput').value = '';
});

async function chooseVideo() {
  const f = await api.pickFile(last && last.room && last.room.media ? 'Choose the next video' : 'Choose a video');
  if (!f) return;
  try {
    await api.changeVideo(f.path);
  } catch (e) {
    alert('Could not switch video: ' + cleanError(e));
  }
}
$('changeVideo').addEventListener('click', chooseVideo);
$('pickNow').addEventListener('click', chooseVideo);
$('pickNow2').addEventListener('click', chooseVideo);

// ---------- in-app player (a native window kept over #stage) ----------

let playerMode = 'embedded'; // or 'popout' (mpv's own window); saved in settings
let lastRect = null;
let stageRaf = null;

/** Is the in-app video supposed to be visible right now? */
function videoShown() {
  const u = last;
  return !!(lobby && u && u.room && u.room.media && u.player && u.player.open
    && playerMode === 'embedded'
    && !$('screen-lobby').classList.contains('hidden')
    && $('voiceSettings').classList.contains('hidden')); // a native window would cover the dialog
}

/** Put the native video window exactly over #stage (or hide it). */
function syncStage() {
  cancelAnimationFrame(stageRaf);
  stageRaf = requestAnimationFrame(() => {
    let rect = null;
    if (videoShown()) {
      const r = $('stage').getBoundingClientRect();
      rect = { x: r.left + 1, y: r.top + 1, width: r.width - 2, height: r.height - 2 }; // inside the border
    }
    const key = JSON.stringify(rect);
    if (key === lastRect) return;
    lastRect = key;
    api.videoRect(rect);
  });
}
new ResizeObserver(syncStage).observe($('stage'));
window.addEventListener('resize', syncStage);
$('sidebar').addEventListener('transitionend', syncStage);
// the voice settings dialog opens and closes in voice-ui.js; hide the video while it's up
new MutationObserver(syncStage).observe($('voiceSettings'), { attributes: true, attributeFilter: ['class'] });

async function setPlayerMode(mode) {
  playerMode = mode;
  renderPlayerChrome();
  syncStage();
  try {
    playerMode = await api.setPlayerMode(mode);
  } catch (e) {
    alert('Could not switch the player: ' + cleanError(e));
  }
  renderPlayerChrome();
  syncStage();
}

// ---------- volume (just you; 100 = the file's own level, up to 130 like mpv) ----------

let volDragging = false;
let volume = 100;
let muted = false;
function paintVolume() {
  const s = $('volSlider');
  if (!volDragging) s.value = String(volume);
  paintRange(s); // voice-ui.js
  const off = muted || volume === 0;
  $('volX').style.display = off ? '' : 'none';
  $('volWave1').style.display = off ? 'none' : '';
  $('volWave2').style.display = off || volume < 50 ? 'none' : '';
  $('volBtn').title = off ? 'Unmute (M)' : 'Mute (M)';
  $('volBtn').classList.toggle('off', off);
  s.title = `Volume ${volume}% (↑ / ↓)`;
}
function changeVolume(v) {
  volume = Math.max(0, Math.min(130, Math.round(v)));
  if (volume > 0) muted = false;
  paintVolume();
  api.setVolume(volume);
}
$('volSlider').addEventListener('input', () => {
  volDragging = true;
  changeVolume(Number($('volSlider').value));
});
$('volSlider').addEventListener('change', () => { volDragging = false; });
$('volBtn').addEventListener('click', () => {
  muted = !muted;
  paintVolume();
  api.setMute(muted);
});
document.querySelector('.volume').addEventListener('wheel', (e) => {
  e.preventDefault();
  changeVolume(volume + (e.deltaY < 0 ? 5 : -5));
}, { passive: false });
document.addEventListener('keydown', (e) => {
  if (!lobby || isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    changeVolume(volume + (e.key === 'ArrowUp' ? 5 : -5));
  } else if (e.key === 'm' || e.key === 'M') {
    $('volBtn').click();
  }
});

$('popOut').addEventListener('click', () => setPlayerMode(playerMode === 'embedded' ? 'popout' : 'embedded'));
$('bringBack').addEventListener('click', () => setPlayerMode('embedded'));
$('fullscreenBtn').addEventListener('click', () => api.fullscreen());

/** Buttons and the message on the stage behind the video. */
function renderPlayerChrome() {
  const u = last;
  const media = u && u.room && u.room.media;
  const open = !!(u && u.player && u.player.open);
  const isHost = !!(lobby && lobby.role === 'host');
  const embedded = playerMode === 'embedded';
  let text = '';
  if (!media) text = isHost ? 'No video yet. Talk it over, then choose one.' : 'Waiting for the host to choose a video.';
  else if (!open) text = 'Your player is closed.';
  else if (!embedded) text = 'Playing in a separate window.';
  else text = 'Loading…';
  $('stagePhText').textContent = text;
  $('pickNow2').classList.toggle('hidden', !!media || !isHost);
  $('bringBack').classList.toggle('hidden', !media || !open || embedded);
  $('popOut').title = embedded ? 'Pop out into its own window' : 'Bring the player back into this window';
  $('popOut').classList.toggle('on', !embedded);
  $('fullscreenBtn').classList.toggle('hidden', !embedded);
}

// Fullscreen: only the movie; the sidebar slides in when the mouse reaches the left edge.
const PEEK_EDGE_PX = 10;      // mouse this close to the left edge (inside the window) opens it
const PEEK_HIDE_DELAY_MS = 700;
let peekTimer = null;
let peekPinned = false;       // opened with Tab: stays until Tab again (or leaving fullscreen)
function setPeek(on, pinned = false) {
  clearTimeout(peekTimer);
  peekTimer = null;
  peekPinned = on && pinned;
  document.body.classList.toggle('peek', on);
}
function toggleSidebar() {
  if (!document.body.classList.contains('fullscreen')) return;
  setPeek(!document.body.classList.contains('peek'), true);
}
api.onFullscreen((on) => {
  document.body.classList.toggle('fullscreen', on);
  setPeek(false);
  syncStage();
});
api.onToggleSidebar(toggleSidebar); // Tab pressed while the video has focus
/** x: cursor position from the left of the window, or null when it's outside the window
 *  (e.g. on another monitor), which counts as "away". */
api.onCursorX((x) => {
  if (!document.body.classList.contains('fullscreen') || peekPinned) return;
  const peeking = document.body.classList.contains('peek');
  const width = $('sidebar').offsetWidth;
  if (x != null && x <= PEEK_EDGE_PX) {
    setPeek(true);
  } else if (peeking && (x == null || x > width + 40)) {
    if (!peekTimer) peekTimer = setTimeout(() => setPeek(false), PEEK_HIDE_DELAY_MS);
  } else if (peeking) {
    clearTimeout(peekTimer);
    peekTimer = null;
  }
});
document.addEventListener('keydown', (e) => {
  if (!lobby || isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'f' || e.key === 'F') {
    if (playerMode === 'embedded') api.fullscreen();
  } else if (e.key === 'Escape' && document.body.classList.contains('fullscreen')) {
    api.fullscreen(false);
  } else if (e.key === 'Tab' && document.body.classList.contains('fullscreen')) {
    e.preventDefault();
    toggleSidebar();
  }
});

$('reopen').addEventListener('click', async () => {
  try {
    await api.reopenPlayer();
  } catch (e) {
    alert('Could not open the player: ' + cleanError(e));
  }
});

$('leave').addEventListener('click', async () => {
  if (lobby && lobby.role === 'host' && !confirm('Close the lobby for everyone?')) return;
  await api.leave();
  exitLobby();
});

api.onEnded((reason) => exitLobby(reason));

api.appVersion().then((v) => { $('appVersion').textContent = 'v' + v; });
$('appVersion').addEventListener('click', () => api.checkUpdates());

let updateNoteTimer = null;
/** Short-lived message in the update area (results of a check the user asked for). */
function updateNote(text, kind) {
  clearTimeout(updateNoteTimer);
  $('appUpdate').classList.remove('hidden');
  $('appUpdate').dataset.kind = kind || '';
  $('appUpdateText').textContent = text;
  $('appUpdateText').title = '';
  $('appUpdateBar').classList.add('hidden');
  $('appUpdateBtn').classList.add('hidden');
  if (kind !== 'checking') updateNoteTimer = setTimeout(() => $('appUpdate').classList.add('hidden'), 4000);
}

function fmtRate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`;
}

api.onAppUpdate((u) => {
  $('appUpdate').classList.remove('hidden');
  if (u.state === 'checking') return updateNote('Checking for updates…', 'checking');
  if (u.state === 'uptodate') return updateNote(`You're up to date (v${u.version}).`, 'ok');
  if (u.state === 'check-failed') return updateNote("Couldn't check for updates. Are you online?", 'warn');
  clearTimeout(updateNoteTimer);
  $('appUpdate').dataset.kind = '';
  const bar = $('appUpdateBar');
  if (u.state === 'failed') {
    $('appUpdateText').textContent = 'Update download failed. Trying again in a few minutes.';
    $('appUpdateText').title = u.message || '';
    bar.classList.add('hidden');
    $('appUpdateBtn').classList.add('hidden');
    return;
  }
  const ready = u.state === 'ready';
  const pct = Math.max(0, Math.min(100, u.percent || 0));
  let text = `v${u.version} is ready. It installs when you close the app.`;
  if (!ready) {
    text = `Downloading v${u.version || ''}…`;
    if (u.total) {
      const left = u.bytesPerSecond ? (u.total - u.transferred) / u.bytesPerSecond : null;
      text = `Updating to v${u.version} · ${Math.floor(pct)}%`
        + (u.bytesPerSecond ? ` · ${fmtRate(u.bytesPerSecond)}` : '')
        + (left != null && left > 5 ? ` · ${left >= 90 ? Math.round(left / 60) + ' min' : Math.round(left) + ' s'} left` : '');
    }
  }
  $('appUpdateText').textContent = text;
  const detail = u.total ? `${text} (${fmtBytes(u.transferred)} of ${fmtBytes(u.total)})` : text;
  $('appUpdateText').title = detail;
  bar.title = detail;
  bar.classList.toggle('hidden', ready);
  bar.classList.toggle('indeterminate', !ready && !u.total);
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.firstElementChild.style.setProperty('--pct', `${pct}%`);
  $('appUpdateBtn').classList.toggle('hidden', !ready);
});

$('appUpdateBtn').addEventListener('click', () => {
  if (lobby && !confirm(lobby.role === 'host'
    ? 'The app restarts for a few seconds and reopens this lobby; everyone reconnects by themselves. Update now?'
    : 'The app restarts for a few seconds and rejoins this lobby. Update now?')) return;
  // remembered so the updated app goes straight back into this lobby (and voice)
  api.installUpdate({ inVoice: voice.joined, muted: voice.muted, deafened: voice.deafened });
});

// ---------- back into the lobby after "Restart to update" ----------

const RESUME_GUEST_WAIT_MS = 90000; // the host may be restarting for the update too

async function resumeAfterUpdate() {
  const r = await api.resumeInfo();
  if (!r || lobby) return;
  const name = r.name || $('name').value.trim() || 'Guest';
  $('name').value = name;
  let cancelled = false;
  const cancel = el('button', { class: 'small', text: 'Cancel' });
  cancel.addEventListener('click', () => { cancelled = true; showError(''); });
  showInfo('Updated! Getting you back into your lobby…', cancel);
  try {
    if (r.host) {
      const h = r.host;
      lobby = await api.host({
        name,
        filePath: h.filePath,
        port: h.port,
        allowLan: h.allowLan,
        resume: { code: h.code, hostToken: h.hostToken, mediaId: h.mediaId, position: h.position },
      });
    } else if (r.guest) {
      const end = Date.now() + RESUME_GUEST_WAIT_MS;
      for (;;) {
        try {
          lobby = await api.join({ name, invite: r.guest.invite, localPath: r.guest.localPath });
          break;
        } catch (e) {
          // a refusal means the lobby is gone; anything else (host offline) is worth waiting for
          if (cancelled || Date.now() > end || /refused|no longer exists/i.test(cleanError(e))) throw e;
          showInfo('Updated! Waiting for the host to come back…', cancel);
          await new Promise((res) => setTimeout(res, 3000));
          if (cancelled) return;
        }
      }
    } else {
      return showError('');
    }
    if (cancelled) {
      await api.leave();
      lobby = null;
      return;
    }
    showError('');
    enterLobby();
    if (r.voice && r.voice.inVoice) await voiceUi.rejoinVoice(r.voice);
  } catch (e) {
    if (!cancelled) showError("Couldn't get back into your lobby: " + cleanError(e));
  }
}

api.onUpdate((u) => {
  if (!lobby) return;
  last = u;
  render(u);
  voiceUi.onUpdate(u);
});

function render(u) {
  const r = u.room;
  const media = r && r.media;
  const dur = (u.player && u.player.duration) || (media && media.duration) || 0;

  const isHost = !!(lobby && lobby.role === 'host');
  $('mediaName').textContent = media ? media.name : 'No video yet';
  $('pickNow').classList.toggle('hidden', !!media || !isHost);
  $('changeVideo').textContent = media ? 'Change video…' : 'Choose video…';
  $('playPause').disabled = !media;
  $('seek').disabled = !media;
  $('mediaName').title = media ? media.name : '';
  const meta = [];
  if (media) meta.push(fmtBytes(media.size));
  if (media && dur) meta.push(`~${Math.round((media.size * 8) / dur / 1e6)} Mbps average`);
  if (u.player && u.player.source) meta.push(u.player.source === 'local' ? 'playing from your disk' : 'streaming from host');
  $('mediaMeta').textContent = meta.join(' · ');

  // transport
  const cur = r ? r.current : 0;
  $('playPause').classList.toggle('playing', !!(r && !r.paused));
  $('seek').max = String(dur || 1);
  if (!dragging) {
    $('seek').value = String(cur || 0);
    $('timeCur').textContent = fmt(cur);
    paintSeek();
  }
  $('timeDur').textContent = fmt(dur);

  // status line
  const status = $('statusLine');
  status.className = 'status';
  let text = '';
  if (!u.connected) {
    text = 'Disconnected from the host. Reconnecting…';
    status.classList.add('bad');
  } else if (!media) {
    text = isHost ? "Talk it over, then choose a video. Everyone's player opens when you do." : 'Waiting for the host to choose a video.';
    status.classList.add('idle');
  } else if (!u.player.open) {
    text = 'Your player window is closed.';
    status.classList.add('warn');
  } else if (r && r.waiting) {
    text = `Waiting for ${r.waitingFor.join(', ')} to buffer…`;
    status.classList.add('warn');
  } else if (u.player.buffering) {
    text = 'Buffering…';
    status.classList.add('warn');
  } else if (r && r.paused) {
    text = 'Paused';
    status.classList.add('idle');
  } else if (r) {
    const d = Math.abs(u.player.drift || 0);
    text = `Playing in sync${d > 0.05 ? ` (${Math.round(d * 1000)} ms off, correcting)` : ''}`;
  }
  status.textContent = text;
  $('reopen').classList.toggle('hidden', u.player.open || !media);
  renderPlayerChrome();
  syncStage();
  // follow the player (its own volume keys / wheel change it too)
  if (u.player && u.player.volume != null && !volDragging) {
    volume = u.player.volume;
    muted = !!u.player.muted;
  }
  paintVolume();

  renderMembers(u, media, dur);
  renderLog(u.log);
}

const AVATAR_COLORS = 8;
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'c' + (h % AVATAR_COLORS);
}
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
  return s.toUpperCase();
}

function renderMembers(u, media, dur) {
  const list = $('members');
  list.replaceChildren();
  for (const m of u.members || []) {
    const dotClass = m.lagging ? 'dot lagging' : m.buffering ? 'dot buffering' : 'dot';
    const tags = [];
    if (m.isHost) tags.push(el('span', { class: 'tag host', text: 'host' }));
    if (m.id === u.me) tags.push(el('span', { class: 'tag', text: 'you' }));
    if (!m.isHost && m.source === 'local') tags.push(el('span', { class: 'tag', text: 'local copy' }));
    const detail = m.lagging ? 'behind' : m.buffering ? 'buffering' : (m.rtt != null && !m.isHost ? `${m.rtt} ms` : '');
    const avatar = el('span', { class: 'avatar ' + avatarColor(m.name), text: initials(m.name) }, el('span', { class: dotClass }));
    const li = el('li', {},
      avatar,
      el('span', { class: 'member-name ellipsis', text: m.name }),
      ...tags,
      el('span', { class: 'muted small', text: detail }));
    decorateMember(li, m, u); // voice-ui.js
    list.append(li);
  }

  const stats = $('hostStats');
  stats.replaceChildren();
  if (u.stats) {
    const streamers = (u.members || []).filter((m) => !m.isHost && m.source !== 'local').length;
    stats.append(el('div', {}, 'Host upload right now: ', el('b', { text: `${u.stats.uploadMbps} Mbps` })));
    if (media && dur) {
      const avg = (media.size * 8) / dur / 1e6;
      const need = Math.ceil(avg * streamers * 1.2);
      if (streamers > 0) {
        stats.append(el('div', {}, `Needs about `, el('b', { text: `${need} Mbps` }), ` of host upload for ${streamers} streaming viewer${streamers === 1 ? '' : 's'}`));
      }
      if (avg > 60) stats.append(el('div', { class: 'warn', text: 'High-bitrate file. Friends with a local copy will save bandwidth.' }));
    }
  }
}

function renderLog(log) {
  const box = $('log');
  if (!log) return;
  // Append only lines we haven't drawn yet (renderedLogCount holds the last seq drawn).
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  for (const l of log) {
    if (l.seq <= renderedLogCount) continue;
    const t = new Date(l.at);
    box.append(el('div', { class: 'log-line ' + l.kind },
      el('time', { text: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), l.text));
    renderedLogCount = l.seq;
  }
  while (box.childElementCount > 300) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- boot ----------

(async function boot() {
  settings = await api.getSettings();
  playerMode = settings.playerMode === 'popout' ? 'popout' : 'embedded';
  volume = Number.isFinite(settings.volume) ? settings.volume : 100;
  paintVolume();
  $('name').value = settings.name || '';
  $('port').value = settings.port || 8787;
  $('allowLan').checked = !!settings.allowLan;
  $('invite').value = settings.lastInvite || '';
  $('name').addEventListener('change', () => api.saveSettings({ name: $('name').value.trim() }));
  showScreen('screen-home');
  await refreshEnv();
  await resumeAfterUpdate();
})();
