#!/usr/bin/env node
/*
 * launcher.js — tiny supervisor for code-droid.
 *
 * Spawns server.js and respawns it when it exits with code 75 (the
 * in-IDE "⟳ Restart" button asks the server to exit with that code).
 * Any other exit code ends the supervisor. This is what `npm start` runs.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const RESTART_CODE = 75;

let stopping = false;
process.on('SIGINT', () => { stopping = true; if (child) child.kill('SIGINT'); });
process.on('SIGTERM', () => { stopping = true; if (child) child.kill('SIGTERM'); });

let child = null;
let restarts = 0;

function start() {
  child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => {
    if (stopping) process.exit(0);
    if (code === RESTART_CODE) {
      restarts++;
      console.log(`\n[launcher] restarting code-droid server (#${restarts})…`);
      setTimeout(start, 150);
    } else {
      console.log(`[launcher] server exited with code ${code}. Bye.`);
      process.exit(code || 0);
    }
  });
}

console.log('[launcher] code-droid supervisor up. Press Ctrl+C to stop.');
start();
