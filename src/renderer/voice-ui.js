'use strict';

/* Voice chat UI: voice bar, member decorations, per-person volume / host menu,
 * settings sheet, global hotkeys and movie ducking.
 * Uses $, el, api, last, lobby, cleanError from app.js and VoiceEngine from voice.js. */

const PEER_PREFS_KEY = 'w2g.peerPrefs';
const TIP_KEY = 'w2g.voiceTipDismissed';
const UNDUCK_DELAY_MS = 700; // keep the movie lowered briefly after someone stops talking

function loadPeerPrefs() {
  try { return JSON.parse(localStorage.getItem(PEER_PREFS_KEY) || '{}'); } catch { return {}; }
}
let peerPrefs = loadPeerPrefs();
function savePeerPrefs() { localStorage.setItem(PEER_PREFS_KEY, JSON.stringify(peerPrefs)); }

function memberById(id) {
  return ((last && last.members) || []).find((m) => m.id === id) || null;
}
/** Volumes are remembered by name, so they survive reconnects and new lobbies. */
function prefsFor(id) {
  const m = memberById(id);
  return (m && peerPrefs[m.name]) || { volume: 1, muted: false };
}

const voice = new VoiceEngine({
  send: (msg) => api.voiceSend(msg),
  sendAudio: (bytes) => api.voiceAudio(bytes),
  loadWasm: (name) => api.voiceWasm(name),
  getPeerPrefs: prefsFor,
});
let voiceMe = null; // our lobby client id when we joined voice

api.onVoice((msg) => voice.handle(msg));
api.onVoiceAudio((bytes) => voice.handleAudio(bytes));

voice.onKicked = () => showVoiceNotice('The host disconnected you from voice.');

// ---------- global hotkeys ----------

/** Tell the main process which keys to watch. Only active while in voice. */
function syncHotkeys() {
  const b = voice.settings.binds;
  api.hotkeysSet({ ptt: voice.settings.mode === 'ptt' ? b.ptt : null, mute: b.mute, deafen: b.deafen }, voice.joined);
}

api.onHotkey(({ action, down }) => {
  if (!voice.joined) return;
  if (action === 'ptt') voice.setPttHeld(down);
  else if (action === 'mute' && down) voice.setMuted(!(voice.muted || voice.deafened));
  else if (action === 'deafen' && down) voice.setDeafened(!voice.deafened);
});

// ---------- movie ducking ----------

let ducked = false;
let unduckTimer = null;
function updateDuck() {
  const want = voice.settings.duck && voice.othersTalking();
  if (want) {
    clearTimeout(unduckTimer);
    unduckTimer = null;
    if (!ducked) {
      ducked = true;
      api.duck(1 - voice.settings.duckAmount);
    }
  } else if (ducked && !unduckTimer) {
    unduckTimer = setTimeout(() => {
      unduckTimer = null;
      ducked = false;
      api.duck(1);
    }, UNDUCK_DELAY_MS);
  }
}
function resetDuck() {
  clearTimeout(unduckTimer);
  unduckTimer = null;
  if (ducked) api.duck(1);
  ducked = false;
}

// ---------- voice bar ----------

function bindLabel(b) {
  return b ? b.label : null;
}

function renderVoiceBar() {
  const joined = voice.joined;
  $('voiceJoinRow').classList.toggle('hidden', joined);
  $('voiceJoin').disabled = voice.joining;
  $('voiceControls').classList.toggle('hidden', !joined);
  if (!joined) return;
  const micOff = voice.muted || voice.deafened || voice.serverMuted;
  $('voiceMute').classList.toggle('on', micOff);
  $('voiceMute').title = voice.serverMuted ? 'Muted by the host' : micOff ? 'Unmute (Ctrl+Shift+M)' : 'Mute (Ctrl+Shift+M)';
  $('voiceDeafen').classList.toggle('on', voice.deafened);
  $('voiceDeafen').title = voice.deafened ? 'Undeafen (Ctrl+Shift+D)' : 'Deafen (Ctrl+Shift+D)';

  const reconnecting = last && !last.connected;
  const inVoice = ((last && last.members) || []).filter((m) => m.voice).length || 1;
  const parts = [`${inVoice} in voice`];
  if (last && last.rtt != null && !reconnecting && last.isHost === false) parts.push(`${last.rtt} ms`);
  let warn = !!voice.micError || reconnecting;
  if (reconnecting) parts.push('reconnecting…');
  if (voice.micError) parts.splice(0, parts.length, voice.micError);
  else if (voice.serverMuted) { parts.push('muted by host'); warn = true; }
  else if (voice.deafened) parts.push('deafened');
  else if (voice.muted) parts.push('muted');
  else if (voice.settings.mode === 'ptt') {
    const key = bindLabel(voice.settings.binds.ptt);
    if (key) parts.push(`hold ${key} to talk`);
    else { parts.push('set a push-to-talk key'); warn = true; }
  }
  $('voiceSub').textContent = parts.join(' · ');
  $('voiceStatus').classList.toggle('warn', warn);
}

$('voiceJoin').addEventListener('click', async () => {
  if (!lobby) return;
  try {
    voiceMe = last && last.me;
    await voice.join();
    syncHotkeys();
    maybeShowHeadphonesTip();
  } catch (e) {
    alert('Could not start voice: ' + cleanError(e));
  }
  renderVoiceBar();
});
$('voiceLeave').addEventListener('click', () => {
  voice.leave();
  syncHotkeys();
  resetDuck();
});
$('voiceMute').addEventListener('click', () => voice.setMuted(!(voice.muted || voice.deafened)));
$('voiceDeafen').addEventListener('click', () => voice.setDeafened(!voice.deafened));

document.addEventListener('keydown', (e) => {
  if (!lobby || !voice.joined || !e.ctrlKey || !e.shiftKey) return;
  if (e.code === 'KeyM') { e.preventDefault(); voice.setMuted(!(voice.muted || voice.deafened)); }
  if (e.code === 'KeyD') { e.preventDefault(); voice.setDeafened(!voice.deafened); }
});

function showVoiceNotice(text) {
  $('voiceTipText').textContent = text;
  $('voiceTip').dataset.kind = 'notice';
  $('voiceTip').classList.remove('hidden');
}
async function maybeShowHeadphonesTip() {
  if (localStorage.getItem(TIP_KEY) || (await voice.outputLooksLikeHeadphones())) return;
  $('voiceTipText').textContent = 'Using speakers? Friends may hear the movie through your mic. Headphones work best.';
  $('voiceTip').dataset.kind = 'headphones';
  $('voiceTip').classList.remove('hidden');
}
$('voiceTipClose').addEventListener('click', () => {
  if ($('voiceTip').dataset.kind === 'headphones') localStorage.setItem(TIP_KEY, '1');
  $('voiceTip').classList.add('hidden');
});

// ---------- member list decorations ----------

const ICONS = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
  slash: '<path d="M4 4l16 16"/>',
  head: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
};
function icon(name, extra = '', cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'vi ' + cls);
  s.innerHTML = ICONS[name] + (extra ? ICONS[extra] : ''); // static markup, never user text
  return s;
}

/** Called by app.js for each member row. */
function decorateMember(li, m, u) {
  li.dataset.id = m.id;
  if (!m.voice) return;
  li.classList.add('in-voice');
  const name = li.querySelector('.member-name');
  const icons = el('span', { class: 'voice-icons' });
  if (m.voice.serverMuted) icons.append(icon('mic', 'slash', 'server-muted'));
  else if (m.voice.deafened) icons.append(icon('head', 'slash'));
  else if (m.voice.muted) icons.append(icon('mic', 'slash'));
  else icons.append(icon('speaker'));
  const pref = peerPrefs[m.name];
  if (m.id !== u.me && pref && (pref.muted || pref.volume !== 1)) {
    icons.append(el('span', { class: 'vol-note', text: pref.muted ? 'muted for you' : `${Math.round(pref.volume * 100)}%` }));
  }
  name.after(icons);
  if (m.voice.serverMuted) li.title = 'Muted by the host';
  else if (m.id !== u.me) li.title = 'Click to change their volume';
}

/** Speaking rings change every few ms, so they're applied directly instead of re-rendering. */
function paintSpeaking() {
  const info = voice.peerInfo();
  document.querySelectorAll('#members li[data-id]').forEach((li) => {
    const id = li.dataset.id;
    const speaking = id === (last && last.me) ? voice.joined && voice.speaking : !!(info[id] && info[id].speaking);
    li.classList.toggle('speaking', speaking);
  });
}

// ---------- per-person menu (volume; host: mute for everyone / disconnect) ----------

let menuFor = null; // { id, name }
$('members').addEventListener('click', (e) => openMemberMenu(e));
$('members').addEventListener('contextmenu', (e) => { e.preventDefault(); openMemberMenu(e); });

function openMemberMenu(e) {
  const li = e.target.closest('li[data-id]');
  const m = li && memberById(li.dataset.id);
  if (!m || m.id === (last && last.me)) return;
  menuFor = { id: m.id, name: m.name };
  const pref = peerPrefs[m.name] || { volume: 1, muted: false };
  $('pmName').textContent = m.name;
  $('pmVol').value = String(Math.round(pref.volume * 100));
  $('pmVolVal').textContent = `${Math.round(pref.volume * 100)}%`;
  $('pmMute').checked = !!pref.muted;
  paintRange($('pmVol'));
  const hostTools = !!(lobby && lobby.role === 'host' && m.voice);
  $('pmHost').classList.toggle('hidden', !hostTools);
  if (hostTools) $('pmServerMute').checked = !!m.voice.serverMuted;
  const menu = $('memberMenu');
  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 12)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 12)}px`;
  e.stopPropagation();
}
function closeMemberMenu() {
  menuFor = null;
  $('memberMenu').classList.add('hidden');
}
document.addEventListener('click', (e) => { if (!e.target.closest('#memberMenu')) closeMemberMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMemberMenu();
  if (!capturing) closeVoiceSettings();
});

function setPref(patch) {
  if (!menuFor) return;
  const p = { volume: 1, muted: false, ...peerPrefs[menuFor.name], ...patch };
  if (p.volume === 1 && !p.muted) delete peerPrefs[menuFor.name];
  else peerPrefs[menuFor.name] = p;
  savePeerPrefs();
  voice.refreshPeerPrefs();
}
$('pmVol').addEventListener('input', () => {
  const v = Number($('pmVol').value);
  $('pmVolVal').textContent = `${v}%`;
  paintRange($('pmVol'));
  setPref({ volume: v / 100 });
});
$('pmMute').addEventListener('change', () => setPref({ muted: $('pmMute').checked }));
$('pmReset').addEventListener('click', () => {
  $('pmVol').value = '100';
  $('pmVolVal').textContent = '100%';
  $('pmMute').checked = false;
  paintRange($('pmVol'));
  setPref({ volume: 1, muted: false });
});
$('pmServerMute').addEventListener('change', () => {
  if (menuFor) api.voiceSend({ type: 'voice-mod', target: menuFor.id, action: $('pmServerMute').checked ? 'mute' : 'unmute' });
});
$('pmKick').addEventListener('click', () => {
  if (!menuFor) return;
  api.voiceSend({ type: 'voice-mod', target: menuFor.id, action: 'kick' });
  closeMemberMenu();
});

// ---------- settings sheet ----------

function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

let meterRaf = null;
let capturing = null; // action whose key is being chosen

async function openVoiceSettings() {
  const s = voice.settings;
  // Device names are only visible after mic permission; ask once if needed.
  let { inputs, outputs } = await voice.listDevices();
  if (inputs.length && !inputs.some((d) => d.label && d.label !== 'Microphone') && !voice.mic) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
      ({ inputs, outputs } = await voice.listDevices());
    } catch { /* labels stay generic */ }
  }
  fillSelect($('vsInput'), inputs, s.inputDeviceId);
  fillSelect($('vsOutput'), outputs, s.outputDeviceId);
  $('vsOutput').disabled = !outputs.length;
  setRange('vsInVol', Math.round(s.inputVolume * 100));
  setRange('vsOutVol', Math.round(s.outputVolume * 100));
  setRange('vsThreshold', s.threshold);
  setRange('vsPttDelay', s.pttReleaseMs);
  setRange('vsDuckAmt', Math.round(s.duckAmount * 100));
  $('vsAuto').checked = s.autoSensitivity;
  $('vsThreshold').disabled = s.autoSensitivity;
  $('vsNoise').value = s.noiseCancel;
  $('vsEc').checked = s.echoCancellation;
  $('vsAgc').checked = s.autoGainControl;
  $('vsDuck').checked = s.duck;
  $('vsDuckAmt').disabled = !s.duck;
  $('vsCues').checked = s.soundCues;
  $('vsBitrate').value = String(s.bitrate);
  renderSettingsState();
  $('voiceSettings').classList.remove('hidden');
  cancelAnimationFrame(meterRaf);
  const draw = () => {
    const pct = (db) => `${Math.max(0, Math.min(100, db + 100))}%`;
    $('vsMeterFill').style.setProperty('--pct', pct(voice.mic ? voice.level : -100));
    $('vsMeterMark').style.setProperty('--pct', pct(voice.thresholdNow));
    $('vsMeter').classList.toggle('open', voice.speaking);
    meterRaf = requestAnimationFrame(draw);
  };
  draw();
}

/** Parts of the sheet that change while it's open. */
function renderSettingsState() {
  const s = voice.settings;
  const ptt = s.mode === 'ptt';
  $('vsModeVad').classList.toggle('active', !ptt);
  $('vsModePtt').classList.toggle('active', ptt);
  $('vsModeVad').setAttribute('aria-checked', String(!ptt));
  $('vsModePtt').setAttribute('aria-checked', String(ptt));
  $('vsVadBox').classList.toggle('hidden', ptt);
  $('vsPttBox').classList.toggle('hidden', !ptt);
  for (const btn of document.querySelectorAll('.bind[data-action]')) {
    const a = btn.dataset.action;
    btn.textContent = capturing === a ? 'Press a key or mouse button… (Esc to cancel)' : bindLabel(s.binds[a]) || 'Click to set';
    btn.classList.toggle('capturing', capturing === a);
    btn.classList.toggle('unset', !s.binds[a]);
  }
  $('vsMicTest').textContent = voice.micTest ? 'Stop test' : "Let's check";
  $('vsMicTest').classList.toggle('primary', voice.micTest);
  $('vsMeterHint').textContent = voice.mic ? '' : 'Join voice or run the mic test to see your level.';
  $('vsNoiseErr').textContent = voice.noiseError || '';
  $('vsNoiseErr').classList.toggle('hidden', !voice.noiseError);
}

function closeVoiceSettings() {
  if ($('voiceSettings').classList.contains('hidden')) return;
  cancelAnimationFrame(meterRaf);
  if (capturing) api.hotkeyCancel();
  if (voice.micTest) voice.setMicTest(false);
  $('voiceSettings').classList.add('hidden');
}
function fillSelect(sel, devices, current) {
  sel.replaceChildren(...devices.map((d) => el('option', { value: d.id, text: d.id === 'default' ? `Default (${d.label.replace(/^Default - /, '')})` : d.label })));
  if (!devices.length) sel.append(el('option', { value: 'default', text: 'Default' }));
  sel.value = devices.some((d) => d.id === current) ? current : 'default';
}
function setRange(id, v) {
  $(id).value = String(v);
  paintRange($(id));
  const out = document.querySelector(`[data-for="${id}"]`);
  if (!out) return;
  out.textContent = id === 'vsThreshold' ? `${v} dB` : id === 'vsPttDelay' ? `${v} ms` : `${v}%`;
}

$('voiceSettingsBtn').addEventListener('click', openVoiceSettings);
$('voiceSettingsBtn2').addEventListener('click', openVoiceSettings);
$('vsClose').addEventListener('click', closeVoiceSettings);
$('voiceSettings').addEventListener('click', (e) => { if (e.target === $('voiceSettings')) closeVoiceSettings(); });

async function changeSettings(patch) {
  await voice.updateSettings(patch);
  syncHotkeys();
  renderSettingsState();
}

const bindRange = (id, key, scale = 1) => $(id).addEventListener('input', () => {
  const v = Number($(id).value);
  setRange(id, v);
  changeSettings({ [key]: v / scale });
});
bindRange('vsInVol', 'inputVolume', 100);
bindRange('vsOutVol', 'outputVolume', 100);
bindRange('vsThreshold', 'threshold');
bindRange('vsPttDelay', 'pttReleaseMs');
bindRange('vsDuckAmt', 'duckAmount', 100);
$('vsAuto').addEventListener('change', () => {
  $('vsThreshold').disabled = $('vsAuto').checked;
  changeSettings({ autoSensitivity: $('vsAuto').checked });
});
$('vsModeVad').addEventListener('click', () => changeSettings({ mode: 'vad' }));
$('vsModePtt').addEventListener('click', () => changeSettings({ mode: 'ptt' }));
$('vsInput').addEventListener('change', () => changeSettings({ inputDeviceId: $('vsInput').value }));
$('vsOutput').addEventListener('change', () => changeSettings({ outputDeviceId: $('vsOutput').value }));
$('vsNoise').addEventListener('change', () => changeSettings({ noiseCancel: $('vsNoise').value }));
$('vsEc').addEventListener('change', () => changeSettings({ echoCancellation: $('vsEc').checked }));
$('vsAgc').addEventListener('change', () => changeSettings({ autoGainControl: $('vsAgc').checked }));
$('vsDuck').addEventListener('change', () => {
  $('vsDuckAmt').disabled = !$('vsDuck').checked;
  changeSettings({ duck: $('vsDuck').checked });
  if (!$('vsDuck').checked) resetDuck();
});
$('vsCues').addEventListener('change', () => changeSettings({ soundCues: $('vsCues').checked }));
$('vsBitrate').addEventListener('change', () => changeSettings({ bitrate: Number($('vsBitrate').value) }));
$('vsMicTest').addEventListener('click', async () => {
  try {
    await voice.setMicTest(!voice.micTest);
  } catch (e) {
    alert('Mic test failed: ' + cleanError(e));
  }
  renderSettingsState();
});

for (const btn of document.querySelectorAll('.bind[data-action]')) {
  btn.addEventListener('click', async () => {
    const action = btn.dataset.action;
    if (capturing) {
      api.hotkeyCancel();
      return;
    }
    capturing = action;
    renderSettingsState();
    let b = null;
    try { b = await api.hotkeyCapture(); } catch { /* hook unavailable */ }
    capturing = null;
    if (b) await changeSettings({ binds: { [action]: b } });
    else renderSettingsState();
  });
}
for (const btn of document.querySelectorAll('.bind-clear[data-clear]')) {
  btn.addEventListener('click', () => changeSettings({ binds: { [btn.dataset.clear]: null } }));
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!$('voiceSettings').classList.contains('hidden')) openVoiceSettings();
});

// ---------- hooks from app.js ----------

voice.onChange = () => {
  renderVoiceBar();
  paintSpeaking();
  updateDuck();
  if (!$('voiceSettings').classList.contains('hidden')) renderSettingsState();
};

const voiceUi = {
  /** Every lobby update (members, connection state). */
  onUpdate(u) {
    if (voice.joined && u.connected && u.me && voiceMe && u.me !== voiceMe) {
      voiceMe = u.me; // the lobby connection came back under a new id
      voice.rejoin();
    }
    const me = (u.members || []).find((m) => m.id === u.me);
    voice.setServerMuted(!!(me && me.voice && me.voice.serverMuted));
    renderVoiceBar();
    paintSpeaking();
  },
  onExitLobby() {
    voice.shutdown();
    syncHotkeys();
    resetDuck();
    voiceMe = null;
    closeMemberMenu();
    closeVoiceSettings();
    $('voiceTip').classList.add('hidden');
    renderVoiceBar();
  },
};
