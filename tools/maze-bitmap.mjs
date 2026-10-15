/**
 * maze-bitmap.mjs — reads the MAZE bitmap out of firmware/maze-demo/maze.c,
 * so the firmware stays the only place the maze is defined.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readMaze(file = path.join(ROOT, 'firmware/maze-demo/maze.c')) {
  const src = fs.readFileSync(file, 'utf8');
  const body = src.match(/static const char MAZE\[H\]\[W \+ 1\] = \{([\s\S]*?)\};/);
  if (!body) throw new Error(`MAZE bitmap not found in ${file}`);
  const rows = [...body[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (rows.length !== 21 || rows.some((r) => r.length !== 21)) throw new Error('MAZE must be 21 rows of 21 characters');
  return rows;
}
