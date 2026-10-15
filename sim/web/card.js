/**
 * card.js — the card-only embed: the 3D card running the fluid firmware,
 * with tilt/rotate controls and a Fluid / Maze switch, and nothing else (no
 * instrument panels, speed control or console). Built by
 * `node tools/build-web.mjs --card`.
 *
 * Hands-off modes until the viewer grabs the card:
 *   rock — fluid demo: the card sways side to side
 *   auto — maze demo: the card lies flat and autopilot.js tilts it to roll
 *          the ball through the maze (camera moves overhead to see it)
 *
 * Same per-frame loop as app.js: orientation -> gravity in board axes ->
 * CardSim.runUntil -> LED intensities -> glow.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CardSim } from '../core/engine.js';
import { buildCard } from './scene.js';
import { MazeAutopilot, findBall } from './autopilot.js';
import { tiltPose } from './tilt.js';

const BOARD = JSON.parse(document.getElementById('board-data').textContent);
const FIRMWARE = JSON.parse(document.getElementById('fw-data').textContent);
const ARTWORK = JSON.parse(document.getElementById('art-data').textContent);
const $ = (id) => document.getElementById(id);

// ---- 3D view -------------------------------------------------------------------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
view.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--mat').trim() || '#161514');
const camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
camera.position.set(0, 8, 170);
const model = buildCard(BOARD, ARTWORK, renderer, { mask: 'black', finish: 'enig' });
scene.environment = model.env;
scene.add(model.card);
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(60, 120, 140);
scene.add(key, new THREE.AmbientLight(0xffffff, 0.15));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Threshold 1.0: only HDR-bright lit LEDs bloom, not silkscreen or pads.
composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.85, 0.5, 1.0));
composer.addPass(new OutputPass());

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
orbit.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
orbit.enablePan = false;
// Embedded in a scrolling page: wheel zoom would hijack page scroll.
orbit.enableZoom = false;
orbit.enableDamping = true;

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  composer.setSize(r.width, r.height);
  camera.aspect = r.width / Math.max(1, r.height);
  // Keep the whole card in frame with room for the hint text above and the
  // pose buttons below, which overlay the canvas.
  const fitDist = (model.size.W * 0.75) / Math.tan((camera.fov * Math.PI) / 360) / camera.aspect;
  camera.position.setLength(Math.max(165, fitDist));
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

// ---- card orientation (= gravity input) -----------------------------------------
// Starts upright with the LED side (back) facing the viewer.
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
let mode = 'rock';   // 'rock' | 'auto' | null (viewer in control)
let rockT = 0;
let pilot = null;    // MazeAutopilot while the maze firmware runs

// Camera directions: straight on for the fluid, overhead for the maze
// (which is played lying flat, like a tabletop tilt maze).
const CAM_FRONT = new THREE.Vector3(0, 8, 170).normalize();
const CAM_ABOVE = new THREE.Vector3(0, 150, 90).normalize();
let camGoal = null;  // direction the camera is easing toward, if any
orbit.addEventListener('start', () => { camGoal = null; });

function setMode(m) {
  mode = m;
  $('rock').setAttribute('aria-pressed', String(m === 'rock'));
  $('auto').setAttribute('aria-pressed', String(m === 'auto'));
  if (m === 'rock') target.setFromEuler(POSES.upright);
  if (m === 'auto') { tiltPose(0, 0, 0, target); camGoal = CAM_ABOVE; }
}
document.querySelectorAll('[data-pose]').forEach((b) => b.addEventListener('click', () => {
  setMode(null);
  target.setFromEuler(POSES[b.dataset.pose]);
}));
$('rock').addEventListener('click', () => setMode(mode === 'rock' ? null : 'rock'));
$('auto').addEventListener('click', () => setMode(mode === 'auto' ? null : 'auto'));

// Drag tilts the card (left button / one finger); right-drag or two fingers orbit.
let drag = null;
const pointers = new Set();
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  pointers.add(e.pointerId);
  if (e.button !== 0 || pointers.size > 1) { drag = null; return; }
  drag = { x: e.clientX, y: e.clientY };
  setMode(null); // the viewer takes over
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || pointers.size > 1) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  const camUp = camera.up.clone().applyQuaternion(camera.quaternion).normalize();
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  const k = 0.008;
  target.premultiply(new THREE.Quaternion().setFromAxisAngle(camUp, dx * k))
    .premultiply(new THREE.Quaternion().setFromAxisAngle(camRight, dy * k)).normalize();
  model.card.quaternion.copy(target);
});
const endDrag = (e) => { pointers.delete(e.pointerId); drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/** Specific force on the card in BOARD axes (what the accelerometer feels). */
const upWorld = new THREE.Vector3(0, 1, 0);
let forceBoard = [0, 1, 0];
function updateForce() {
  const f = upWorld.clone().applyQuaternion(model.card.quaternion.clone().invert());
  forceBoard = [f.x, f.y, f.z];
}

// ---- simulation ------------------------------------------------------------------
let sim = null;
const snaps = [];
const intens = new Float32Array(BOARD.leds.length);

function base64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// The eye integrates ~30 ms of light; average LED current over that window.
function updateLight() {
  const s = sim.snapshot();
  snaps.push(s);
  while (snaps.length > 2 && snaps[1].t <= s.t - 30000) snaps.shift();
  if (snaps.length > 400) snaps.shift();
  const a = snaps[0];
  if (s.t - a.t <= 0) return;
  const { avgMa } = CardSim.between(a, s);
  // 0.25 mA average ~ "full" (one LED at ~5.8 mA, 1/22 duty)
  for (let i = 0; i < intens.length; i++) {
    const v = avgMa[i] / 0.25;
    intens[i] = v > 0 ? Math.min(3, Math.sqrt(v)) : 0;
  }
  model.setLeds(intens, null);

  if (mode === 'auto' && pilot) {
    const dir = pilot.steer(findBall(avgMa, BOARD.leds, FIRMWARE[fwKey].maze), performance.now());
    if (dir) tiltPose(dir[0], dir[1], 0.3, target);
  }
}

// Pause the firmware while the embed is scrolled out of view: it costs real
// CPU, and the host page shouldn't pay for it off-screen.
let visible = true;
new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(view);

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!visible) return;

  if (mode === 'rock') {
    rockT += dt;
    target.setFromEuler(new THREE.Euler(0, Math.PI, Math.sin(rockT * 0.9) * 0.55));
  }
  if (camGoal) {
    const len = camera.position.length();
    const d = camera.position.clone().normalize().lerp(camGoal, Math.min(1, dt * 2.5)).normalize();
    camera.position.copy(d.multiplyScalar(len));
    if (d.angleTo(camGoal) < 0.01) camGoal = null;
  }
  model.card.quaternion.slerp(target, drag ? 1 : Math.min(1, dt * 6));
  updateForce();
  orbit.update();

  if (sim && !sim.halted) {
    sim.runUntil(sim.time + dt * 1e6, 22);
    updateLight();
  }
  composer.render();
}

// Firmware switch (Fluid / Maze). ?fw=maze picks the starting one, so a page
// can embed either demo directly.
const fwSwitch = $('fw');
let fwKey = null;
async function boot(key) {
  sim = null;
  fwKey = key;
  const maze = FIRMWARE[key].maze;
  pilot = maze ? new MazeAutopilot(maze) : null;
  $('auto').hidden = !maze;
  $('rock').hidden = !!maze;
  $('help').textContent = maze ? 'Watching the autopilot · drag the card to take over' : 'Drag to tilt · right-drag or two fingers to orbit';
  if (maze) setMode('auto');
  else { camGoal = CAM_FRONT; setMode('rock'); }
  snaps.length = 0;
  model.setLeds(intens.fill(0), null);
  fwSwitch.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fw === key)));
  const s = new CardSim({ board: BOARD, wasmBytes: base64ToBytes(FIRMWARE[key].b64), getGravity: () => forceBoard, onPrint: () => {} });
  try {
    await s.start();
    sim = s;
    $('err').hidden = true;
  } catch (e) {
    $('err').hidden = false;
    console.error(e);
  }
}
for (const [k, v] of Object.entries(FIRMWARE)) {
  const b = document.createElement('button');
  b.textContent = v.label;
  b.dataset.fw = k;
  b.addEventListener('click', () => boot(k));
  fwSwitch.append(b);
}
fwSwitch.hidden = Object.keys(FIRMWARE).length < 2;
const wanted = new URLSearchParams(location.search).get('fw');
boot(FIRMWARE[wanted] ? wanted : Object.keys(FIRMWARE)[0]).finally(() => requestAnimationFrame(frame));
