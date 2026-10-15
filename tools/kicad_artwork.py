#!/usr/bin/env python3
"""
kicad_artwork.py — extract the board's VISUAL layers for the 3D view
=====================================================================

    python3 tools/kicad_artwork.py board/JT-Business-Card.kicad_pcb [-o board/artwork.json]

The 3D simulator paints each side of the card from this file, so what you see
is your actual design, not a stand-in:

  outline     Edge.Cuts chained into closed loops: the card outline (with the
              USB-C paddle slots) plus internal cutouts (the coin-cell hole).
              Footprint-level Edge.Cuts are included.
  copper      tracks, zone fills, vias and pads per side. Under solder mask
              these show as a slightly lighter tint, as on a real board.
  mask        pads whose layer list includes F.Mask / B.Mask (or *.Mask):
              the mask OPENINGS, drawn in the surface finish colour.
  silk        F.SilkS / B.SilkS: your text (from KiCad's render cache, so
              the fonts are exact), the logo polygons, footprint outlines,
              and visible reference designators.
  holes       drills (vias, thru-hole pads).

Coordinates stay in KiCad's frame (mm, x right, y DOWN), rounded to 0.01 mm.
Arcs are converted to polylines.
"""
import json
import math
import sys

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from kicad_pcb_extract import parse_sexpr, children, child, prop  # noqa: E402

R = lambda v: round(v, 3)  # noqa: E731
R2 = lambda v: round(v, 2)  # noqa: E731


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def xy(node):
    return float(node[1]), float(node[2])


class Frame:
    """Footprint-local -> board transform. KiCad stores children of a flipped
    (back-side) footprint already mirrored, so only rotation + offset apply.
    KiCad angles are CCW on screen with y pointing down, hence the -angle."""

    def __init__(self, at=None):
        self.x = float(at[1]) if at else 0.0
        self.y = float(at[2]) if at else 0.0
        self.rot = float(at[3]) if at and len(at) > 3 else 0.0
        a = math.radians(-self.rot)
        self.c, self.s = math.cos(a), math.sin(a)

    def __call__(self, px, py):
        return (self.x + px * self.c - py * self.s, self.y + px * self.s + py * self.c)


WORLD = Frame()


def arc_points(start, mid, end, seg_len=0.15):
    """Polyline through a 3-point arc (start -> mid -> end)."""
    (x1, y1), (x2, y2), (x3, y3) = start, mid, end
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-12:
        return [start, end]
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1, a2, a3 = (math.atan2(p[1] - uy, p[0] - ux) for p in (start, mid, end))

    def ccw(a, b):  # angle from a to b going counter-clockwise (in maths sense)
        return (b - a) % (2 * math.pi)
    # choose the sweep direction that passes through mid
    if ccw(a1, a2) < ccw(a1, a3):
        sweep = ccw(a1, a3)
    else:
        sweep = -ccw(a3, a1)
    n = max(4, int(abs(sweep) * r / seg_len))
    return [(ux + r * math.cos(a1 + sweep * i / n), uy + r * math.sin(a1 + sweep * i / n)) for i in range(n + 1)]


def graphic_to_paths(g, f):
    """Any gr_*/fp_* graphic -> (kind, data) in board coordinates.
    kind: 'line' (open polyline), 'poly' (closed rings, filled), 'circle'."""
    kind = g[0].split('_', 1)[1]
    stroke = child(g, 'stroke')
    width = float(child(stroke, 'width')[1]) if stroke and child(stroke, 'width') else \
        float(child(g, 'width')[1]) if child(g, 'width') else 0.12
    fill = child(g, 'fill')
    filled = bool(fill) and fill[1] in ('yes', 'solid')
    if kind == 'line':
        return 'line', width, [f(*xy(child(g, 'start'))), f(*xy(child(g, 'end')))], filled
    if kind == 'arc':
        pts = arc_points(f(*xy(child(g, 'start'))), f(*xy(child(g, 'mid'))), f(*xy(child(g, 'end'))))
        return 'line', width, pts, filled
    if kind == 'rect':
        (x0, y0), (x1, y1) = xy(child(g, 'start')), xy(child(g, 'end'))
        pts = [f(x0, y0), f(x1, y0), f(x1, y1), f(x0, y1), f(x0, y0)]
        return ('poly' if filled else 'line'), width, pts, filled
    if kind == 'circle':
        cx, cy = f(*xy(child(g, 'center')))
        ex, ey = f(*xy(child(g, 'end')))
        return 'circle', width, [(cx, cy, math.hypot(ex - cx, ey - cy))], filled
    if kind == 'poly':
        pts = [f(*xy(p)) for p in children(child(g, 'pts'), 'xy')]
        return ('poly' if filled else 'line'), width, pts + [pts[0]], filled
    return None


# --------------------------------------------------------------------------
# outline: chain Edge.Cuts pieces into closed loops
# --------------------------------------------------------------------------
def chain(pieces, tol=0.02):
    pieces = [list(p) for p in pieces]
    loops = []
    while pieces:
        cur = pieces.pop(0)
        changed = True
        while changed and math.dist(cur[0], cur[-1]) > tol:
            changed = False
            for i, p in enumerate(pieces):
                if math.dist(cur[-1], p[0]) < tol:
                    cur += p[1:]
                elif math.dist(cur[-1], p[-1]) < tol:
                    cur += p[::-1][1:]
                else:
                    continue
                pieces.pop(i)
                changed = True
                break
        loops.append(cur)
    return loops


def area(loop):
    return 0.5 * sum(loop[i][0] * loop[i - 1][1] - loop[i - 1][0] * loop[i][1] for i in range(len(loop)))


# --------------------------------------------------------------------------
# pads
# --------------------------------------------------------------------------
PAD_SHAPES = {'rect': 'r', 'roundrect': 'rr', 'circle': 'c', 'oval': 'o', 'trapezoid': 'r', 'custom': 'r'}


def pad_record(pad, f):
    at = child(pad, 'at')
    x, y = f(float(at[1]), float(at[2]))
    ang = float(at[3]) if len(at) > 3 else 0.0  # pad angle is absolute in KiCad >= 6
    sz = child(pad, 'size')
    w, h = float(sz[1]), float(sz[2])
    rr = child(pad, 'roundrect_rratio')
    margin = child(pad, 'solder_mask_margin')
    m = float(margin[1]) if margin else 0.0
    return [PAD_SHAPES.get(pad[3], 'r'), R(x), R(y), R(w + 2 * m), R(h + 2 * m), R(ang),
            R(float(rr[1])) if rr else 0]


def pad_sides(layers):
    cu, mask = set(), set()
    for L in layers:
        side = {'F': 'F', 'B': 'B', '*': 'FB'}.get(L[0], '')
        if L.endswith('.Cu'):
            cu.update(side)
        elif L.endswith('.Mask'):
            mask.update(side)
    return cu, mask


# --------------------------------------------------------------------------
def main():
    src = sys.argv[1]
    out = sys.argv[sys.argv.index('-o') + 1] if '-o' in sys.argv else 'board/artwork.json'
    root = parse_sexpr(open(src, encoding='utf-8').read())

    side = {s: {'tracks': [], 'zones': [], 'vias': [], 'pads': [], 'openings': [], 'cu_circles': [],
                'silk_lines': [], 'silk_polys': [], 'silk_circles': [], 'silk_text': []} for s in 'FB'}
    holes = []
    edge = []

    def add_silk(s, rec):
        kind, width, pts, filled = rec
        if kind == 'line':
            side[s]['silk_lines'].append([R(width)] + [R(v) for p in pts for v in p])
        elif kind == 'poly':
            side[s]['silk_polys'].append([[R(v) for p in pts for v in p]])
        elif kind == 'circle':
            cx, cy, r = pts[0]
            side[s]['silk_circles'].append([R(cx), R(cy), R(r), R(width), 1 if filled else 0])

    def add_text_cache(s, node):
        """KiCad stores outline-font text as polygons in (render_cache)."""
        rc = child(node, 'render_cache')
        if not rc:
            return False
        for poly in children(rc, 'polygon'):
            rings = [[R(v) for p in children(pts, 'xy') for v in xy(p)] for pts in children(poly, 'pts')]
            side[s]['silk_polys'].append(rings)
        return True

    def add_stroke_text(s, text, at, eff, f, base_rot=0.0):
        """Stroke-font text (reference designators): position/size only; the
        browser draws it with a thin monospace face."""
        font = child(eff, 'font')
        size = child(font, 'size')
        thick = child(font, 'thickness')
        just = child(eff, 'justify') or []
        x, y = f(float(at[1]), float(at[2]))
        ang = float(at[3]) if len(at) > 3 else 0.0
        side[s]['silk_text'].append({
            't': text, 'x': R(x), 'y': R(y), 'a': R(ang), 'h': R(float(size[1])),
            'w': R(float(thick[1])) if thick else 0.15,
            'j': [j for j in just[1:] if j in ('left', 'right', 'top', 'bottom')],
            'm': 'mirror' in just,
        })

    # ---- board-level graphics ----------------------------------------------
    for node in root:
        if not (isinstance(node, list) and node and isinstance(node[0], str)):
            continue
        tag = node[0]
        lay = child(node, 'layer')
        L = lay[1] if lay else ''
        if tag.startswith('gr_') and tag != 'gr_text':
            rec = graphic_to_paths(node, WORLD)
            if not rec:
                continue
            if L == 'Edge.Cuts':
                edge.append(rec[2] if rec[0] != 'circle' else
                            [(rec[2][0][0] + rec[2][0][2] * math.cos(t / 32 * math.tau),
                              rec[2][0][1] + rec[2][0][2] * math.sin(t / 32 * math.tau)) for t in range(33)])
            elif L in ('F.SilkS', 'B.SilkS'):
                add_silk(L[0], rec)
            elif L in ('F.Cu', 'B.Cu') and rec[0] == 'circle':
                cx, cy, r = rec[2][0]
                side[L[0]]['cu_circles'].append([R(cx), R(cy), R(r)])
        elif tag == 'gr_text' and L in ('F.SilkS', 'B.SilkS'):
            if not add_text_cache(L[0], node):
                add_stroke_text(L[0], node[1], child(node, 'at'), child(node, 'effects'), WORLD)
        elif tag == 'segment' and L in ('F.Cu', 'B.Cu'):
            (x1, y1), (x2, y2) = xy(child(node, 'start')), xy(child(node, 'end'))
            side[L[0]]['tracks'].append([R(x1), R(y1), R(x2), R(y2), R(float(child(node, 'width')[1]))])
        elif tag == 'arc' and L in ('F.Cu', 'B.Cu'):
            pts = arc_points(xy(child(node, 'start')), xy(child(node, 'mid')), xy(child(node, 'end')))
            w = float(child(node, 'width')[1])
            for a, b in zip(pts, pts[1:]):
                side[L[0]]['tracks'].append([R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(w)])
        elif tag == 'via':
            x, y = xy(child(node, 'at'))
            d = float(child(node, 'size')[1])
            for s in 'FB':
                side[s]['vias'].append([R(x), R(y), R(d)])
            holes.append([R(x), R(y), R(float(child(node, 'drill')[1])), 1])  # 1 = tented/plated small
        elif tag == 'zone':
            for fp in children(node, 'filled_polygon'):
                zl = child(fp, 'layer')[1]
                if zl in ('F.Cu', 'B.Cu'):
                    side[zl[0]]['zones'].append([R2(v) for p in children(child(fp, 'pts'), 'xy') for v in xy(p)])

    # ---- footprints ----------------------------------------------------------
    for fp in children(root, 'footprint'):
        f = Frame(child(fp, 'at'))
        for g in fp:
            if not (isinstance(g, list) and g and isinstance(g[0], str)):
                continue
            if g[0] in ('fp_line', 'fp_arc', 'fp_rect', 'fp_circle', 'fp_poly'):
                L = child(g, 'layer')[1]
                rec = graphic_to_paths(g, f)
                if not rec:
                    continue
                if L == 'Edge.Cuts':
                    edge.append(rec[2])
                elif L in ('F.SilkS', 'B.SilkS'):
                    add_silk(L[0], rec)
            elif g[0] in ('property', 'fp_text'):
                lay = child(g, 'layer')
                if not lay or lay[1] not in ('F.SilkS', 'B.SilkS'):
                    continue
                hide = child(g, 'hide')
                eff = child(g, 'effects')
                if (hide and hide[1] == 'yes') or 'hide' in g or (eff and 'hide' in eff):
                    continue
                text = g[2] if g[0] == 'property' else g[2]
                if g[0] == 'fp_text' and text == '${REFERENCE}':
                    text = prop(fp, 'Reference') or ''
                if not text or text.startswith('${'):
                    continue
                if not add_text_cache(lay[1][0], g):
                    add_stroke_text(lay[1][0], text, child(g, 'at'), eff, f)
            elif g[0] == 'pad':
                cu, mask = pad_sides(child(g, 'layers')[1:])
                rec = pad_record(g, f)
                for s in cu:
                    side[s]['pads'].append(rec)
                for s in mask:
                    side[s]['openings'].append(rec)
                drill = child(g, 'drill')
                if drill and len(drill) > 1:
                    d = float(drill[1]) if drill[1] != 'oval' else float(drill[2])
                    holes.append([rec[1], rec[2], R(d), 0 if mask else 1])

    # ---- outline loops ---------------------------------------------------------
    loops = chain(edge)
    loops.sort(key=lambda l: -abs(area(l)))
    open_loops = [l for l in loops if math.dist(l[0], l[-1]) > 0.05]
    flat = lambda l: [R(v) for p in l for v in p]  # noqa: E731
    art = {
        'outline': flat(loops[0]),
        'cutouts': [flat(l) for l in loops[1:] if l not in open_loops],
        'sides': side,
        'holes': holes,
        'warnings': [f'Edge.Cuts piece near ({l[0][0]:.2f}, {l[0][1]:.2f}) does not close' for l in open_loops],
    }
    with open(out, 'w') as fh:
        json.dump(art, fh, separators=(',', ':'))
    print(f"wrote {out}: outline {len(loops[0])} pts, {len(art['cutouts'])} cutout(s), "
          + ', '.join(f"{s}: {len(side[s]['tracks'])} tracks, {len(side[s]['zones'])} zone fills, "
                      f"{len(side[s]['openings'])} mask openings, {len(side[s]['silk_polys'])} silk polys, "
                      f"{len(side[s]['silk_lines'])} silk lines, {len(side[s]['silk_text'])} labels" for s in 'FB'))
    for w in art['warnings']:
        print('  WARNING:', w)


if __name__ == '__main__':
    main()
