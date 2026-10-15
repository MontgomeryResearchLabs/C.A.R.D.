#!/usr/bin/env node
/**
 * run-headless.mjs — run firmware on the simulated card without a browser
 * =======================================================================
 *
 *   node tools/run-headless.mjs dist/fluid-demo.wasm [options]
 *
 * Options
 *   --pose <list>   comma-separated "angle:seconds" segments. angle is the
 *                   direction gravity points in the LED plane, in degrees,
 *                   as seen looking at the LEDs: 0 = down, 90 = right,
 *                   -90 = left, 180 = up. "flat:s" = lying LEDs-up.
 *                   default: 0:1.5,90:1.5
 *   --cpi <n>       scale the instruction-cost model (default 1.0)
 *   --json <file>   write a machine-readable report
 *   --quiet         don't echo firmware printf output
 *
 * Exit code: 0 = no errors in the diagnostics, 1 = errors found, 2 = halted.
 * That makes it usable in CI: "does this firmware drive the board safely?"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardSim } from '../sim/core/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const wasmPath = args.find((a) => a.endsWith('.wasm'));
if (!wasmPath) { console.error('usage: run-headless.mjs firmware.wasm [--pose 0:1,90:1] [--json out.json]'); process.exit(1); }

const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'board/board.json'), 'utf8'));
const quiet = args.includes('--quiet');

// ---- pose script -> specific force in BOARD axes --------------------------
// Display x = -board x (LEDs are on the back), display y(up) = board y.
const segs = opt('--pose', '0:1.5,90:1.5').split(',').map((s) => {
  const [a, sec] = s.split(':');
  return { flat: a === 'flat', ang: a === 'flat' ? 0 : +a, dur: +sec * 1e6 };
});
let acc = 0;
for (const s of segs) { s.start = acc; acc += s.dur; }
const total = acc;
function forceAt(t) {
  const s = segs.find((x) => t < x.start + x.dur) || segs[segs.length - 1];
  if (s.flat) return [0, 0, -1]; // LED side (back, -z) facing up
  const a = (s.ang * Math.PI) / 180;
  return [Math.sin(a), Math.cos(a), 0];
}

const sim = new CardSim({
  board,
  wasmBytes: fs.readFileSync(wasmPath),
  getGravity: forceAt,
  cpi: +opt('--cpi', 1),
  onPrint: (line, t) => { if (!quiet) console.log(`  [fw ${(t / 1e6).toFixed(3)}s] ${line}`); },
});
await sim.start();

// ---- run, taking a light snapshot at the end of every segment -----------
const frames = [];
const wall0 = Date.now();
for (const s of segs) {
  const end = s.start + s.dur;
  while (sim.time < end - 1 && !sim.halted) sim.runUntil(end, 1000);
  const a = sim.snapshot();
  while (sim.time < end + 50000 && !sim.halted) sim.runUntil(end + 50000, 1000); // 50 ms exposure
  const b = sim.snapshot();
  frames.push({ seg: s, ...CardSim.between(a, b) });
}
const wallS = (Date.now() - wall0) / 1000;

// ---- render ----------------------------------------------------------------
const R = board.led_grid.rows, C = board.led_grid.cols;
const ramp = ' .:-=+*#%@';
function ascii(avg) {
  // display coordinates: LEDs on the back -> mirror columns
  let maxv = 0;
  for (const v of avg) maxv = Math.max(maxv, v);
  const rows = [];
  for (let r = 0; r < R; r++) {
    let line = '';
    for (let x = 0; x < C; x++) {
      const col = C - 1 - x;
      const i = board.leds.findIndex((l) => l.row === r && l.col === col);
      const v = maxv > 0 ? avg[i] / maxv : 0;
      line += ramp[Math.min(ramp.length - 1, Math.round(v * (ramp.length - 1)))] + ' ';
    }
    rows.push('    ' + line);
  }
  return rows.join('\n');
}
console.log(`\nSimulated ${(total / 1e6).toFixed(2)} s of firmware time in ${wallS.toFixed(1)} s wall time.\n`);
for (const f of frames) {
  const lit = [...f.avgMa].filter((v) => v > 0.001);
  const hz = [...f.hz].filter((v, i) => f.avgMa[i] > 0.001);
  console.log(`Pose ${f.seg.flat ? 'flat (LEDs up)' : f.seg.ang + '°'}  —  ${lit.length} LEDs lit, ` +
    (lit.length ? `avg current ${Math.min(...lit).toFixed(3)}-${Math.max(...lit).toFixed(3)} mA, ` +
      `refresh ${Math.min(...hz).toFixed(0)}-${Math.max(...hz).toFixed(0)} Hz` : ''));
  console.log(ascii(f.avgMa) + '\n');
}

const pins = sim.pinStates();
const ledPeak = Math.max(...sim.bm.ledPeakI), ledPeakMin = Math.min(...[...sim.bm.ledPeakI].filter((v) => v > 0.01));
console.log('Electrical summary');
console.log(`  peak LED current          ${ledPeakMin.toFixed(2)} – ${ledPeak.toFixed(2)} mA (depends on LEDs sharing the anode)`);
console.log(`  most LEDs lit at once     ${sim.bm.maxLitAtOnce}`);
console.log(`  busiest LED line          GPIO${pins.slice(0, 22).reduce((a, b) => (b.peak > a.peak ? b : a)).pin}: ` +
  `${Math.max(...pins.slice(0, 22).map((p) => p.peak)).toFixed(1)} mA peak`);
console.log(`  total GPIO current peak   ${sim.bm.totalPeak.toFixed(1)} mA`);
console.log(`  I2C transactions          ${sim.bus.stats.ok} ok, ${sim.bus.stats.fail} failed`);
for (const c of sim.cores) if (c.launched) {
  const tot = c.busyUs + c.waitUs;
  console.log(`  core ${c.n} busy              ${tot ? ((100 * c.busyUs) / tot).toFixed(1) : 0} % (instruction-cost model)`);
}
console.log(`  static RAM (approx.)      ${(sim.staticRamBytes / 1024).toFixed(1)} KB of 520 KB, heap ${(sim.heapHighWater / 1024).toFixed(1)} KB`);

const diags = sim.diagList();
console.log(`\nDiagnostics (${diags.length})`);
for (const d of diags) console.log(`  [${d.severity.toUpperCase()}] ${d.title}${d.count > 1 ? `  (x${d.count})` : ''}\n      ${d.detail}`);
if (!diags.length) console.log('  none');
if (sim.halted) console.log('\nHALTED: ' + sim.halted);

if (opt('--json')) {
  fs.writeFileSync(opt('--json'), JSON.stringify({
    simulatedSeconds: total / 1e6, halted: sim.halted, diagnostics: diags,
    console: sim.consoleLines, i2c: sim.bus.stats, maxLitAtOnce: sim.bm.maxLitAtOnce,
    pins: pins.map(({ pin, peak, drive }) => ({ pin, peakMa: peak, driveMa: drive })),
    frames: frames.map((f) => ({ pose: f.seg, avgMa: [...f.avgMa], hz: [...f.hz] })),
  }, null, 1));
}
process.exit(sim.halted ? 2 : diags.some((d) => d.severity === 'error') ? 1 : 0);
