#!/usr/bin/env node
/**
 * build-firmware.mjs — compile Pico SDK C firmware into a simulator .wasm
 * =========================================================================
 *
 *   node tools/build-firmware.mjs <firmware-dir | file.c ...> [-o out.wasm] [-DNAME=VALUE ...]
 *
 * Pipeline (each step echoes its command so failures are easy to reproduce):
 *
 *   1. clang  --target=wasm32   every *.c in the firmware dir, plus the
 *      simulated SDK (sim/hal/src/*.c). Includes resolve to sim/hal/include,
 *      so `#include "pico/stdlib.h"` picks up the simulator versions.
 *      -DPICO_SIMULATOR=1 is defined in case firmware wants sim-only code.
 *   2. wasm-ld  links everything. There is no --allow-undefined: calling an
 *      SDK function the simulator does not implement is a clear link error
 *      instead of a silent no-op.
 *   3. instrument-cycles.mjs adds an instruction-cost counter so compute
 *      time on the simulated 150 MHz Cortex-M33 is deterministic.
 *   4. wasm-opt --asyncify  (Binaryen, from node_modules) instruments the
 *      code so the engine can suspend/resume each core at sim_yield().
 *
 * Requirements: clang + wasm-ld (LLVM >= 15) on PATH, and `npm install`
 * run once in the project root (for binaryen).
 *   macOS:  brew install llvm lld   and add $(brew --prefix llvm)/bin to PATH
 *   Ubuntu: sudo apt install clang lld
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { instrumentCycles } from './instrument-cycles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAL = path.join(ROOT, 'sim/hal');

// ---- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
let out = null;
const inputs = [];
const defines = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i].startsWith('-D')) defines.push(args[i]);
  else inputs.push(args[i]);
}
if (!inputs.length) {
  console.error('usage: node tools/build-firmware.mjs <firmware-dir | file.c ...> [-o out.wasm]');
  process.exit(1);
}

// Collect C sources. A directory means "every .c file in it" (not recursive,
// matching a flat Pico SDK project). Its folder is also added to -I.
const userSources = [];
const includeDirs = new Set();
for (const inp of inputs) {
  if (!fs.existsSync(inp)) {
    console.error(`"${inp}" does not exist. Pass the folder that holds your firmware's .c files,`);
    console.error('for example:  node tools/build-firmware.mjs firmware/fluid-demo -o fw.wasm');
    process.exit(1);
  }
  const st = fs.statSync(inp);
  if (st.isDirectory()) {
    includeDirs.add(path.resolve(inp));
    for (const f of fs.readdirSync(inp)) if (f.endsWith('.c')) userSources.push(path.resolve(inp, f));
  } else {
    includeDirs.add(path.dirname(path.resolve(inp)));
    userSources.push(path.resolve(inp));
  }
}
if (!out) out = path.join(path.resolve(inputs[0]), '..', path.basename(path.resolve(inputs[0])) + '.wasm');

// ---- tool discovery ----------------------------------------------------------
function findTool(names) {
  const extra = ['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin', '/opt/homebrew/opt/lld/bin',
                 '/usr/local/opt/lld/bin', '/usr/lib/llvm-18/bin', '/usr/lib/llvm-17/bin'];
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extra);
  for (const n of names) for (const d of dirs) {
    const p = path.join(d, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const clang = process.env.CLANG || findTool(['clang', 'clang-18', 'clang-17', 'clang-16']);
const wasmld = process.env.WASM_LD || findTool(['wasm-ld', 'wasm-ld-18', 'wasm-ld-17', 'wasm-ld-16']);
const wasmopt = path.join(ROOT, 'node_modules/.bin/wasm-opt');
if (!clang || !wasmld) {
  console.error('clang and wasm-ld are required (macOS: brew install llvm lld; Ubuntu: apt install clang lld)');
  process.exit(1);
}
if (!fs.existsSync(wasmopt)) {
  console.error('binaryen not found — run `npm install` in ' + ROOT);
  process.exit(1);
}

function run(cmd, argv) {
  console.log('$', path.basename(cmd), argv.map(a => (a.includes(' ') ? JSON.stringify(a) : a)).join(' '));
  try {
    execFileSync(cmd, argv, { stdio: 'inherit' });
  } catch {
    console.error('\nbuild failed at: ' + path.basename(cmd));
    process.exit(1);
  }
}

// ---- 1. compile --------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwbuild-'));
const cflags = [
  '--target=wasm32-unknown-unknown', '-O2', '-g0',
  '-ffreestanding', '-nostdlibinc', '-fno-exceptions', '-fvisibility=hidden',
  '-isystem', path.join(HAL, 'include'),
  ...[...includeDirs].flatMap(d => ['-I', d]),
  '-DPICO_SIMULATOR=1', '-DPICO_RP2350=1', '-DPICO_RP2350A=1', ...defines,
  '-Wall', '-Wno-unused-function',
];
const objects = [];
const halSources = ['hal.c', 'libc.c', 'libm.c'].map(f => path.join(HAL, 'src', f));
for (const src of [...userSources, ...halSources]) {
  const obj = path.join(tmp, path.basename(src).replace(/\.c$/, '') + '-' + objects.length + '.o');
  // libc must not have its own loops turned back into memcpy()/memset() calls.
  const extra = src.endsWith('libc.c') ? ['-fno-builtin'] : [];
  run(clang, [...cflags, ...extra, '-c', src, '-o', obj]);
  objects.push(obj);
}

// ---- 2. link -----------------------------------------------------------------
// Memory layout (--stack-first): [0, 64K) = core-0 C stack, then .data/.bss,
// then the heap. The engine reads __data_end/__heap_base to report RAM use
// against the RP2350's 520 KB.
const linked = path.join(tmp, 'linked.wasm');
run(wasmld, [
  '--no-entry', '--stack-first', '-z', 'stack-size=65536',
  '--initial-memory=2097152', '--max-memory=67108864',
  '--export=__stack_pointer', '--export=__heap_base', '--export=__data_end',
  '--export-table', '-o', linked, ...objects,
]);

// ---- 3. cycle counting (deterministic CPU-time model, see instrument-cycles.mjs)
const counted = path.join(tmp, 'counted.wasm');
console.log('$ instrument-cycles', path.basename(linked));
fs.writeFileSync(counted, instrumentCycles(fs.readFileSync(linked)));

// ---- 4. asyncify -----------------------------------------------------------------
// (create the output folder first: a fresh clone has no dist/)
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
run(wasmopt, [
  counted, '-O2', '--asyncify',
  '--pass-arg=asyncify-imports@sim.yield',
  '-o', path.resolve(out),
]);
fs.rmSync(tmp, { recursive: true, force: true });
const size = fs.statSync(out).size;
console.log(`\n✓ ${out}  (${(size / 1024).toFixed(1)} KB)`);
