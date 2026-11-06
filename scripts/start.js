'use strict';
// Launch Electron with a clean environment. VS Code terminals set ELECTRON_RUN_AS_NODE=1,
// which makes Electron behave like plain Node and the app fails to start.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: require('path').join(__dirname, '..') });
child.on('exit', (code) => process.exit(code || 0));
