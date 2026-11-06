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
  box.textContent = msg;
  box.classList.toggle('hidden', !msg);
}

function cleanError(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function myName() {
  const n = $('name').value.trim();
  if (!n) throw new Error('Enter your name first.');
  return n;
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
    if (!hostFile) throw new Error('Choose a video to host first.');
    busy(btn, true, 'Starting…');
    lobby = await api.host({ name, filePath: hostFile.path, port: Number($('port').value) || 8787, allowLan: $('allowLan').checked });
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

// ---------- lobby ----------

function enterLobby() {
  $('screen-home').classList.add('hidden');
  $('screen-lobby').classList.remove('hidden');
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
  $('screen-lobby').classList.add('hidden');
  $('screen-home').classList.remove('hidden');
  if (reason) showError(reason);
  refreshEnv();
}

$('copyInvite').addEventListener('click', async () => {
  await api.copy($('inviteCode').textContent);
  $('copyInvite').textContent = 'Copied!';
  setTimeout(() => { $('copyInvite').textContent = 'Copy invite'; }, 1500);
});

$('playPause').addEventListener('click', () => api.cmd('toggle'));

$('seek').addEventListener('input', () => {
  dragging = true;
  $('timeCur').textContent = fmt(Number($('seek').value));
});
$('seek').addEventListener('change', () => {
  dragging = false;
  api.cmd('seek', Number($('seek').value));
});

// Space toggles play/pause anywhere in the lobby except while typing. Holding it
// down doesn't repeat, and a focused button (e.g. play/pause after a click) isn't
// also "clicked" by the keyup, which would toggle twice.
const isTyping = (t) => t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox');
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

$('changeVideo').addEventListener('click', async () => {
  const f = await api.pickFile('Choose the next video');
  if (!f) return;
  try {
    await api.changeVideo(f.path);
  } catch (e) {
    alert('Could not switch video: ' + cleanError(e));
  }
});

$('reopen').addEventListener('click', async () => {
  try {
    await api.reopenPlayer();
  } catch (e) {
    alert('Could not reopen the player: ' + cleanError(e));
  }
});

$('leave').addEventListener('click', async () => {
  if (lobby && lobby.role === 'host' && !confirm('Close the lobby for everyone?')) return;
  await api.leave();
  exitLobby();
});

api.onEnded((reason) => exitLobby(reason));

api.appVersion().then((v) => { $('appVersion').textContent = 'v' + v; });

api.onAppUpdate((u) => {
  $('appUpdate').classList.remove('hidden');
  const ready = u.state === 'ready';
  $('appUpdateText').textContent = ready
    ? `v${u.version} is ready. It installs when you close the app.`
    : `Downloading v${u.version}…`;
  $('appUpdateBtn').classList.toggle('hidden', !ready);
});

$('appUpdateBtn').addEventListener('click', () => {
  if (lobby && !confirm(lobby.role === 'host'
    ? 'Restarting closes the lobby for everyone. Update now?'
    : 'Restarting leaves the lobby. Update now?')) return;
  api.installUpdate();
});

api.onUpdate((u) => {
  if (!lobby) return;
  last = u;
  render(u);
});

function render(u) {
  const r = u.room;
  const media = r && r.media;
  const dur = (u.player && u.player.duration) || (media && media.duration) || 0;

  $('mediaName').textContent = media ? media.name : 'No video selected';
  $('mediaName').title = media ? media.name : '';
  const meta = [];
  if (media) meta.push(fmtBytes(media.size));
  if (media && dur) meta.push(`~${Math.round((media.size * 8) / dur / 1e6)} Mbps average`);
  if (u.player && u.player.source) meta.push(u.player.source === 'local' ? 'playing from your disk' : 'streaming from host');
  $('mediaMeta').textContent = meta.join(' · ');

  // transport
  const cur = r ? r.current : 0;
  $('playPause').textContent = r && !r.paused ? '❚❚' : '▶';
  $('seek').max = String(dur || 1);
  if (!dragging) {
    $('seek').value = String(cur || 0);
    $('timeCur').textContent = fmt(cur);
  }
  $('timeDur').textContent = fmt(dur);

  // status line
  const status = $('statusLine');
  status.className = 'status';
  let text = '';
  if (!u.connected) {
    text = 'Disconnected from the host. Reconnecting…';
    status.classList.add('bad');
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
  } else if (r) {
    const d = Math.abs(u.player.drift || 0);
    text = `Playing in sync${d > 0.05 ? ` (${Math.round(d * 1000)} ms off, correcting)` : ''}`;
  }
  status.textContent = text;
  $('reopen').classList.toggle('hidden', u.player.open);

  renderMembers(u, media, dur);
  renderLog(u.log);
}

function renderMembers(u, media, dur) {
  const list = $('members');
  list.replaceChildren();
  for (const m of u.members || []) {
    const dotClass = m.lagging ? 'dot lagging' : m.buffering ? 'dot buffering' : 'dot';
    const tags = [];
    if (m.isHost) tags.push(el('span', { class: 'tag', text: 'host' }));
    if (m.id === u.me) tags.push(el('span', { class: 'tag', text: 'you' }));
    if (!m.isHost && m.source === 'local') tags.push(el('span', { class: 'tag', text: 'local copy' }));
    const detail = m.lagging ? 'behind' : m.buffering ? 'buffering' : (m.rtt != null && !m.isHost ? `${m.rtt} ms` : '');
    list.append(el('li', {},
      el('span', { class: dotClass }),
      el('span', { class: 'member-name ellipsis', text: m.name }),
      ...tags,
      el('span', { class: 'muted small', text: detail })));
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
  $('name').value = settings.name || '';
  $('port').value = settings.port || 8787;
  $('allowLan').checked = !!settings.allowLan;
  $('invite').value = settings.lastInvite || '';
  $('name').addEventListener('change', () => api.saveSettings({ name: $('name').value.trim() }));
  await refreshEnv();
})();
