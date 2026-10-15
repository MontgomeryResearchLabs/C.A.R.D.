/**
 * scene.js — three.js model of the JT business card
 * ==================================================
 * Builds the PCB, the 441 matrix LEDs (with glow sprites driven by the
 * simulated light output), and the main components, all placed from the
 * coordinates in board.json (i.e. straight from the .kicad_pcb).
 *
 * Both faces of the board are painted from artwork.json (artwork.js): the
 * real outline, copper showing through the solder mask, mask openings,
 * and your silkscreen text and logo. Nothing on the board is invented.
 *
 * Coordinates: 1 unit = 1 mm. The card group's local axes are the BOARD
 * axes used by the engine: +x = KiCad right, +y = KiCad up, +z = out of the
 * FRONT (component) side. The LEDs sit on the back (-z).
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makePainter } from './artwork.js';

const LED_GREEN = new THREE.Color(0.25, 1.0, 0.42); // ~520 nm, as rendered

/**
 * @param board     board.json (LED/part placement)
 * @param art       artwork.json (outline, copper, mask openings, silkscreen)
 * @param renderer  for anisotropy + the environment map
 * @param look      { mask, finish } initial solder mask / surface finish
 */
export function buildCard(board, art, renderer, look) {
  // Texture resolution: ~25 px/mm keeps 0.6 mm reference designators
  // legible; capped at 2400 px across to stay friendly to phone GPUs.
  const painter = makePainter(art, { maxPpm: 26, maxPx: 2400 });
  const W = painter.W, H = painter.H, T = board.thickness || 0.6;
  const cx = painter.x0 + W / 2, cy = painter.y0 + H / 2;
  const toXY = (x, y) => [x - cx, -(y - cy)];

  const card = new THREE.Group();

  // ---- PCB: the real Edge.Cuts outline (USB-C slots, coin-cell cutout) ------
  const ring = (flat) => {
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(...toXY(flat[i], flat[i + 1])));
    if (pts[0].distanceTo(pts[pts.length - 1]) < 1e-3) pts.pop();
    return pts;
  };
  const shape = new THREE.Shape(ring(art.outline));
  for (const c of art.cutouts) shape.holes.push(new THREE.Path(ring(c)));
  const pcbGeo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 4 });
  pcbGeo.translate(0, 0, -T / 2);
  // ExtrudeGeometry puts both lids in group 0 (back lid first, then front);
  // split them so each side gets its own painted material.
  const lid = pcbGeo.groups[0], sides = pcbGeo.groups[1];
  pcbGeo.clearGroups();
  pcbGeo.addGroup(lid.start, lid.count / 2, 2);              // back  (z = -T/2)
  pcbGeo.addGroup(lid.start + lid.count / 2, lid.count / 2, 0); // front (z = +T/2)
  pcbGeo.addGroup(sides.start, sides.count, 1);              // edges

  // Each face: colour texture + packed height/roughness/metalness texture,
  // painted from artwork.json. Lid UVs are the shape's (x, y) in mm, so the
  // textures are scaled to span the board.
  const faces = {};
  const aniso = renderer.capabilities.getMaxAnisotropy();
  for (const key of ['F', 'B']) {
    const colorCanvas = document.createElement('canvas');
    const pbrCanvas = document.createElement('canvas');
    const color = new THREE.CanvasTexture(colorCanvas);
    color.colorSpace = THREE.SRGBColorSpace;
    const pbr = new THREE.CanvasTexture(pbrCanvas);
    for (const t of [color, pbr]) {
      t.repeat.set(1 / W, 1 / H);
      t.offset.set(0.5, 0.5);
      t.anisotropy = aniso;
    }
    const mat = new THREE.MeshPhysicalMaterial({
      map: color, roughnessMap: pbr, metalnessMap: pbr, bumpMap: pbr, bumpScale: 0.5,
      roughness: 1, metalness: 1, clearcoat: 0.2, clearcoatRoughness: 0.5, envMapIntensity: 0.8,
    });
    faces[key] = { colorCanvas, pbrCanvas, color, pbr, mat };
  }
  const edge = new THREE.MeshStandardMaterial({ color: 0xa8915c, roughness: 0.85 });
  const pcb = new THREE.Mesh(pcbGeo, [faces.F.mat, edge, faces.B.mat]);
  card.add(pcb);

  /** (Re)paint both faces for a mask colour / finish. */
  function paintFaces(opts) {
    for (const key of ['F', 'B']) {
      const f = faces[key];
      painter.paint(key, 'color', f.colorCanvas, opts);
      painter.paint(key, 'pbr', f.pbrCanvas, opts);
      f.color.needsUpdate = true;
      f.pbr.needsUpdate = true;
    }
  }
  paintFaces(look);
  // Labels use JetBrains Mono from Google Fonts: repaint once it has loaded.
  if (document.fonts && document.fonts.load) {
    document.fonts.load('600 20px "JetBrains Mono"').then(() => paintFaces(look)).catch(() => {});
  }

  // ---- matrix LEDs (back side) ----------------------------------------------
  const n = board.leds.length;
  const ledGeo = new THREE.BoxGeometry(1.6, 0.8, 0.45);
  const ledMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0, envMapIntensity: 0.35 });
  const leds = new THREE.InstancedMesh(ledGeo, ledMat, n);
  const glowTex = radialTexture();
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffffff,
  });
  const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(3.4, 3.4), glowMat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  board.leds.forEach((l, i) => {
    const [x, y] = toXY(l.x, l.y);
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (l.rot * Math.PI) / 180);
    m.compose(new THREE.Vector3(x, y, -T / 2 - 0.25), q, s);
    leds.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(x, y, -T / 2 - 0.55), flip, s);
    glows.setMatrixAt(i, m);
    leds.setColorAt(i, new THREE.Color(0x7d8079));
    glows.setColorAt(i, new THREE.Color(0, 0, 0));
  });
  card.add(leds, glows);

  // ---- front-side parts -------------------------------------------------------
  const ic = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.55 });
  const res = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });
  const cap = new THREE.MeshStandardMaterial({ color: 0xa88454, roughness: 0.55 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8d9198, metalness: 1, roughness: 0.42, envMapIntensity: 0.6 });
  const ind = new THREE.MeshStandardMaterial({ color: 0x3a3b3e, roughness: 0.7 });

  function sizeOf(p) {
    const lib = p.lib;
    if (/QFN-60/.test(lib)) return [7, 7, 0.85, ic];
    if (/LGA-12/.test(lib)) return [2, 2, 1.0, ic];
    if (/USON-8/.test(lib)) return [3, 2, 0.55, ic];
    if (/SO-8/.test(lib)) return [4.9, 3.9, 1.5, ic];
    if (/SOT-23-6/.test(lib)) return [2.9, 1.6, 1.1, ic];
    if (/SOT-23/.test(lib)) return [2.9, 1.3, 1.0, ic];
    if (/3225/.test(lib)) return [3.2, 2.5, 0.8, metal];
    if (/L_pol_2016/.test(lib)) return [2.0, 1.6, 1.0, ind];
    if (/SOD-323/.test(lib)) return [1.7, 1.25, 0.9, ic];
    if (/R_0402/.test(lib)) return [1.0, 0.5, 0.35, res];
    if (/C_0402/.test(lib)) return [1.0, 0.5, 0.5, cap];
    return null;
  }
  const front = T / 2;
  for (const p of board.parts) {
    const [x, y] = toXY(p.x, p.y);
    const z0 = p.side === 'back' ? -T / 2 : front, sgn = p.side === 'back' ? -1 : 1;
    const rot = (p.rot * Math.PI) / 180;
    // Test points and the USB-C paddle are just pads: they come from the
    // painted mask openings, so nothing to model here.
    if (/TestPoint|USB_C_PADDLE|LOGO/.test(p.lib)) continue;
    if (/BatteryHolder/.test(p.lib)) {
      // The coin cell sits IN the board's circular cutout (Edge.Cuts in the
      // BT1 footprint), centred on the board's mid-plane. ~24 mm cell.
      const bt = new THREE.Mesh(new THREE.CylinderGeometry(12.0, 12.0, 3.0, 96), metal);
      bt.rotation.x = Math.PI / 2;
      bt.position.set(x, y, 0);
      card.add(bt);
      continue;
    }
    if (p.ref === 'LED1') {
      const led1 = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.45), new THREE.MeshBasicMaterial({ color: LED_GREEN.clone().multiplyScalar(2.2) }));
      led1.rotation.z = rot;
      led1.position.set(x, y, z0 + 0.25);
      card.add(led1);
      const g = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), glowMat.clone());
      g.material.color = LED_GREEN.clone().multiplyScalar(1.6);
      g.position.set(x, y, z0 + 0.6);
      card.add(g);
      continue;
    }
    const sz = sizeOf(p);
    if (!sz) continue;
    const [w, h, d, mat] = sz;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    body.rotation.z = rot;
    body.position.set(x, y, z0 + sgn * d / 2);
    card.add(body);
  }

  // ---- environment lighting --------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const tmpColor = new THREE.Color();
  const offColor = new THREE.Color(0x7d8079); // unlit water-clear 0603 lens
  return {
    card,
    env,
    size: { W, H, T },
    /** intensities: Float32Array(n), 0 = off, ~1 = full, >1 = blown out */
    setLeds(intens, ghost) {
      for (let i = 0; i < n; i++) {
        const v = intens[i];
        tmpColor.copy(LED_GREEN).multiplyScalar(v * 2.4);
        glows.setColorAt(i, tmpColor);
        tmpColor.copy(offColor).lerp(LED_GREEN, Math.min(1, v * 1.6)).multiplyScalar(1 + v * 2.2);
        if (ghost && ghost[i]) tmpColor.lerp(new THREE.Color(1, 0.35, 0.3), 0.6);
        leds.setColorAt(i, tmpColor);
      }
      glows.instanceColor.needsUpdate = true;
      leds.instanceColor.needsUpdate = true;
    },
    /** opts: { mask: key of MASKS, finish: key of FINISHES } */
    setLook(opts) { look = opts; paintFaces(opts); },
  };
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
