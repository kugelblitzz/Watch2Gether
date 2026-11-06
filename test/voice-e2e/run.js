'use strict';
// Launch the voice e2e harness in Electron with a clean environment
// (VS Code terminals set ELECTRON_RUN_AS_NODE, which would make Electron act like Node).
const { spawn } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'main.js')], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code || 0));
