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
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 10 * 60 * 1000;
const PROGRESS_EVERY_MS = 400;

let updater = null;
let state = 'idle';

/**
 * @param notify  called with { state: 'downloading' | 'ready' | 'failed', version,
 *                percent?, transferred?, total?, bytesPerSecond?, message? }
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

  updater.on('update-available', (i) => {
    state = 'downloading';
    version = i.version;
    lastProgress = 0;
    notify({ state, version, percent: 0 });
  });
  updater.on('update-not-available', () => { state = 'idle'; });
  updater.on('download-progress', (p) => {
    if (state !== 'downloading') return;
    const now = Date.now();
    if (now - lastProgress < PROGRESS_EVERY_MS && p.percent < 100) return;
    lastProgress = now;
    notify({
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
    notify({ state, version: i.version });
  });
  updater.on('error', (e) => {
    console.error('[updater]', e && e.message);
    if (state === 'ready') return; // a finished download is still installable
    const wasDownloading = state === 'downloading';
    state = 'idle';
    if (wasDownloading) notify({ state: 'failed', version, message: e && e.message });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => check(true), RETRY_AFTER_FAIL_MS);
  });

  /** Check unless an update is already on its way or ready. */
  function check(scheduled) {
    if (state !== 'idle') return;
    if (scheduled && isBusy()) return;
    state = 'checking';
    updater.checkForUpdates()
      .then(() => { if (state === 'checking') state = 'idle'; }) // resolved without an event
      .catch(() => { /* reported through 'error' */ });
  }

  setTimeout(() => check(false), FIRST_CHECK_MS);
  setInterval(() => check(true), CHECK_EVERY_MS).unref();
}

/** Quit and run the downloaded installer silently, then relaunch. */
function installUpdate() {
  if (updater && state === 'ready') updater.quitAndInstall(true, true);
}

module.exports = { initUpdater, installUpdate };
