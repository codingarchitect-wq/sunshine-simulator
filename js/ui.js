// DOM layer. main.js hands us an `app` facade; we render panels and forward events.

import { OBJECT_TYPES, ADD_PRESETS, compass8 } from './objects.js';
import { renderMonthlyChart } from './charts.js';
import { rampCSS } from './heatmap.js';

let app;
const $ = (id) => document.getElementById(id);

const SETTINGS_SCHEMA = [
  { key: 'packingFactor', label: 'Roof area usable for panels', min: 0.2, max: 1, step: 0.05, hint: 'fraction of a face you can actually cover' },
  { key: 'kwpPerM2', label: 'Panel power (kWp per m²)', min: 0.1, max: 0.3, step: 0.005 },
  { key: 'performanceRatio', label: 'System performance ratio', min: 0.5, max: 0.95, step: 0.01, hint: 'inverter, wiring, temperature, soiling losses' },
  { key: 'albedo', label: 'Ground albedo', min: 0.05, max: 0.8, step: 0.05 },
];

export function initUI(appFacade) {
  app = appFacade;

  // top bar
  $('lat').value = app.state.location.lat;
  $('lon').value = app.state.location.lon;
  const onLoc = () => app.setLocation(parseFloat($('lat').value), parseFloat($('lon').value));
  $('lat').addEventListener('change', onLoc);
  $('lon').addEventListener('change', onLoc);
  $('btn-run').addEventListener('click', () => app.runAnalysis());
  $('btn-fetch-weather').addEventListener('click', () => app.fetchWeather());
  $('btn-export-obj').addEventListener('click', () => app.exportOBJ());
  $('btn-export-dae').addEventListener('click', () => app.exportDAE());
  $('btn-save').addEventListener('click', () => app.saveJSON());
  $('btn-load').addEventListener('click', () => $('file-load').click());
  $('file-load').addEventListener('change', (e) => {
    if (e.target.files[0]) app.loadJSONFile(e.target.files[0]);
    e.target.value = '';
  });

  // add-object buttons (types + presets)
  const grid = $('add-buttons');
  for (const [type, def] of Object.entries(OBJECT_TYPES)) {
    const b = document.createElement('button');
    b.textContent = `${def.icon} ${def.label}`;
    b.addEventListener('click', () => app.addObject(type));
    grid.appendChild(b);
  }
  for (const preset of ADD_PRESETS) {
    const b = document.createElement('button');
    b.textContent = `${preset.icon} ${preset.label}`;
    b.title = `${OBJECT_TYPES[preset.type].label} preset`;
    b.addEventListener('click', () => app.addObject(preset.type, preset));
    grid.appendChild(b);
  }
  $('btn-delete').addEventListener('click', () => app.deleteSelected());
  $('btn-duplicate').addEventListener('click', () => app.duplicateSelected());
  $('btn-undo').addEventListener('click', () => app.undo());
  $('btn-redo').addEventListener('click', () => app.redo());
  $('btn-home-view').addEventListener('click', () => app.resetView());
  $('btn-top-view').addEventListener('click', () => app.topView());
  $('btn-reset').addEventListener('click', () => {
    if (confirm('Replace the current scene with the demo scene?')) app.resetScene();
  });

  // settings
  const sBox = $('settings');
  for (const s of SETTINGS_SCHEMA) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = s.label;
    if (s.hint) label.title = s.hint;
    const input = document.createElement('input');
    input.type = 'number';
    Object.assign(input, { min: s.min, max: s.max, step: s.step });
    input.value = app.state.settings[s.key];
    input.addEventListener('change', () => app.setSetting(s.key, clamp(parseFloat(input.value), s.min, s.max)));
    row.append(label, input);
    sBox.appendChild(row);
  }

  // time bar
  $('date').addEventListener('change', () => app.setDate($('date').value));
  document.querySelectorAll('#timebar .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const year = ($('date').value || '2026').slice(0, 4);
      app.setDate(`${year}-${chip.dataset.day}`);
    })
  );
  $('time').addEventListener('input', () => app.setMinutes(+$('time').value));
  $('btn-play').addEventListener('click', () => {
    const playing = app.togglePlay();
    $('btn-play').textContent = playing ? '⏸' : '▶';
  });

  // results
  $('heatmap-mode').addEventListener('change', () => app.setHeatmapMode($('heatmap-mode').value));

  window.addEventListener('keydown', (e) => {
    if (isTyping()) return;
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[e.key] && app.getSelectedIds().length && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.shiftKey) {
        // shift+←/→ rotate the selection (alt = fine steps)
        const step = e.altKey ? 1 : 5;
        if (e.key === 'ArrowLeft') app.rotateSelected(-step);
        else if (e.key === 'ArrowRight') app.rotateSelected(step);
      } else {
        // arrows move in world axes: up=N, down=S, left=W, right=E (alt = fine steps)
        const step = e.altKey ? 0.1 : 0.5;
        const [dx, dz] = arrows[e.key];
        app.nudgeSelected(dx * step, dz * step);
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      app.deleteSelected();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) app.redo();
      else app.undo();
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      app.redo();
      e.preventDefault();
    }
  });
}

export function refreshHistory(canUndo, canRedo) {
  $('btn-undo').disabled = !canUndo;
  $('btn-redo').disabled = !canRedo;
}

const isTyping = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
const clamp = (v, a, b) => Math.min(b, Math.max(a, isNaN(v) ? a : v));

// ---------- refreshers (called by main) ----------

export function refreshObjectList() {
  const list = $('object-list');
  list.innerHTML = '';
  const selIds = app.getSelectedIds();
  for (const desc of app.getObjects()) {
    const li = document.createElement('li');
    li.className = selIds.includes(desc.id) ? 'selected' : '';
    const name = document.createElement('span');
    name.textContent = `${OBJECT_TYPES[desc.type].icon} ${desc.name}`;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = OBJECT_TYPES[desc.type].label;
    li.append(name, tag);
    li.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) app.toggleSelect(desc.id);
      else app.selectObject(desc.id);
    });
    list.appendChild(li);
  }
  $('btn-delete').disabled = $('btn-duplicate').disabled = selIds.length === 0;
}

export function refreshParams() {
  const box = $('params');
  box.innerHTML = '';
  const selIds = app.getSelectedIds();
  if (selIds.length > 1) {
    $('params-title').textContent = `Properties — ${selIds.length} objects`;
    let html = '';
    const m = selIds.length === 2 ? app.getMeasurement() : null;
    if (m) {
      html += `<div class="measure"><span>Nearest gap</span><b>${m.nearest.toFixed(2)} m</b></div>` +
        `<div class="measure"><span>Center to center</span><b>${m.center.toFixed(2)} m</b></div>`;
    }
    html += `<p class="note">${selIds.length === 2 ? 'The dashed line in the 3D view marks the nearest gap. ' : ''}Drag any selected object to move the whole group; shift-drag rotates the group around its center. Select a single object to edit its properties.</p>`;
    box.innerHTML = html;
    return;
  }
  const desc = app.getObjects().find((o) => o.id === app.getSelectedId());
  $('params-title').textContent = desc ? `Properties — ${desc.name}` : 'Properties';
  if (!desc) {
    box.innerHTML = '<p class="note">Select an object (click it in the 3D view or in the list). ⌘/Ctrl-click adds to the selection.</p>';
    return;
  }
  // name
  const nameRow = document.createElement('div');
  nameRow.className = 'param-row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = desc.name;
  nameInput.addEventListener('change', () => app.setObjectName(desc.id, nameInput.value || desc.name));
  nameRow.append(nameLabel, nameInput);
  box.appendChild(nameRow);

  for (const def of OBJECT_TYPES[desc.type].params) {
    if (def.showIf && !def.showIf(desc.params)) continue;
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = def.label;
    let input;
    if (def.kind === 'select') {
      input = document.createElement('select');
      for (const opt of def.options) {
        const o = document.createElement('option');
        o.value = o.textContent = opt;
        input.appendChild(o);
      }
      input.value = desc.params[def.key];
      input.addEventListener('change', () => app.setObjectParam(desc.id, def.key, input.value));
    } else if (def.kind === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!desc.params[def.key];
      input.addEventListener('change', () => app.setObjectParam(desc.id, def.key, input.checked));
    } else {
      input = document.createElement('input');
      input.type = 'number';
      Object.assign(input, { min: def.min, max: def.max, step: def.step });
      input.value = round2(desc.params[def.key]);
      input.addEventListener('change', () =>
        app.setObjectParam(desc.id, def.key, clamp(parseFloat(input.value), def.min, def.max))
      );
    }
    row.append(label, input);
    box.appendChild(row);
  }
}

const round2 = (v) => Math.round(v * 100) / 100;

export function refreshSun(info) {
  const el = $('sun-readout');
  if (info.elevation > 0) {
    el.innerHTML = `Sun <b>${compass8(info.azimuth)}</b> · azimuth <b>${info.azimuth.toFixed(0)}°</b> · elevation <b>${info.elevation.toFixed(1)}°</b>`;
  } else {
    el.innerHTML = `Sun below horizon (elevation ${info.elevation.toFixed(1)}°)`;
  }
  const st = $('suntimes');
  if (info.sunrise && info.sunset) {
    const len = (info.sunset - info.sunrise) / 60000;
    st.textContent = `☀ ${hm(info.sunrise)} → ${hm(info.sunset)} · ${Math.floor(len / 60)} h ${Math.round(len % 60)} min daylight`;
  } else {
    st.textContent = '';
  }
}

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function setTimeUI(dateStr, minutes) {
  $('date').value = dateStr;
  $('time').value = minutes;
  $('clock').textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function setProgress(visible, frac = 0, label = '') {
  $('progress').hidden = !visible;
  $('progress-bar').style.width = `${Math.round(frac * 100)}%`;
  $('progress-label').textContent = label;
}

export function setWeatherStatus(text, live = false) {
  const el = $('weather-status');
  el.textContent = text;
  el.title = text;
  el.classList.toggle('live', live);
}

export function setStale(msg) {
  $('results-note').hidden = false;
  $('results-note').innerHTML = msg;
}

const fmtI = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });

export function refreshResults(results, selectedFaceId, dayLabel) {
  const table = $('results-table');
  const total = $('results-total');
  const chartPanel = $('chart-panel');
  if (!results || results.length === 0) {
    table.innerHTML = '';
    total.innerHTML = '';
    chartPanel.hidden = true;
    $('heatmap-controls').hidden = true;
    return;
  }
  $('results-note').hidden = true;
  $('heatmap-controls').hidden = false;

  const bestId = results.reduce((a, b) => (b.specificYield > a.specificYield ? b : a)).id;
  let html = `<table><tr><th>Surface</th><th title="Plane-of-array insolation after shading">kWh/m²·yr</th><th title="Annual energy lost to shading">shade</th><th title="Average hours of direct (unblocked) sun per day, annual mean">☀ h/d</th><th title="Estimated AC yield with the PV assumptions below">est. kWh/yr</th></tr>`;
  for (const f of results) {
    const sel = f.id === selectedFaceId ? ' class="sel"' : '';
    const best = f.id === bestId && !sel ? ' class="best"' : '';
    html += `<tr${sel} data-face="${f.id}"><td>${esc(shortLabel(f.label))}</td><td${best}>${fmtI(f.annualPOA)}</td><td>${f.shadingLossPct.toFixed(0)}%</td><td>${(f.sunHoursYr / 365).toFixed(1)}</td><td>${fmtI(f.yieldKWh)}</td></tr>`;
  }
  html += '</table>';
  table.innerHTML = html;
  table.querySelectorAll('tr[data-face]').forEach((tr) =>
    tr.addEventListener('click', () => app.selectFace(tr.dataset.face))
  );

  const f = results.find((r) => r.id === selectedFaceId) || results[0];
  const sumYield = results.reduce((s, r) => s + r.yieldKWh, 0);
  const sumKwp = results.reduce((s, r) => s + r.kwp, 0);
  total.innerHTML =
    `<div class="big">${fmtI(f.annualPOA)} kWh/m²·yr</div>` +
    `<div>${esc(shortLabel(f.label))} — ${f.area.toFixed(1)} m², tilt ${f.tilt.toFixed(0)}°, facing ${compass8(f.az)} (${f.az.toFixed(0)}°)</div>` +
    `<div class="note">unshaded ${fmtI(f.unshadedPOA)} kWh/m²·yr · shading −${f.shadingLossPct.toFixed(1)}% · ` +
    `${(f.sunHoursYr / 365).toFixed(1)} h direct sun/day (yr avg)${f.sunHoursDay != null ? ` · ${f.sunHoursDay.toFixed(1)} h on ${dayLabel}` : ''}</div>` +
    `<div class="note">≈ ${f.kwp.toFixed(1)} kWp on ${f.usableArea.toFixed(1)} m² → <b>${fmtI(f.yieldKWh)} kWh/yr</b> (${fmtI(f.specificYield)} kWh/kWp)</div>` +
    `<div class="note" style="border-top:1px solid var(--grid);margin-top:6px;padding-top:6px">All ${results.length} analyzed surfaces together: ≈ ${sumKwp.toFixed(1)} kWp → ${fmtI(sumYield)} kWh/yr</div>`;

  chartPanel.hidden = false;
  $('chart-title').textContent = `Monthly insolation — ${shortLabel(f.label)}`;
  renderMonthlyChart($('chart'), f.monthlyPOA, { unit: 'kWh/m²', decimals: 0 });
}

const shortLabel = (l) => l.replace(' — ', ' · ');
const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export function setHeatmapLegend(vmin, vmax, unit) {
  const box = $('heatmap-legend');
  if (vmin == null) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    `<div class="legend-bar" style="background:${rampCSS()}"></div>` +
    `<div class="legend-labels"><span>${fmtI(vmin)} ${unit}</span><span>${fmtI(vmax)} ${unit}</span></div>`;
}
