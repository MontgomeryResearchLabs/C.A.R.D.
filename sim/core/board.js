/**
 * board.js — electrical model of the JT business card
 * ====================================================
 *
 * Owns the RP2350 pad state (function, direction, output latch, pulls, drive
 * strength, input enable) for GPIO0..29 and turns it into physics:
 *
 *  - Charlieplex matrix: which of the 441 LEDs conduct, and how much current
 *    each one gets. Every LED sits between two GPIO lines, each with a 22 R
 *    series resistor. Current is solved from a simple LED model
 *        I = max(0, (V_anode - V_cathode - V_th) / R_d)
 *    where V_anode/V_cathode sag with the total current through each pin's
 *    driver + resistor (so a row of 21 lit LEDs is dimmer than a single one,
 *    as on the real board).
 *  - Ghosting: weak glow through internal pull-ups/pull-downs on tri-stated
 *    LED lines.
 *  - Light integration: charge (uA*us) per LED, so brightness = average
 *    current over any window, exactly as the eye integrates PWM/BCM.
 *  - Hazards from the schematic: GPIO26-28 tied to GND, LIS2DH12 INT pins,
 *    I2C pull-ups powered from GPIO29.
 *
 * All "electrical constants" live in ELEC so they are easy to tweak; values
 * marked (est.) are engineering estimates, not datasheet guarantees.
 */
import { hex } from './devices.js';

export const FN = { SIO: 5, I2C: 3, NULL: 0x1f };

export const ELEC = {
  vdd: 3.3,               // IOVDD
  rSeries: 22,            // R4, R13..R36 on every LED line (from the PCB)
  // RP2350 pad output resistance per drive-strength setting (est.: chosen so
  // the pad droops ~0.4 V at roughly its rated current).
  rDriver: [160, 80, 40, 27], // 2, 4, 8, 12 mA
  driveMa: [2, 4, 8, 12],
  // Würth 150060GS75000 (InGaN green, 520 nm). Piecewise-linear fit (est.)
  // to Vf ~ 3.2 V @ 20 mA with a ~2.55 V knee.
  ledVth: 2.55,
  ledRd: 32,
  // Weak glow model for a pull-resistor path (internal pulls ~50 k).
  rPull: 50e3,
  glowVth: 2.35,          // InGaN LEDs are visibly lit at a few uA
  totalCurrentWarnMa: 50, // conservative total-GPIO-current guideline (est.)
};

/** Solve G x = b in place (small dense systems, partial pivoting). */
function gaussSolve(G, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(G[r][c]) > Math.abs(G[piv][c])) piv = r;
    [G[c], G[piv]] = [G[piv], G[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    const d = G[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = G[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) G[r][k] -= f * G[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= G[r][k] * x[k];
    x[r] = s / (G[r][r] || 1e-12);
  }
  return x;
}

export class BoardModel {
  /**
   * @param {object} board  board.json content (leds[], led_nets ...)
   * @param {function} diag (key, severity, title, detail, t)
   */
  constructor(board, diag) {
    this.board = board;
    this.diag = diag;
    this.nLeds = board.leds.length;
    // pairToLed[a*32+k] = LED index for anode GPIO a, cathode GPIO k
    this.pairToLed = new Int16Array(32 * 32).fill(-1);
    this.ledAnode = new Uint8Array(this.nLeds);
    this.ledCathode = new Uint8Array(this.nLeds);
    board.leds.forEach((l, i) => {
      this.pairToLed[l.anode_gpio * 32 + l.cathode_gpio] = i;
      this.ledAnode[i] = l.anode_gpio;
      this.ledCathode[i] = l.cathode_gpio;
    });
    this.ledPinMask = 0;
    for (const n of Object.values(board.led_nets)) this.ledPinMask |= 1 << n.gpio;
    this.reset();
  }

  reset() {
    // RP2350 reset state of bank-0 pads: function NULL, input, pull-DOWN on,
    // input buffer enabled, 4 mA drive.
    this.fn = new Uint8Array(30).fill(FN.NULL);
    this.oe = 0;
    this.out = 0;
    this.pullUp = 0;
    this.pullDown = (1 << 30) - 1;
    this.inEn = (1 << 30) - 1;
    this.drive = new Uint8Array(30).fill(1);

    // LED state
    this.ledI = new Float64Array(this.nLeds);     // current now (mA)
    this.ledCharge = new Float64Array(this.nLeds); // integrated mA*us
    this.ledPulses = new Uint32Array(this.nLeds);  // distinct on-pulses
    this.ledOffSince = new Float64Array(this.nLeds).fill(-1e9);
    this.ledPeakI = new Float64Array(this.nLeds);
    this.lit = [];                                 // indices with ledI > 0
    this.lastT = 0;
    this.pinI = new Float64Array(30);              // current through each pad now (mA, +source)
    this.pinPeak = new Float64Array(30);
    this.totalPeak = 0;
    this.maxLitAtOnce = 0;
    this.minDrivenI = Infinity;   // smallest / largest current seen in a
    this.maxDrivenI = 0;          // directly driven LED (mA)
    this.glowing = 0;                              // count of LEDs lit only by pull leakage
    this.ghosted = new Uint8Array(this.nLeds);     // sticky: LED was ever lit by leakage
    this.dirty = true;
  }

  // ------------------------------------------------------------------ pads
  setFunction(pin, f, t) { this.integrate(t); this.fn[pin] = f; this.changed(1 << pin, t); }
  setOE(mask, value, t) { this.integrate(t); this.oe = (this.oe & ~mask) | (value & mask); this.changed(mask, t); }
  setOut(mask, value, t) { this.integrate(t); this.out = (this.out & ~mask) | (value & mask); this.changed(mask, t); }
  xorOut(mask, t) { this.integrate(t); this.out ^= mask; this.changed(mask, t); }
  setPulls(pin, up, down, t) {
    this.integrate(t);
    this.pullUp = up ? this.pullUp | (1 << pin) : this.pullUp & ~(1 << pin);
    this.pullDown = down ? this.pullDown | (1 << pin) : this.pullDown & ~(1 << pin);
    this.changed(1 << pin, t);
  }
  setInputEnabled(pin, en, t) { this.inEn = en ? this.inEn | (1 << pin) : this.inEn & ~(1 << pin); this.changed(1 << pin, t); }
  setDrive(pin, s, t) { this.integrate(t); this.drive[pin] = s & 3; this.changed(1 << pin, t); }

  /** Is the pad actively driving (SIO function + output enabled)? */
  driving(pin) { return this.fn[pin] === FN.SIO && ((this.oe >> pin) & 1); }

  // ------------------------------------------------------------ change hook
  changed(mask, t) {
    if (mask & this.ledPinMask) this.dirty = true;
    if (mask & 0x3fc00000) this.checkHazards(t);
    if (this.dirty) this.solve(t);
  }

  checkHazards(t) {
    for (const p of [26, 27, 28]) {
      if (this.driving(p) && ((this.out >> p) & 1)) {
        this.diag(`short-${p}`, 'error', `GPIO${p} driven HIGH but it is wired to GND`,
          `In the schematic GPIO26/27/28 carry no-connect flags yet are joined to GND (#PWR036). Driving GPIO${p} high shorts the pad driver to ground (~${(ELEC.vdd / ELEC.rDriver[this.drive[p]] * 1000).toFixed(0)} mA). Leave them as inputs with pulls off, or remove the GND wire in the next revision.`, t);
      }
    }
    for (const p of [24, 25]) {
      if (this.driving(p)) {
        this.diag(`int-contention-${p}`, 'error', `GPIO${p} is an output, but LIS2DH12 INT${p - 23} drives this net`,
          'The accelerometer\'s INT pins are push-pull outputs. Configure GPIO24/25 as inputs (gpio_init + gpio_set_dir(pin, GPIO_IN)).', t);
      }
    }
  }

  // -------------------------------------------------------------- LED physics
  /** Accumulate light for the interval [lastT, t] using the current state. */
  integrate(t) {
    const dt = t - this.lastT;
    if (dt > 0) {
      for (const i of this.lit) this.ledCharge[i] += this.ledI[i] * dt;
      this.lastT = t;
    }
  }

  /** Recompute which LEDs conduct and their currents. */
  solve(t) {
    this.dirty = false;
    const E = ELEC;
    const prevLit = this.lit;
    for (const i of prevLit) { this.ledI[i] = 0; }
    const lit = [];
    const H = [], L = [], Z = [];
    for (let p = 0; p < 30; p++) {
      if (!((this.ledPinMask >> p) & 1)) continue;
      if (this.driving(p)) ((this.out >> p) & 1 ? H : L).push(p);
      else Z.push(p);
    }
    this.pinI.fill(0);

    // 1. Directly driven LEDs: anode high, cathode low.
    const pairs = [];
    for (const a of H) for (const k of L) {
      const i = this.pairToLed[a * 32 + k];
      if (i >= 0) pairs.push(i);
    }
    if (pairs.length) {
      const I = this.solveNetwork(pairs);
      pairs.forEach((i, j) => {
        const mA = I[j] * 1000;
        if (mA > 1e-4) {
          this.ledI[i] = mA; lit.push(i);
          if (mA < this.minDrivenI) this.minDrivenI = mA;
          if (mA > this.maxDrivenI) this.maxDrivenI = mA;
        }
        this.pinI[this.ledAnode[i]] += mA;
        this.pinI[this.ledCathode[i]] -= mA;
      });
      const ratio = this.maxDrivenI / this.minDrivenI;
      if (ratio > 2) {
        this.diag('led-spread', 'warn', `LED current varies ${ratio.toFixed(1)}x with the number of LEDs lit per scan slot`,
          `Measured ${this.minDrivenI.toFixed(2)}-${this.maxDrivenI.toFixed(2)} mA per LED. Every LED lit in a slot shares the anode line's driver + 22 R, and green InGaN LEDs at 3.3 V have only ~0.7 V of headroom above their knee, so a slot with many LEDs lit is much dimmer per LED than a slot with one. Expect visible brightness steps unless the firmware compensates (e.g. limit LEDs per slot, or stretch slots with many LEDs).`, t, ratio);
      }
    }

    // 2. Ghost glow through internal pulls on tri-stated lines.
    let glowing = 0;
    const glowI = (r) => Math.max(0, (E.vdd - E.glowVth) / r) * 1000; // mA
    for (const z of Z) {
      const up = (this.pullUp >> z) & 1, down = (this.pullDown >> z) & 1;
      if (down) for (const a of H) {
        const i = this.pairToLed[a * 32 + z];
        if (i >= 0 && !this.ledI[i]) { this.ledI[i] = glowI(E.rPull); lit.push(i); glowing++; this.ghosted[i] = 1; }
      }
      if (up) for (const k of L) {
        const i = this.pairToLed[z * 32 + k];
        if (i >= 0 && !this.ledI[i]) { this.ledI[i] = glowI(E.rPull); lit.push(i); glowing++; this.ghosted[i] = 1; }
      }
      if (up) for (const z2 of Z) {
        if (z2 === z || !((this.pullDown >> z2) & 1)) continue;
        const i = this.pairToLed[z * 32 + z2];
        if (i >= 0 && !this.ledI[i]) { this.ledI[i] = glowI(2 * E.rPull); lit.push(i); glowing++; this.ghosted[i] = 1; }
      }
    }
    if (glowing) {
      this.diag('ghost-pulls', 'warn', 'Ghost glow: pulls enabled on tri-stated LED lines',
        `${glowing} LED(s) conduct ~${glowI(E.rPull).toFixed(3)} mA through the RP2350's internal pull resistors (pull-down is ON at reset). Call gpio_disable_pulls() on GPIO0-21.`, t);
      // RP2350-E9: input enabled + pull-down on a pin that is driven and released
      for (const z of Z) if (((this.inEn & this.pullDown) >> z) & 1) {
        this.diag('e9', 'info', 'RP2350 erratum E9 conditions on LED lines',
          'Pads with input enabled and pull-down on can latch near 2 V after being driven high and released. Disable the input buffer (gpio_set_input_enabled(pin,false)) or the pull-down on charlieplex lines.', t);
        break;
      }
    }
    this.glowing = glowing;

    // 3. Pulse bookkeeping (for refresh-rate / flicker analysis).
    for (const i of lit) {
      if (!prevLit.includes(i) && t - this.ledOffSince[i] > 20) this.ledPulses[i]++;
      if (this.ledI[i] > this.ledPeakI[i]) this.ledPeakI[i] = this.ledI[i];
    }
    for (const i of prevLit) if (!this.ledI[i]) this.ledOffSince[i] = t;
    this.lit = lit;
    if (lit.length > this.maxLitAtOnce) this.maxLitAtOnce = lit.length;

    // 4. Pin current checks.
    let total = 0;
    for (let p = 0; p < 30; p++) {
      const a = Math.abs(this.pinI[p]);
      if (this.pinI[p] > 0) total += this.pinI[p];
      if (a > this.pinPeak[p]) {
        this.pinPeak[p] = a;
        const rated = E.driveMa[this.drive[p]];
        if (a > rated * 1.05) {
          const nLeds = this.pinI[p] > 0
            ? lit.filter((i) => this.ledAnode[i] === p).length
            : lit.filter((i) => this.ledCathode[i] === p).length;
          this.diag('pin-over', 'warn', `LED lines exceed their drive-strength rating (worst: GPIO${p}, ${a.toFixed(1)} mA vs ${rated} mA)`,
            `GPIO${p} ${this.pinI[p] > 0 ? 'sourced' : 'sank'} ${a.toFixed(1)} mA for ${nLeds} LED(s) at once. Above the rated current the pad voltage sags, so LEDs sharing that line get dimmer (the simulator models the sag). Options: light fewer LEDs per scan slot, or accept the brightness variation.`, t, a);
        }
      }
    }
    if (total > this.totalPeak) {
      this.totalPeak = total;
      if (total > E.totalCurrentWarnMa) {
        this.diag('total-current', 'warn', `Total GPIO current peaks at ${total.toFixed(1)} mA`,
          `Above the ${E.totalCurrentWarnMa} mA guideline used here for the sum of all GPIO currents; check the RP2350 datasheet IOVDD limits. (The XC6206 LDO is rated 250 mA.)`, t, total);
      }
    }
  }

  /**
   * Nodal analysis of the driven part of the matrix.
   *
   * Unknowns: the voltage at each involved LED line, measured on the LED
   * side of its 22 R resistor. Each driven line connects to its rail
   * (VDD for high, 0 V for low) through R = R_driver + R_series. Each
   * conducting LED is modelled as a V_th source in series with R_d.
   * KCL at every node gives a small linear system G*V = b, solved by
   * Gaussian elimination. LEDs that come out reverse-biased (I < 0) are
   * switched off and the system is re-solved (max a few passes).
   *
   * @param {number[]} pairs LED indices whose anode is high and cathode low
   * @returns {number[]} current through each LED in amps
   */
  solveNetwork(pairs) {
    const E = ELEC;
    const nodes = new Map(); // gpio -> row index
    const nodeOf = (p) => { if (!nodes.has(p)) nodes.set(p, nodes.size); return nodes.get(p); };
    pairs.forEach((i) => { nodeOf(this.ledAnode[i]); nodeOf(this.ledCathode[i]); });
    const n = nodes.size;
    const on = pairs.map(() => true);
    const g = 1 / E.ledRd;
    let I = pairs.map(() => 0);
    for (let pass = 0; pass < 6; pass++) {
      const G = Array.from({ length: n }, () => new Float64Array(n));
      const b = new Float64Array(n);
      for (const [p, r] of nodes) {
        const R = E.rDriver[this.drive[p]] + E.rSeries;
        const src = (this.out >> p) & 1 ? E.vdd : 0;
        G[r][r] += 1 / R;
        b[r] += src / R;
      }
      pairs.forEach((i, j) => {
        if (!on[j]) return;
        const a = nodes.get(this.ledAnode[i]), k = nodes.get(this.ledCathode[i]);
        G[a][a] += g; G[a][k] -= g; b[a] += g * E.ledVth;
        G[k][k] += g; G[k][a] -= g; b[k] -= g * E.ledVth;
      });
      const V = gaussSolve(G, b);
      let changed = false;
      I = pairs.map((i, j) => {
        if (!on[j]) return 0;
        const cur = g * (V[nodes.get(this.ledAnode[i])] - V[nodes.get(this.ledCathode[i])] - E.ledVth);
        if (cur < 0) { on[j] = false; changed = true; return 0; }
        return cur;
      });
      if (!changed) break;
    }
    return I;
  }

  // ---------------------------------------------------------------- inputs
  /** Value the SIO GPIO_IN register would read. */
  readInputs(external) {
    let v = 0;
    for (let p = 0; p < 30; p++) {
      if (!((this.inEn >> p) & 1)) continue;
      let level;
      if (this.driving(p)) level = (this.out >> p) & 1;
      else if (p in external) level = external[p];
      else if ((this.pullUp >> p) & 1) level = 1;
      else level = 0; // pulled down or floating (reads low on average)
      v |= level << p;
    }
    return v >>> 0;
  }

  /** State of the I2C pull-ups (R1/R3 are fed from GPIO29). */
  pullupState() {
    const p = 29;
    if (this.driving(p)) return (this.out >> p) & 1 ? 'on' : 'shorted-low';
    if ((this.pullDown >> p) & 1) return 'off-pulldown';
    return 'floating';
  }
}

// ---------------------------------------------------------------------------
// I2C bus with routing / pull-up / speed checks and a protocol trace
// ---------------------------------------------------------------------------
const I2C_SDA = { 0: [0, 4, 8, 12, 16, 20, 24, 28], 1: [2, 6, 10, 14, 18, 22, 26] };
const I2C_SCL = { 0: [1, 5, 9, 13, 17, 21, 25, 29], 1: [3, 7, 11, 15, 19, 23, 27] };
export const PICO_ERROR_TIMEOUT = -1, PICO_ERROR_GENERIC = -2;

export class I2CBus {
  constructor(boardModel, devices, diag) {
    this.bm = boardModel;
    this.devices = devices; // { addr: device }, all physically on GPIO22/23
    this.diag = diag;
    this.baud = [0, 0];
    this.trace = [];        // recent transactions for the UI
    this.stats = { ok: 0, nack: 0, fail: 0 };
  }
  init(bus, baud) {
    this.baud[bus] = baud;
    if (baud > 400000) {
      this.diag('i2c-fast', 'error', `I2C${bus} at ${(baud / 1000).toFixed(0)} kHz exceeds the LIS2DH12's 400 kHz`,
        'Fast-mode plus is not supported by the accelerometer. Use i2c_init(i2c1, 400000) or lower.');
    }
    return baud;
  }

  /** Is the bus physically able to carry a transaction? Returns null if OK,
   * or a reason string. Emits diagnostics. */
  checkBus(bus, t) {
    const bm = this.bm;
    if (!this.baud[bus]) {
      this.diag(`i2c-noinit-${bus}`, 'error', `I2C${bus} used before i2c_init()`, 'Call i2c_init() first.', t);
      return 'not initialised';
    }
    const sdaOk = bm.fn[22] === FN.I2C, sclOk = bm.fn[23] === FN.I2C;
    if (bus !== 1) {
      this.diag('i2c-wrong-bus', 'error', `I2C0 has no devices on this board`,
        'GPIO22/23 can only be I2C1 (SDA=22 is an I2C1 pin). Use i2c1.', t);
      return 'wrong controller';
    }
    if (!sdaOk || !sclOk) {
      const routed = [...I2C_SDA[bus], ...I2C_SCL[bus]].filter(p => bm.fn[p] === FN.I2C);
      this.diag('i2c-pins', 'error', 'I2C1 is not routed to GPIO22 (SDA) / GPIO23 (SCL)',
        `gpio_set_function(22, GPIO_FUNC_I2C) and gpio_set_function(23, GPIO_FUNC_I2C) are required.${routed.length ? ' Currently routed to GPIO' + routed.join(', GPIO') + ', where nothing is connected.' : ''}`, t);
      return 'pins not routed';
    }
    const pu = bm.pullupState();
    if (pu === 'on') return null;
    const internal = ((bm.pullUp >> 22) & 1) && ((bm.pullUp >> 23) & 1);
    if (pu === 'shorted-low') {
      this.diag('i2c-pu-low', 'error', 'GPIO29 (ENABLE_ACCEL) is driven LOW: the pull-ups hold SDA/SCL low',
        'R1/R3 (5.1 k) connect SDA/SCL to GPIO29. Drive GPIO29 HIGH before using the bus. On hardware the blocking I2C call would hang here.', t);
      return 'bus held low';
    }
    if (internal && pu === 'floating' && this.baud[1] <= 100000) {
      this.diag('i2c-pu-weak', 'warn', 'I2C running on internal pull-ups only',
        'GPIO29 is not driving the external 5.1 k pull-ups, so only the ~50 k internal pull-ups hold the bus. Works at 100 kHz with little margin. Drive GPIO29 high.', t);
      return null;
    }
    this.diag('i2c-pu-off', 'error', 'I2C pull-ups are not powered (GPIO29 / ENABLE_ACCEL not driven high)',
      `R1/R3 are fed from GPIO29, which is ${pu === 'off-pulldown' ? 'an input with its reset pull-down' : 'floating'}. SDA/SCL cannot rise, so nothing on the bus answers. gpio_init(29); gpio_set_dir(29, GPIO_OUT); gpio_put(29, 1);`, t);
    return 'no pull-ups';
  }

  /**
   * Execute one master transaction (START, address, data..., [STOP]).
   * @returns {result, busTimeUs}
   */
  xfer(bus, addr, bytes, isRead, nostop, t) {
    const baud = this.baud[bus] || 100000;
    const busTimeUs = ((bytes.length + 1) * 9 + 2) * 1e6 / baud;
    const rec = { t, bus, addr, rw: isRead ? 'R' : 'W', data: [], result: '' };
    const done = (result) => {
      rec.result = result >= 0 ? 'ok' : result === PICO_ERROR_TIMEOUT ? 'timeout' : 'error';
      this.trace.push(rec);
      if (this.trace.length > 64) this.trace.shift();
      if (result >= 0) this.stats.ok++; else this.stats.fail++;
      return { result, busTimeUs };
    };
    if ((addr & 0x78) === 0 || (addr & 0x78) === 0x78) {
      this.diag('i2c-reserved', 'warn', `I2C access to reserved address 0x${hex(addr)}`, 'Addresses 0x00-0x07 and 0x78-0x7F are reserved.', t);
      return done(PICO_ERROR_GENERIC);
    }
    const why = this.checkBus(bus, t);
    if (why) { rec.note = why; return done(PICO_ERROR_GENERIC); }
    const dev = this.devices[addr];
    if (!dev) {
      this.stats.nack++;
      rec.note = 'NACK';
      this.diag(`i2c-nack-${addr}`, 'info', `No device at I2C address 0x${hex(addr)} (NACK)`,
        'Devices on this board: 0x18 LIS2DH12, 0x53 / 0x57 ST25DV04K.', t);
      return done(PICO_ERROR_GENERIC);
    }
    if (dev.update) dev.update(t);
    dev.start(isRead);
    if (isRead) for (let i = 0; i < bytes.length; i++) { bytes[i] = dev.read(); rec.data.push(bytes[i]); }
    else for (const b of bytes) { dev.write(b); rec.data.push(b); }
    if (!nostop) dev.stop();
    return done(bytes.length);
  }
}
