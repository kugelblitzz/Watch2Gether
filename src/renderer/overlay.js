'use strict';

/* Fullscreen play bar (its own window over the video; see src/main/overlay.js). It gets
 * the same lobby updates as the main window and sends the same commands. */

const api = window.w2g;
const $ = (id) => document.getElementById(id);

let last = null;
let dragging = false;
let volDragging = false;
let volume = 100;
let muted = false;

function fmt(sec) {
  if (sec == null || !Number.isFinite(sec)) return '0:00';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function paintVolume() {
  const s = $('volSlider');
  if (!volDragging) s.value = String(volume);
  paintRange(s);
  const off = muted || volume === 0;
  $('volX').style.display = off ? '' : 'none';
  $('volWave1').style.display = off ? 'none' : '';
  $('volWave2').style.display = off || volume < 50 ? 'none' : '';
  $('volBtn').classList.toggle('off', off);
}

function render() {
  const u = last;
  if (!u) return;
  const r = u.room;
  const media = r && r.media;
  const dur = (u.player && u.player.duration) || (media && media.duration) || 0;
  $('playPause').classList.toggle('playing', !!(r && !r.paused));
  $('playPause').disabled = !media;
  $('seek').disabled = !media;
  $('seek').max = String(dur || 1);
  if (!dragging) {
    $('seek').value = String((r && r.current) || 0);
    $('timeCur').textContent = fmt(r && r.current);
    paintRange($('seek'));
  }
  $('timeDur').textContent = fmt(dur);
  if (u.player && u.player.volume != null && !volDragging) {
    volume = u.player.volume;
    muted = !!u.player.muted;
  }
  paintVolume();
}

api.onUpdate((u) => {
  last = u;
  render();
});

$('playPause').addEventListener('click', () => api.cmd('toggle'));
$('seek').addEventListener('input', () => {
  dragging = true;
  paintRange($('seek'));
  $('timeCur').textContent = fmt(Number($('seek').value));
});
$('seek').addEventListener('change', () => {
  dragging = false;
  api.cmd('seek', Number($('seek').value));
});
$('volSlider').addEventListener('input', () => {
  volDragging = true;
  volume = Number($('volSlider').value);
  if (volume > 0) muted = false;
  paintVolume();
  api.setVolume(volume);
});
$('volSlider').addEventListener('change', () => { volDragging = false; });
$('volBtn').addEventListener('click', () => {
  muted = !muted;
  paintVolume();
  api.setMute(muted);
});
document.querySelector('.volume').addEventListener('wheel', (e) => {
  e.preventDefault();
  volume = Math.max(0, Math.min(130, volume + (e.deltaY < 0 ? 5 : -5)));
  if (volume > 0) muted = false;
  paintVolume();
  api.setVolume(volume);
}, { passive: false });
$('sidebarBtn').addEventListener('click', () => api.toggleSidebar());
$('exitFs').addEventListener('click', () => api.fullscreen(false));

paintVolume();
