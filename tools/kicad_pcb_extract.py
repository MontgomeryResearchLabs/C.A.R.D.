#!/usr/bin/env python3
"""
kicad_pcb_extract.py — turn the card's .kicad_pcb into board/board.json
=========================================================================

The simulator needs three things that only the PCB file knows for sure:

  1. The real charlieplex wiring: for each of the 441 matrix LEDs, which
     net is on its ANODE pad and which on its CATHODE pad, plus where the LED
     physically sits (so the 3D view and the firmware's (row, col) agree).
  2. Which GPIO drives each LED net (GPIOn -> 22 ohm resistor -> /LED_ARRAY/Dk).
  3. Where the other parts sit (outline, accelerometer rotation/side,
     RP2350, flash, NFC, battery ...) for the 3D model and the accelerometer
     axis mapping.

Usage:
    python3 tools/kicad_pcb_extract.py path/to/board.kicad_pcb [-o board/board.json]

The parser is a small, dependency-free S-expression reader. KiCad 7/8/9
footprints store pad nets as (net <code> "<name>"); KiCad 9 also adds
pinfunction names, which is how we tell ANODE from CATHODE on the LEDs.
"""
import json
import math
import re
import sys
from collections import defaultdict


# --------------------------------------------------------------------------
# S-expression reader
# --------------------------------------------------------------------------
TOKEN = re.compile(r'\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+')


def parse_sexpr(text):
    """Parse KiCad S-expression text into nested Python lists.
    Strings keep their content (quotes removed); atoms stay as str."""
    stack = [[]]
    for m in TOKEN.finditer(text):
        tok = m.group(0)
        if tok == '(':
            stack.append([])
        elif tok == ')':
            node = stack.pop()
            stack[-1].append(node)
        elif tok[0] == '"':
            stack[-1].append(tok[1:-1].replace('\\"', '"'))
        else:
            stack[-1].append(tok)
    return stack[0][0]


def children(node, name):
    """All direct child lists whose head is `name`."""
    return [c for c in node if isinstance(c, list) and c and c[0] == name]


def child(node, name):
    c = children(node, name)
    return c[0] if c else None


def prop(fp, key):
    for p in children(fp, 'property'):
        if p[1] == key:
            return p[2]
    return None


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------
def pad_world_xy(fp_at, pad_at):
    """KiCad stores pad positions relative to the footprint, rotated by the
    footprint angle. Note KiCad's Y axis points DOWN and angles are CCW as
    seen on screen, so the rotation uses -angle in maths convention."""
    fx, fy = float(fp_at[1]), float(fp_at[2])
    frot = float(fp_at[3]) if len(fp_at) > 3 else 0.0
    px, py = float(pad_at[1]), float(pad_at[2])
    a = math.radians(-frot)
    return (fx + px * math.cos(a) - py * math.sin(a),
            fy + px * math.sin(a) + py * math.cos(a))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[sys.argv.index('-o') + 1] if '-o' in sys.argv else 'board/board.json'
    root = parse_sexpr(open(src, encoding='utf-8').read())

    # ---- footprints ---------------------------------------------------------
    parts = []
    for fp in children(root, 'footprint'):
        at = child(fp, 'at')
        layer = child(fp, 'layer')[1]
        ref = prop(fp, 'Reference') or '?'
        pads = []
        for pad in children(fp, 'pad'):
            net = child(pad, 'net')
            pf = child(pad, 'pinfunction')
            pads.append({
                'num': pad[1],
                'net': net[2] if net and len(net) > 2 else (net[1] if net else ''),
                'fn': pf[1] if pf else '',
                'xy': pad_world_xy(at, child(pad, 'at')),
            })
        parts.append({
            'ref': ref,
            'value': prop(fp, 'Value') or '',
            'lib': fp[1],
            'side': 'back' if layer.startswith('B.') else 'front',
            'x': float(at[1]), 'y': float(at[2]),
            'rot': float(at[3]) if len(at) > 3 else 0.0,
            'pads': pads,
        })
    by_ref = {p['ref']: p for p in parts}

    # ---- board outline (Edge.Cuts bounding box) -----------------------------
    xs, ys = [], []
    for kind in ('gr_line', 'gr_rect', 'gr_arc', 'gr_poly'):
        for g in children(root, kind):
            lay = child(g, 'layer')
            if not lay or lay[1] != 'Edge.Cuts':
                continue
            for key in ('start', 'end', 'mid'):
                c = child(g, key)
                if c:
                    xs.append(float(c[1])); ys.append(float(c[2]))
            pts = child(g, 'pts')
            if pts:
                for xy in children(pts, 'xy'):
                    xs.append(float(xy[1])); ys.append(float(xy[2]))
    outline = {'x0': min(xs), 'y0': min(ys), 'x1': max(xs), 'y1': max(ys)}
    # corner radius guess from arcs, if any
    arcs = [g for g in children(root, 'gr_arc') if child(g, 'layer')[1] == 'Edge.Cuts']
    radius = 0.0
    if arcs:
        a = arcs[0]
        s, m = child(a, 'start'), child(a, 'mid')
        e = child(a, 'end')
        # radius of circle through three points
        (x1, y1), (x2, y2), (x3, y3) = [(float(p[1]), float(p[2])) for p in (s, m, e)]
        d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
        if abs(d) > 1e-9:
            ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
            uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
            radius = math.hypot(x1 - ux, y1 - uy)
    outline['corner_radius'] = round(radius, 3)

    # ---- GPIO -> LED net (through the series resistors) --------------------
    gpio_of_net = {}
    for p in parts:
        if not p['ref'].startswith('R') or len(p['pads']) != 2:
            continue
        nets = [pd['net'] for pd in p['pads']]
        g = [n for n in nets if re.search(r'U1-GPIO(\d+)\)', n)]
        d = [n for n in nets if n.startswith('/LED_ARRAY/D')]
        if g and d:
            gpio = int(re.search(r'GPIO(\d+)', g[0]).group(1))
            gpio_of_net[d[0]] = {'gpio': gpio, 'resistor': p['ref'], 'ohms': p['value']}

    # ---- matrix LEDs ---------------------------------------------------------
    leds = []
    for p in parts:
        # A matrix LED is a 2-pad diode footprint whose pads are both on
        # /LED_ARRAY/Dk nets (this excludes the 22 series resistors, which
        # have one GPIO-side pad, and LED1, the power indicator).
        if len(p['pads']) != 2 or not all(pd['net'].startswith('/LED_ARRAY/D') for pd in p['pads']):
            continue
        # Pin function names come from the symbol: K/A (KiCad Device:LED) or
        # CATHODE/ANODE (WE symbol). Fall back to pad numbers 1=K, 2=A.
        nets = {}
        for pd in p['pads']:
            fn = pd['fn'].upper()
            key = 'K' if fn in ('K', 'CATHODE') else 'A' if fn in ('A', 'ANODE') else pd['num']
            nets[key] = pd['net']
        an = nets.get('A') or nets.get('2')
        ca = nets.get('K') or nets.get('1')
        leds.append({'ref': p['ref'], 'x': p['x'], 'y': p['y'], 'rot': p['rot'],
                     'side': p['side'], 'anode_net': an, 'cathode_net': ca})

    # Sort into a grid: rows by Y (top of card = row 0), cols by X.
    def cluster(vals, tol=0.3):
        vals = sorted(vals)
        groups = [[vals[0]]]
        for v in vals[1:]:
            (groups[-1].append(v) if v - groups[-1][-1] < tol else groups.append([v]))
        return [sum(g) / len(g) for g in groups]
    row_ys = cluster([l['y'] for l in leds])
    col_xs = cluster([l['x'] for l in leds])
    for l in leds:
        l['row'] = min(range(len(row_ys)), key=lambda i: abs(row_ys[i] - l['y']))
        l['col'] = min(range(len(col_xs)), key=lambda i: abs(col_xs[i] - l['x']))
        l['anode_gpio'] = gpio_of_net.get(l['anode_net'], {}).get('gpio')
        l['cathode_gpio'] = gpio_of_net.get(l['cathode_net'], {}).get('gpio')

    # ---- sanity checks -----------------------------------------------------
    issues = []
    seen = defaultdict(list)
    for l in leds:
        seen[(l['anode_gpio'], l['cathode_gpio'])].append(l['ref'])
        if l['anode_gpio'] is None or l['cathode_gpio'] is None:
            issues.append(f"{l['ref']}: net not driven by a GPIO ({l['anode_net']} / {l['cathode_net']})")
        elif l['anode_gpio'] == l['cathode_gpio']:
            issues.append(f"{l['ref']}: anode and cathode on the same net — LED can never light")
    for k, refs in seen.items():
        if len(refs) > 1:
            issues.append(f"LEDs {', '.join(refs)} share pin pair {k} — they always light together")
    cells = defaultdict(list)
    for l in leds:
        cells[(l['row'], l['col'])].append(l['ref'])
    for k, refs in cells.items():
        if len(refs) > 1:
            issues.append(f"grid cell {k} has several LEDs: {refs}")

    def brief(ref):
        p = by_ref.get(ref)
        if not p:
            return None
        return {k: p[k] for k in ('ref', 'value', 'side', 'x', 'y', 'rot', 'lib')}

    others = [brief(p['ref']) for p in parts
              if p['ref'] not in {l['ref'] for l in leds}]

    board = {
        'source': src.split('/')[-1],
        'outline_mm': outline,
        'led_grid': {'rows': len(row_ys), 'cols': len(col_xs),
                     'row_y_mm': [round(v, 3) for v in row_ys],
                     'col_x_mm': [round(v, 3) for v in col_xs]},
        'led_nets': {k: v for k, v in sorted(gpio_of_net.items(),
                                             key=lambda kv: int(kv[0].split('D')[-1]))},
        'leds': sorted(leds, key=lambda l: (l['row'], l['col'])),
        'accelerometer': brief('U4'),
        'parts': others,
        'extract_issues': issues,
    }
    with open(out, 'w') as f:
        json.dump(board, f, indent=1)

    # ---- optional: C header for firmware -------------------------------------
    # Coordinates in the header are DISPLAY coordinates: as seen by a person
    # looking at the LED face of the card, x to the right, y downwards. The
    # LEDs are on the back copper, so that view is mirrored left-right
    # relative to KiCad's (front) view: x = (cols-1) - col.
    if '--header' in sys.argv:
        hpath = sys.argv[sys.argv.index('--header') + 1]
        R, C = len(row_ys), len(col_xs)
        back = all(l['side'] == 'back' for l in leds)
        an = [[0] * C for _ in range(R)]
        ca = [[0] * C for _ in range(R)]
        for l in leds:
            x = (C - 1 - l['col']) if back else l['col']
            an[l['row']][x] = l['anode_gpio']
            ca[l['row']][x] = l['cathode_gpio']
        def table(name, t):
            rows = ',\n'.join('    {' + ', '.join(f'{v:2d}' for v in r) + '}' for r in t)
            return f'static const uint8_t {name}[LED_ROWS][LED_COLS] = {{\n{rows}\n}};\n'
        with open(hpath, 'w') as f:
            f.write(f'''/*
 * led_map.h — GENERATED by tools/kicad_pcb_extract.py from {board['source']}
 * DO NOT EDIT BY HAND: re-run the extractor after changing the PCB.
 *
 * LED_ANODE[y][x] / LED_CATHODE[y][x] give the RP2350 GPIO numbers wired to
 * the anode / cathode of the LED at display position (x, y). Display
 * coordinates are as seen looking at the LED face: x -> right, y -> down.
 * The LEDs are on the {'back' if back else 'front'} copper, so x is mirrored
 * relative to KiCad's front view.
 *
 * To light LED (x, y): drive LED_ANODE high, LED_CATHODE low, leave every
 * other LED pin as a high-impedance input.
 */
#ifndef LED_MAP_H
#define LED_MAP_H
#include <stdint.h>
#define LED_ROWS {R}
#define LED_COLS {C}
#define LED_PIN_COUNT {len(gpio_of_net)}
/* bit n set = GPIOn is a charlieplex line */
#define LED_PIN_MASK 0x{sum(1 << v['gpio'] for v in gpio_of_net.values()):08x}u
{table('LED_ANODE', an)}
{table('LED_CATHODE', ca)}
#endif
''')
        print('wrote', hpath)
    print(f"wrote {out}: {len(leds)} matrix LEDs in {len(row_ys)}x{len(col_xs)}, "
          f"{len(gpio_of_net)} LED nets, outline {outline}")
    for i in issues[:20]:
        print('  ISSUE:', i)


if __name__ == '__main__':
    main()
