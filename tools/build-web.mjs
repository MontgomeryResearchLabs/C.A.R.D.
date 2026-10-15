#!/usr/bin/env node
/**
 * build-web.mjs — assemble the self-contained simulator page
 * ==========================================================
 *
 *   node tools/build-web.mjs [-o dist/simulator.html] [--three <url-base>]
 *                            [--add my-fw.wasm] [--standalone]
 *
 * Inlines into sim/web/template.html:
 *   - the app + engine, bundled with esbuild (three.js stays external and is
 *     loaded through an import map, from jsDelivr by default)
 *   - board/board.json, trimmed to what the page needs
 *   - board/artwork.json: outline, copper, mask openings, silkscreen
 *   - every firmware in dist/*.wasm listed in FIRMWARE below, as base64
 *
 * --three lets you point the import map at a local copy, e.g. for offline
 * use: --three ./node_modules/three
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = opt('-o', path.join(ROOT, 'dist/simulator.html'));
const threeBase = opt('--three', 'https://cdn.jsdelivr.net/npm/three@0.160.0');

const FIRMWARE = {
  fluid: { label: 'Fluid demo (reference)', file: 'dist/fluid-demo.wasm' },
  mistakes: { label: 'Common mistakes (buggy on purpose)', file: 'dist/common-mistakes.wasm' },
};

const bundle = await esbuild.build({
  entryPoints: [path.join(ROOT, 'sim/web/app.js')],
  bundle: true, format: 'esm', write: false, minify: true,
  external: ['three', 'three/addons/*'], target: 'es2020',
});
const appJs = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'board/board.json'), 'utf8'));
const pcb = fs.readFileSync(path.join(ROOT, 'board', b.source), 'utf8');
const thickness = +(pcb.match(/\(general\s*\(thickness ([\d.]+)\)/) || [0, 1.6])[1];
const board = {
  source: b.source, thickness, outline_mm: b.outline_mm, led_grid: b.led_grid, led_nets: b.led_nets,
  accelerometer: b.accelerometer,
  leds: b.leds.map(({ ref, x, y, rot, row, col, anode_gpio, cathode_gpio }) => ({ ref, x, y, rot, row, col, anode_gpio, cathode_gpio })),
  parts: b.parts.map(({ ref, value, side, x, y, rot, lib }) => ({ ref, value, side, x, y, rot, lib: lib.split(':').pop() })),
};

const fw = {};
// --add <file.wasm> (repeatable): extra firmware, listed first and selected
// at start-up. Used by tools/sim.mjs to open the page with YOUR build.
args.forEach((a, i) => {
  if (a !== '--add') return;
  const file = path.resolve(args[i + 1]);
  const key = 'user' + i;
  fw[key] = { label: path.basename(file), default: Object.keys(fw).length === 0, b64: fs.readFileSync(file).toString('base64') };
});
for (const [k, v] of Object.entries(FIRMWARE)) {
  const file = path.join(ROOT, v.file);
  if (!fs.existsSync(file)) continue; // built-ins are optional (e.g. not built yet)
  fw[k] = { label: v.label, b64: fs.readFileSync(file).toString('base64') };
}
if (!Object.keys(fw).length) { console.error('No firmware to embed: run `npm run build` or pass --add file.wasm'); process.exit(1); }

const html = fs.readFileSync(path.join(ROOT, 'sim/web/template.html'), 'utf8')
  .replaceAll('__THREE__', threeBase)
  .replace('__BOARD__', () => JSON.stringify(board))
  .replace('__FIRMWARE__', () => JSON.stringify(fw))
  .replace('__ARTWORK__', () => fs.readFileSync(path.join(ROOT, 'board/artwork.json'), 'utf8'))
  .replace('__APP__', () => appJs);
// --standalone: wrap in a full HTML document so the file opens directly in a
// browser (the published artifact gets this skeleton from the host).
const doc = args.includes('--standalone')
  ? '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + html + '</body></html>'
  : html;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, doc);
console.log(`✓ ${out}  (${(doc.length / 1024).toFixed(0)} KB)`);
