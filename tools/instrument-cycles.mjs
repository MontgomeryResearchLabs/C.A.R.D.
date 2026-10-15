/**
 * instrument-cycles.mjs — deterministic CPU-time model for firmware
 * =================================================================
 *
 * Problem: the simulator must know how long pure computation (e.g. one fluid
 * step) would take on a 150 MHz Cortex-M33. Measuring wall-clock time in the
 * browser is noisy (timers are coarsened to 0.1-1 ms) and depends on the
 * user's computer.
 *
 * Solution: count instructions. This pass adds an f64 global `sim_cycles`
 * to the module and, at the start of every function body and every loop
 * iteration, adds the estimated cycle cost of the straight-line code in that
 * region. The engine reads the counter at each SDK call and converts cycles
 * to microseconds at the current clk_sys.
 *
 * Cost table (approximate Cortex-M33 + FPv5-SP timings):
 *   - ALU / compare / branch / select ........ 1
 *   - load 2, store 1, call 3, indirect call 4
 *   - i32 divide 6, i64 ops 3 (32-bit core), i64 mul/div 20
 *   - f32 add/mul 1, f32 div 14, f32 sqrt 14
 *   - ANY f64 arithmetic 40   (no double-precision FPU: software emulation)
 *   - constants, local get/set, blocks ...... 0 (registers / structure)
 *
 * Both arms of an if/else are charged (a slight over-estimate), which is
 * the conservative direction for a timing check.
 */
import binaryen from '../node_modules/binaryen/index.js';

const B = binaryen;
const CHILD_KEYS = {
  [B.BlockId]: ['children'],
  [B.IfId]: ['condition', 'ifTrue', 'ifFalse'],
  [B.LoopId]: ['body'],
  [B.BreakId]: ['condition', 'value'],
  [B.SwitchId]: ['condition', 'value'],
  [B.CallId]: ['operands'],
  [B.CallIndirectId]: ['target', 'operands'],
  [B.LocalSetId]: ['value'],
  [B.GlobalSetId]: ['value'],
  [B.LoadId]: ['ptr'],
  [B.StoreId]: ['ptr', 'value'],
  [B.UnaryId]: ['value'],
  [B.BinaryId]: ['left', 'right'],
  [B.SelectId]: ['ifTrue', 'ifFalse', 'condition'],
  [B.DropId]: ['value'],
  [B.ReturnId]: ['value'],
  [B.MemoryGrowId]: ['delta'],
  [B.MemoryCopyId]: ['dest', 'source', 'size'],
  [B.MemoryFillId]: ['dest', 'value', 'size'],
};

const DIV_I32 = new Set([B.DivSInt32, B.DivUInt32, B.RemSInt32, B.RemUInt32]);
const SLOW_I64 = new Set([B.MulInt64, B.DivSInt64, B.DivUInt64, B.RemSInt64, B.RemUInt64]);

function nodeCost(info) {
  switch (info.id) {
    case B.LoadId: return 2;
    case B.StoreId: return 1;
    case B.CallId: return 3;
    case B.CallIndirectId: return 4;
    case B.BreakId: case B.SwitchId: case B.IfId: case B.SelectId:
    case B.ReturnId: case B.GlobalGetId: case B.GlobalSetId: return 1;
    case B.MemoryCopyId: case B.MemoryFillId: return 10;
    case B.UnaryId: {
      if (info.type === B.f64) return 40;
      if (info.op === B.SqrtFloat32) return 14;
      return 1;
    }
    case B.BinaryId: {
      // The operand type decides the cost (comparisons return i32).
      const lt = B.getExpressionType(info.left);
      if (lt === B.f64) return 40;
      if (info.op === B.DivFloat32) return 14;
      if (DIV_I32.has(info.op)) return 6;
      if (SLOW_I64.has(info.op)) return 20;
      if (lt === B.i64) return 3;
      return 1;
    }
    default: return 0;
  }
}

/** Sum the cost of `expr`, NOT descending into loops; collect loops found. */
function regionCost(expr, loops) {
  if (!expr) return 0;
  const id = B.getExpressionId(expr);
  if (id === B.LoopId) { loops.push(expr); return 0; }
  if (!(id in CHILD_KEYS)) return id === B.GlobalGetId ? 1 : 0; // leaves: const, local.get, nop ...
  const info = B.getExpressionInfo(expr);
  let c = nodeCost(info);
  for (const k of CHILD_KEYS[info.id] || []) {
    const v = info[k];
    if (Array.isArray(v)) for (const e of v) c += regionCost(e, loops);
    else if (v) c += regionCost(v, loops);
  }
  return c;
}

/**
 * @param {Uint8Array} wasm  linked module (before asyncify)
 * @returns {Uint8Array}     instrumented module
 */
export function instrumentCycles(wasm) {
  const m = B.readBinary(wasm);
  m.setFeatures(B.Features.MutableGlobals | B.Features.SignExt | B.Features.BulkMemory | B.Features.NontrappingFPToInt);
  m.addGlobal('sim_cycles', B.f64, true, m.f64.const(0));
  m.addGlobalExport('sim_cycles', 'sim_cycles');
  const bump = (k) => m.global.set('sim_cycles', m.f64.add(m.global.get('sim_cycles', B.f64), m.f64.const(k)));

  const n = m.getNumFunctions();
  for (let i = 0; i < n; i++) {
    const fref = m.getFunctionByIndex(i);
    const f = B.getFunctionInfo(fref);
    if (f.module || !f.body) continue; // imported
    // 1. function body (outside loops)
    const loops = [];
    const k = regionCost(f.body, loops);
    // 2. every loop, including nested ones: charge per iteration
    while (loops.length) {
      const lp = loops.pop();
      const body = B.Loop.getBody(lp);
      const inner = [];
      const lk = regionCost(body, inner);
      loops.push(...inner);
      if (lk > 0) B.Loop.setBody(lp, m.block(null, [bump(lk), body], B.getExpressionType(body)));
    }
    if (k > 0) B.Function.setBody(fref, m.block(null, [bump(k), f.body], B.getExpressionType(f.body)));
  }
  if (!m.validate()) throw new Error('cycle instrumentation produced an invalid module');
  const out = m.emitBinary();
  m.dispose();
  return out;
}
