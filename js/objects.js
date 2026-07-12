// Parametric scene objects. Every object descriptor is
//   { id, type, name, params: {...} }
// buildObject() turns one into { group: THREE.Group, faces: [...] } where faces are
// the PV-candidate surfaces (world-space planar polygons) used by the analysis.
//
// World convention: X = east, Y = up, Z = south. `rot` params are compass degrees
// (clockwise from north seen from above).

import * as THREE from 'three';

const RAD = Math.PI / 180;

// ---------- parameter schema helpers ----------
const num = (key, label, min, max, step, def, showIf) => ({ kind: 'number', key, label, min, max, step, def, showIf });
const sel = (key, label, options, def, showIf) => ({ kind: 'select', key, label, options, def, showIf });
const bool = (key, label, def, showIf) => ({ kind: 'boolean', key, label, def, showIf });

const POS = [
  num('x', 'Position east–west (m)', -150, 150, 0.1, 0),
  num('z', 'Position north–south (m)', -150, 150, 0.1, 0),
  num('rot', 'Rotation (° cw, negative = ccw)', -360, 360, 1, 0),
];

const pitched = (p) => p.roofType === 'gable' || p.roofType === 'hip';
const isShed = (p) => p.roofType === 'shed';

export const OBJECT_TYPES = {
  building: {
    label: 'Building', icon: '🏠',
    params: [
      num('w', 'Width E–W (m)', 2, 60, 0.1, 10),
      num('d', 'Depth N–S (m)', 2, 60, 0.1, 8),
      num('eave', 'Eave height (m)', 1, 30, 0.1, 5.5),
      sel('roofType', 'Roof type', ['gable', 'hip', 'shed', 'flat'], 'gable'),
      num('pitch', 'Roof pitch (°)', 3, 75, 1, 35, (p) => p.roofType !== 'flat'),
      sel('ridgeAxis', 'Ridge along', ['x', 'z'], 'x', pitched),
      sel('lowSide', 'Low eave side', ['z+', 'z-', 'x+', 'x-'], 'z+', isShed),
      num('overhang', 'Roof overhang (m)', 0, 2, 0.05, 0.4, (p) => p.roofType !== 'flat'),
      bool('analyze', 'Analyze roof for PV', true),
      ...POS,
    ],
  },
  tree: {
    label: 'Tree', icon: '🌳',
    params: [
      sel('variety', 'Variety', ['broadleaf', 'conifer'], 'broadleaf'),
      num('height', 'Total height (m)', 1, 40, 0.5, 10),
      num('trunkHeight', 'Trunk height (m)', 0.5, 20, 0.5, 2.5),
      num('canopyDiameter', 'Canopy Ø (m)', 0.5, 25, 0.5, 7),
      num('tSummer', 'Light through canopy, summer', 0, 1, 0.05, 0.15),
      num('tWinter', 'Light through canopy, winter', 0, 1, 0.05, 0.55),
      ...POS,
    ],
  },
  hedge: {
    label: 'Hedge / shrubs', icon: '🌿',
    params: [
      num('w', 'Length (m)', 0.5, 50, 0.5, 6),
      num('d', 'Thickness (m)', 0.3, 10, 0.1, 1),
      num('h', 'Height (m)', 0.3, 8, 0.1, 2),
      num('tSummer', 'Light through, summer', 0, 1, 0.05, 0.1),
      num('tWinter', 'Light through, winter', 0, 1, 0.05, 0.3),
      ...POS,
    ],
  },
  terrace: {
    label: 'Terrace', icon: '▦',
    params: [
      num('w', 'Width (m)', 1, 30, 0.1, 5),
      num('d', 'Depth (m)', 1, 30, 0.1, 4),
      bool('analyze', 'Analyze surface for PV', false),
      ...POS,
    ],
  },
  pergola: {
    label: 'Roofed terrace', icon: '⛱',
    params: [
      num('w', 'Width (m)', 1, 20, 0.1, 4),
      num('d', 'Depth (m)', 1, 20, 0.1, 3),
      num('h', 'Post height (m)', 1.8, 6, 0.05, 2.5),
      num('pitch', 'Roof pitch (°)', 0, 30, 1, 8),
      bool('analyze', 'Analyze roof for PV', true),
      ...POS,
    ],
  },
  balcony: {
    label: 'Balcony', icon: '🏗',
    params: [
      num('w', 'Width (m)', 1, 15, 0.1, 4),
      num('d', 'Depth (m)', 0.6, 5, 0.1, 1.6),
      num('floorHeight', 'Floor height (m)', 1, 25, 0.1, 3.1),
      num('railingHeight', 'Railing height (m)', 0.8, 1.4, 0.05, 1.0),
      bool('analyzeRailing', 'Analyze railing (balcony PV)', true),
      ...POS,
    ],
  },
  chimney: {
    label: 'Chimney', icon: '🧱',
    params: [
      num('w', 'Width (m)', 0.2, 3, 0.05, 0.5),
      num('d', 'Depth (m)', 0.2, 3, 0.05, 0.5),
      num('h', 'Height above base (m)', 0.3, 6, 0.1, 1.6),
      ...POS,
    ],
  },
  panel: {
    label: 'Free PV panel', icon: '⬛',
    params: [
      num('w', 'Width (m)', 0.5, 30, 0.1, 2),
      num('len', 'Panel length (m)', 0.5, 20, 0.1, 1.2),
      num('tilt', 'Tilt from horizontal (°)', 0, 90, 1, 35),
      num('baseHeight', 'Base height (m)', 0, 30, 0.1, 0.3),
      bool('analyze', 'Analyze', true),
      ...POS,
    ],
  },
};

export function defaultParams(type) {
  const p = {};
  for (const def of OBJECT_TYPES[type].params) p[def.key] = def.def;
  return p;
}

let idCounter = 1;

// After loading a saved scene, push the id counter past every existing id.
export function ensureIdCounterAbove(objects) {
  for (const o of objects) {
    const n = parseInt(String(o.id).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n >= idCounter) idCounter = n + 1;
  }
}

export function newObject(type, name, overrides = {}) {
  return {
    id: 'o' + idCounter++,
    type,
    name: name || OBJECT_TYPES[type].label,
    params: { ...defaultParams(type), ...overrides },
  };
}

export function compass8(az) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

// ---------- geometry helpers ----------
class TriBuilder {
  constructor() { this.pos = []; }
  tri(a, b, c) { this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  poly(pts) { for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1]); }
  box(cx, cy, cz, w, h, d) {
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const v = (x, y, z) => new THREE.Vector3(x, y, z);
    this.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)); // +z
    this.quad(v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)); // -z
    this.quad(v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)); // +x
    this.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)); // -x
    this.quad(v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0)); // +y
    this.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)); // -y
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    return g;
  }
  get isEmpty() { return this.pos.length === 0; }
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, ...opts,
  });
}

function polygonArea(pts) {
  let a = new THREE.Vector3();
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  for (let i = 1; i < pts.length - 1; i++) {
    t1.subVectors(pts[i], pts[0]);
    t2.subVectors(pts[i + 1], pts[0]);
    a.add(t1.clone().cross(t2));
  }
  return a.length() / 2;
}

function polygonNormal(pts) {
  const n = new THREE.Vector3();
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  for (let i = 1; i < pts.length - 1; i++) {
    t1.subVectors(pts[i], pts[0]);
    t2.subVectors(pts[i + 1], pts[0]);
    n.add(t1.clone().cross(t2));
  }
  return n.normalize();
}

export function normalToOrientation(n) {
  const tilt = Math.acos(Math.min(1, Math.max(-1, n.y))) / RAD;
  let az = Math.atan2(n.x, -n.z) / RAD;
  az = ((az % 360) + 360) % 360;
  return { tilt, az };
}

function faceLabel(desc, n, suffix = '') {
  const { tilt, az } = normalToOrientation(n);
  const dir = tilt < 3 ? 'flat' : `${compass8(az)} ${Math.round(tilt)}°`;
  return `${desc.name} — ${suffix || 'roof'} ${dir}`;
}

// ---------- per-type builders (local coords; transform applied at the end) ----------

function buildBuildingLocal(p) {
  const walls = new TriBuilder();
  const roof = new TriBuilder();
  const facePolys = [];
  const v = (x, y, z) => new THREE.Vector3(x, y, z);

  // Canonical construction: gable/hip ridge along x, shed low side +z.
  // Other axes are handled by swapping footprint dims and pre-rotating (yaw).
  let w = p.w, d = p.d, yaw = 0;
  if ((pitched(p) && p.ridgeAxis === 'z')) { w = p.d; d = p.w; yaw = Math.PI / 2; }
  if (isShed(p)) {
    if (p.lowSide === 'z-') yaw = Math.PI;
    else if (p.lowSide === 'x+') { w = p.d; d = p.w; yaw = -Math.PI / 2; }
    else if (p.lowSide === 'x-') { w = p.d; d = p.w; yaw = Math.PI / 2; }
  }
  const hw = w / 2, hd = d / 2, e = p.eave;
  const tan = Math.tan((p.pitch || 0) * RAD);
  const o = p.roofType === 'flat' ? 0 : p.overhang;
  const X = hw + o, Zo = hd + o;
  const eY = e - o * tan;

  if (p.roofType === 'flat') {
    walls.box(0, e / 2, 0, w, e, d);
    facePolys.push({ poly: [v(-hw, e, -hd), v(-hw, e, hd), v(hw, e, hd), v(hw, e, -hd)], suffix: 'flat roof' });
  } else if (p.roofType === 'gable') {
    const rH = e + hd * tan;
    walls.box(0, e / 2, 0, w, e, d);
    walls.tri(v(hw, e, hd), v(hw, e, -hd), v(hw, rH, 0));
    walls.tri(v(-hw, e, -hd), v(-hw, e, hd), v(-hw, rH, 0));
    const south = [v(X, rH, 0), v(-X, rH, 0), v(-X, eY, Zo), v(X, eY, Zo)];
    const north = [v(-X, rH, 0), v(X, rH, 0), v(X, eY, -Zo), v(-X, eY, -Zo)];
    roof.poly(south); roof.poly(north);
    facePolys.push({ poly: south }, { poly: north });
  } else if (p.roofType === 'hip') {
    const inset = Math.min(hw, hd);
    const aH = e + inset * tan;
    const rhl = hw - inset; // ridge half length (0 => pyramid)
    const R1 = v(-rhl, aH, 0), R2 = v(rhl, aH, 0);
    walls.box(0, e / 2, 0, w, e, d);
    const eSE = v(X, eY, Zo), eSW = v(-X, eY, Zo), eNE = v(X, eY, -Zo), eNW = v(-X, eY, -Zo);
    const south = [R2, R1, eSW, eSE];
    const north = [R1, R2, eNE, eNW];
    const east = [R2, eSE, eNE];
    const west = [R1, eNW, eSW];
    for (const f of [south, north, east, west]) { roof.poly(f); facePolys.push({ poly: f }); }
  } else if (p.roofType === 'shed') {
    const yLow = eY, yHigh = e + (d + o) * tan;
    // walls: low wall (z+) height e, high wall (z-) height e + d*tan, sides trapezoid
    walls.quad(v(-hw, 0, hd), v(hw, 0, hd), v(hw, e, hd), v(-hw, e, hd));
    walls.quad(v(hw, 0, -hd), v(-hw, 0, -hd), v(-hw, e + d * tan, -hd), v(hw, e + d * tan, -hd));
    walls.quad(v(hw, 0, hd), v(hw, 0, -hd), v(hw, e + d * tan, -hd), v(hw, e, hd));
    walls.quad(v(-hw, 0, -hd), v(-hw, 0, hd), v(-hw, e, hd), v(-hw, e + d * tan, -hd));
    const face = [v(X, yHigh, -Zo), v(-X, yHigh, -Zo), v(-X, yLow, Zo), v(X, yLow, Zo)];
    roof.poly(face);
    facePolys.push({ poly: face });
  }

  // pre-rotate canonical geometry
  if (yaw !== 0) {
    const rot = new THREE.Matrix4().makeRotationY(yaw);
    const apply = (tb) => { for (let i = 0; i < tb.pos.length; i += 3) { const vv = new THREE.Vector3(tb.pos[i], tb.pos[i + 1], tb.pos[i + 2]).applyMatrix4(rot); tb.pos[i] = vv.x; tb.pos[i + 1] = vv.y; tb.pos[i + 2] = vv.z; } };
    apply(walls); apply(roof);
    for (const f of facePolys) f.poly = f.poly.map((pt) => pt.clone().applyMatrix4(rot));
  }

  const wallColor = p.analyze ? 0xcfc8b8 : 0x8f8a83;
  const roofColor = p.analyze ? 0xa05a4a : 0x6b6560;
  const meshes = [
    { builder: walls, material: mat(wallColor), name: 'walls' },
    { builder: roof, material: mat(roofColor), name: 'roof' },
  ];
  return { meshes, facePolys: p.analyze ? facePolys : [] };
}

function buildTreeLocal(p) {
  const group = [];
  const trunkH = Math.min(p.trunkHeight, p.height - 0.5);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, trunkH, 8), mat(0x6b4a2f));
  trunk.position.y = trunkH / 2;
  group.push({ mesh: trunk, name: 'trunk' });
  const canopyH = p.height - trunkH;
  let canopy;
  if (p.variety === 'conifer') {
    canopy = new THREE.Mesh(new THREE.ConeGeometry(p.canopyDiameter / 2, canopyH, 10), mat(0x2f5a35));
    canopy.position.y = trunkH + canopyH / 2;
  } else {
    canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 9), mat(0x4a7a3a));
    canopy.scale.set(p.canopyDiameter / 2, canopyH / 2, p.canopyDiameter / 2);
    canopy.position.y = trunkH + canopyH / 2;
  }
  canopy.userData.transmittance = { summer: p.tSummer, winter: p.tWinter };
  group.push({ mesh: canopy, name: 'canopy' });
  return group;
}

function buildPergolaLocal(p) {
  const wood = new TriBuilder();
  const hw = p.w / 2, hd = p.d / 2;
  const tan = Math.tan((p.pitch || 0) * RAD);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * (hw - 0.1), pz = sz * (hd - 0.1);
    const hAt = p.h + (p.pitch ? tan * (hd - pz) : 0);
    wood.box(px, hAt / 2, pz, 0.12, hAt, 0.12);
  }
  const O = 0.15; // roof plate overhang beyond the posts; back edge (z-) is the high side
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const roofPoly = [v(hw + O, p.h + tan * (2 * hd + 2 * O), -(hd + O)), v(-(hw + O), p.h + tan * (2 * hd + 2 * O), -(hd + O)), v(-(hw + O), p.h, hd + O), v(hw + O, p.h, hd + O)];
  const roof = new TriBuilder();
  roof.poly(roofPoly);
  return {
    meshes: [
      { builder: wood, material: mat(0x8a6a4a), name: 'posts' },
      { builder: roof, material: mat(0x7f7a72), name: 'roof' },
    ],
    facePolys: p.analyze ? [{ poly: roofPoly, suffix: 'pergola roof' }] : [],
  };
}

function buildBalconyLocal(p) {
  const hw = p.w / 2, hd = p.d / 2;
  const slab = new TriBuilder();
  slab.box(0, p.floorHeight - 0.07, 0, p.w, 0.14, p.d);
  const rail = new TriBuilder();
  const rTop = p.floorHeight + p.railingHeight;
  rail.box(0, (p.floorHeight + rTop) / 2, hd - 0.03, p.w, p.railingHeight, 0.06);
  rail.box(-hw + 0.03, (p.floorHeight + rTop) / 2, 0, 0.06, p.railingHeight, p.d - 0.12);
  rail.box(hw - 0.03, (p.floorHeight + rTop) / 2, 0, 0.06, p.railingHeight, p.d - 0.12);
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const railPoly = [v(-hw, p.floorHeight, hd), v(hw, p.floorHeight, hd), v(hw, rTop, hd), v(-hw, rTop, hd)];
  return {
    meshes: [
      { builder: slab, material: mat(0xb5b0a6), name: 'floor' },
      { builder: rail, material: mat(0x77736b), name: 'railing' },
    ],
    facePolys: p.analyzeRailing ? [{ poly: railPoly, suffix: 'railing' }] : [],
  };
}

function buildPanelLocal(p) {
  const tb = new TriBuilder();
  tb.box(0, 0, 0, p.w, 0.06, p.len);
  const rot = new THREE.Matrix4().makeRotationX(p.tilt * RAD);
  let minY = Infinity;
  for (let i = 0; i < tb.pos.length; i += 3) {
    const vv = new THREE.Vector3(tb.pos[i], tb.pos[i + 1], tb.pos[i + 2]).applyMatrix4(rot);
    tb.pos[i] = vv.x; tb.pos[i + 1] = vv.y; tb.pos[i + 2] = vv.z;
    minY = Math.min(minY, vv.y);
  }
  const lift = p.baseHeight - minY;
  for (let i = 1; i < tb.pos.length; i += 3) tb.pos[i] += lift;
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  const top = [v(-p.w / 2, 0.03, -p.len / 2), v(-p.w / 2, 0.03, p.len / 2), v(p.w / 2, 0.03, p.len / 2), v(p.w / 2, 0.03, -p.len / 2)]
    .map((pt) => { const q = pt.applyMatrix4(rot); q.y += lift; return q; });
  // ensure the analysis polygon's normal points away from the ground
  if (polygonNormal(top).y < 0) top.reverse();
  return {
    meshes: [{ builder: tb, material: mat(0x1c2b4a, { roughness: 0.4 }), name: 'panel' }],
    facePolys: p.analyze ? [{ poly: top, suffix: 'panel' }] : [],
  };
}

// ---------- main entry ----------
// ctx: { baseY } — used by chimneys (main raycasts the roof below and passes it in)
export function buildObject(desc, ctx = {}) {
  const p = desc.params;
  const group = new THREE.Group();
  group.name = desc.name;
  group.userData.objId = desc.id;
  let result = { meshes: [], facePolys: [] };
  let simpleMeshes = null;

  switch (desc.type) {
    case 'building': result = buildBuildingLocal(p); break;
    case 'pergola': result = buildPergolaLocal(p); break;
    case 'balcony': result = buildBalconyLocal(p); break;
    case 'panel': result = buildPanelLocal(p); break;
    case 'tree': simpleMeshes = buildTreeLocal(p); break;
    case 'hedge': {
      const tb = new TriBuilder();
      tb.box(0, p.h / 2, 0, p.w, p.h, p.d);
      result.meshes = [{ builder: tb, material: mat(0x46603a), name: 'hedge' }];
      break;
    }
    case 'terrace': {
      const tb = new TriBuilder();
      tb.box(0, 0.06, 0, p.w, 0.12, p.d);
      result.meshes = [{ builder: tb, material: mat(0x9b968c), name: 'slab' }];
      const v = (x, y, z) => new THREE.Vector3(x, y, z);
      if (p.analyze) result.facePolys = [{ poly: [v(-p.w / 2, 0.12, -p.d / 2), v(-p.w / 2, 0.12, p.d / 2), v(p.w / 2, 0.12, p.d / 2), v(p.w / 2, 0.12, -p.d / 2)], suffix: 'terrace' }];
      break;
    }
    case 'chimney': {
      const tb = new TriBuilder();
      const baseY = ctx.baseY ?? 0;
      tb.box(0, baseY + p.h / 2, 0, p.w, p.h, p.d);
      result.meshes = [{ builder: tb, material: mat(0x915245), name: 'chimney' }];
      break;
    }
  }

  if (simpleMeshes) {
    for (const { mesh, name } of simpleMeshes) {
      mesh.name = name;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.objId = desc.id;
      group.add(mesh);
    }
  }
  for (const { builder, material, name } of result.meshes) {
    if (builder.isEmpty) continue;
    const mesh = new THREE.Mesh(builder.geometry(), material);
    mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.objId = desc.id;
    if (desc.type === 'hedge') mesh.userData.transmittance = { summer: p.tSummer, winter: p.tWinter };
    group.add(mesh);
  }

  // hedges attenuate light in the analysis (see userData above); everything else is opaque

  const rotY = -(p.rot || 0) * RAD;
  group.rotation.y = rotY;
  group.position.set(p.x || 0, 0, p.z || 0);

  // world-space analysis faces (same transform as the group)
  const euler = new THREE.Euler(0, rotY, 0);
  const offset = new THREE.Vector3(p.x || 0, 0, p.z || 0);
  const faces = result.facePolys.map((f, i) => {
    const poly = f.poly.map((pt) => pt.clone().applyEuler(euler).add(offset));
    const normal = polygonNormal(poly);
    const { tilt, az } = normalToOrientation(normal);
    return {
      id: `${desc.id}:${i}`,
      objId: desc.id,
      label: faceLabel(desc, normal, f.suffix),
      kind: f.suffix || 'roof',
      poly, normal,
      area: polygonArea(poly),
      tilt, az,
    };
  });

  return { group, faces };
}

// ---------- demo scene: a typical Stuttgart plot ----------
export function createDefaultScene() {
  idCounter = 1;
  return [
    newObject('building', 'My house', { w: 11, d: 9, eave: 5.8, roofType: 'gable', pitch: 38, ridgeAxis: 'x', overhang: 0.4, x: 0, z: 0, rot: 0, analyze: true }),
    newObject('building', 'Garage', { w: 6, d: 3.5, eave: 2.8, roofType: 'flat', x: -8.6, z: 2.5, rot: 0, analyze: true }),
    newObject('building', 'Neighbor east', { w: 12, d: 9, eave: 6, roofType: 'gable', pitch: 35, ridgeAxis: 'x', x: 18, z: 2, rot: 15, analyze: false }),
    newObject('building', 'Neighbor south-west', { w: 10, d: 8, eave: 5.5, roofType: 'hip', pitch: 30, x: -15, z: 13, rot: 0, analyze: false }),
    newObject('chimney', 'Chimney', { w: 0.5, d: 0.5, h: 1.4, x: 3, z: -1.2 }),
    newObject('balcony', 'South balcony', { w: 4, d: 1.6, floorHeight: 3.1, x: 1.5, z: 5.3, rot: 0, analyzeRailing: true }),
    newObject('terrace', 'Terrace', { w: 5, d: 4, x: 3, z: 7.5, analyze: false }),
    newObject('pergola', 'Pergola', { w: 4, d: 3, h: 2.5, pitch: 8, x: -3.5, z: 7, analyze: true }),
    newObject('tree', 'Old maple', { variety: 'broadleaf', height: 12, trunkHeight: 3, canopyDiameter: 9, x: 8, z: 10 }),
    newObject('tree', 'Spruce', { variety: 'conifer', height: 15, trunkHeight: 2, canopyDiameter: 6, tSummer: 0.1, tWinter: 0.1, x: -12, z: -6 }),
    newObject('tree', 'Apple tree', { variety: 'broadleaf', height: 6, trunkHeight: 1.8, canopyDiameter: 5, x: 12, z: -8 }),
    newObject('hedge', 'Hedge', { w: 10, d: 1, h: 2, x: 7, z: 13, rot: 0 }),
    newObject('panel', 'Garden panel test', { w: 2, len: 1.2, tilt: 35, baseHeight: 0.3, x: -8, z: 12, rot: 0 }),
  ];
}
