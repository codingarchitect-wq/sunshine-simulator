// Shading + insolation analysis.
//
// For every analysis face we lay a sample grid over the polygon and ray-cast from each
// sample point toward the sun across the year (12 representative days × 30-min steps).
// Direct beam uses DNI × cos(AOI) × shade factor; trees/hedges attenuate by their
// seasonal transmittance instead of blocking outright. Diffuse uses an isotropic sky
// with a per-point obstruction factor (hemisphere ray sampling), ground-reflected uses
// a constant albedo. Everything is driven by the month×hour climatology (climate.js).

import * as THREE from 'three';
import { sunPosition, sunDirection } from './solar.js';
import { climateAt, DAYS_IN_MONTH } from './climate.js';

const REF_YEAR = 2025;

// ---------- sampling ----------
export function sampleFace(face, targetPoints = 140) {
  const { poly, normal } = face;
  const u = poly[1].clone().sub(poly[0]).normalize();
  const v = normal.clone().cross(u).normalize();
  const o = poly[0];
  const pts2 = poly.map((p) => {
    const d = p.clone().sub(o);
    return [d.dot(u), d.dot(v)];
  });
  const xs = pts2.map((p) => p[0]), ys = pts2.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spacing = Math.max(0.35, Math.sqrt(face.area / targetPoints));
  const points = [];
  for (let gy = minY + spacing / 2; gy < maxY; gy += spacing) {
    for (let gx = minX + spacing / 2; gx < maxX; gx += spacing) {
      if (!pointInPoly(gx, gy, pts2)) continue;
      const pos = o.clone().addScaledVector(u, gx).addScaledVector(v, gy).addScaledVector(normal, 0.06);
      points.push({ pos, a: 0, unshadedA: 0, diffFactor: 1, sunMinYr: 0, day: 0 });
    }
  }
  // tiny faces: fall back to the centroid
  if (points.length === 0) {
    const c = poly.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / poly.length);
    points.push({ pos: c.addScaledVector(normal, 0.06), a: 0, unshadedA: 0, diffFactor: 1, sunMinYr: 0, day: 0 });
  }
  return { points, spacing, u, v };
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- shading ----------
const _raycaster = new THREE.Raycaster();
_raycaster.far = 500;

function shadeFactor(pos, dir, occluders, season) {
  _raycaster.set(pos, dir);
  const hits = _raycaster.intersectObjects(occluders, true);
  if (hits.length === 0) return 1;
  let factor = 1;
  const seen = new Set();
  for (const h of hits) {
    if (h.distance < 0.05) continue;
    if (seen.has(h.object.id)) continue; // count each canopy once (entry+exit hits)
    seen.add(h.object.id);
    const t = h.object.userData.transmittance;
    if (!t) return 0; // opaque
    factor *= season === 'summer' ? t.summer : t.winter;
    if (factor < 0.01) return 0;
  }
  return factor;
}

const seasonOfMonth = (m) => (m >= 4 && m <= 9 ? 'summer' : 'winter');

// Per-point diffuse obstruction: stratified hemisphere sampling of the sky dome,
// weighted by incidence on the plane. Returns the fraction of the face's unobstructed
// isotropic diffuse that actually arrives (0..1).
function diffuseObstruction(pos, normal, occluders) {
  const bands = [7.5, 22.5, 37.5, 52.5, 67.5, 82.5];
  const nAz = 8;
  let total = 0, visible = 0;
  const dir = new THREE.Vector3();
  for (const elev of bands) {
    const w0 = Math.cos(elev * (Math.PI / 180)); // band solid-angle weight
    for (let a = 0; a < nAz; a++) {
      const az = ((a + 0.5) * 360) / nAz;
      const d = sunDirection(az, elev);
      dir.set(d.x, d.y, d.z);
      const inc = normal.dot(dir);
      if (inc <= 0) continue;
      const w = w0 * inc;
      total += w;
      // average of the two seasons for diffuse (it accrues year-round)
      const sf = 0.5 * (shadeFactor(pos, dir, occluders, 'summer') + shadeFactor(pos, dir, occluders, 'winter'));
      visible += w * sf;
    }
  }
  return total > 0 ? visible / total : 1;
}

// ---------- the annual run ----------
export async function runAnnualAnalysis({ faces, occluders, climate, location, settings, onProgress = () => {} }) {
  for (const o of occluders) o.updateMatrixWorld(true);
  const results = [];
  const stepMin = 30;
  const totalWork = faces.length * (12 + 1);
  let done = 0;
  const tick = async (label) => {
    onProgress(Math.min(1, ++done / totalWork), label);
    await new Promise((r) => setTimeout(r, 0));
  };

  for (const face of faces) {
    const { points, spacing, u, v } = sampleFace(face);
    const n = face.normal;
    const cosBeta = Math.max(-1, Math.min(1, n.y));
    const skyFrac = (1 + cosBeta) / 2;
    const groundFrac = (1 - cosBeta) / 2;

    for (const pt of points) pt.diffFactor = diffuseObstruction(pt.pos, n, occluders);
    await tick(`${face.label}: sky view`);

    const monthly = new Array(12).fill(0); // kWh/m² per month (face mean)
    const monthlyUnshaded = new Array(12).fill(0);
    let diffuseAnnual = 0, reflAnnual = 0; // kWh/m² (before per-point diffFactor)

    for (let m = 0; m < 12; m++) {
      const season = seasonOfMonth(m);
      const days = DAYS_IN_MONTH[m];
      let mBeam = 0, mBeamUn = 0, mDiff = 0, mRefl = 0; // Wh/m² for the rep day (face mean)

      for (let minutes = 3 * 60; minutes <= 22 * 60; minutes += stepMin) {
        const t = new Date(REF_YEAR, m, 15, 0, minutes);
        const sp = sunPosition(t, location.lat, location.lon);
        if (sp.elevation <= 0.3) continue;
        const { dni, dhi, ghi } = climateAt(climate, m, minutes / 60);
        const dtH = stepMin / 60;

        // diffuse & ground-reflected (independent of sun direction)
        mDiff += dhi * skyFrac * dtH;
        mRefl += ghi * settings.albedo * groundFrac * dtH;

        const sd = sunDirection(sp.azimuth, sp.elevation);
        const dir = new THREE.Vector3(sd.x, sd.y, sd.z);
        const cosAOI = n.dot(dir);
        if (cosAOI <= 0 || dni <= 0) continue;

        let beamSum = 0, shadeCount = 0;
        for (const pt of points) {
          const sf = shadeFactor(pt.pos, dir, occluders, season);
          const wh = dni * cosAOI * sf * dtH;
          pt.a += wh * days;
          beamSum += wh;
          if (sf > 0.5) {
            pt.sunMinYr += stepMin * days;
            shadeCount++;
          }
        }
        mBeam += beamSum / points.length;
        mBeamUn += dni * cosAOI * dtH;
      }

      const meanDiffFactor = points.reduce((s, p) => s + p.diffFactor, 0) / points.length;
      monthly[m] = ((mBeam + mDiff * meanDiffFactor + mRefl) * days) / 1000;
      monthlyUnshaded[m] = ((mBeamUn + mDiff + mRefl) * days) / 1000;
      diffuseAnnual += (mDiff * days) / 1000;
      reflAnnual += (mRefl * days) / 1000;
      await tick(`${face.label}: ${'JFMAMJJASOND'[m]}`);
    }

    // per-point annual value = its beam + its diffuse + shared reflected (kWh/m²/yr)
    for (const pt of points) {
      pt.annual = pt.a / 1000 + diffuseAnnual * pt.diffFactor + reflAnnual;
    }

    const annualPOA = monthly.reduce((a, b) => a + b, 0);
    const unshadedPOA = monthlyUnshaded.reduce((a, b) => a + b, 0);
    const packing = face.kind === 'panel' ? 1 : settings.packingFactor;
    const usableArea = face.area * packing;
    const kwp = usableArea * settings.kwpPerM2;
    const yieldKWh = kwp * annualPOA * settings.performanceRatio; // POA in kWh/m² ≡ full-sun hours
    results.push({
      id: face.id, label: face.label, area: face.area, tilt: face.tilt, az: face.az,
      normal: { x: n.x, y: n.y, z: n.z },
      u: { x: u.x, y: u.y, z: u.z }, v: { x: v.x, y: v.y, z: v.z },
      spacing,
      points: points.map((p) => ({
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
        annual: p.annual,
        sunHoursYr: p.sunMinYr / 60,
        day: 0,
      })),
      monthlyPOA: monthly,
      annualPOA, unshadedPOA,
      shadingLossPct: unshadedPOA > 0 ? (1 - annualPOA / unshadedPOA) * 100 : 0,
      sunHoursYr: points.reduce((s, p) => s + p.sunMinYr, 0) / points.length / 60,
      usableArea, kwp, yieldKWh,
      specificYield: kwp > 0 ? yieldKWh / kwp : 0,
    });
  }
  onProgress(1, 'done');
  return results;
}

// ---------- single-day pass (for the "sun hours today" heatmap + table column) ----------
export async function runDayAnalysis({ results, occluders, date, location }) {
  for (const o of occluders) o.updateMatrixWorld(true);
  const stepMin = 10;
  const m = date.getMonth();
  const season = seasonOfMonth(m);
  for (const face of results) {
    const n = new THREE.Vector3(face.normal.x, face.normal.y, face.normal.z);
    for (const p of face.points) p.day = 0;
    for (let minutes = 3 * 60; minutes <= 22 * 60; minutes += stepMin) {
      const t = new Date(date.getFullYear(), m, date.getDate(), 0, minutes);
      const sp = sunPosition(t, location.lat, location.lon);
      if (sp.elevation <= 0.3) continue;
      const sd = sunDirection(sp.azimuth, sp.elevation);
      const dir = new THREE.Vector3(sd.x, sd.y, sd.z);
      if (n.dot(dir) <= 0) continue;
      for (const p of face.points) {
        const pos = new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z);
        if (shadeFactor(pos, dir, occluders, season) > 0.5) p.day += stepMin / 60;
      }
    }
    face.sunHoursDay = face.points.reduce((s, p) => s + p.day, 0) / face.points.length;
    await new Promise((r) => setTimeout(r, 0));
  }
  return results;
}
