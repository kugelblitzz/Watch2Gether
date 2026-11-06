'use strict';

/**
 * Updater state machine with electron and electron-updater faked out.
 * Covers: progress, a release landing mid-download, a release landing after
 * the update is ready, download failure + retry, and lobby-aware scheduling.
 */

const assert = require('assert');
const { EventEmitter } = require('events');

// ---------- fakes ----------
const fakeUpdater = new EventEmitter();
fakeUpdater.checks = 0;
fakeUpdater.latest = '0.3.0';
fakeUpdater.installed = null;
fakeUpdater.checkForUpdates = async function () {
  this.checks++;
  if (this.failNextCheck) {
    this.failNextCheck = false;
    const e = new Error('net::ERR_CONNECTION_RESET');
    this.emit('error', e);
    throw e;
  }
  if (this.upToDate) {
    this.emit('update-not-available', { version: '0.5.1' });
    return { updateInfo: { version: '0.5.1' } };
  }
  this.emit('update-available', { version: this.latest });
  return { updateInfo: { version: this.latest } };
};
fakeUpdater.quitAndInstall = function () { this.installed = true; };

const Module = require('module');
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { isPackaged: true, getVersion: () => '0.5.1' } };
  if (req === 'electron-updater') return { autoUpdater: fakeUpdater };
  return realLoad.call(this, req, ...rest);
};

// capture timers so the test can fire them by hand
const timeouts = [];
const intervals = [];
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { const t = { fn, ms, unref() { return t; } }; timeouts.push(t); return t; };
global.setInterval = (fn, ms) => { const t = { fn, ms, unref() { return t; } }; intervals.push(t); return t; };
global.clearTimeout = (t) => { const i = timeouts.indexOf(t); if (i >= 0) timeouts.splice(i, 1); };
const fireTimeout = (ms) => { const i = timeouts.findIndex((t) => t.ms === ms); assert(i >= 0, 'no timer of ' + ms); const [t] = timeouts.splice(i, 1); t.fn(); };
const fireInterval = () => intervals[0].fn();
const tick = () => new Promise((r) => setImmediate(r));

const { initUpdater, installUpdate } = require('../src/main/updater');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

(async () => {
  const seen = [];
  let busy = false;
  initUpdater((u) => seen.push(u), () => busy);
  const last = () => seen[seen.length - 1];

  console.log('updater');
  await test('first check runs shortly after launch and starts the download', async () => {
    fireTimeout(5000);
    await tick();
    assert.strictEqual(fakeUpdater.checks, 1);
    assert.deepStrictEqual(last(), { state: 'downloading', version: '0.3.0', percent: 0 });
  });

  await test('progress is forwarded with the downloading version', async () => {
    fakeUpdater.emit('download-progress', { percent: 28.4, transferred: 33e6, total: 117.8e6, bytesPerSecond: 129e3 });
    assert.strictEqual(last().percent, 28.4);
    assert.strictEqual(last().version, '0.3.0');
  });

  await test('progress events are throttled', async () => {
    const n = seen.length;
    for (let i = 0; i < 20; i++) fakeUpdater.emit('download-progress', { percent: 29 + i * 0.01, transferred: 1, total: 2, bytesPerSecond: 1 });
    assert.strictEqual(seen.length, n, 'no flood of updates within 400 ms');
  });

  await test('a release published mid-download does not start a second download or relabel it', async () => {
    fakeUpdater.latest = '0.3.1';
    fireInterval(); // the 4-hour check comes round
    await tick();
    assert.strictEqual(fakeUpdater.checks, 1, 'no check while downloading');
    assert.strictEqual(last().version, '0.3.0');
  });

  await test('the finished download is offered', async () => {
    fakeUpdater.emit('update-downloaded', { version: '0.3.0' });
    assert.deepStrictEqual(last(), { state: 'ready', version: '0.3.0' });
  });

  await test('a newer release after the update is ready keeps "Restart to update"', async () => {
    fireInterval();
    await tick();
    assert.strictEqual(fakeUpdater.checks, 1, 'no check once ready; next launch gets 0.3.1');
    assert.strictEqual(last().state, 'ready');
    installUpdate();
    assert.strictEqual(fakeUpdater.installed, true);
  });

  // ---- fresh updater instance for the failure paths ----
  delete require.cache[require.resolve('../src/main/updater')];
  fakeUpdater.removeAllListeners();
  fakeUpdater.checks = 0;
  fakeUpdater.installed = null;
  timeouts.length = 0; intervals.length = 0;
  const upd2 = require('../src/main/updater');
  const seen2 = [];
  busy = false;
  upd2.initUpdater((u) => seen2.push(u), () => busy);
  const last2 = () => seen2[seen2.length - 1];

  await test('a failed download is reported, not left at 28% forever', async () => {
    fireTimeout(5000);
    await tick();
    fakeUpdater.emit('download-progress', { percent: 28, transferred: 1, total: 2, bytesPerSecond: 1 });
    fakeUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'));
    assert.strictEqual(last2().state, 'failed');
    assert.strictEqual(last2().version, '0.3.1');
  });

  await test('install is refused unless an update is actually ready', async () => {
    upd2.installUpdate();
    assert.strictEqual(fakeUpdater.installed, null);
  });

  await test('it retries after 10 minutes', async () => {
    fireTimeout(10 * 60 * 1000);
    await tick();
    assert.strictEqual(fakeUpdater.checks, 2);
    assert.strictEqual(last2().state, 'downloading');
    fakeUpdater.emit('update-downloaded', { version: '0.3.1' });
  });

  // ---- lobby-aware scheduling + failed check ----
  delete require.cache[require.resolve('../src/main/updater')];
  fakeUpdater.removeAllListeners();
  fakeUpdater.checks = 0;
  timeouts.length = 0; intervals.length = 0;
  const upd3 = require('../src/main/updater');
  const seen3 = [];
  upd3.initUpdater((u) => seen3.push(u), () => busy);

  await test('a failed check (offline) is silent and retried', async () => {
    fakeUpdater.failNextCheck = true;
    fireTimeout(5000);
    await tick();
    assert.strictEqual(seen3.length, 0, 'nothing shown for a failed check');
    assert(timeouts.some((t) => t.ms === 10 * 60 * 1000), 'retry scheduled');
  });

  await test('scheduled checks run every 30 minutes and wait while in a lobby', async () => {
    assert.strictEqual(intervals[0].ms, 30 * 60 * 1000);
    fakeUpdater.upToDate = true;
    busy = true;
    fireInterval();
    await tick();
    assert.strictEqual(fakeUpdater.checks, 1);
    busy = false;
    fireInterval();
    await tick();
    assert.strictEqual(fakeUpdater.checks, 2);
    assert.strictEqual(seen3.length, 0, 'automatic "up to date" results are not shown');
  });

  await test('leaving a lobby triggers the check that was skipped during the movie', async () => {
    busy = false;
    upd3.checkAfterLobby();
    await tick();
    assert.strictEqual(fakeUpdater.checks, 3);
  });

  await test('"check for updates" (click on the version) reports up to date', async () => {
    busy = true; // works even in a lobby: the user asked
    upd3.checkNow();
    await tick();
    assert.strictEqual(fakeUpdater.checks, 4);
    assert.deepStrictEqual(seen3.splice(0), [{ state: 'checking' }, { state: 'uptodate', version: '0.5.1' }]);
    busy = false;
  });

  await test('"check for updates" while offline says so', async () => {
    fakeUpdater.failNextCheck = true;
    upd3.checkNow();
    await tick();
    assert.deepStrictEqual(seen3.splice(0).map((u) => u.state), ['checking', 'check-failed']);
  });

  await test('"check for updates" finds a new version and downloads it', async () => {
    fakeUpdater.upToDate = false;
    fakeUpdater.latest = '0.6.0';
    upd3.checkNow();
    await tick();
    assert.deepStrictEqual(seen3.splice(0), [{ state: 'checking' }, { state: 'downloading', version: '0.6.0', percent: 0 }]);
    fakeUpdater.emit('download-progress', { percent: 40, transferred: 4, total: 10, bytesPerSecond: 1 });
    seen3.splice(0);
  });

  await test('clicking again mid-download just shows the progress, no second download', async () => {
    const before = fakeUpdater.checks;
    upd3.checkNow();
    await tick();
    assert.strictEqual(fakeUpdater.checks, before);
    assert.deepStrictEqual(seen3.splice(0).map((u) => [u.state, u.percent]), [['downloading', 40]]);
    fakeUpdater.emit('update-downloaded', { version: '0.6.0' });
    seen3.splice(0);
    upd3.checkNow();
    assert.deepStrictEqual(seen3.splice(0), [{ state: 'ready', version: '0.6.0' }], 'and once ready, shows "Restart to update" again');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  realSetTimeout(() => process.exit(process.exitCode || 0), 10);
})();
