'use strict';

/**
 * Anonymous playback stats, only with the user's consent (off until they say yes).
 *
 * Reports (see playstats.js) are queued in a local file and uploaded in small batches to
 * our Cloudflare Worker (telemetry-worker/). Uploading never blocks or bothers the user:
 * offline, failed, rejected — the report waits for the next try, and the queue is capped.
 *
 * Never sent: file names or paths, names, chat, voice, room codes, IP addresses
 * (the Worker doesn't store them). Each install has a random id the user can reset,
 * which also deletes everything stored for it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ENDPOINT = 'https://telemetry.w2g-stats.workers.dev';
const MAX_QUEUE = 100; // reports kept locally while offline
const BATCH = 20; // reports per upload
const FLUSH_DELAY_MS = 5000;
const RETRY_MS = [60e3, 5 * 60e3, 30 * 60e3];

class Telemetry {
  /**
   * @param {object} o
   * @param {string} o.dir             folder for the queue file (userData)
   * @param {() => object} o.getSettings
   * @param {(patch: object) => void} o.saveSettings
   * @param {() => object} [o.machine] facts about this PC (filled lazily, see machineInfo)
   * @param {string} o.appVersion
   */
  constructor({ dir, getSettings, saveSettings, machine, appVersion, endpoint = ENDPOINT, fetchImpl = globalThis.fetch }) {
    this.file = path.join(dir, 'stats-queue.jsonl');
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.machine = machine || (() => ({}));
    this.appVersion = appVersion;
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.flushTimer = null;
    this.flushing = null;
    this.failures = 0;
    this.last = null; // the last report built, for "See what's sent"
  }

  get state() {
    const s = this.getSettings().stats;
    return s && typeof s === 'object' ? s : {};
  }

  /** 'yes' | 'no' | null (never asked) */
  get consent() {
    const c = this.state.consent;
    return c === 'yes' || c === 'no' ? c : null;
  }

  get installId() {
    return this.state.installId || null;
  }

  status() {
    return { consent: this.consent, queued: this._read().length, endpoint: this.endpoint };
  }

  setConsent(yes) {
    const st = this.state;
    this.saveSettings({
      stats: {
        ...st,
        consent: yes ? 'yes' : 'no',
        installId: st.installId || crypto.randomUUID(),
        decidedAt: Date.now(),
      },
    });
    if (!yes) this._write([]); // nothing waits to be sent once they say no
    else this.flushSoon();
    return this.status();
  }

  /** A finished video's report from the session. Dropped unless the user agreed. */
  record(report) {
    if (this.consent !== 'yes' || !report || typeof report !== 'object') return;
    const full = this.build(report);
    this.last = full;
    const q = this._read();
    q.push(full);
    this._write(q.slice(-MAX_QUEUE));
    this.flushSoon();
  }

  /** The report as it would be uploaded (also shown in "See what's sent"). */
  build(report) {
    return {
      ...report,
      app: this.appVersion,
      os: `windows ${os.release()}`,
      machine: this.machine(),
    };
  }

  /** What "See what's sent" shows: the last real report, or an example built from this PC. */
  preview() {
    if (this.last) return { example: false, report: this.last };
    const q = this._read();
    if (q.length) return { example: false, report: q[q.length - 1] };
    return {
      example: true,
      report: this.build({
        v: 1,
        role: 'guest',
        source: 'stream',
        viewers: 3,
        video: { codec: 'av1', width: 3840, height: 2160, fps: 23.976, bitDepth: 10, hdr: 'pq', container: 'mkv', bitrateMbps: 18.2, durationMin: 128 },
        decode: { hwdec: 'no', droppedFrames: 1240, decoderDroppedFrames: 0, slowSec: 310 },
        net: { rttMs: 24, throughputMbps: 41.5, minCacheSec: 22.4 },
        sync: { watchSec: 5400, stalls: { network: 0, seek: 2, load: 1, decode: 9, align: 1, other: 0 }, stallSec: 64, driftSeeks: 11, driftSeeksSlow: 9, maxDriftMs: 1620 },
        mpv: 'mpv v0.41.0',
      }),
    };
  }

  flushSoon(delay = FLUSH_DELAY_MS) {
    if (this.consent !== 'yes') return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flush().catch(() => {}); }, delay);
    if (this.flushTimer.unref) this.flushTimer.unref(); // never keeps the app alive
  }

  /** Upload what's queued. Resolves to the number of reports the server accepted. */
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      let sent = 0;
      try {
        while (this.consent === 'yes' && this.installId) {
          const q = this._read();
          if (!q.length) break;
          const batch = q.slice(0, BATCH);
          const res = await this._post('/v1/report', { installId: this.installId, reports: batch });
          if (res.status === 400 || res.status === 413) {
            // the server will never take these (e.g. an old format): drop them, don't retry forever
            this._write(this._read().slice(batch.length));
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this._write(this._read().slice(batch.length));
          sent += batch.length;
        }
        this.failures = 0;
      } catch {
        // offline / server trouble: try again later, a bit later each time
        this.flushSoon(RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]);
        this.failures++;
      } finally {
        this.flushing = null;
      }
      return sent;
    })();
    return this.flushing;
  }

  /**
   * Ask the server to delete everything for this install, then start over with a new id.
   * Consent stays as it was (turning stats off is a separate choice).
   */
  async deleteMyData() {
    const id = this.installId;
    if (id) {
      const res = await this._request('DELETE', `/v1/install/${id}`);
      if (!res.ok) throw new Error(`The stats server answered HTTP ${res.status}. Try again later.`);
    }
    this._write([]);
    this.last = null;
    this.saveSettings({ stats: { ...this.state, installId: crypto.randomUUID() } });
    return this.status();
  }

  // ---------- internals ----------

  _post(p, body) {
    return this._request('POST', p, body);
  }

  async _request(method, p, body) {
    if (!this.fetch) throw new Error('No network access');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      return await this.fetch(this.endpoint + p, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  _read() {
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  _write(list) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''));
    } catch { /* non-fatal: stats are best effort */ }
  }
}

/**
 * GPU / CPU / RAM, coarse enough not to identify anyone. getGPUInfo is Electron's
 * (app.getGPUInfo('basic')); passed in so this file stays testable without Electron.
 */
/**
 * The GPU's marketing name ("NVIDIA GeForce RTX 4070") from Windows, matched by PCI ids.
 * Electron's quick ('basic') GPU info only has the ids, and its 'complete' info is slow.
 */
function windowsGpuName(vendorId, deviceId) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const ps = 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.PNPDeviceID + "|" + $_.Name }';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const hex = (n) => (n || 0).toString(16).padStart(4, '0').toUpperCase();
      const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('|'));
      const hit = lines.find((l) => l.toUpperCase().includes(`VEN_${hex(vendorId)}&DEV_${hex(deviceId)}`))
        || (lines.length === 1 ? lines[0] : null);
      resolve(hit ? hit.slice(hit.indexOf('|') + 1).trim() || null : null);
    });
  });
}

async function machineInfo(getGPUInfo, lookupGpuName = windowsGpuName) {
  const cpus = os.cpus() || [];
  const info = {
    cpu: cpus[0] ? cpus[0].model.replace(/\s+/g, ' ').trim().slice(0, 64) : null,
    cores: cpus.length || null,
    ramGb: Math.round(os.totalmem() / 2 ** 30),
    gpu: null,
    gpuDriver: null,
  };
  try {
    const g = getGPUInfo ? await getGPUInfo() : null;
    const devs = (g && g.gpuDevice) || [];
    const d = devs.find((x) => x.active) || devs[0];
    if (d) {
      // ids too: names vary by driver, "10de:2d04" pins the exact chip
      const ids = `${(d.vendorId || 0).toString(16).padStart(4, '0')}:${(d.deviceId || 0).toString(16).padStart(4, '0')}`;
      const name = d.deviceString || (await lookupGpuName(d.vendorId, d.deviceId).catch(() => null));
      info.gpu = (name ? `${String(name).slice(0, 50)} (${ids})` : ids).slice(0, 64);
      info.gpuDriver = d.driverVersion ? String(d.driverVersion).slice(0, 32) : null;
    }
  } catch { /* unknown */ }
  return info;
}

module.exports = { Telemetry, machineInfo, ENDPOINT };
