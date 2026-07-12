// Heatmap overlays: one colored quad per sample point, drawn slightly above each
// analyzed face. Sequential single-hue blue ramp (light = low, dark = high) from the
// validated dataviz reference palette.

import * as THREE from 'three';

export const SEQ_RAMP = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5',
  '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b',
];
const rampColors = SEQ_RAMP.map((h) => new THREE.Color(h));

export function rampColor(t) {
  const x = Math.min(1, Math.max(0, t)) * (rampColors.length - 1);
  const i = Math.min(rampColors.length - 2, Math.floor(x));
  return rampColors[i].clone().lerp(rampColors[i + 1], x - i);
}

export function rampCSS() {
  return `linear-gradient(90deg, ${SEQ_RAMP.join(',')})`;
}

// mode: 'annual' (kWh/m²/yr) or 'day' (hours). Returns { group, vmin, vmax }.
export function buildHeatmapOverlay(faceResults, mode) {
  const group = new THREE.Group();
  group.name = 'heatmap';
  const key = mode === 'day' ? 'day' : 'annual';

  let vmin = Infinity, vmax = -Infinity;
  for (const f of faceResults)
    for (const p of f.points) {
      vmin = Math.min(vmin, p[key]);
      vmax = Math.max(vmax, p[key]);
    }
  if (!isFinite(vmin)) return { group, vmin: 0, vmax: 0 };
  if (vmax - vmin < 1e-6) vmax = vmin + 1e-6;

  for (const f of faceResults) {
    const u = new THREE.Vector3(f.u.x, f.u.y, f.u.z);
    const v = new THREE.Vector3(f.v.x, f.v.y, f.v.z);
    const n = new THREE.Vector3(f.normal.x, f.normal.y, f.normal.z);
    const half = (f.spacing * 0.94) / 2;
    const pos = [], col = [];
    for (const p of f.points) {
      const c = rampColor((p[key] - vmin) / (vmax - vmin));
      const center = new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z).addScaledVector(n, 0.04);
      const c1 = center.clone().addScaledVector(u, -half).addScaledVector(v, -half);
      const c2 = center.clone().addScaledVector(u, half).addScaledVector(v, -half);
      const c3 = center.clone().addScaledVector(u, half).addScaledVector(v, half);
      const c4 = center.clone().addScaledVector(u, -half).addScaledVector(v, half);
      for (const q of [c1, c2, c3, c1, c3, c4]) pos.push(q.x, q.y, q.z);
      for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    group.add(new THREE.Mesh(g, m));
  }
  return { group, vmin, vmax };
}
