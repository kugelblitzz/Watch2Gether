'use strict';

/**
 * Auto-update from GitHub Releases (see "publish" in package.json).
 * Downloads in the background and installs when the app quits, so a watch
 * session is never interrupted. The UI can also offer "Restart to update".
 *
 * States: idle -> checking -> downloading -> ready
 *                         \-> (failed) -> idle, retried soon
 * Only one update is handled at a time:
 *  - no new check while downloading: a release that lands mid-download is
 *    picked up after this one finishes and the app restarts;
 *  - no new check once an update is ready: the next launch checks again and
 *    gets the newest release, so there's no reason to replace a finished
 *    download (and hide "Restart to update") with another one.
 */

const { app } = require('electron');

const FIRST_CHECK_MS = 5000;
const CHECK_EVERY_MS = 30 * 60 * 1000; // skipped while in a lobby; also checked right after leaving one
const RETRY_AFTER_FAIL_MS = 10 * 60 * 1000;
const PROGRESS_EVERY_MS = 400;

let updater = null;
let state = 'idle';
let check = () => {};
let current = null; // last thing shown to the user (re-shown on a manual check)

/**
 * @param notify  called with { state: 'checking' | 'uptodate' | 'check-failed' | 'downloading' | 'ready' | 'failed',
 *                version?, percent?, transferred?, total?, bytesPerSecond?, message? }
 *                ('checking' / 'uptodate' / 'check-failed' only for checks the user asked for)
 * @param isBusy  returns true while in a lobby; scheduled checks wait, so a
 *                download never competes with a stream mid-movie
 */
function initUpdater(notify, isBusy = () => false) {
  if (!app.isPackaged) return; // dev runs (npm start) have no app-update.yml
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let version = null; // the version being downloaded, fixed for the whole download
  let lastProgress = 0;
  let retryTimer = null;
  let manual = false; // the running check was started by the user
  const show = (u) => {
    if (u.state === 'downloading' || u.state === 'ready') current = u;
    notify(u);
  };

  updater.on('update-available', (i) => {
    state = 'downloading';
    version = i.version;
    lastProgress = 0;
    manual = false;
    show({ state, version, percent: 0 });
  });
  updater.on('update-not-available', () => {
    state = 'idle';
    if (manual) notify({ state: 'uptodate', version: app.getVersion() });
    manual = false;
  });
  updater.on('download-progress', (p) => {
    if (state !== 'downloading') return;
    const now = Date.now();
    if (now - lastProgress < PROGRESS_EVERY_MS && p.percent < 100) return;
    lastProgress = now;
    show({
      state,
      version,
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  updater.on('update-downloaded', (i) => {
    state = 'ready';
    show({ state, version: i.version });
  });
  updater.on('error', (e) => {
    console.error('[updater]', e && e.message);
    if (state === 'ready') return; // a finished download is still installable
    const wasDownloading = state === 'downloading';
    state = 'idle';
    current = null;
    if (wasDownloading) notify({ state: 'failed', version, message: e && e.message });
    else if (manual) notify({ state: 'check-failed', message: e && e.message });
    manual = false;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => check(true), RETRY_AFTER_FAIL_MS);
  });

  /**
   * Check unless an update is already on its way or ready.
   * scheduled: skipped while in a lobby.  byUser: report the outcome (up to date / failed).
   */
  check = (scheduled, byUser = false) => {
    if (state === 'downloading' || state === 'ready') {
      if (byUser && current) notify(current); // already on its way: show where it is
      return;
    }
    if (state === 'checking') {
      if (byUser) { manual = true; notify({ state: 'checking' }); }
      return;
    }
    if (scheduled && isBusy()) return;
    manual = byUser;
    if (byUser) notify({ state: 'checking' });
    state = 'checking';
    updater.checkForUpdates()
      .then(() => { if (state === 'checking') state = 'idle'; }) // resolved without an event
      .catch(() => { /* reported through 'error' */ });
  };

  setTimeout(() => check(false), FIRST_CHECK_MS);
  setInterval(() => check(true), CHECK_EVERY_MS).unref();
}

/** The user clicked "check for updates". */
function checkNow() {
  check(false, true);
}

/** Just left a lobby: a good moment for the check that was skipped during the movie. */
function checkAfterLobby() {
  check(true);
}

/** Quit and run the downloaded installer silently, then relaunch. */
function installUpdate() {
  if (updater && state === 'ready') updater.quitAndInstall(true, true);
}

module.exports = { initUpdater, installUpdate, checkNow, checkAfterLobby };
