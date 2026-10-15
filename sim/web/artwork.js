/**
 * artwork.js — paint the card's real layers into textures
 * ========================================================
 * Input: board/artwork.json (made by tools/kicad_artwork.py from the PCB).
 * Output, per side ('F' front / 'B' back), two canvases in KiCad's front-view
 * frame (x right, y down, 1 unit = 1 mm before scaling):
 *
 *   color  what you see: solder mask, copper showing through the mask,
 *          silkscreen, mask openings in the surface finish, drill holes
 *   pbr    packed material data for three.js:
 *            R = height (bump map: silk and copper stand proud of the mask)
 *            G = roughness (silk matte, mask satin, finish shiny)
 *            B = metalness (only exposed pads are metal)
 *
 * Both canvases are painted by the same routine with a different palette,
 * so the material maps always line up exactly with the colour map.
 */

/** Solder-mask presets. `cu` = colour of mask over copper (slightly lighter,
 * as on a real board), `silk` = the silkscreen ink normally paired with it. */
export const MASKS = {
  black: { label: 'Matte black', base: '#121314', cu: '#191a1c', silk: '#deded8' },
  green: { label: 'Green', base: '#0e4a28', cu: '#287443', silk: '#e2e2dc' },
  blue: { label: 'Blue', base: '#11366c', cu: '#2a5b9f', silk: '#e2e2dc' },
  red: { label: 'Red', base: '#761515', cu: '#a32e28', silk: '#e2e2dc' },
  purple: { label: 'Purple', base: '#311958', cu: '#523386', silk: '#e2e2dc' },
  yellow: { label: 'Yellow', base: '#c49c16', cu: '#dbb53a', silk: '#141414' },
  white: { label: 'White', base: '#e6e8e4', cu: '#f2f2ee', silk: '#151515' },
};
export const FINISHES = {
  enig: { label: 'ENIG (gold)', color: '#d6b26a' },
  hasl: { label: 'HASL (silver)', color: '#c7cbd0' },
  osp: { label: 'Bare copper (OSP)', color: '#c27744' },
};

const PBR = {
  // height, roughness, metalness packed as rgb(R, G, B)
  base: 'rgb(40,92,0)',
  cu: 'rgb(120,84,0)',
  silk: 'rgb(205,220,0)',
  open: 'rgb(95,52,255)',
  hole: 'rgb(0,240,0)',
  tent: 'rgb(150,92,0)',
};

/**
 * @param {object} art   artwork.json
 * @param {object} res   { maxPpm, maxPx }: pixels per mm, capped so the
 *                       canvas is at most maxPx wide/tall
 * @returns {{x0,y0,W,H,ppm, paint(side, kind, canvas, opts)}}
 */
export function makePainter(art, { maxPpm = 26, maxPx = 2400 } = {}) {
  const o = art.outline;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < o.length; i += 2) {
    x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]);
    y0 = Math.min(y0, o[i + 1]); y1 = Math.max(y1, o[i + 1]);
  }
  const W = x1 - x0, H = y1 - y0;
  const ppm = Math.min(maxPpm, maxPx / Math.max(W, H));

  function ringPath(ctx, flat) {
    ctx.moveTo(flat[0], flat[1]);
    for (let i = 2; i < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
    ctx.closePath();
  }

  /** Pad outline (rect / roundrect / circle / oval) centred at its position. */
  function padPath(ctx, p) {
    const [shape, x, y, w, h, ang, rr] = p;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((-ang * Math.PI) / 180); // KiCad: CCW on screen
    ctx.beginPath();
    if (shape === 'c') ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
    else {
      const r = shape === 'o' ? Math.min(w, h) / 2 : shape === 'rr' ? rr * Math.min(w, h) : 0;
      if (r > 0 && ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, r);
      else ctx.rect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  /**
   * Paint one side.
   * kind: 'color' | 'pbr'
   * opts: { mask: key of MASKS, finish: key of FINISHES }
   */
  function paint(sideKey, kind, canvas, opts) {
    const s = art.sides[sideKey];
    const m = MASKS[opts.mask] || MASKS.black;
    const pal = kind === 'pbr' ? PBR : {
      base: m.base, cu: m.cu, silk: m.silk,
      open: (FINISHES[opts.finish] || FINISHES.enig).color,
      hole: '#0a0a0a', tent: shade(m.cu, -0.12),
    };
    canvas.width = Math.round(W * ppm);
    canvas.height = Math.round(H * ppm);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // background outside the outline: same as mask so mip-mapping at the
    // edges doesn't bleed a dark fringe onto the board
    ctx.fillStyle = pal.base;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ppm, 0, 0, ppm, -x0 * ppm, -y0 * ppm); // now in KiCad mm

    // 1. copper under the mask
    ctx.fillStyle = ctx.strokeStyle = pal.cu;
    for (const z of s.zones) { ctx.beginPath(); ringPath(ctx, z); ctx.fill(); }
    ctx.lineCap = 'round';
    for (const [ax, ay, bx, by, w] of s.tracks) {
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    for (const [x, y, d] of s.vias) { ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2); ctx.fill(); }
    for (const [x, y, r] of s.cu_circles) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    for (const p of s.pads) { padPath(ctx, p); ctx.fill(); }

    // 2. silkscreen
    ctx.fillStyle = ctx.strokeStyle = pal.silk;
    for (const rings of s.silk_polys) {
      ctx.beginPath();
      for (const r of rings) ringPath(ctx, r);
      ctx.fill('evenodd');
    }
    for (const l of s.silk_lines) {
      ctx.lineWidth = l[0];
      ctx.beginPath();
      ctx.moveTo(l[1], l[2]);
      for (let i = 3; i < l.length; i += 2) ctx.lineTo(l[i], l[i + 1]);
      ctx.stroke();
    }
    for (const [x, y, r, w, fill] of s.silk_circles) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      if (fill) ctx.fill(); else { ctx.lineWidth = w; ctx.stroke(); }
    }
    drawLabels(ctx, s.silk_text, pal.silk);

    // 3. mask openings (finish). Drawn after the silk: fabs clip silkscreen
    //    off exposed pads, and so does this.
    ctx.fillStyle = pal.open;
    for (const p of s.openings) { padPath(ctx, p); ctx.fill(); }

    // 4. drills: open holes dark, tented vias as a small dimple
    for (const [x, y, d, tented] of art.holes) {
      ctx.fillStyle = tented ? pal.tent : pal.hole;
      ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  /** Reference designators in KiCad's stroke font, approximated with a
   * thin monospace face. Drawn in pixel space so small text stays crisp. */
  function drawLabels(ctx, labels, color) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = color;
    for (const t of labels) {
      const px = (t.x - x0) * ppm, py = (t.y - y0) * ppm;
      const sizePx = (t.h / 0.72) * ppm; // KiCad size = cap height
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((-t.a * Math.PI) / 180);
      if (t.m) ctx.scale(-1, 1); // back-side text reads correctly from behind
      ctx.font = `${t.w / t.h > 0.18 ? 700 : 500} ${sizePx}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textAlign = t.j.includes('left') ? 'left' : t.j.includes('right') ? 'right' : 'center';
      ctx.textBaseline = t.j.includes('top') ? 'top' : t.j.includes('bottom') ? 'bottom' : 'middle';
      ctx.fillText(t.t, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  return { x0, y0, W, H, ppm, paint };
}

/** Lighten (k > 0) or darken (k < 0) a #rrggbb colour. */
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
