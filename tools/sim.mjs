#!/usr/bin/env node
/**
 * sim.mjs — build firmware (if needed) and open it in the 3D simulator
 * =====================================================================
 *
 *   node tools/sim.mjs fw.wasm                 open an existing build
 *   node tools/sim.mjs path/to/firmware-dir    compile it first, then open
 *
 * Writes dist/<name>-sim.html — a single self-contained page with your
 * firmware embedded and selected — and opens it in your default browser.
 * The page loads three.js from jsDelivr, so it needs an internet connection.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error('usage: node tools/sim.mjs <fw.wasm | firmware-folder>');
  console.error('  e.g. node tools/sim.mjs firmware/fluid-demo');
  process.exit(1);
}

// 1. a folder of .c files -> compile it
let wasm = path.resolve(input);
if (fs.statSync(input).isDirectory()) {
  wasm = path.join(ROOT, 'dist', path.basename(path.resolve(input)) + '.wasm');
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-firmware.mjs'), input, '-o', wasm], { stdio: 'inherit' });
}

// 2. page with that firmware embedded and preselected
const page = path.join(ROOT, 'dist', path.basename(wasm, '.wasm') + '-sim.html');
execFileSync(process.execPath, [path.join(ROOT, 'tools/build-web.mjs'), '-o', page, '--add', wasm, '--standalone'], { stdio: 'inherit' });

// 3. open it
const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
try {
  execFileSync(opener, [page], { stdio: 'ignore' });
  console.log('Opened in your browser. Drag the card to tilt it.');
} catch {
  console.log('Open this file in your browser: ' + page);
}
