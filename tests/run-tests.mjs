// Headless verification of the sunshine-simulator core (runs in Node, no DOM needed).
import { sunPosition, sunTimes, sunDirection } from '../js/solar.js';
import { buildSyntheticClimatology, annualGHI, climateAt } from '../js/climate.js';
import { createDefaultScene, buildObject } from '../js/objects.js';
import { runAnnualAnalysis, runDayAnalysis } from '../js/analysis.js';
import { buildHeatmapOverlay } from '../js/heatmap.js';
import { collectExportMeshes, exportOBJ, exportDAE } from '../js/exporters.js';
import { applyPvSizing, PANEL_TYPES } from '../js/panels.js';

const LAT = 48.7758, LON = 9.1829;
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failures++;
}

console.log('TZ:', Intl.DateTimeFormat().resolvedOptions().timeZone);

// ---- 1. solar position ----
{
  // Jun 21 solar noon in Stuttgart is ~13:20 CEST; max elevation ≈ 64.7°
  let best = { elevation: -99 };
  for (let m = 600; m < 1000; m += 2) {
    const sp = sunPosition(new Date(2026, 5, 21, 0, m), LAT, LON);
    if (sp.elevation > best.elevation) best = { ...sp, m };
  }
  check('summer solstice max elevation ~64.7°', Math.abs(best.elevation - 64.7) < 0.6, best.elevation.toFixed(2));
  check('solar noon azimuth ~180°', Math.abs(best.azimuth - 180) < 2, best.azimuth.toFixed(1));
  check('solar noon ~13:20 CEST', Math.abs(best.m - 800) < 15, (best.m / 60).toFixed(2) + 'h');

  let bestW = { elevation: -99 };
  for (let m = 600; m < 1000; m += 2) {
    const sp = sunPosition(new Date(2026, 11, 21, 0, m), LAT, LON);
    if (sp.elevation > bestW.elevation) bestW = { ...sp, m };
  }
  check('winter solstice max elevation ~17.8°', Math.abs(bestW.elevation - 17.8) < 0.6, bestW.elevation.toFixed(2));

  const morning = sunPosition(new Date(2026, 5, 21, 8, 0), LAT, LON);
  check('morning sun in the east', morning.azimuth > 60 && morning.azimuth < 120, morning.azimuth.toFixed(1));

  const { sunrise, sunset } = sunTimes(new Date(2026, 5, 21), LAT, LON);
  check('Jun 21 sunrise ~05:2x', sunrise && sunrise.getHours() === 5 && sunrise.getMinutes() < 35, sunrise?.toTimeString().slice(0, 5));
  check('Jun 21 sunset ~21:3x', sunset && sunset.getHours() === 21, sunset?.toTimeString().slice(0, 5));

  const dir = sunDirection(180, 45);
  check('sun dir south=+z', dir.z > 0.7 && Math.abs(dir.x) < 1e-9 && dir.y > 0.7, JSON.stringify(dir));
}

// ---- 2. climatology ----
const clim = buildSyntheticClimatology(LAT, LON);
{
  const ghi = annualGHI(clim);
  check('synthetic annual GHI ≈ 1149', Math.abs(ghi - 1149) < 25, ghi.toFixed(0));
  const noonJun = climateAt(clim, 5, 13.0);
  check('June noon GHI plausible (400–700)', noonJun.ghi > 400 && noonJun.ghi < 700, noonJun.ghi.toFixed(0));
  check('June noon DNI plausible (300–800)', noonJun.dni > 300 && noonJun.dni < 800, noonJun.dni.toFixed(0));
  const nightVal = climateAt(clim, 5, 1.0);
  check('night GHI = 0', nightVal.ghi === 0);
}

// ---- 3. geometry / faces ----
const sceneDescs = createDefaultScene();
const built = new Map();
for (const desc of sceneDescs) built.set(desc.id, buildObject(desc, { baseY: desc.type === 'chimney' ? 8 : 0 }));
const groups = [...built.values()].map((b) => b.group);
for (const g of groups) g.updateMatrixWorld(true);
const faces = [...built.values()].flatMap((b) => b.faces);
{
  const house = built.get(sceneDescs[0].id);
  check('house has 2 roof faces', house.faces.length === 2, String(house.faces.length));
  const south = house.faces.find((f) => f.az > 90 && f.az < 270);
  const north = house.faces.find((f) => f.az <= 90 || f.az >= 270);
  check('south face tilt = 38°', south && Math.abs(south.tilt - 38) < 0.5, south?.tilt.toFixed(1));
  check('south face az = 180°', south && Math.abs(south.az - 180) < 0.5, south?.az.toFixed(1));
  // slope length = (4.5+0.4)/cos38 ≈ 6.218; width 11+0.8 → area ≈ 73.4
  check('south face area ≈ 73.4 m²', south && Math.abs(south.area - 73.4) < 1.5, south?.area.toFixed(1));
  check('north face az = 0°', north && (north.az < 0.5 || north.az > 359.5), north?.az.toFixed(1));

  const garage = built.get(sceneDescs[1].id);
  check('garage flat face up', garage.faces.length === 1 && garage.faces[0].tilt < 0.5, garage.faces[0]?.tilt.toFixed(2));
  check('garage flat face area = 21', Math.abs(garage.faces[0].area - 21) < 0.1, garage.faces[0]?.area.toFixed(1));

  const balcony = [...built.values()].find((b) => b.faces.some((f) => f.kind === 'railing front'));
  const rail = balcony.faces.find((f) => f.kind === 'railing front');
  check('railing tilt 90, az 180', Math.abs(rail.tilt - 90) < 0.5 && Math.abs(rail.az - 180) < 0.5, `${rail.tilt.toFixed(1)}/${rail.az.toFixed(1)}`);

  // balcony with all three railing sides: front S, left (looking out) = E, right = W
  const bal3 = buildObject({ id: 'baltest', type: 'balcony', name: 'bal', params: { w: 4, d: 1.6, floorHeight: 3, railingHeight: 1, analyzeFront: true, analyzeLeft: true, analyzeRight: true, x: 0, z: 0, rot: 0 } });
  check('balcony exposes 3 railing faces', bal3.faces.length === 3, String(bal3.faces.length));
  const azOf = (kind) => bal3.faces.find((f) => f.kind === kind)?.az;
  check('railing sides face S/E/W', Math.abs(azOf('railing front') - 180) < 0.5 && Math.abs(azOf('railing left') - 90) < 0.5 && Math.abs(azOf('railing right') - 270) < 0.5,
    `front ${azOf('railing front')}, left ${azOf('railing left')}, right ${azOf('railing right')}`);
  check('all railing faces vertical', bal3.faces.every((f) => Math.abs(f.tilt - 90) < 0.5));
  // legacy scenes: analyzeRailing maps to the front face
  const balOld = buildObject({ id: 'balold', type: 'balcony', name: 'old', params: { w: 4, d: 1.6, floorHeight: 3, railingHeight: 1, analyzeRailing: true, x: 0, z: 0, rot: 0 } });
  check('legacy analyzeRailing still yields front face', balOld.faces.length === 1 && balOld.faces[0].kind === 'railing front');

  const panel = [...built.values()].find((b) => b.faces.some((f) => f.kind === 'panel'));
  const pf = panel.faces.find((f) => f.kind === 'panel');
  check('panel tilt 35, az 180', Math.abs(pf.tilt - 35) < 0.5 && Math.abs(pf.az - 180) < 0.5, `${pf.tilt.toFixed(1)}/${pf.az.toFixed(1)}`);

  const pergola = [...built.values()].find((b) => b.faces.some((f) => f.kind === 'pergola roof'));
  const pgf = pergola.faces.find((f) => f.kind === 'pergola roof');
  check('pergola roof tilt 8, az 180', Math.abs(pgf.tilt - 8) < 0.5 && Math.abs(pgf.az - 180) < 0.5, `${pgf.tilt.toFixed(1)}/${pgf.az.toFixed(1)}`);

  // hip roof variant: 4 faces
  const hip = buildObject({ id: 'hiptest', type: 'building', name: 'hip', params: { w: 10, d: 8, eave: 5, roofType: 'hip', pitch: 30, ridgeAxis: 'x', lowSide: 'z+', overhang: 0.4, analyze: true, x: 0, z: 0, rot: 0 } });
  check('hip roof has 4 faces', hip.faces.length === 4, String(hip.faces.length));
  check('hip normals all upward', hip.faces.every((f) => f.tilt < 90));
  // shed with rotation: rot 90 means low side faces west (z+ rotated 90° cw = W... z+ is S; S rotated 90° cw = W)
  const shed = buildObject({ id: 'shedtest', type: 'building', name: 'shed', params: { w: 6, d: 4, eave: 3, roofType: 'shed', pitch: 10, ridgeAxis: 'x', lowSide: 'z+', overhang: 0.2, analyze: true, x: 0, z: 0, rot: 90 } });
  check('rotated shed faces west', Math.abs(shed.faces[0].az - 270) < 0.5, shed.faces[0].az.toFixed(1));
  // negative rotation = counterclockwise: shed low side S rotated −90 faces east
  const negShed = buildObject({ id: 'negshed', type: 'building', name: 'negshed', params: { w: 6, d: 4, eave: 3, roofType: 'shed', pitch: 10, ridgeAxis: 'x', lowSide: 'z+', overhang: 0.2, analyze: true, x: 0, z: 0, rot: -90 } });
  check('rot −90 (ccw): shed faces east', Math.abs(negShed.faces[0].az - 90) < 0.5, negShed.faces[0].az.toFixed(1));

  check('total analyzed faces in demo', faces.length >= 6, String(faces.length));
  console.log('   faces:', faces.map((f) => `${f.label} (${f.area.toFixed(0)}m²)`).join(' | '));
}

// ---- 4. full annual analysis ----
{
  const t0 = Date.now();
  const settings = { packingFactor: 0.7, performanceRatio: 0.8, albedo: 0.2 };
  const results = await runAnnualAnalysis({
    faces, occluders: groups, climate: clim,
    location: { lat: LAT, lon: LON }, settings,
    onProgress: () => {},
  });
  const dt = (Date.now() - t0) / 1000;
  console.log(`   analysis took ${dt.toFixed(1)}s for ${results.length} faces, ${results.reduce((s, f) => s + f.points.length, 0)} points`);
  check('analysis under 30s', dt < 30, dt.toFixed(1) + 's');

  const south = results.find((f) => f.label.includes('My house') && f.az > 150 && f.az < 210);
  const north = results.find((f) => f.label.includes('My house') && (f.az < 30 || f.az > 330));
  console.log('   ' + results.map((f) => `${f.label}: ${f.annualPOA.toFixed(0)} kWh/m² (unshaded ${f.unshadedPOA.toFixed(0)}, loss ${f.shadingLossPct.toFixed(1)}%, ${(f.sunHoursYr / 365).toFixed(1)}h/d, yield ${f.yieldKWh.toFixed(0)}kWh)`).join('\n   '));
  check('south roof POA 1150–1400', south && south.annualPOA > 1150 && south.annualPOA < 1400, south?.annualPOA.toFixed(0));
  check('north roof POA 500–800', north && north.annualPOA > 500 && north.annualPOA < 800, north?.annualPOA.toFixed(0));
  check('south > north', south.annualPOA > north.annualPOA * 1.5);
  check('south shading loss < 20%', south.shadingLossPct < 20, south.shadingLossPct.toFixed(1));
  check('specific yield south ~950–1150 kWh/kWp', south.specificYield > 900 && south.specificYield < 1200, south.specificYield.toFixed(0));
  check('monthly arrays sum to annual', results.every((f) => Math.abs(f.monthlyPOA.reduce((a, b) => a + b, 0) - f.annualPOA) < 1));
  check('all points have annual values', results.every((f) => f.points.every((p) => isFinite(p.annual) && p.annual >= 0)));
  check('June > December on south roof', south.monthlyPOA[5] > south.monthlyPOA[11] * 2, `${south.monthlyPOA[5].toFixed(0)} vs ${south.monthlyPOA[11].toFixed(0)}`);

  // panel-based sizing: south face 73.4 m² × 0.7 packing / 2.224 m² per 500W panel = 23
  check('south roof auto-fits 23 × 500 W panels', south.panelCount === 23 && Math.abs(south.kwp - 11.5) < 0.01, `${south.panelCount} × → ${south.kwp} kWp`);
  const gardenPanel = results.find((f) => f.kind === 'panel');
  check('free panel face fits exactly 1 panel (no packing derate)', gardenPanel.panelCount === 1 && gardenPanel.kwp === 0.5, `${gardenPanel.panelCount}`);
  // explicit config: 10 × 440 W on the south roof
  applyPvSizing(results, { [south.id]: { type: 'anker440', count: 10 } }, settings);
  check('custom config 10 × 440 W → 4.4 kWp', south.panelType === 'anker440' && south.panelCount === 10 && Math.abs(south.kwp - 4.4) < 0.001, `${south.kwp}`);
  check('custom yield = kWp × POA × PR', Math.abs(south.yieldKWh - 4.4 * south.annualPOA * 0.8) < 1, south.yieldKWh.toFixed(0));
  // half a panel on a railing: 0.5 × 500 W = 0.25 kWp
  const railFace = results.find((f) => f.kind === 'railing front');
  applyPvSizing(results, { [railFace.id]: { count: 0.5 } }, settings);
  check('half panel on front railing → 0.25 kWp', railFace.panelCount === 0.5 && Math.abs(railFace.kwp - 0.25) < 0.001, `${railFace.panelCount} × → ${railFace.kwp}`);
  // a whole panel on the small left railing exceeds the flush fit → allowed but flagged
  const leftRail = results.find((f) => f.kind === 'railing left');
  applyPvSizing(results, { [leftRail.id]: { count: 1 } }, settings);
  check('1 panel on left railing allowed with overhang flag', leftRail.panelCount === 1 && leftRail.exceedsFit === true && Math.abs(leftRail.kwp - 0.5) < 0.001, `${leftRail.panelCount}, exceeds=${leftRail.exceedsFit}`);
  check('auto sizing never exceeds fit', (applyPvSizing(results, {}, settings), results.every((f) => !f.exceedsFit)));
  applyPvSizing(results, {}, settings); // back to auto for the checks below

  // day pass
  await runDayAnalysis({ results, occluders: groups, date: new Date(2026, 5, 21), location: { lat: LAT, lon: LON } });
  check('day sun hours on south roof Jun 21 (8–16h)', south.sunHoursDay > 8 && south.sunHoursDay < 16.5, south.sunHoursDay?.toFixed(1));
  await runDayAnalysis({ results, occluders: groups, date: new Date(2026, 11, 21), location: { lat: LAT, lon: LON } });
  check('day sun hours south roof Dec 21 (2–8.5h)', south.sunHoursDay > 2 && south.sunHoursDay < 8.5, south.sunHoursDay?.toFixed(1));

  // heatmap
  const { group, vmin, vmax } = buildHeatmapOverlay(results, 'annual');
  check('heatmap group has a mesh per face', group.children.length === results.length);
  check('heatmap range sane', vmin < vmax && vmin >= 0, `${vmin.toFixed(0)}–${vmax.toFixed(0)}`);
}

// ---- 5. exporters ----
{
  const meshes = collectExportMeshes(groups);
  check('export meshes collected', meshes.length > 10, String(meshes.length));
  const { obj, mtl } = exportOBJ(meshes);
  const vCount = (obj.match(/^v /gm) || []).length;
  const fCount = (obj.match(/^f /gm) || []).length;
  check('OBJ vertex/face consistency', vCount === fCount * 3, `${vCount} v, ${fCount} f`);
  check('MTL has materials', (mtl.match(/^newmtl /gm) || []).length >= 5);
  const dae = exportDAE(meshes);
  check('DAE has geometries', (dae.match(/<geometry /g) || []).length === meshes.length);
  check('DAE has scene nodes', (dae.match(/<instance_geometry /g) || []).length === meshes.length);
  check('DAE balanced COLLADA tags', dae.includes('</COLLADA>') && dae.startsWith('<?xml'));
  // rough XML well-formedness: every float_array count matches its contents
  let ok = true;
  for (const m of dae.matchAll(/<float_array[^>]*count="(\d+)">([^<]*)</g)) {
    const n = m[2].trim().split(/\s+/).length;
    if (n !== +m[1]) { ok = false; break; }
  }
  check('DAE float_array counts match', ok);
  // and every <triangles count> matches its <p> index list (3 indices per tri)
  let ok2 = true;
  for (const m of dae.matchAll(/<triangles[^>]*count="(\d+)">[\s\S]*?<p>([^<]*)<\/p>/g)) {
    const n = m[2].trim().split(/\s+/).length;
    if (n !== +m[1] * 3) { ok2 = false; break; }
  }
  check('DAE triangle index counts match', ok2);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
