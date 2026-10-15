/**
 * devices.js — I2C peripherals on the JT business card
 * =====================================================
 *
 *   Lis2dh12  ST LIS2DH12 3-axis accelerometer   (I2C 0x18, SA0 = GND)
 *   St25dv    ST ST25DV04K dynamic NFC tag        (I2C 0x53 user, 0x57 system)
 *
 * Each device implements the byte-level I2C slave interface used by I2CBus:
 *   start(isRead)        a (repeated) START addressed to this device
 *   write(byte) -> ack   master writes a byte
 *   read() -> byte       master reads a byte
 *   stop()               STOP condition
 *
 * The LIS2DH12 model follows the datasheet register map closely enough that
 * driver bugs show up the way they would on hardware: power-down mode
 * returns stale data, multi-byte reads without the auto-increment bit return
 * the same register repeatedly, the resolution/full-scale bits change the
 * scaling, the data-ready flag and INT1 data-ready line behave per spec.
 */

// --------------------------------------------------------------------------
// LIS2DH12
// --------------------------------------------------------------------------
const LIS = {
  STATUS_REG_AUX: 0x07, OUT_TEMP_L: 0x0c, OUT_TEMP_H: 0x0d, WHO_AM_I: 0x0f,
  CTRL_REG0: 0x1e, TEMP_CFG_REG: 0x1f, CTRL_REG1: 0x20, CTRL_REG2: 0x21,
  CTRL_REG3: 0x22, CTRL_REG4: 0x23, CTRL_REG5: 0x24, CTRL_REG6: 0x25,
  REFERENCE: 0x26, STATUS_REG: 0x27, OUT_X_L: 0x28, OUT_Z_H: 0x2d,
  FIFO_CTRL_REG: 0x2e, FIFO_SRC_REG: 0x2f,
};
// Output data rates selected by CTRL_REG1[7:4] (Hz). Index 9 depends on mode.
const ODR_HZ = [0, 1, 10, 25, 50, 100, 200, 400, 1620, 1344];
// Sensitivity in mg/digit for [LP, normal, HR] x FS (+-2, 4, 8, 16 g).
const SENS = {
  lp: [16, 32, 64, 192],
  normal: [4, 8, 16, 48],
  hr: [1, 2, 4, 12],
};
const BITS = { lp: 8, normal: 10, hr: 12 };
// Registers that exist and are writable (others are reserved or read-only).
const WRITABLE = new Set([0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x2e,
  0x30, 0x32, 0x33, 0x34, 0x36, 0x37, 0x38, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]);

export class Lis2dh12 {
  /**
   * @param {object} opts
   *   getForce(tUs) -> [fx, fy, fz] specific force in g, in SENSOR axes
   *   diag(key, severity, title, detail)  diagnostics sink
   *   noiseMg  rms noise per axis in mg
   */
  constructor({ getForce, diag, noiseMg = 1.5 }) {
    this.getForce = getForce;
    this.diag = diag;
    this.noiseMg = noiseMg;
    this.reset();
  }

  reset() {
    this.reg = new Uint8Array(0x40);
    this.reg[LIS.WHO_AM_I] = 0x33;
    this.reg[LIS.CTRL_REG0] = 0x10;
    this.reg[LIS.CTRL_REG1] = 0x07; // power-down, X/Y/Z enabled
    this.ptr = 0;
    this.autoInc = false;
    this.gotSub = false;       // first written byte of a transaction = sub-address
    this.lastSample = -1;      // index of the last generated sample
    this.dataReady = false;
    this.overrun = false;
    this.readsInTxn = 0;
    this.now = 0;              // set by the bus before each transaction
    this.lastForce = [0, 0, 0];
  }

  // ---- derived configuration ----
  get odrHz() {
    const code = this.reg[LIS.CTRL_REG1] >> 4;
    if (code === 9) return this.mode === 'lp' ? 5376 : 1344;
    return ODR_HZ[code] ?? 0;
  }
  get mode() {
    const lp = (this.reg[LIS.CTRL_REG1] >> 3) & 1;
    const hr = (this.reg[LIS.CTRL_REG4] >> 3) & 1;
    return lp ? 'lp' : hr ? 'hr' : 'normal';
  }
  get fsIndex() { return (this.reg[LIS.CTRL_REG4] >> 4) & 3; }
  get fullScaleG() { return [2, 4, 8, 16][this.fsIndex]; }
  /** INT1 output level (true = electrically high). */
  get int1Level() {
    const drdyRouted = (this.reg[LIS.CTRL_REG3] >> 4) & 1; // I1_ZYXDA
    const active = drdyRouted && this.dataReady;
    const activeLow = (this.reg[LIS.CTRL_REG6] >> 1) & 1;   // INT_POLARITY
    return activeLow ? !active : active;
  }
  /** Time (us) of the next new sample, or Infinity in power-down. */
  nextSampleTime(tUs) {
    const odr = this.odrHz;
    if (!odr) return Infinity;
    const period = 1e6 / odr;
    return (Math.floor(tUs / period) + 1) * period;
  }

  /** Advance the sensor's internal clock: latch any new samples. */
  update(tUs) {
    this.now = tUs;
    const odr = this.odrHz;
    if (!odr) return;
    const idx = Math.floor((tUs * odr) / 1e6);
    if (idx === this.lastSample) return;
    if (this.dataReady && idx > this.lastSample + 1) this.overrun = true;
    this.lastSample = idx;
    this.latch(tUs);
    this.dataReady = true;
  }

  /** Convert the current specific force into output register values. */
  latch(tUs) {
    const f = this.getForce(tUs);
    this.lastForce = f;
    const mode = this.mode;
    const sens = SENS[mode][this.fsIndex];
    const bits = BITS[mode];
    const max = (1 << (bits - 1)) - 1;
    const en = this.reg[LIS.CTRL_REG1] & 7; // Zen Yen Xen
    for (let axis = 0; axis < 3; axis++) {
      let v = 0;
      if ((en >> axis) & 1) {
        const mg = f[axis] * 1000 + gauss() * this.noiseMg;
        v = Math.max(-max - 1, Math.min(max, Math.round(mg / sens)));
      }
      const word = (v << (16 - bits)) & 0xffff; // left-justified
      this.reg[LIS.OUT_X_L + axis * 2] = word & 0xff;
      this.reg[LIS.OUT_X_L + axis * 2 + 1] = word >> 8;
    }
  }

  // ---- I2C slave interface ----
  start(isRead) {
    this.update(this.now);
    if (!isRead) this.gotSub = false;
    this.readsInTxn = 0;
    if (isRead) this.readStartPtr = this.ptr;
  }
  write(byte) {
    if (!this.gotSub) {
      this.gotSub = true;
      this.ptr = byte & 0x7f;
      this.autoInc = !!(byte & 0x80);
      return true;
    }
    const r = this.ptr;
    if (r === LIS.CTRL_REG1 && ((byte >> 3) & 1) && ((this.reg[LIS.CTRL_REG4] >> 3) & 1)) {
      this.diag('lis-lp-hr', 'warn', 'LIS2DH12: LPen and HR both set',
        'CTRL_REG1.LPen=1 with CTRL_REG4.HR=1 is a "not allowed" combination in the datasheet.');
    }
    if (WRITABLE.has(r)) {
      if (r === LIS.CTRL_REG5 && (byte & 0x80)) this.reset(); // BOOT: reload trimming
      else this.reg[r] = byte;
      if (r === LIS.CTRL_REG1 || r === LIS.CTRL_REG4) { this.lastSample = -1; this.dataReady = false; }
    } else {
      this.diag(`lis-wr-${r}`, r < 0x1e ? 'error' : 'warn', `LIS2DH12: write to reserved/read-only register 0x${hex(r)}`,
        'The datasheet warns that writing reserved registers (0x00-0x06 especially) can permanently change factory calibration.');
    }
    if (this.autoInc) this.ptr = (this.ptr + 1) & 0x7f;
    return true;
  }
  read() {
    const r = this.ptr;
    if (r >= LIS.OUT_X_L && r <= LIS.OUT_Z_H) {
      if (!this.odrHz) {
        this.diag('lis-powerdown', 'warn', 'LIS2DH12 read while in power-down',
          'CTRL_REG1 ODR bits are 0000, so the output registers never update. Write CTRL_REG1 (e.g. 0x57 for 100 Hz, XYZ on).');
      }
      if (r === LIS.OUT_Z_H) this.dataReady = false;
    }
    if (r === LIS.STATUS_REG) {
      const v = (this.dataReady ? 0x0f : 0) | (this.overrun ? 0xf0 : 0);
      this.overrun = false;
      this.advance();
      return v;
    }
    const v = this.reg[r] ?? 0;
    this.readsInTxn++;
    if (this.readsInTxn === 2 && !this.autoInc) {
      this.diag('lis-noinc', 'warn', 'LIS2DH12 multi-byte read without auto-increment',
        `Read of ${this.readsInTxn}+ bytes from 0x${hex(r)} with sub-address MSB = 0: every byte comes from the same register. Use (reg | 0x80).`);
    }
    this.advance();
    if (r === LIS.OUT_Z_H) this.dataReady = false;
    return v;
  }
  advance() { if (this.autoInc) this.ptr = (this.ptr + 1) & 0x7f; }
  stop() { this.gotSub = false; }
}

// --------------------------------------------------------------------------
// ST25DV04K — 512 bytes of user EEPROM + a system area. Enough for a bus scan,
// reading/writing NDEF records, and seeing that the tag answers.
// --------------------------------------------------------------------------
export class St25dv {
  constructor({ system = false } = {}) {
    this.system = system;
    this.mem = new Uint8Array(system ? 0x100 : 512);
    if (!system) {
      // Type 5 capability container + empty NDEF TLV, as shipped blank.
      this.mem.set([0xe1, 0x40, 0x40, 0x00, 0x03, 0x00, 0xfe]);
    } else {
      this.mem[0x17] = 0x24; // IC_REF for ST25DV04K
    }
    this.addr = 0;
    this.addrBytes = 0;
  }
  start(isRead) { if (!isRead) this.addrBytes = 0; }
  write(b) {
    if (this.addrBytes < 2) {
      this.addr = ((this.addr << 8) | b) & 0xffff;
      this.addrBytes++;
      return true;
    }
    if (this.system) return true; // password-protected area: accept, ignore
    this.mem[this.addr % this.mem.length] = b;
    this.addr++;
    return true;
  }
  read() { const v = this.mem[this.addr % this.mem.length]; this.addr++; return v; }
  stop() {}
}

// --------------------------------------------------------------------------
function gauss() {
  // Box-Muller, one sample
  const u = Math.random() || 1e-9, v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function hex(v, n = 2) { return v.toString(16).padStart(n, '0'); }
export { LIS };
