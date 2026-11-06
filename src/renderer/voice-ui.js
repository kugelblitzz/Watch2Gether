'use strict';

/* Voice chat UI: voice bar, member decorations, per-person volume menu, settings sheet.
 * Uses $, el, api, last, lobby from app.js and VoiceEngine from voice.js. */

const PEER_PREFS_KEY = 'w2g.peerPrefs';
const TIP_KEY = 'w2g.voiceTipDismissed';

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
  getPeerPrefs: prefsFor,
});
let voiceMe = null; // our lobby client id when we joined voice

api.onVoice((msg) => voice.handle(msg));
api.onVoiceAudio((bytes) => voice.handleAudio(bytes));

// ---------- voice bar ----------

function renderVoiceBar() {
  const joined = voice.joined;
  $('voiceJoin').classList.toggle('hidden', joined);
  $('voiceJoin').disabled = voice.joining;
  $('voiceControls').classList.toggle('hidden', !joined);
  if (!joined) return;
  $('voiceMute').classList.toggle('on', voice.muted || voice.deafened);
  $('voiceMute').title = voice.muted || voice.deafened ? 'Unmute (Ctrl+Shift+M)' : 'Mute (Ctrl+Shift+M)';
  $('voiceDeafen').classList.toggle('on', voice.deafened);
  $('voiceDeafen').title = voice.deafened ? 'Undeafen (Ctrl+Shift+D)' : 'Deafen (Ctrl+Shift+D)';

  const connecting = last && !last.connected ? 1 : 0;
  const inVoice = ((last && last.members) || []).filter((m) => m.voice).length || 1;
  let sub = `${inVoice} in voice`;
  if (connecting) sub += ' · reconnecting…';
  if (voice.micError) sub = voice.micError;
  else if (voice.deafened) sub += ' · deafened';
  else if (voice.muted) sub += ' · muted';
  $('voiceSub').textContent = sub;
  $('voiceStatus').classList.toggle('warn', !!voice.micError || connecting > 0);
}

$('voiceJoin').addEventListener('click', async () => {
  if (!lobby) return;
  try {
    voiceMe = last && last.me;
    await voice.join();
    maybeShowHeadphonesTip();
  } catch (e) {
    alert('Could not start voice: ' + cleanError(e));
  }
  renderVoiceBar();
});
$('voiceLeave').addEventListener('click', () => voice.leave());
$('voiceMute').addEventListener('click', () => voice.setMuted(!(voice.muted || voice.deafened)));
$('voiceDeafen').addEventListener('click', () => voice.setDeafened(!voice.deafened));

document.addEventListener('keydown', (e) => {
  if (!lobby || !voice.joined || !e.ctrlKey || !e.shiftKey) return;
  if (e.code === 'KeyM') { e.preventDefault(); voice.setMuted(!(voice.muted || voice.deafened)); }
  if (e.code === 'KeyD') { e.preventDefault(); voice.setDeafened(!voice.deafened); }
});

async function maybeShowHeadphonesTip() {
  if (localStorage.getItem(TIP_KEY) || (await voice.outputLooksLikeHeadphones())) return;
  $('voiceTip').classList.remove('hidden');
}
$('voiceTipClose').addEventListener('click', () => {
  localStorage.setItem(TIP_KEY, '1');
  $('voiceTip').classList.add('hidden');
});

// ---------- member list decorations ----------

const ICONS = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
  slash: '<path d="M4 4l16 16"/>',
  head: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
};
function icon(name, extra = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'vi');
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
  if (m.voice.deafened) icons.append(icon('head', 'slash'));
  else if (m.voice.muted) icons.append(icon('mic', 'slash'));
  else icons.append(icon('speaker'));
  const pref = peerPrefs[m.name];
  if (m.id !== u.me && pref && (pref.muted || pref.volume !== 1)) {
    icons.append(el('span', { class: 'vol-note', text: pref.muted ? 'muted for you' : `${Math.round(pref.volume * 100)}%` }));
  }
  name.after(icons);
  if (m.id !== u.me) li.title = 'Click to change their volume';
}

/** Speaking rings change every few ms, so they're applied directly instead of re-rendering. */
function paintSpeaking() {
  const info = voice.peerInfo();
  document.querySelectorAll('#members li[data-id]').forEach((li) => {
    const id = li.dataset.id;
    const speaking = id === (last && last.me) ? voice.speaking : !!(info[id] && info[id].speaking);
    li.classList.toggle('speaking', speaking);
  });
}

// ---------- per-person volume menu ----------

let menuFor = null;
$('members').addEventListener('click', (e) => openMemberMenu(e));
$('members').addEventListener('contextmenu', (e) => { e.preventDefault(); openMemberMenu(e); });

function openMemberMenu(e) {
  const li = e.target.closest('li[data-id]');
  const m = li && memberById(li.dataset.id);
  if (!m || m.id === (last && last.me)) return;
  menuFor = m.name;
  const pref = peerPrefs[m.name] || { volume: 1, muted: false };
  $('pmName').textContent = m.name;
  $('pmVol').value = String(Math.round(pref.volume * 100));
  $('pmVolVal').textContent = `${Math.round(pref.volume * 100)}%`;
  $('pmMute').checked = !!pref.muted;
  paintRange($('pmVol'));
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMemberMenu(); closeVoiceSettings(); } });

function setPref(patch) {
  if (!menuFor) return;
  const p = { volume: 1, muted: false, ...peerPrefs[menuFor], ...patch };
  if (p.volume === 1 && !p.muted) delete peerPrefs[menuFor];
  else peerPrefs[menuFor] = p;
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

// ---------- settings sheet ----------

function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

let meterRaf = null;

async function openVoiceSettings() {
  const s = voice.settings;
  // Device names are only visible after mic permission; ask once if needed.
  let { inputs, outputs } = await voice.listDevices();
  if (inputs.length && !inputs.some((d) => d.label && d.label !== 'Microphone') && !voice.joined) {
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
  $('vsAuto').checked = s.autoSensitivity;
  $('vsThreshold').disabled = s.autoSensitivity;
  $('vsNs').checked = s.noiseSuppression;
  $('vsEc').checked = s.echoCancellation;
  $('vsAgc').checked = s.autoGainControl;
  $('vsCues').checked = s.soundCues;
  $('vsBitrate').value = String(s.bitrate);
  $('vsMeterHint').textContent = voice.joined ? '' : 'Join voice to see your mic level.';
  $('voiceSettings').classList.remove('hidden');
  cancelAnimationFrame(meterRaf);
  const draw = () => {
    const pct = (db) => `${Math.max(0, Math.min(100, db + 100))}%`;
    $('vsMeterFill').style.setProperty('--pct', pct(voice.joined ? voice.level : -100));
    $('vsMeterMark').style.setProperty('--pct', pct(voice.thresholdNow));
    $('vsMeter').classList.toggle('open', voice.speaking);
    meterRaf = requestAnimationFrame(draw);
  };
  draw();
}
function closeVoiceSettings() {
  cancelAnimationFrame(meterRaf);
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
  if (out) out.textContent = id === 'vsThreshold' ? `${v} dB` : `${v}%`;
}

$('voiceSettingsBtn').addEventListener('click', openVoiceSettings);
$('vsClose').addEventListener('click', closeVoiceSettings);
$('voiceSettings').addEventListener('click', (e) => { if (e.target === $('voiceSettings')) closeVoiceSettings(); });

const bindRange = (id, key, scale = 1) => $(id).addEventListener('input', () => {
  const v = Number($(id).value);
  setRange(id, v);
  voice.updateSettings({ [key]: v / scale });
});
bindRange('vsInVol', 'inputVolume', 100);
bindRange('vsOutVol', 'outputVolume', 100);
bindRange('vsThreshold', 'threshold');
$('vsAuto').addEventListener('change', () => {
  $('vsThreshold').disabled = $('vsAuto').checked;
  voice.updateSettings({ autoSensitivity: $('vsAuto').checked });
});
$('vsInput').addEventListener('change', () => voice.updateSettings({ inputDeviceId: $('vsInput').value }));
$('vsOutput').addEventListener('change', () => voice.updateSettings({ outputDeviceId: $('vsOutput').value }));
$('vsNs').addEventListener('change', () => voice.updateSettings({ noiseSuppression: $('vsNs').checked }));
$('vsEc').addEventListener('change', () => voice.updateSettings({ echoCancellation: $('vsEc').checked }));
$('vsAgc').addEventListener('change', () => voice.updateSettings({ autoGainControl: $('vsAgc').checked }));
$('vsCues').addEventListener('change', () => voice.updateSettings({ soundCues: $('vsCues').checked }));
$('vsBitrate').addEventListener('change', () => voice.updateSettings({ bitrate: Number($('vsBitrate').value) }));
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!$('voiceSettings').classList.contains('hidden')) openVoiceSettings();
});

// ---------- hooks from app.js ----------

voice.onChange = () => {
  renderVoiceBar();
  paintSpeaking();
};

const voiceUi = {
  /** Every lobby update (members, connection state). */
  onUpdate(u) {
    if (voice.joined && u.connected && u.me && voiceMe && u.me !== voiceMe) {
      voiceMe = u.me; // the lobby connection came back under a new id
      voice.rejoin();
    }
    renderVoiceBar();
    paintSpeaking();
  },
  onExitLobby() {
    voice.shutdown();
    voiceMe = null;
    closeMemberMenu();
    $('voiceTip').classList.add('hidden');
    renderVoiceBar();
  },
};
