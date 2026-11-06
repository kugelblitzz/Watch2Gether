'use strict';

/**
 * Auto-update from GitHub Releases (see "publish" in package.json).
 * Downloads in the background and installs when the app quits, so a watch
 * session is never interrupted. The UI can also offer "Restart to update".
 */

const { app } = require('electron');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let updater = null;

/**
 * @param notify  called with { state: 'downloading' | 'ready', version }
 * @param isBusy  returns true while in a lobby; periodic checks wait, so a
 *                download never competes with a stream mid-movie
 */
function initUpdater(notify, isBusy = () => false) {
  if (!app.isPackaged) return; // dev runs (npm start) have no app-update.yml
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('update-available', (i) => notify({ state: 'downloading', version: i.version }));
  updater.on('update-downloaded', (i) => notify({ state: 'ready', version: i.version }));
  updater.on('error', (e) => console.error('[updater]', e && e.message));

  const check = () => updater.checkForUpdates().catch((e) => console.error('[updater]', e && e.message));
  setTimeout(check, 5000);
  setInterval(() => { if (!isBusy()) check(); }, CHECK_EVERY_MS).unref();
}

/** Quit and run the downloaded installer silently, then relaunch. */
function installUpdate() {
  if (updater) updater.quitAndInstall(true, true);
}

module.exports = { initUpdater, installUpdate };
