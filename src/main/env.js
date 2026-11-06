'use strict';

/** Detect Tailscale and mpv on this PC, and install mpv via winget if asked. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { isTailscale } = require('./util');

function run(exe, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function tailscaleExe() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'tailscale';
}

function tailscaleIpFromInterfaces() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && isTailscale(ni.address)) return ni.address;
    }
  }
  return null;
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal && !isTailscale(ni.address)) return ni.address;
    }
  }
  return null;
}

async function getTailscaleInfo() {
  const exe = tailscaleExe();
  const { err, stdout } = await run(exe, ['status', '--json']);
  const ifaceIp = tailscaleIpFromInterfaces();
  if (err && err.code === 'ENOENT') {
    return { installed: !!ifaceIp, running: !!ifaceIp, ip: ifaceIp, dnsName: null };
  }
  try {
    const j = JSON.parse(stdout);
    const self = j.Self || {};
    const ip = (self.TailscaleIPs || []).find((a) => a.includes('.')) || ifaceIp;
    return {
      installed: true,
      running: j.BackendState === 'Running',
      state: j.BackendState,
      ip: j.BackendState === 'Running' ? ip : null,
      dnsName: self.DNSName ? self.DNSName.replace(/\.$/, '') : null,
    };
  } catch {
    return { installed: true, running: !!ifaceIp, ip: ifaceIp, dnsName: null };
  }
}

function findMpv(extraDirs = [], configured = null) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [];
  if (configured) candidates.push(configured);
  for (const d of extraDirs) candidates.push(path.join(d, 'mpv.exe'));
  candidates.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'mpv.exe'));
  const wingetPkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(wingetPkgs)) {
      if (/^shinchiro\.mpv/i.test(d)) candidates.push(path.join(wingetPkgs, d, 'mpv.exe'));
    }
  } catch { /* none */ }
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  candidates.push(
    path.join(pf, 'MPV Player', 'mpv.exe'), // winget shinchiro.mpv installer
    path.join(pf, 'mpv', 'mpv.exe'),
    path.join(local, 'Programs', 'mpv', 'mpv.exe'),
    path.join(os.homedir(), 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\mpv.exe',
  );
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    if (p) candidates.push(path.join(p, 'mpv.exe'));
  }
  return candidates.find((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; }
  }) || null;
}

function installMpvWithWinget() {
  return new Promise((resolve) => {
    const proc = spawn('winget', [
      'install', '--id', 'shinchiro.mpv', '-e',
      '--accept-source-agreements', '--accept-package-agreements', '--silent',
    ], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', (e) => resolve({ ok: false, output: 'Could not run winget: ' + e.message }));
    proc.on('exit', (code) => resolve({ ok: code === 0, output: out.slice(-2000) }));
  });
}

module.exports = { getTailscaleInfo, findMpv, installMpvWithWinget, lanIp };
