'use strict';

/**
 * PlaybackStats — what one viewer's playback of one video was like: the video's format,
 * whether the GPU decoded it, how often and *why* playback stalled.
 *
 * Why the cause matters: a PC that can't decode a video fast enough (typically AV1 or 4K HEVC
 * without hardware decoding) drops frames and falls behind the room clock; the sync loop then
 * seeks it forward, and that seek looks exactly like buffering. Network numbers stay fine the
 * whole time, so "it buffers regardless of bandwidth". Telling the two apart is the point.
 *
 * It's used for the in-app "your PC can't keep up" warning (always) and for the anonymous
 * usage report (only with the user's consent). It never holds file names or paths.
 */

const MIN_WATCH_SEC = 30; // shorter than this isn't worth a report
const SLOW_DROPS_PER_SEC = 2; // frames dropped per second that count as "can't keep up"
const SLOW_AVSYNC_SEC = 0.25; // video this far behind the audio, too
const SLOW_BEHIND_RATE = 0.1; // losing this many seconds per second against the room clock
const SLOW_ENTER_SAMPLES = 2; // consecutive slow samples before we call it (about 4 s)
const SLOW_EXIT_SAMPLES = 3;

const HEAVY_CODECS = new Set(['av1', 'hevc', 'vp9']);

/** mpv's file-format ("matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2", ...) -> short name. */
function containerName(fmt) {
  const f = String(fmt || '').toLowerCase();
  if (!f) return null;
  if (f.includes('matroska') || f.includes('webm')) return 'mkv';
  if (f.includes('mp4') || f.includes('mov')) return 'mp4';
  if (f.includes('mpegts')) return 'ts';
  if (f.includes('avi')) return 'avi';
  if (f.includes('asf')) return 'wmv';
  return f.split(',')[0].slice(0, 16);
}

/** mpv video-params -> { width, height, bitDepth, hdr } */
function paramsInfo(p) {
  if (!p || typeof p !== 'object') return {};
  // Software formats carry the depth after the 'p' (yuv420p10, yuv420p10le, gbrp12). With
  // hardware decoding pixelformat is just "d3d11" and the depth is in hw-pixelformat:
  // p010 / p016 are 10 / 16 bit, nv12 is 8 bit (its "12" is bits per pixel, not depth).
  const sw = String(p.pixelformat || '');
  const hw = String(p['hw-pixelformat'] || '');
  const m = sw.match(/p(\d{2})(le|be)?$/);
  let bitDepth = 8;
  if (m && Number(m[1]) >= 9 && Number(m[1]) <= 16) bitDepth = Number(m[1]);
  else if (/^p010/.test(hw) || /^p010/.test(sw)) bitDepth = 10;
  else if (/^p016/.test(hw) || /^p016/.test(sw)) bitDepth = 16;
  const gamma = String(p.gamma || '').toLowerCase();
  const hdr = gamma === 'pq' ? 'pq' : gamma === 'hlg' ? 'hlg' : 'sdr';
  return {
    width: Number.isFinite(p.w) ? p.w : null,
    height: Number.isFinite(p.h) ? p.h : null,
    bitDepth,
    hdr,
  };
}

function round(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

class PlaybackStats {
  constructor({ media, source, role }) {
    this.role = role; // 'host' | 'guest'
    this.source = source; // 'local' | 'stream'
    this.sizeBytes = media && media.size;
    this.video = { codec: null, width: null, height: null, fps: null, bitDepth: null, hdr: null, container: null };
    this.duration = null;
    this.hwdec = null;
    this.mpvVersion = null;
    this.watchSec = 0;
    this.stalls = { network: 0, seek: 0, load: 0, decode: 0, align: 0, other: 0 };
    this.stallSec = 0;
    this.stallStartedAt = null;
    this.stallCause = null;
    this.driftSeeks = 0;
    this.driftSeeksSlow = 0;
    this.maxDrift = 0;
    this.minCache = null;
    this.rtts = [];
    this.speeds = [];
    this.maxViewers = 0;
    this.drops = { vo: 0, decoder: 0 };
    this.lastDrops = null;
    this.slowSec = 0;
    this.slowRun = 0;
    this.fastRun = 0;
    this.decodeSlow = false;
    this.lastSampleAt = null;
    this.minWatchSec = MIN_WATCH_SEC;
  }

  /** From mpv once the file is open (any field may be missing). */
  setVideoInfo({ format, params, fps, fileFormat, duration, mpvVersion }) {
    if (format) this.video.codec = String(format).toLowerCase().slice(0, 24);
    Object.assign(this.video, paramsInfo(params));
    if (Number.isFinite(fps) && fps > 0) this.video.fps = round(fps, 3);
    if (fileFormat) this.video.container = containerName(fileFormat);
    if (Number.isFinite(duration) && duration > 0) this.duration = duration;
    if (mpvVersion) this.mpvVersion = String(mpvVersion).slice(0, 40);
  }

  setHwdec(v) {
    if (typeof v === 'string' && v) this.hwdec = v.slice(0, 24);
  }

  /** True when this video is the kind that needs a GPU to play smoothly. */
  get heavy() {
    return isHeavyVideo(this.video);
  }

  /**
   * Every couple of seconds.
   * playing:    this viewer is actually playing (room playing, not waiting, not buffering)
   * voDrops / decoderDrops: mpv's running totals
   * settled:    nothing (seek, resume, load) happened since the previous sample, so frame drops
   *             in this interval say something about the decoder
   * behindRate: seconds per second this player fell further behind the room clock over the
   *             interval (null if a seek happened in it); the most direct sign of a slow decoder
   */
  sample({ playing, settled = true, behindRate = null, speed = 1, voDrops, decoderDrops, avsync, cacheSec, cacheSpeed, rtt, drift, viewers }, now = Date.now()) {
    const dt = this.lastSampleAt == null ? 0 : Math.min(10, (now - this.lastSampleAt) / 1000);
    this.lastSampleAt = now;
    if (Number.isFinite(rtt)) this.rtts.push(rtt);
    if (this.rtts.length > 300) this.rtts.shift();
    if (Number.isFinite(viewers)) this.maxViewers = Math.max(this.maxViewers, viewers);

    const vo = Number.isFinite(voDrops) ? voDrops : null;
    const dec = Number.isFinite(decoderDrops) ? decoderDrops : null;
    let dropRate = null; // null: no previous totals to compare with yet
    if (this.lastDrops && dt > 0) {
      // Counters restart when the file is reloaded; a negative step is just a reset.
      const dVo = vo != null && this.lastDrops.vo != null ? Math.max(0, vo - this.lastDrops.vo) : 0;
      const dDec = dec != null && this.lastDrops.dec != null ? Math.max(0, dec - this.lastDrops.dec) : 0;
      if (playing) {
        this.drops.vo += dVo;
        this.drops.decoder += dDec;
      }
      dropRate = (dVo + dDec) / dt;
    }
    this.lastDrops = { vo, dec };

    if (!playing) return;
    this.watchSec += dt;
    if (Number.isFinite(drift)) this.maxDrift = Math.max(this.maxDrift, Math.abs(drift));
    if (this.source === 'stream') {
      if (Number.isFinite(cacheSec)) this.minCache = this.minCache == null ? cacheSec : Math.min(this.minCache, cacheSec);
      // cache-speed is only meaningful while the cache is still filling
      if (Number.isFinite(cacheSpeed) && cacheSpeed > 0) this.speeds.push(cacheSpeed);
      if (this.speeds.length > 300) this.speeds.shift();
    }

    // Three signs, each only where it means something (all seen on real mpv with a 4K60 AV1 file):
    // - falling behind the room clock while playing: a healthy player holds or catches up even
    //   while frames drop; a slow decoder loses time every second, even when sped up.
    // - dropped frames, but not right after a seek / resume / load (a fast GPU-decoding host
    //   drops a few then and got flagged), and allowing for the sync loop's catch-up speed-up
    //   (60 fps at 1.08x on a 60 Hz screen must drop ~5 frames/s).
    // - video lagging the audio.
    const fps = this.video.fps || 60;
    const allowedDrops = Math.max(SLOW_DROPS_PER_SEC, fps * 0.05) + fps * Math.max(0, (Number(speed) || 1) - 1);
    const signs = [];
    if (Number.isFinite(behindRate)) signs.push(behindRate > SLOW_BEHIND_RATE);
    if (settled && dropRate != null) signs.push(dropRate >= allowedDrops);
    if (Number.isFinite(avsync)) signs.push(Math.abs(avsync) > SLOW_AVSYNC_SEC);
    if (!signs.length) return; // nothing to judge this time: leave the verdict as it is
    const slowNow = signs.some(Boolean);
    if (slowNow) {
      this.slowRun++;
      this.fastRun = 0;
      this.slowSec += dt;
      if (this.slowRun >= SLOW_ENTER_SAMPLES) this.decodeSlow = true;
    } else {
      this.fastRun++;
      this.slowRun = 0;
      if (this.fastRun >= SLOW_EXIT_SAMPLES) this.decodeSlow = false;
    }
  }

  stallStart(cause, now = Date.now()) {
    if (this.stallStartedAt != null) return;
    const c = Object.prototype.hasOwnProperty.call(this.stalls, cause) ? cause : 'other';
    this.stalls[c]++;
    this.stallCause = c;
    this.stallStartedAt = now;
  }

  stallEnd(now = Date.now()) {
    if (this.stallStartedAt == null) return;
    // the first load isn't a stall the viewer suffers through mid-movie; count it but not its time
    if (this.stallCause !== 'load') this.stallSec += Math.max(0, (now - this.stallStartedAt) / 1000);
    this.stallStartedAt = null;
    this.stallCause = null;
  }

  /**
   * The sync loop had to jump forward while playing (fell > 1.5 s behind). Right after a
   * "falling behind" reading that settles it: on real mpv the struggling player then sat ~10 s
   * in a stall, so waiting for a second reading took ~19 s instead of ~4.
   */
  driftSeek() {
    this.driftSeeks++;
    if (this.slowRun >= 1) this.decodeSlow = true;
    if (this.decodeSlow) this.driftSeeksSlow++;
  }

  /** The anonymous report, or null if too little was watched to say anything. */
  report(now = Date.now()) {
    this.stallEnd(now);
    if (this.watchSec < this.minWatchSec) return null;
    const bitrate = this.sizeBytes && this.duration ? (this.sizeBytes * 8) / this.duration / 1e6 : null;
    const speedMbps = this.speeds.length ? (median(this.speeds) * 8) / 1e6 : null;
    return {
      v: 1,
      role: this.role,
      source: this.source,
      viewers: this.maxViewers || null,
      video: {
        ...this.video,
        bitrateMbps: round(bitrate, 1),
        durationMin: this.duration ? Math.round(this.duration / 60) : null,
      },
      decode: {
        hwdec: this.hwdec,
        droppedFrames: this.drops.vo,
        decoderDroppedFrames: this.drops.decoder,
        slowSec: Math.round(this.slowSec),
      },
      net: {
        rttMs: median(this.rtts),
        throughputMbps: round(speedMbps, 1),
        minCacheSec: round(this.minCache, 1),
      },
      sync: {
        watchSec: Math.round(this.watchSec),
        stalls: { ...this.stalls },
        stallSec: Math.round(this.stallSec),
        driftSeeks: this.driftSeeks,
        driftSeeksSlow: this.driftSeeksSlow,
        maxDriftMs: Math.round(this.maxDrift * 1000),
      },
      mpv: this.mpvVersion,
    };
  }
}

/** AV1 / HEVC / VP9 at 1440p or more: smooth only with GPU decoding on most PCs. */
function isHeavyVideo(video) {
  return !!video && HEAVY_CODECS.has(video.codec) && (video.height || 0) >= 1440;
}

module.exports = { PlaybackStats, containerName, paramsInfo, isHeavyVideo, MIN_WATCH_SEC };
