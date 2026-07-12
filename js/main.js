// App entry: three.js scene, sun, interactions, and the glue between modules.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { sunPosition, sunDirection, sunTimes } from './solar.js';
import { buildSyntheticClimatology, annualGHI } from './climate.js';
import { fetchOpenMeteoClimatology, cacheClimatology, loadCachedClimatology } from './weather.js';
import { createDefaultScene, buildObject, newObject, ensureIdCounterAbove, OBJECT_TYPES } from './objects.js';
import { runAnnualAnalysis, runDayAnalysis } from './analysis.js';
import { buildHeatmapOverlay } from './heatmap.js';
import { collectExportMeshes, exportOBJ, exportDAE, download } from './exporters.js';
import * as ui from './ui.js';

const STORAGE_KEY = 'sunshine-sim-scene-v2';

// ---------- state ----------
const state = {
  location: { lat: 48.7758, lon: 9.1829 }, // Stuttgart
  settings: { packingFactor: 0.7, kwpPerM2: 0.215, performanceRatio: 0.8, albedo: 0.2 },
  objects: [],
};
let climate = null;
let results = null;
let selectedId = null;
let selectedFaceId = null;
let heatmapMode = 'annual';
let playing = false;
let analysisRunning = false;

const now = new Date();
let dateStr = now.toISOString().slice(0, 10);
let minutes = now.getHours() * 60 + now.getMinutes();
let cachedSunTimes = null;

const objMap = new Map(); // id -> { desc, group, faces }

// ---------- three.js scene ----------
const viewport = document.getElementById('viewport');
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87aac5);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
camera.position.set(30, 26, 38);

// object interaction listeners must be registered BEFORE OrbitControls so we can
// disable the controls when a drag starts on an object
canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 3, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.maxDistance = 400;

const hemi = new THREE.HemisphereLight(0xbfd4e8, 0x40453c, 0.5);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffffff, 0.12);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff2d9, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -55;
sun.shadow.camera.right = sun.shadow.camera.top = 55;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);
scene.add(sun.target);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(150, 48),
  new THREE.MeshStandardMaterial({ color: 0x46503f, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(120, 60, 0x525b4e, 0x4b5448);
grid.material.transparent = true;
grid.material.opacity = 0.35;
grid.position.y = 0.02;
scene.add(grid);

// compass letters
function letterSprite(letter, color) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(letter, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
  sprite.scale.set(5, 5, 1);
  return sprite;
}
for (const [letter, x, z, color] of [['N', 0, -46, '#e66767'], ['E', 46, 0, '#c3c2b7'], ['S', 0, 46, '#c3c2b7'], ['W', -46, 0, '#c3c2b7']]) {
  const s = letterSprite(letter, color);
  s.position.set(x, 2.2, z);
  scene.add(s);
}

const objectsRoot = new THREE.Group();
scene.add(objectsRoot);
const heatmapRoot = new THREE.Group();
scene.add(heatmapRoot);

// sun path line + marker
let sunPathLine = null;
const sunMarker = new THREE.Mesh(
  new THREE.SphereGeometry(1.7, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd97a })
);
scene.add(sunMarker);

const SUN_R = 80;

function rebuildSunPath() {
  if (sunPathLine) {
    scene.remove(sunPathLine);
    sunPathLine.geometry.dispose();
  }
  const pts = [];
  const d = currentDate();
  for (let m = 0; m <= 1440; m += 10) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m);
    const sp = sunPosition(t, state.location.lat, state.location.lon);
    if (sp.elevation < -1) continue;
    const dir = sunDirection(sp.azimuth, sp.elevation);
    pts.push(new THREE.Vector3(dir.x * SUN_R, dir.y * SUN_R, dir.z * SUN_R));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  sunPathLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd9a13b, transparent: true, opacity: 0.55 }));
  scene.add(sunPathLine);
}

function currentDate() {
  const [y, mo, da] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, da, Math.floor(minutes / 60), minutes % 60);
}

const NIGHT = new THREE.Color(0x0a0e18), DUSK = new THREE.Color(0x5a6478), DAY = new THREE.Color(0x87aac5);
const SUN_WARM = new THREE.Color(0xffb257), SUN_WHITE = new THREE.Color(0xfff4e0);

function updateSun() {
  const d = currentDate();
  const sp = sunPosition(d, state.location.lat, state.location.lon);
  const dir = sunDirection(sp.azimuth, sp.elevation);
  sun.position.set(dir.x * 110, dir.y * 110, dir.z * 110);
  sun.target.position.set(0, 0, 0);
  const el = sp.elevation;
  sun.visible = el > 0;
  sun.intensity = el <= 0 ? 0 : 2.4 * Math.min(1, el / 25 + 0.12);
  sun.color.copy(SUN_WARM).lerp(SUN_WHITE, Math.min(1, Math.max(0, el / 30)));
  hemi.intensity = 0.12 + 0.38 * Math.min(1, Math.max(0, (el + 6) / 16));
  const bg =
    el <= -6 ? NIGHT.clone()
    : el <= 8 ? NIGHT.clone().lerp(DUSK, (el + 6) / 14).lerp(DAY, Math.max(0, el / 8) * 0.5)
    : DUSK.clone().lerp(DAY, Math.min(1, (el - 8) / 14 + 0.5));
  scene.background = bg;
  sunMarker.visible = el > 0;
  sunMarker.position.set(dir.x * SUN_R, dir.y * SUN_R, dir.z * SUN_R);
  ui.refreshSun({ ...sp, ...(cachedSunTimes || {}) });
}

// ---------- object management ----------
function groundYAt(x, z, excludeGroup) {
  objectsRoot.updateMatrixWorld(true); // groups may have been (re)built this tick
  const rc = new THREE.Raycaster(new THREE.Vector3(x, 300, z), new THREE.Vector3(0, -1, 0));
  const targets = objectsRoot.children.filter((g) => g !== excludeGroup);
  const hits = rc.intersectObjects(targets, true);
  return hits.length ? hits[0].point.y : 0;
}

function disposeGroup(group) {
  group.traverse((n) => {
    if (n.isMesh) {
      n.geometry?.dispose();
      n.material?.dispose();
    }
  });
}

function rebuildObject(desc) {
  const old = objMap.get(desc.id);
  if (old?.group) {
    objectsRoot.remove(old.group);
    disposeGroup(old.group);
  }
  const ctx = {};
  if (desc.type === 'chimney') ctx.baseY = groundYAt(desc.params.x, desc.params.z, old?.group);
  const { group, faces } = buildObject(desc, ctx);
  objMap.set(desc.id, { desc, group, faces });
  objectsRoot.add(group);
  if (desc.id === selectedId) applyHighlight(group, true);
}

function rebuildChimneys() {
  for (const desc of state.objects) if (desc.type === 'chimney') rebuildObject(desc);
}

function rebuildAll() {
  for (const o of objMap.values()) {
    objectsRoot.remove(o.group);
    disposeGroup(o.group);
  }
  objMap.clear();
  for (const desc of state.objects) if (desc.type !== 'chimney') rebuildObject(desc);
  rebuildChimneys();
}

function applyHighlight(group, on) {
  group.traverse((n) => {
    if (n.isMesh && n.material.emissive) n.material.emissive.setHex(on ? 0x274a7a : 0x000000);
  });
}

function invalidateResults(msg = 'Scene changed — press <b>Run analysis</b> to refresh the numbers.') {
  if (!results) return;
  results = null;
  selectedFaceId = null;
  clearHeatmap();
  ui.refreshResults(null);
  ui.setStale(msg);
}

function clearHeatmap() {
  for (const child of [...heatmapRoot.children]) {
    heatmapRoot.remove(child);
    disposeGroup(child);
  }
  ui.setHeatmapLegend(null);
}

function applyHeatmap() {
  clearHeatmap();
  if (!results || heatmapMode === 'off') return;
  const { group, vmin, vmax } = buildHeatmapOverlay(results, heatmapMode);
  heatmapRoot.add(group);
  ui.setHeatmapLegend(vmin, vmax, heatmapMode === 'day' ? 'h' : 'kWh/m²·yr');
}

// ---------- persistence ----------
let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        location: state.location, settings: state.settings, objects: state.objects,
      }));
    } catch { /* ignore quota */ }
  }, 600);
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.objects) || data.objects.length === 0) return false;
    Object.assign(state.location, data.location || {});
    Object.assign(state.settings, data.settings || {});
    state.objects = data.objects;
    ensureIdCounterAbove(state.objects);
    return true;
  } catch {
    return false;
  }
}

// ---------- climate ----------
function initClimate() {
  const cached = loadCachedClimatology(state.location.lat, state.location.lon);
  climate = cached || buildSyntheticClimatology(state.location.lat, state.location.lon);
  updateWeatherStatus();
}

function updateWeatherStatus() {
  const ghi = annualGHI(climate);
  ui.setWeatherStatus(`${climate.builtin ? 'built-in climatology' : climate.source} · GHI ≈ ${Math.round(ghi)} kWh/m²·yr`, !climate.builtin);
}

// ---------- app facade for the UI ----------
const app = {
  state,
  getObjects: () => state.objects,
  getSelectedId: () => selectedId,

  selectObject(id) {
    if (selectedId && objMap.get(selectedId)) applyHighlight(objMap.get(selectedId).group, false);
    selectedId = id;
    if (id && objMap.get(id)) applyHighlight(objMap.get(id).group, true);
    ui.refreshObjectList();
    ui.refreshParams();
  },

  addObject(type) {
    const desc = newObject(type, undefined, { x: Math.round(Math.random() * 10 - 5), z: Math.round(Math.random() * 10 + 12) });
    state.objects.push(desc);
    rebuildObject(desc);
    this.selectObject(desc.id);
    invalidateResults();
    saveLocal();
  },

  deleteSelected() {
    if (!selectedId) return;
    const idx = state.objects.findIndex((o) => o.id === selectedId);
    if (idx < 0) return;
    const o = objMap.get(selectedId);
    if (o) {
      objectsRoot.remove(o.group);
      disposeGroup(o.group);
      objMap.delete(selectedId);
    }
    state.objects.splice(idx, 1);
    selectedId = null;
    rebuildChimneys();
    ui.refreshObjectList();
    ui.refreshParams();
    invalidateResults();
    saveLocal();
  },

  duplicateSelected() {
    if (!selectedId) return;
    const src = state.objects.find((o) => o.id === selectedId);
    if (!src) return;
    const desc = newObject(src.type, src.name + ' copy', { ...src.params, x: src.params.x + 3, z: src.params.z + 3 });
    state.objects.push(desc);
    rebuildObject(desc);
    this.selectObject(desc.id);
    invalidateResults();
    saveLocal();
  },

  resetScene() {
    state.objects = createDefaultScene();
    selectedId = null;
    rebuildAll();
    ui.refreshObjectList();
    ui.refreshParams();
    invalidateResults();
    saveLocal();
  },

  setObjectName(id, name) {
    const desc = state.objects.find((o) => o.id === id);
    if (!desc) return;
    desc.name = name;
    rebuildObject(desc);
    ui.refreshObjectList();
    ui.refreshParams();
    saveLocal();
  },

  setObjectParam(id, key, value) {
    const desc = state.objects.find((o) => o.id === id);
    if (!desc) return;
    desc.params[key] = value;
    rebuildObject(desc);
    if (desc.type !== 'chimney') rebuildChimneys();
    ui.refreshParams();
    invalidateResults();
    saveLocal();
  },

  setLocation(lat, lon) {
    if (isNaN(lat) || isNaN(lon)) return;
    state.location.lat = lat;
    state.location.lon = lon;
    initClimate();
    cachedSunTimes = sunTimes(currentDate(), lat, lon);
    rebuildSunPath();
    updateSun();
    invalidateResults('Location changed — press <b>Run analysis</b> to refresh the numbers.');
    saveLocal();
  },

  setSetting(key, value) {
    state.settings[key] = value;
    invalidateResults('PV assumptions changed — press <b>Run analysis</b> to refresh the numbers.');
    saveLocal();
  },

  setDate(str) {
    if (!str || isNaN(new Date(str).getTime())) return;
    dateStr = str;
    cachedSunTimes = sunTimes(currentDate(), state.location.lat, state.location.lon);
    rebuildSunPath();
    updateSun();
    ui.setTimeUI(dateStr, minutes);
    scheduleDayRefresh();
  },

  setMinutes(m) {
    minutes = m;
    updateSun();
    ui.setTimeUI(dateStr, minutes);
  },

  togglePlay() {
    playing = !playing;
    return playing;
  },

  async runAnalysis() {
    if (analysisRunning) return;
    const faces = [...objMap.values()].flatMap((o) => o.faces);
    if (faces.length === 0) {
      ui.setStale('No surfaces to analyze — enable “Analyze” on a building, pergola, balcony or panel.');
      return;
    }
    analysisRunning = true;
    document.getElementById('btn-run').disabled = true;
    try {
      const occluders = [...objectsRoot.children];
      const res = await runAnnualAnalysis({
        faces, occluders, climate,
        location: state.location, settings: state.settings,
        onProgress: (f, label) => ui.setProgress(true, f, label),
      });
      await runDayAnalysis({ results: res, occluders, date: currentDate(), location: state.location });
      results = res;
      selectedFaceId = res.reduce((a, b) => (b.specificYield > a.specificYield ? b : a)).id;
      ui.refreshResults(results, selectedFaceId, dayLabel());
      applyHeatmap();
    } catch (err) {
      console.error(err);
      ui.setStale(`Analysis failed: ${err.message}`);
    } finally {
      analysisRunning = false;
      document.getElementById('btn-run').disabled = false;
      ui.setProgress(false);
    }
  },

  async fetchWeather() {
    const btn = document.getElementById('btn-fetch-weather');
    btn.disabled = true;
    try {
      const clim = await fetchOpenMeteoClimatology(
        state.location.lat, state.location.lon,
        (f, label) => ui.setProgress(true, f, label)
      );
      climate = clim;
      cacheClimatology(clim);
      updateWeatherStatus();
      invalidateResults('Weather data updated — press <b>Run analysis</b> to refresh the numbers.');
    } catch (err) {
      console.error(err);
      ui.setWeatherStatus(`Weather fetch failed (${err.message}) — using ${climate.builtin ? 'built-in climatology' : 'previous data'}`);
    } finally {
      btn.disabled = false;
      ui.setProgress(false);
    }
  },

  setHeatmapMode(mode) {
    heatmapMode = mode;
    applyHeatmap();
  },

  selectFace(faceId) {
    selectedFaceId = faceId;
    ui.refreshResults(results, selectedFaceId, dayLabel());
  },

  exportOBJ() {
    const meshes = collectExportMeshes(objectsRoot.children);
    const { obj, mtl } = exportOBJ(meshes);
    download('sunshine-scene.obj', obj);
    download('scene.mtl', mtl);
  },

  exportDAE() {
    const meshes = collectExportMeshes(objectsRoot.children);
    download('sunshine-scene.dae', exportDAE(meshes), 'model/vnd.collada+xml');
  },

  saveJSON() {
    download('sunshine-scene.json', JSON.stringify({
      version: 1, location: state.location, settings: state.settings, objects: state.objects,
    }, null, 2), 'application/json');
  },

  loadJSONFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.objects)) throw new Error('not a scene file');
        Object.assign(state.location, data.location || {});
        Object.assign(state.settings, data.settings || {});
        state.objects = data.objects;
        ensureIdCounterAbove(state.objects);
        selectedId = null;
        rebuildAll();
        initClimate();
        document.getElementById('lat').value = state.location.lat;
        document.getElementById('lon').value = state.location.lon;
        ui.refreshObjectList();
        ui.refreshParams();
        rebuildSunPath();
        updateSun();
        invalidateResults();
        saveLocal();
      } catch (err) {
        alert('Could not load scene: ' + err.message);
      }
    };
    reader.readAsText(file);
  },
};

function dayLabel() {
  const d = currentDate();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// re-run the cheap single-day pass when the date changes (updates the day heatmap)
let dayRefreshTimer = null;
function scheduleDayRefresh() {
  if (!results) return;
  clearTimeout(dayRefreshTimer);
  dayRefreshTimer = setTimeout(async () => {
    if (!results) return;
    await runDayAnalysis({
      results, occluders: [...objectsRoot.children],
      date: currentDate(), location: state.location,
    });
    ui.refreshResults(results, selectedFaceId, dayLabel());
    if (heatmapMode === 'day') applyHeatmap();
  }, 350);
}

// ---------- pointer interaction ----------
const pointer = new THREE.Vector2();
const pickRay = new THREE.Raycaster();
let dragState = null;

function setPointer(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickObject(e) {
  setPointer(e);
  pickRay.setFromCamera(pointer, camera);
  const hits = pickRay.intersectObjects(objectsRoot.children, true);
  for (const h of hits) {
    let n = h.object;
    while (n && !n.userData.objId) n = n.parent;
    if (n) return { objId: n.userData.objId, point: h.point };
  }
  return null;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const hit = pickObject(e);
  if (!hit) {
    if (app.getSelectedId()) app.selectObject(null);
    return;
  }
  app.selectObject(hit.objId);
  const desc = state.objects.find((o) => o.id === hit.objId);
  const entry = objMap.get(hit.objId);
  controls.enabled = false;
  dragState = {
    desc, group: entry.group, moved: false,
    rotate: e.shiftKey,
    startRot: desc.params.rot || 0,
    startX: e.clientX,
    offset: new THREE.Vector3(hit.point.x - desc.params.x, 0, hit.point.z - desc.params.z),
    // drag on a horizontal plane at the grab height, else elevated grab points jump
    plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y),
  };
}

function onPointerMove(e) {
  if (!dragState) return;
  if (dragState.rotate) {
    if (typeof dragState.desc.params.rot !== 'number') return;
    const rot = ((dragState.startRot + (e.clientX - dragState.startX) * 0.5) % 360 + 360) % 360;
    dragState.desc.params.rot = Math.round(rot);
    dragState.group.rotation.y = -rot * (Math.PI / 180);
    dragState.moved = true;
  } else {
    setPointer(e);
    pickRay.setFromCamera(pointer, camera);
    const p = new THREE.Vector3();
    if (!pickRay.ray.intersectPlane(dragState.plane, p)) return;
    dragState.desc.params.x = Math.round((p.x - dragState.offset.x) * 10) / 10;
    dragState.desc.params.z = Math.round((p.z - dragState.offset.z) * 10) / 10;
    dragState.group.position.set(dragState.desc.params.x, 0, dragState.desc.params.z);
    dragState.moved = true;
  }
}

function onPointerUp() {
  if (!dragState) return;
  const { desc, moved } = dragState;
  dragState = null;
  controls.enabled = true;
  if (moved) {
    rebuildObject(desc); // refresh analysis faces at the final transform
    if (desc.type !== 'chimney') rebuildChimneys();
    ui.refreshParams();
    invalidateResults();
    saveLocal();
  }
}

// ---------- resize & render loop ----------
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

let lastPlayTick = 0;
function animate(t) {
  requestAnimationFrame(animate);
  if (playing && t - lastPlayTick > 30) {
    lastPlayTick = t;
    minutes = (minutes + 4) % 1440;
    updateSun();
    ui.setTimeUI(dateStr, minutes);
  }
  controls.update();
  renderer.render(scene, camera);
}

// ---------- boot ----------
function boot() {
  if (!loadLocal()) state.objects = createDefaultScene();
  initClimate();
  ui.initUI(app);
  rebuildAll();
  ui.refreshObjectList();
  ui.refreshParams();
  cachedSunTimes = sunTimes(currentDate(), state.location.lat, state.location.lon);
  ui.setTimeUI(dateStr, minutes);
  rebuildSunPath();
  updateSun();
  resize();
  animate(0);
}

boot();
window.app = app; // for debugging
