/**
 * engine.js — runs RP2350 firmware (compiled to WebAssembly) against the
 * simulated JT business card
 * =======================================================================
 *
 * Execution model
 * ---------------
 * The firmware is ordinary blocking C (`while (1) { ... sleep_ms(16); }`).
 * The build runs Binaryen's "asyncify" pass, which lets the engine pause the
 * WebAssembly stack inside `sim.yield()` and resume it later. That gives us:
 *
 *   - two cooperative "cores": core 0 runs main(), core 1 runs the function
 *     passed to multicore_launch_core1(). Each has its own C stack, its own
 *     asyncify buffer and its own VIRTUAL clock (microseconds since boot).
 *   - a scheduler that always resumes the core whose clock is furthest
 *     behind, and suspends a core once it gets QUANTUM_US ahead of the other.
 *     The cores therefore stay within a few microseconds of each other, and
 *     cross-core races behave much like on the real chip.
 *   - interrupts: repeating timers, alarms and GPIO IRQs run on core 0, on a
 *     separate stack, whenever core 0's clock passes their due time.
 *
 * Virtual time advances by
 *   (a) explicit waits: sleep_us, busy_wait_us, I2C bus time ...
 *   (b) a small per-call cost for SDK register accesses, and
 *   (c) compute time: every function and loop in the firmware is
 *       instrumented at build time with an instruction-cost counter
 *       (Cortex-M33 cycle estimates, see tools/instrument-cycles.mjs),
 *       converted to microseconds at the current clk_sys.
 *
 * Everything observable (LED light, pin currents, I2C traffic, diagnostics)
 * is produced by BoardModel / I2CBus / devices in the same timeline.
 */
import { BoardModel, I2CBus, FN, ELEC } from './board.js';
import { Lis2dh12, St25dv } from './devices.js';

const QUANTUM_US = 5;            // max lead of one core over the other
const FIFO_DEPTH = 4;            // RP2350 SIO inter-core FIFO depth per direction
const CORE1_HAL_STACKS = 4 * 64 * 1024; // simulator-only buffers inside .bss

const ASYNC_NORMAL = 0, ASYNC_UNWINDING = 1, ASYNC_REWINDING = 2;

export class SimPanic extends Error {}

export class CardSim {
  /**
   * @param {object} opts
   *   board        board.json content
   *   wasmBytes    ArrayBuffer/Uint8Array of a firmware built with build-firmware.mjs
   *   getGravity   (tUs) -> [fx, fy, fz]: specific force on the card in g, in
   *                BOARD axes (KiCad front view: x right, y up, z out of the
   *                component side). The engine rotates it into sensor axes.
   *   onPrint      (line) -> void
   *   cpi          multiplier on the instruction-cost model (1.0 = as counted)
   */
  constructor({ board, wasmBytes, getGravity, onPrint = () => {}, cpi = 1.0 }) {
    this.board = board;
    this.wasmBytes = wasmBytes;
    this.getGravity = getGravity || (() => [0, 0, 1]);
    this.onPrint = onPrint;
    this.cpi = cpi; // cycles-per-instruction fudge factor for the cost model
    this.now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    this.accelMount = accelMountFromBoard(board);
  }

  // ======================================================================
  // Setup
  // ======================================================================
  async start() {
    this.diagnostics = new Map();
    this.consoleLines = [];
    this.halted = null;
    this.sysHz = 150e6;
    this.heapHighWater = 0;
    const diag = (key, severity, title, detail, t, score) => this.addDiag(key, severity, title, detail, t, score);

    this.bm = new BoardModel(this.board, diag);
    this.accel = new Lis2dh12({
      getForce: (t) => this.sensorForce(t),
      diag: (k, s, ti, d) => diag(k, s, ti, d, this.cur ? this.cur.t : 0),
    });
    this.bus = new I2CBus(this.bm, {
      0x18: this.accel,
      0x53: new St25dv(),
      0x57: new St25dv({ system: true }),
    }, diag);

    const { instance } = await WebAssembly.instantiate(this.wasmBytes, { sim: this.makeImports() });
    this.ex = instance.exports;
    this.mem = this.ex.memory;
    const required = ['asyncify_start_unwind', 'sim_entry_core0', '__stack_pointer'];
    for (const r of required) if (!this.ex[r]) throw new Error(`firmware is missing "${r}" — was it built with tools/build-firmware.mjs?`);

    const bufSize = this.ex.sim_async_buf_size();
    this.cores = [0, 1].map((n) => ({
      n,
      t: 0,                 // virtual time, us
      started: false,
      launched: n === 0,
      done: false,
      sp: 0,
      buf: this.ex.sim_async_buf(n),
      stackTop: n === 0 ? this.ex.__stack_pointer.value : this.ex.sim_stack_top(1),
      busyUs: 0,            // compute + short ops (CPU actually executing)
      waitUs: 0,            // sleeps / busy-waits / bus waits
    }));
    this.bufSize = bufSize;
    this.irqStackTop = this.ex.sim_stack_top(2);
    this.cur = null;
    this.inIrq = false;
    this.irqMasked = false;
    this.timers = [];       // {id, kind, obj, due}
    this.nextTimerId = 1;
    this.gpioIrq = new Map(); // pin -> event mask
    this.pendingIrq = [];   // {pin, events}
    this.fifo = [[], []];   // fifo[n] = messages waiting to be popped BY core n
    this.lastCycles = 0;
    this.yieldCount = 0;
    this.ext = { 22: 1, 23: 1, 24: 0, 25: 0, 26: 0, 27: 0, 28: 0 }; // externally driven inputs

    // static RAM estimate vs the RP2350's 520 KB
    const dataEnd = this.ex.__data_end.value;
    this.staticRamBytes = Math.max(0, dataEnd - 65536 - CORE1_HAL_STACKS);
    if (this.staticRamBytes > 520 * 1024) {
      this.addDiag('ram', 'error', `Static RAM ~${(this.staticRamBytes / 1024).toFixed(0)} KB exceeds the RP2350's 520 KB`, '', 0);
    }
  }

  // ======================================================================
  // Diagnostics & console
  // ======================================================================
  /** Record a finding. Repeats are counted; if `score` is given, a worse
   * (higher-score) occurrence replaces the stored title/detail. */
  addDiag(key, severity, title, detail, t = 0, score = 0) {
    const d = this.diagnostics.get(key);
    if (d) {
      d.count++;
      d.lastT = t;
      if (score > d.score) Object.assign(d, { title, detail, score });
      return;
    }
    this.diagnostics.set(key, { key, severity, title, detail, count: 1, firstT: t, lastT: t, score });
  }
  print(text) {
    for (const line of text.replace(/\n$/, '').split('\n')) {
      const t = this.cur ? this.cur.t : 0;
      this.consoleLines.push({ t, line });
      if (this.consoleLines.length > 500) this.consoleLines.shift();
      this.onPrint(line, t);
    }
  }

  // ======================================================================
  // Accelerometer geometry
  // ======================================================================
  /** Specific force in SENSOR axes at time t. */
  sensorForce(t) {
    const f = this.getGravity(t);               // board axes
    const m = this.accelMount;                  // rows = sensor axes in board coords
    return [0, 1, 2].map((r) => m[r][0] * f[0] + m[r][1] * f[1] + m[r][2] * f[2]);
  }

  // ======================================================================
  // Imports (the C side's view of the hardware)
  // ======================================================================
  makeImports() {
    const self = this;
    const u8 = () => new Uint8Array(self.mem.buffer);
    const str = (p, n) => new TextDecoder().decode(u8().subarray(p, p + n));

    // Every import first charges the cycles executed since the previous
    // import, so firmware number-crunching takes virtual time.
    const wrap = (fn) => function (...a) {
      self.chargeCompute();
      return fn(...a);
    };
    const t = () => self.cur.t;

    const imp = {
      yield: (costNs) => self.yieldImport(costNs),
      time_us: () => t(),
      core_num: () => (self.inIrq ? 0 : self.cur.n),

      gpio_set_function: (pin, fn) => self.bm.setFunction(pin, fn, t()),
      gpio_get_function: (pin) => self.bm.fn[pin],
      gpio_set_oe: (mask, value) => self.bm.setOE(mask >>> 0, value >>> 0, t()),
      gpio_get_oe: () => self.bm.oe >>> 0,
      gpio_set_out: (mask, value) => self.bm.setOut(mask >>> 0, value >>> 0, t()),
      gpio_xor_out: (mask) => self.bm.xorOut(mask >>> 0, t()),
      gpio_get_out: () => self.bm.out >>> 0,
      gpio_get_in: () => { self.updateExternal(t()); return self.bm.readInputs(self.ext) | 0; },
      gpio_set_pulls: (pin, up, down) => self.bm.setPulls(pin, up, down, t()),
      gpio_get_pulls: (pin) => ((self.bm.pullUp >> pin) & 1) | (((self.bm.pullDown >> pin) & 1) << 1),
      gpio_set_input_enabled: (pin, en) => self.bm.setInputEnabled(pin, en, t()),
      gpio_set_drive: (pin, s) => self.bm.setDrive(pin, s, t()),
      gpio_irq_enable: (pin, events, enabled) => {
        const cur = self.gpioIrq.get(pin) || 0;
        self.gpioIrq.set(pin, enabled ? cur | events : cur & ~events);
      },

      i2c_init: (bus, baud) => self.bus.init(bus, baud >>> 0),
      i2c_xfer: (bus, addr, ptr, len, nostop, isRead, timeoutUs) => {
        const bytes = isRead ? new Uint8Array(len) : u8().slice(ptr, ptr + len);
        const { result, busTimeUs } = self.bus.xfer(bus, addr, bytes, !!isRead, !!nostop, t());
        if (isRead && result > 0) u8().set(bytes, ptr);
        self.cur.t += busTimeUs;              // the bus transfer takes real time
        self.cur.waitUs += busTimeUs;
        return result;
      },

      core1_launch: () => {
        const c1 = self.cores[1];
        Object.assign(c1, { launched: true, started: false, done: false, t: self.cur.t });
      },
      core1_reset: () => Object.assign(self.cores[1], { launched: false, started: false, done: false }),
      fifo_push: (v) => {
        const dst = self.fifo[1 - self.cur.n];
        if (dst.length >= FIFO_DEPTH) return 0;
        dst.push(v >>> 0);
        return 1;
      },
      fifo_pop: (outPtr) => {
        const q = self.fifo[self.cur.n];
        if (!q.length) return 0;
        new Uint32Array(self.mem.buffer, outPtr, 1)[0] = q.shift();
        return 1;
      },
      fifo_count: (which) => which === 0 ? self.fifo[self.cur.n].length : FIFO_DEPTH - self.fifo[1 - self.cur.n].length,
      fifo_drain: () => { self.fifo[self.cur.n].length = 0; },

      timer_add: (kind, obj, due) => {
        const id = self.nextTimerId++;
        self.timers.push({ id, kind, obj, due });
        return id;
      },
      timer_cancel: (id) => {
        const i = self.timers.findIndex((x) => x.id === id);
        if (i >= 0) self.timers.splice(i, 1);
        return i >= 0 ? 1 : 0;
      },
      irq_mask: (m) => { self.irqMasked = !!m; },

      print: (p, n) => self.print(str(p, n)),
      panic: (p, n) => { const msg = str(p, n); self.halted = 'panic: ' + msg; throw new SimPanic(msg); },
      set_sys_clock: (hz) => { self.sysHz = hz; },
      heap_mark: (hw) => { self.heapHighWater = hw; },
    };
    for (const k of Object.keys(imp)) if (k !== 'yield') imp[k] = wrap(imp[k]);
    return imp;
  }

  /**
   * Charge the CPU cycles executed since the last SDK call to the running
   * core. The build instruments every function/loop with an instruction-cost
   * counter (tools/instrument-cycles.mjs), so this is deterministic and
   * independent of how fast the computer running the simulator is.
   */
  chargeCompute() {
    const g = this.ex && this.ex.sim_cycles;
    if (!g) return;
    const v = g.value;
    const d = v - this.lastCycles;
    this.lastCycles = v;
    if (!this.cur || d <= 0) return;
    const us = (d * this.cpi * 1e6) / this.sysHz;
    this.cur.t += us;
    this.cur.busyUs += us;
  }

  // ======================================================================
  // The scheduler
  // ======================================================================
  yieldImport(costNs) {
    const ex = this.ex;
    if (ex.asyncify_get_state() === ASYNC_REWINDING) {
      // We are resuming a core that suspended right here: finish the rewind.
      ex.asyncify_stop_rewind();
      return;
    }
    this.chargeCompute();
    const c = this.cur;
    const us = costNs / 1000;
    c.t += us;
    if (us >= 1) c.waitUs += us; else c.busyUs += us;
    if (this.inIrq || this.halted) return;
    if (this.shouldSwitch(c)) {
      c.sp = ex.__stack_pointer.value;
      const b = c.buf >> 2, mem32 = new Int32Array(this.mem.buffer);
      mem32[b] = c.buf + 8;
      mem32[b + 1] = c.buf + this.bufSize;
      ex.asyncify_start_unwind(c.buf);
    }
  }

  shouldSwitch(c) {
    if (c.t >= this.sliceEnd) return true;
    const o = this.cores[1 - c.n];
    if (this.runnable(o) && c.t > o.t + QUANTUM_US) return true;
    if (c.n === 0 && !this.irqMasked && this.nextInterruptTime() <= c.t) return true;
    // keep the page responsive (checked every 256 yields; now() is not free)
    if ((++this.yieldCount & 255) === 0 && this.now() > this.wallDeadline) return true;
    return false;
  }

  runnable(c) { return c.launched && !c.done; }

  nextInterruptTime() {
    let t = Infinity;
    for (const tm of this.timers) if (tm.due < t) t = tm.due;
    if (this.pendingIrq.length) t = -Infinity;
    // LIS2DH12 data-ready on INT1 (only matters if an IRQ is armed on GPIO24)
    if (this.gpioIrq.get(24)) t = Math.min(t, this.accel.nextSampleTime(this.cores[0].t - 1));
    return t;
  }

  /** Recompute externally driven input levels (accelerometer INT pins). */
  updateExternal(t) {
    this.accel.update(t);
    const lvl = this.accel.int1Level ? 1 : 0;
    if (lvl !== this.ext[24]) {
      const ev = this.gpioIrq.get(24) || 0;
      const fired = (lvl ? 8 /*rise*/ | 2 /*high*/ : 4 /*fall*/ | 1 /*low*/) & ev;
      if (fired) this.pendingIrq.push({ pin: 24, events: fired });
      this.ext[24] = lvl;
    }
  }

  /** Run interrupts that are due on core 0. */
  serviceInterrupts(c0) {
    if (this.irqMasked || !this.ex) return;
    this.updateExternal(c0.t);
    for (let guard = 0; guard < 64; guard++) {
      let job = null;
      if (this.pendingIrq.length) job = { irq: this.pendingIrq.shift() };
      else {
        let best = null;
        for (const tm of this.timers) if (tm.due <= c0.t && (!best || tm.due < best.due)) best = tm;
        if (best) job = { timer: best };
      }
      if (!job) return;
      const savedCur = this.cur;
      this.cur = c0;
      this.inIrq = true;
      this.ex.__stack_pointer.value = this.irqStackTop;
      try {
        if (job.irq) {
          this.ex.sim_fire_gpio_irq(job.irq.pin, job.irq.events);
        } else {
          const tm = job.timer;
          const r = this.ex.sim_fire_timer(tm.kind, tm.obj, tm.id);
          if (r > 0) tm.due += r;
          else if (r < 0) tm.due = c0.t - r;
          else this.timers.splice(this.timers.indexOf(tm), 1);
        }
        c0.t += 0.1; // ~15 cycles of exception entry/exit
      } finally {
        this.inIrq = false;
        this.cur = savedCur;
      }
    }
  }

  resume(c) {
    const ex = this.ex;
    this.cur = c;
    if (!c.started) {
      c.started = true;
      ex.__stack_pointer.value = c.stackTop;
    } else {
      ex.__stack_pointer.value = c.sp;
      ex.asyncify_start_rewind(c.buf);
    }
    try {
      if (c.n === 0) ex.sim_entry_core0(); else ex.sim_entry_core1();
    } catch (e) {
      if (!this.halted) this.halted = (e instanceof SimPanic ? 'panic: ' : 'crash: ') + e.message;
      this.addDiag('halt', 'error', `Firmware stopped on core ${c.n}`, this.halted, c.t);
      throw e;
    }
    if (ex.asyncify_get_state() === ASYNC_UNWINDING) ex.asyncify_stop_unwind();
    else c.done = true; // the entry function returned
    this.chargeCompute();
  }

  /**
   * Advance the simulation until virtual time `tTargetUs`, or until
   * `wallBudgetMs` of real time has been used (whichever comes first).
   * Returns the virtual time reached.
   */
  runUntil(tTargetUs, wallBudgetMs = 30) {
    if (this.halted) return this.time;
    this.sliceEnd = tTargetUs;
    this.wallDeadline = this.now() + wallBudgetMs;
    try {
      while (this.now() < this.wallDeadline) {
        const c0 = this.cores[0], c1 = this.cores[1];
        const cand = [c0, c1].filter((c) => this.runnable(c));
        if (!cand.length) { // both idle: only interrupts left
          const nt = Math.min(this.nextInterruptTime(), tTargetUs);
          c0.t = Math.max(c0.t, nt);
          if (nt >= tTargetUs) break;
          this.serviceInterrupts(c0);
          continue;
        }
        const c = cand.reduce((a, b) => (b.t < a.t ? b : a));
        if (c.t >= tTargetUs) break;
        if (c === c0 || !this.runnable(c0)) this.serviceInterrupts(c0);
        this.resume(c);
      }
    } catch (e) {
      if (!(e instanceof SimPanic)) console.error(e);
    }
    this.bm.integrate(this.time);
    return this.time;
  }

  get time() {
    const ts = this.cores.filter((c) => this.runnable(c)).map((c) => c.t);
    return ts.length ? Math.min(...ts) : this.cores[0].t;
  }

  // ======================================================================
  // Observations for the UI / test runner
  // ======================================================================
  /** Snapshot of integrated LED charge (copy) at the current time. */
  snapshot() {
    this.bm.integrate(this.time);
    return { t: this.time, charge: Float64Array.from(this.bm.ledCharge), pulses: Uint32Array.from(this.bm.ledPulses) };
  }
  /** Average LED current (mA) and refresh rate (Hz) between two snapshots. */
  static between(a, b) {
    const dt = b.t - a.t;
    const n = a.charge.length;
    const avgMa = new Float64Array(n), hz = new Float64Array(n);
    if (dt > 0) for (let i = 0; i < n; i++) {
      avgMa[i] = (b.charge[i] - a.charge[i]) / dt;
      hz[i] = ((b.pulses[i] - a.pulses[i]) / dt) * 1e6;
    }
    return { dt, avgMa, hz };
  }

  pinStates() {
    const bm = this.bm;
    return Array.from({ length: 30 }, (_, p) => ({
      pin: p,
      fn: bm.fn[p],
      dir: (bm.oe >> p) & 1,
      out: (bm.out >> p) & 1,
      driving: !!bm.driving(p),
      pull: ((bm.pullUp >> p) & 1 ? 'U' : '') + ((bm.pullDown >> p) & 1 ? 'D' : ''),
      inEn: (bm.inEn >> p) & 1,
      drive: ELEC.driveMa[bm.drive[p]],
      mA: bm.pinI[p],
      peak: bm.pinPeak[p],
    }));
  }

  diagList() {
    const order = { error: 0, warn: 1, info: 2 };
    return [...this.diagnostics.values()].sort((a, b) => order[a.severity] - order[b.severity] || a.firstT - b.firstT);
  }
}

/**
 * Sensor axes expressed in board axes (rows = sensor X, Y, Z), derived from
 * the LIS2DH12 footprint's side and rotation in the PCB.
 * Board axes: KiCad front view, x right, y UP (KiCad's y is down), z out of
 * the front (component) side.
 * Assumes the LIS2DH12 datasheet top view: X right, Y up, Z out of the top,
 * pin 1 at top-left — which matches the KiCad footprint's pin 1 placement.
 */
export function accelMountFromBoard(board) {
  const a = board.accelerometer || { rot: 0, side: 'front' };
  const th = (a.rot * Math.PI) / 180; // KiCad angles are CCW on screen
  const c = Math.cos(th), s = Math.sin(th);
  let X = [c, s, 0], Y = [-s, c, 0], Z = [0, 0, 1];
  if (a.side === 'back') { X = [-X[0], X[1], 0]; Z = [0, 0, -1]; } // mirrored footprint
  return [X, Y, Z];
}

export { ELEC, FN };
