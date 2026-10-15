#!/usr/bin/env node
/**
 * test-autopilot.mjs — headless check that the embed's maze autopilot works
 * against the real maze firmware (the same modules card.js uses).
 *
 *   node tools/test-autopilot.mjs [dist/maze-demo.wasm] [seconds]
 *
 * Runs at 60 "frames" per simulated second: ease the card toward the
 * autopilot's pose, feed the resulting gravity to the firmware, find the ball
 * from the LED currents, steer. Prints how much of the maze the ball covered.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CardSim } from '../sim/core/engine.js';
import { MazeAutopilot, findBall } from '../sim/web/autopilot.js';
import { FLAT, tiltPose } from '../sim/web/tilt.js';
import { readMaze } from './maze-bitmap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasm = fs.readFileSync(process.argv[2] || path.join(ROOT, 'dist/maze-demo.wasm'));
const seconds = +(process.argv[3] || 90);
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'board/board.json'), 'utf8'));
const maze = readMaze();

let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pilot = new MazeAutopilot(maze, rand);
const card = FLAT.clone(), target = FLAT.clone();
const up = new THREE.Vector3(0, 1, 0);
let force = [0, 0, 1];
const sim = new CardSim({ board, wasmBytes: wasm, getGravity: () => force });
await sim.start();

const visited = new Set(), dt = 1 / 60;
let snaps = [], goals = 0, reached = 0, lastGoal = null, lost = 0;
for (let f = 0; f < seconds * 60; f++) {
  card.slerp(target, Math.min(1, dt * 6));
  const u = up.clone().applyQuaternion(card.clone().invert());
  force = [u.x, u.y, u.z];
  sim.runUntil(sim.time + dt * 1e6, 1000);
  const s = sim.snapshot();
  snaps.push(s);
  while (snaps.length > 2 && snaps[1].t <= s.t - 30000) snaps.shift();
  const ball = findBall(CardSim.between(snaps[0], s).avgMa, board.leds, maze);
  if (!ball) { lost++; continue; }
  visited.add(ball.x + ',' + ball.y);
  if (pilot.goal && ball.x === pilot.goal[0] && ball.y === pilot.goal[1]) reached++;
  const dir = pilot.steer(ball, f * 1000 / 60);
  if (pilot.goal !== lastGoal) { goals++; lastGoal = pilot.goal; }
  if (dir) tiltPose(dir[0], dir[1], 0.3, target);
}
let open = 0;
for (const row of maze) for (const c of row) if (c === ' ') open++;
console.log(`${seconds}s simulated: ball visited ${visited.size}/${open} track cells, ${reached} destinations reached, ${goals - 1 - reached} abandoned after a stall, ball not found in ${lost} frames`);
process.exit(visited.size > open * 0.3 ? 0 : 1);
