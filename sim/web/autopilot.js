/**
 * autopilot.js — plays the maze demo by tilting the card
 * ======================================================
 *
 * Only looks at what a person would see: which LEDs are lit. It never reads
 * the firmware's state. The firmware runs unchanged and only feels the tilt.
 *
 *   findBall(avgMa, leds, maze)  -> {x, y} of the lit LED that isn't a wall
 *   new MazeAutopilot(maze).steer(ball, nowMs) -> [tx, ty] tilt in display
 *     axes (each -1..1, scaled by the caller's maximum tilt), or null
 *
 * Steering is like a person's: tilt toward the next cell on the route, but
 * brake (tilt back) when the ball is going too fast to make the next turn,
 * and damp sideways motion. Speed is estimated from how often the ball
 * changes LED, since that is all we can see.
 *
 * The route goes to a random far-away cell; once the ball gets there (or stops
 * making progress for a few seconds) a new destination is picked, so the
 * ball wanders the whole maze forever.
 *
 * `maze` is the firmware's MAZE bitmap (rows of '#' wall / ' ' track),
 * extracted from firmware/maze-demo/maze.c at build time.
 */

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const STALL_MS = 4000;
const BRAKE = 6;      // cells/s^2 of deceleration to plan turns with (max tilt gives ~13)
const MIN_SPEED = 1.5; // cells/s: always allowed, so the ball never stalls short of a turn
const GAIN = 0.5;       // tilt per cell/s of speed error along the route
const SIDE_DAMP = 0.3;  // tilt per cell/s of sideways speed

/** Breadth-first distances (in cells) from (x, y) over open track. */
function bfs(maze, x, y) {
  const H = maze.length, W = maze[0].length;
  const d = Array.from({ length: H }, () => new Int16Array(W).fill(-1));
  const q = [[x, y]];
  d[y][x] = 0;
  for (let h = 0; h < q.length; h++) {
    const [cx, cy] = q[h];
    for (const [sx, sy] of STEPS) {
      const nx = cx + sx, ny = cy + sy;
      if (ny >= 0 && ny < H && nx >= 0 && nx < W && maze[ny][nx] === ' ' && d[ny][nx] < 0) {
        d[ny][nx] = d[cy][cx] + 1;
        q.push([nx, ny]);
      }
    }
  }
  return d;
}

/**
 * The ball is the brightest lit LED that isn't a wall. Board LEDs are
 * indexed in KiCad's front view; the display is seen from the back, so
 * display x is mirrored (same as led_map.h).
 */
export function findBall(avgMa, leds, maze) {
  const W = maze[0].length;
  let best = -1, bestMa = 0.02; // mA: ignore leakage glow
  for (let i = 0; i < leds.length; i++) {
    const x = W - 1 - leds[i].col, y = leds[i].row;
    if (maze[y][x] === ' ' && avgMa[i] > bestMa) { bestMa = avgMa[i]; best = i; }
  }
  return best < 0 ? null : { x: W - 1 - leds[best].col, y: leds[best].row };
}

export class MazeAutopilot {
  constructor(maze, random = Math.random) {
    this.maze = maze;
    this.random = random;
    this.field = null;   // BFS distances to the current destination
    this.goal = null;
    this.best = Infinity;
    this.lastProgress = 0;
    this.cell = null;    // last ball cell seen
    this.cellT = 0;      // when the ball entered it
    this.vel = [0, 0];   // estimated velocity, cells/s
  }

  /** Velocity from LED-to-LED moves. Between moves the ball can't be going
   * faster than one cell per elapsed time, so the estimate decays. */
  track(x, y, now) {
    if (!this.cell) { this.cell = [x, y]; this.cellT = now; return; }
    const dt = Math.max(1, now - this.cellT) / 1000;
    if (x !== this.cell[0] || y !== this.cell[1]) {
      this.vel = [(x - this.cell[0]) / dt, (y - this.cell[1]) / dt];
      this.cell = [x, y];
      this.cellT = now;
    } else {
      const sp = Math.hypot(this.vel[0], this.vel[1]);
      if (sp > 1 / dt) this.vel = this.vel.map((v) => (v * (1 / dt)) / sp);
    }
  }

  /** Pick a destination far from (x, y): at least 60% of the farthest reachable distance. */
  retarget(x, y, now) {
    const from = bfs(this.maze, x, y);
    let far = 0;
    for (const row of from) for (const v of row) if (v > far) far = v;
    const pool = [];
    from.forEach((row, cy) => row.forEach((v, cx) => { if (v >= far * 0.6) pool.push([cx, cy]); }));
    if (!pool.length) { this.field = null; return; }
    this.goal = pool[Math.floor(this.random() * pool.length)];
    this.field = bfs(this.maze, this.goal[0], this.goal[1]);
    this.best = Infinity;
    this.lastProgress = now;
  }

  steer(ball, now) {
    if (!ball) return null;
    const { x, y } = ball;
    if (!this.field || this.field[y][x] < 0 || (x === this.goal[0] && y === this.goal[1])) this.retarget(x, y, now);
    if (!this.field) return null;
    this.track(x, y, now);
    const f = this.field;
    const d = f[y][x];
    if (d < this.best) { this.best = d; this.lastProgress = now; }
    else if (now - this.lastProgress > STALL_MS) { this.retarget(x, y, now); return this.steer(ball, now); }
    const dir = STEPS.find(([sx, sy]) => f[y + sy]?.[x + sx] === d - 1);
    if (!dir) return null;
    const [sx, sy] = dir;

    // Straight cells ahead before the route turns (or ends).
    let run = 1;
    while (f[y + sy * (run + 1)]?.[x + sx * (run + 1)] === d - run - 1) run++;
    // Fastest speed that can still stop within the straight: v^2 = 2 a s.
    const vMax = Math.max(MIN_SPEED, Math.sqrt(2 * BRAKE * Math.max(0, run - 0.5)));
    const vAlong = this.vel[0] * sx + this.vel[1] * sy;
    // Proportional, not bang-bang: the speed estimate lags by up to a cell,
    // so full tilt right up to the limit overshoots short straights.
    const along = Math.max(-1, Math.min(1, GAIN * (vMax - vAlong)));
    const vSide = -this.vel[0] * sy + this.vel[1] * sx; // component across the route
    const side = Math.max(-1, Math.min(1, -vSide * SIDE_DAMP));
    return [along * sx - side * sy, along * sy + side * sx];
  }
}
