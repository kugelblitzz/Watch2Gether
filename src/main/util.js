'use strict';

/** Strip the IPv4-mapped IPv6 prefix Node puts on dual-stack sockets. */
function normalizeAddress(addr) {
  return String(addr || '').replace(/^::ffff:/i, '');
}

function isLoopback(addr) {
  addr = normalizeAddress(addr);
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}

/** Tailscale hands out 100.64.0.0/10 (IPv4) and fd7a:115c:a1e0::/48 (IPv6). */
function isTailscale(addr) {
  addr = normalizeAddress(addr).toLowerCase();
  const m = addr.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  return addr.startsWith('fd7a:115c:a1e0:');
}

function isPrivateLan(addr) {
  addr = normalizeAddress(addr).toLowerCase();
  const m = addr.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return addr.startsWith('fe80:') || addr.startsWith('fc') || addr.startsWith('fd');
}

function isAllowedAddress(addr, allowLan) {
  return isLoopback(addr) || isTailscale(addr) || (allowLan && isPrivateLan(addr));
}

function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '0:00';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Parse an invite like "100.101.1.2:8787/ABC123", "w2g://host:8787/ABC123"
 * or "http://my-pc.tail1234.ts.net:8787/ABC123".
 */
function parseInvite(text, defaultPort = 8787) {
  let s = String(text || '').trim().replace(/^(w2g|https?):\/\//i, '');
  const slash = s.lastIndexOf('/');
  if (slash <= 0) throw new Error('Invite should look like 100.x.y.z:8787/ROOMCODE');
  const code = s.slice(slash + 1).trim().toUpperCase();
  let hostPort = s.slice(0, slash).replace(/\/+$/, '');
  if (!code) throw new Error('Invite is missing the room code');
  let host = hostPort;
  let port = defaultPort;
  const v6 = hostPort.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) {
    host = `[${v6[1]}]`;
    if (v6[2]) port = Number(v6[2]);
  } else {
    const m = hostPort.match(/^(.+):(\d+)$/);
    if (m) {
      host = m[1];
      port = Number(m[2]);
    }
  }
  if (!host) throw new Error('Invite is missing the host address');
  return { host, port, code, baseUrl: `http://${host}:${port}` };
}

/**
 * Cursor position relative to the window's left edge, or null when the cursor is outside
 * the window. Outside includes another monitor to the left, which must count as "away"
 * (it used to count as "at the left edge" and kept the fullscreen sidebar open).
 */
function cursorXInWindow(p, b) {
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  return inside ? p.x - b.x : null;
}

module.exports = {
  cursorXInWindow,
  normalizeAddress,
  isLoopback,
  isTailscale,
  isPrivateLan,
  isAllowedAddress,
  formatTime,
  clamp,
  parseInvite,
};
