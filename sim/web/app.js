/**
 * app.js — the simulator page: 3D view, controls, and instrument panels
 * =====================================================================
 *
 * Data flow, once per animation frame:
 *
 *   card orientation (your mouse/touch)  ->  gravity in board axes
 *        -> CardSim.runUntil(...)  runs the firmware for the elapsed time
 *        -> light snapshot  ->  LED intensities  ->  three.js glow sprites
 *
 * Panels (checks, pins, I2C, console) refresh a few times per second.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CardSim } from '../core/engine.js';
import { buildCard } from './scene.js';
import { MASKS, FINISHES } from './artwork.js';

const BOARD = JSON.parse(document.getElementById('board-data').textContent);
const FIRMWARE = JSON.parse(document.getElementById('fw-data').textContent);
const ARTWORK = JSON.parse(document.getElementById('art-data').textContent);
const $ = (id) => document.getElementById(id);
const fmtT = (us) => (us / 1e6).toFixed(us < 1e7 ? 3 : 1) + ' s';

// ============================================================================
// 3D view
// ============================================================================
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
view.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
camera.position.set(0, 8, 170);
// Solder mask colour and surface finish are not stored in the KiCad file
// (they're chosen when ordering), so they're a viewer setting, remembered
// per browser.
const LOOK_KEY = 'jtcard.look';
let look = { mask: 'black', finish: 'enig' };
try { look = { ...look, ...JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') }; } catch { /* storage blocked */ }
const model = buildCard(BOARD, ARTWORK, renderer, look);
scene.environment = model.env;
scene.add(model.card);
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(60, 120, 140);
scene.add(key, new THREE.AmbientLight(0xffffff, 0.15));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = // Bloom threshold 1.0: only HDR-bright things (lit LEDs) glow, never the
// white silkscreen or the shiny pads.
new UnrealBloomPass(new THREE.Vector2(512, 512), 0.85, 0.5, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
orbit.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
orbit.enablePan = false;
orbit.minDistance = 70;
orbit.maxDistance = 400;
orbit.enableDamping = true;

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  composer.setSize(r.width, r.height);
  camera.aspect = r.width / Math.max(1, r.height);
  // keep the whole card in frame on narrow screens
  const fitDist = (model.size.W * 0.62) / Math.tan((camera.fov * Math.PI) / 360) / camera.aspect;
  if (!resize.done || camera.position.length() < fitDist) camera.position.setLength(Math.max(130, fitDist));
  resize.done = true;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

function syncBackground() {
  const css = getComputedStyle(document.documentElement);
  scene.background = new THREE.Color(css.getPropertyValue('--mat').trim() || '#3d5560');
}
syncBackground();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBackground);
new MutationObserver(syncBackground).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---- card orientation (= gravity input) ---------------------------------------
// The card starts upright with its LED side (back) facing you.
const POSES = {
  upright: new THREE.Euler(0, Math.PI, 0),
  left: new THREE.Euler(0, Math.PI, Math.PI / 4),
  right: new THREE.Euler(0, Math.PI, -Math.PI / 4),
  flat: new THREE.Euler(-Math.PI / 2 + 0.18, Math.PI, 0),
  inverted: new THREE.Euler(0, Math.PI, Math.PI),
  back: new THREE.Euler(0, 0, 0),
};
const target = new THREE.Quaternion().setFromEuler(POSES.upright);
model.card.quaternion.copy(target);
let rocking = true;
let rockT = 0;
let shake = { v: new THREE.Vector3(), until: 0 };

function setPose(name) {
  rocking = false;
  $('rock').setAttribute('aria-pressed', 'false');
  target.setFromEuler(POSES[name]);
}
document.querySelectorAll('[data-pose]').forEach((b) => b.addEventListener('click', () => setPose(b.dataset.pose)));
$('rock').addEventListener('click', () => {
  rocking = !rocking;
  $('rock').setAttribute('aria-pressed', String(rocking));
  if (rocking) target.setFromEuler(POSES.upright);
});
$('shake').addEventListener('click', () => {
  shake.until = performance.now() + 450;
});

// Drag the card to tilt it (left button / one finger). Right-drag orbits the camera.
let drag = null;
const pointers = new Set();
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointers.add(e.pointerId);
  if (e.button !== 0 || pointers.size > 1) { drag = null; return; }
  drag = { x: e.clientX, y: e.clientY };
  rocking = false;
  $('rock').setAttribute('aria-pressed', 'false');
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag || pointers.size > 1) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  const camUp = camera.up.clone().applyQuaternion(camera.quaternion).normalize();
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  const k = 0.008;
  const qx = new THREE.Quaternion().setFromAxisAngle(camUp, dx * k);
  const qy = new THREE.Quaternion().setFromAxisAngle(camRight, dy * k);
  target.premultiply(qx).premultiply(qy).normalize();
  model.card.quaternion.copy(target);
});
const endDrag = (e) => { pointers.delete(e.pointerId); drag = null; };
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

/** Specific force on the card in BOARD axes (what an accelerometer feels). */
const upWorld = new THREE.Vector3(0, 1, 0);
let forceBoard = [0, 1, 0];
function updateForce(now) {
  const f = upWorld.clone();
  if (now < shake.until) {
    const ph = (shake.until - now) / 450;
    f.add(new THREE.Vector3(Math.sin(now * 0.09) * 2.2 * ph, Math.cos(now * 0.13) * 1.6 * ph, 0));
  }
  const inv = model.card.quaternion.clone().invert();
  f.applyQuaternion(inv);
  forceBoard = [f.x, f.y, f.z];
}

// ============================================================================
// Simulation
// ============================================================================
let sim = null;
let fwName = 'fluid';
let customBytes = null;
let running = true;
let speed = 1;
let snaps = [];
let lastStats = null;
let bootError = null;

async function boot(name, bytes) {
  bootError = null;
  fwName = name;
  const wasm = bytes || base64ToBytes(FIRMWARE[name].b64);
  const s = new CardSim({
    board: BOARD,
    wasmBytes: wasm,
    getGravity: () => forceBoard,
    onPrint: (line, t) => appendConsole(line, t),
  });
  $('console-out').textContent = '';
  try {
    await s.start();
  } catch (e) {
    bootError = 'Could not start this firmware: ' + e.message;
    showToast(bootError);
    return;
  }
  sim = s;
  snaps = [];
  lastStats = null;
  model.setLeds(new Float32Array(BOARD.leds.length));
  renderPanels(true);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// ---- light rendering -------------------------------------------------------
// The eye integrates ~30 ms of light. In slow motion the exposure window
// shrinks with the speed, so at 1/1000x you can watch individual scan slots.
const intens = new Float32Array(BOARD.leds.length);
let exposure = 1;
function updateLight() {
  const s = sim.snapshot();
  snaps.push(s);
  const win = Math.max(8, Math.min(30000, 30000 * speed));
  while (snaps.length > 2 && snaps[1].t <= s.t - win) snaps.shift();
  if (snaps.length > 400) snaps.shift();
  const a = snaps[0];
  if (s.t - a.t <= 0) return;
  const { avgMa } = CardSim.between(a, s);
  // 0.25 mA average ~ "full" at 1x (one LED at ~5.8 mA, 1/22 duty);
  // in slow motion the reference moves toward instantaneous current.
  const slow = Math.max(0, Math.min(1, 1 - win / 3000));
  const ref = 0.25 + slow * 4;
  for (let i = 0; i < intens.length; i++) {
    const v = avgMa[i] / ref;
    intens[i] = v > 0 ? Math.min(3, Math.sqrt(v) * exposure) : 0;
  }
  model.setLeds(intens, $('show-ghost').checked ? sim.bm.ghosted : null);
}

// ---- main loop -----------------------------------------------------------------
let lastFrame = performance.now();
let lastPanel = 0;
let rtFactor = 1;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (rocking) {
    rockT += dt;
    const ang = Math.sin(rockT * 0.9) * 0.55;
    target.setFromEuler(new THREE.Euler(0, Math.PI, ang));
  }
  model.card.quaternion.slerp(target, drag ? 1 : Math.min(1, dt * 6));
  updateForce(now);
  orbit.update();

  if (sim && running && !sim.halted) {
    const t0 = sim.time;
    const goal = t0 + dt * 1e6 * speed;
    const reached = sim.runUntil(goal, 22);
    const want = goal - t0;
    rtFactor = want > 0 ? 0.9 * rtFactor + 0.1 * Math.min(1, (reached - t0) / want) : rtFactor;
    updateLight();
  }
  composer.render();

  if (sim && now - lastPanel > 250) {
    lastPanel = now;
    renderPanels(false);
  }
}

// ============================================================================
// Controls
// ============================================================================
const fwSelect = $('fw-select');
for (const [k, v] of Object.entries(FIRMWARE)) fwSelect.add(new Option(v.label, k));
fwSelect.add(new Option('Load your .wasm…', '__file'));
fwSelect.addEventListener('change', () => {
  if (fwSelect.value === '__file') { $('fw-file').click(); fwSelect.value = fwName === 'custom' ? 'custom' : fwName; return; }
  boot(fwSelect.value);
});
$('fw-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  customBytes = new Uint8Array(await f.arrayBuffer());
  let opt = [...fwSelect.options].find((o) => o.value === 'custom');
  if (!opt) { opt = new Option('', 'custom'); fwSelect.add(opt, fwSelect.options.length - 1); }
  opt.text = f.name;
  fwSelect.value = 'custom';
  boot('custom', customBytes);
  e.target.value = '';
});
$('run').addEventListener('click', () => {
  running = !running;
  $('run').textContent = running ? 'Pause' : 'Run';
  $('run').setAttribute('aria-pressed', String(!running));
});
$('reset').addEventListener('click', () => boot(fwName, fwName === 'custom' ? customBytes : null));
$('speed').addEventListener('change', (e) => { speed = +e.target.value; snaps = []; });
$('exposure').addEventListener('input', (e) => { exposure = +e.target.value; });
for (const [k, v] of Object.entries(MASKS)) $('mask-color').add(new Option(v.label, k));
for (const [k, v] of Object.entries(FINISHES)) $('finish').add(new Option(v.label, k));
$('mask-color').value = look.mask;
$('finish').value = look.finish;
function applyLook() {
  look = { mask: $('mask-color').value, finish: $('finish').value };
  model.setLook(look);
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch { /* storage blocked */ }
}
$('mask-color').addEventListener('change', applyLook);
$('finish').addEventListener('change', applyLook);

// tabs
document.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== tab.getAttribute('aria-controls'); });
  renderPanels(true);
}));

// copy buttons
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const text = $(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents($(b.dataset.copy)); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = 'Selected'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1500);
}));

let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

function appendConsole(line, t) {
  const el = $('console-out');
  el.textContent += `${(t / 1e6).toFixed(3).padStart(8)}  ${line}\n`;
  if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-30000);
  el.scrollTop = el.scrollHeight;
}

// ============================================================================
// Panels
// ============================================================================
const PIN_NET = {};
for (const [net, v] of Object.entries(BOARD.led_nets)) PIN_NET[v.gpio] = net.replace('/LED_ARRAY/', 'LED ');
Object.assign(PIN_NET, {
  22: 'I2C1 SDA', 23: 'I2C1 SCL', 24: 'ACCEL INT1', 25: 'ACCEL INT2',
  26: 'tied to GND', 27: 'tied to GND', 28: 'tied to GND', 29: 'I2C pull-up EN',
});
const FN_NAME = { 0: 'HSTX', 1: 'SPI', 2: 'UART', 3: 'I2C', 4: 'PWM', 5: 'SIO', 6: 'PIO0', 7: 'PIO1', 8: 'PIO2', 31: '—' };

function stats() {
  // 100 ms statistics window (independent of the visual exposure)
  const s = snaps[snaps.length - 1];
  if (!s) return null;
  let a = snaps[0];
  for (const x of snaps) if (x.t <= s.t - 100000) a = x;
  const { avgMa, hz, dt } = CardSim.between(a, s);
  let lit = 0, minHz = Infinity;
  for (let i = 0; i < avgMa.length; i++) if (avgMa[i] > 0.002) { lit++; if (hz[i] < minHz) minHz = hz[i]; }
  return { lit, minHz: lit && dt > 20000 ? minHz : null };
}

let lastCores = null;
function renderPanels(force) {
  if (!sim) return;
  const bm = sim.bm;
  // ---- header readouts ----
  $('t-sim').textContent = fmtT(sim.time);
  $('t-rt').textContent = running ? Math.round(rtFactor * 100) + ' %' : 'paused';
  $('t-rt').dataset.state = !running ? 'paused' : rtFactor < 0.8 ? 'slow' : 'ok';
  const st = stats() || lastStats;
  if (st) lastStats = st;

  // core load over the last panel interval
  const cores = sim.cores.map((c) => ({ busy: c.busyUs, wait: c.waitUs, on: c.launched }));
  if (lastCores) {
    ['core0', 'core1'].forEach((id, n) => {
      const b = cores[n].busy - lastCores[n].busy, w = cores[n].wait - lastCores[n].wait;
      $(id).textContent = cores[n].on && b + w > 0 ? Math.round((100 * b) / (b + w)) + ' %' : '—';
    });
  }
  lastCores = cores;

  // ---- HUD: accelerometer as the firmware sees it ----
  const f = sim.accel.lastForce;
  $('acc-x').textContent = fmtG(f[0]);
  $('acc-y').textContent = fmtG(f[1]);
  $('acc-z').textContent = fmtG(f[2]);
  $('acc-mode').textContent = sim.accel.odrHz ? `${sim.accel.odrHz} Hz · ${sim.accel.mode.toUpperCase()} · ±${sim.accel.fullScaleG} g` : 'power-down';
  drawCompass();

  // ---- status banner ----
  const diags = sim.diagList();
  const errs = diags.filter((d) => d.severity === 'error').length;
  const warns = diags.filter((d) => d.severity === 'warn').length;
  const banner = $('status');
  if (sim.halted) { banner.dataset.sev = 'error'; banner.textContent = 'Firmware stopped: ' + sim.halted; }
  else if (errs) { banner.dataset.sev = 'error'; banner.textContent = `${errs} error${errs > 1 ? 's' : ''}, ${warns} warning${warns !== 1 ? 's' : ''}`; }
  else if (warns) { banner.dataset.sev = 'warn'; banner.textContent = `No errors · ${warns} warning${warns !== 1 ? 's' : ''}`; }
  else { banner.dataset.sev = 'ok'; banner.textContent = 'No problems found so far'; }
  $('tab-checks-count').textContent = diags.length || '';

  const tab = document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-controls');

  if (tab === 'p-checks') {
    $('m-led').textContent = isFinite(bm.minDrivenI) ? `${bm.minDrivenI.toFixed(2)}–${bm.maxDrivenI.toFixed(2)}` : '—';
    // 0 pulses while lit = driven continuously (no multiplexing)
    $('m-hz').textContent = lastStats && lastStats.minHz != null ? (lastStats.minHz < 1 ? 'DC' : Math.round(lastStats.minHz)) : '—';
    $('m-lit').textContent = lastStats ? lastStats.lit : '—';
    let pk = 0, pkPin = 0;
    for (let p = 0; p < 22; p++) if (bm.pinPeak[p] > pk) { pk = bm.pinPeak[p]; pkPin = p; }
    $('m-pin').textContent = pk ? pk.toFixed(1) : '—';
    $('m-pin-sub').textContent = pk ? `GPIO${pkPin}, rated ${[2, 4, 8, 12][bm.drive[pkPin]]} mA` : 'no LED current yet';
    $('m-i2c').textContent = `${sim.bus.stats.ok} / ${sim.bus.stats.fail}`;
    $('m-ram').textContent = (sim.staticRamBytes / 1024).toFixed(0);
    const list = $('diag-list');
    const html = diags.length ? diags.map((d) => `
      <li class="diag" data-sev="${d.severity}">
        <div class="diag-head"><span class="sev">${d.severity}</span><span class="diag-title">${esc(d.title)}</span></div>
        <p>${esc(d.detail)}</p>
        <div class="diag-meta">first at ${fmtT(d.firstT)}${d.count > 1 ? ` · ${d.count.toLocaleString()} times` : ''}</div>
      </li>`).join('') : '<li class="empty">The firmware has not tripped any electrical or protocol check yet.</li>';
    if (list.dataset.sig !== html.length + ':' + diags.length || force) { list.innerHTML = html; list.dataset.sig = html.length + ':' + diags.length; }
  }

  if (tab === 'p-pins') {
    const rows = sim.pinStates().map((p) => {
      const state = p.driving ? (p.out ? 'H' : 'L') : p.fn === 3 ? 'I2C' : 'Z';
      return `<tr data-state="${state}">
        <td>GPIO${p.pin}</td><td>${PIN_NET[p.pin] || ''}</td><td>${FN_NAME[p.fn] ?? p.fn}</td>
        <td><span class="lvl">${state}</span></td><td>${p.pull || '—'}</td><td>${p.drive}</td>
        <td class="num">${Math.abs(p.mA) > 0.005 ? p.mA.toFixed(2) : ''}</td><td class="num">${p.peak > 0.005 ? p.peak.toFixed(1) : ''}</td></tr>`;
    }).join('');
    $('pin-rows').innerHTML = rows;
  }

  if (tab === 'p-i2c') {
    const r = sim.accel.reg;
    $('lis-regs').innerHTML = [
      ['CTRL_REG1', 0x20], ['CTRL_REG3', 0x22], ['CTRL_REG4', 0x23], ['STATUS', 0x27],
    ].map(([n, a]) => `<div><dt>${n}</dt><dd>0x${r[a].toString(16).padStart(2, '0')}</dd></div>`).join('') +
      `<div><dt>Output rate</dt><dd>${sim.accel.odrHz ? sim.accel.odrHz + ' Hz' : 'off'}</dd></div>` +
      `<div><dt>Pull-ups</dt><dd>${{ on: 'powered', 'shorted-low': 'held low', 'off-pulldown': 'off', floating: 'off' }[bm.pullupState()]}</dd></div>`;
    $('i2c-rows').innerHTML = sim.bus.trace.slice(-24).reverse().map((x) => `
      <tr data-res="${x.result}"><td class="num">${(x.t / 1e6).toFixed(4)}</td><td>0x${x.addr.toString(16).padStart(2, '0')}</td>
      <td>${x.rw}</td><td class="bytes">${x.data.map((b) => b.toString(16).padStart(2, '0')).join(' ')}</td>
      <td>${x.result === 'ok' ? 'ACK' : esc(x.note || x.result)}</td></tr>`).join('') ||
      '<tr><td colspan="5" class="empty">No I2C traffic yet.</td></tr>';
  }
}
const fmtG = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Gravity compass: where "down" is on the LED face (display coordinates).
function drawCompass() {
  const c = $('compass');
  const g = c.getContext('2d');
  const d = c.width, r = d / 2 - 6;
  g.clearRect(0, 0, d, d);
  const css = getComputedStyle(document.documentElement);
  g.strokeStyle = css.getPropertyValue('--hud-dim');
  g.lineWidth = 1.5;
  g.beginPath(); g.arc(d / 2, d / 2, r, 0, 7); g.stroke();
  // display x = -board x, display down = -board y; gravity = -force
  const gx = forceBoard[0], gy = forceBoard[1];
  const len = Math.min(1, Math.hypot(gx, gy));
  const ang = Math.atan2(gy, gx);
  g.strokeStyle = g.fillStyle = css.getPropertyValue('--hud-fg');
  g.lineWidth = 2.5;
  const ex = d / 2 + Math.cos(ang) * r * len, ey = d / 2 + Math.sin(ang) * r * len;
  g.beginPath(); g.moveTo(d / 2, d / 2); g.lineTo(ex, ey); g.stroke();
  g.beginPath(); g.arc(ex, ey, 3.5, 0, 7); g.fill();
}

// ============================================================================
// Start with the firmware marked as default (tools/sim.mjs marks yours),
// otherwise the first one in the list.
const firstFw = Object.keys(FIRMWARE).find((k) => FIRMWARE[k].default) || Object.keys(FIRMWARE)[0];
fwSelect.value = firstFw;
boot(firstFw).then(() => requestAnimationFrame(frame));
