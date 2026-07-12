// PV panel catalog and per-surface sizing.
// Sizing is pure post-processing on analysis results: insolation (kWh/m²) does not
// depend on the panel choice, so changing type/count never requires re-analysis.

export const PANEL_TYPES = {
  anker500: { label: 'Anker SOLIX 500 W bifacial · 1.96 × 1.13 m', watts: 500, width: 1.961, height: 1.134 },
  anker440: { label: 'Anker SOLIX 440 W · 1.76 × 1.13 m', watts: 440, width: 1.762, height: 1.134 },
};
export const DEFAULT_PANEL = 'anker500';

export const panelArea = (type) => PANEL_TYPES[type].width * PANEL_TYPES[type].height;

// How many panels fit on a face, in half-panel steps (balcony setups often use a
// half-size module on one side). Usable fraction of the face area over the panel
// area; free-panel surfaces are themselves the mounting area, so no packing derating.
export function maxPanelsFor(face, packingFactor, type) {
  const packing = face.kind === 'panel' ? 1 : packingFactor;
  return Math.max(0, Math.floor(((face.area * packing) / panelArea(type)) * 2) / 2);
}

// Fill in panelType/panelCount/maxPanels/kwp/usableArea/yieldKWh/specificYield on each
// face result. panelConfig: { [faceId]: { type?, count? } } — missing = auto (max fit).
export function applyPvSizing(results, panelConfig = {}, settings) {
  for (const f of results) {
    const cfg = panelConfig[f.id] || {};
    const type = PANEL_TYPES[cfg.type] ? cfg.type : DEFAULT_PANEL;
    const maxN = maxPanelsFor(f, settings.packingFactor, type);
    // half-panel steps; a manual count MAY exceed the area fit (overhanging mounts,
    // common on balcony railings) — flagged so the UI can warn
    const count = cfg.count != null
      ? Math.max(0, Math.round(cfg.count * 2) / 2)
      : maxN;
    f.exceedsFit = count > maxN;
    f.panelType = type;
    f.panelCount = count;
    f.maxPanels = maxN;
    f.kwp = (count * PANEL_TYPES[type].watts) / 1000;
    f.usableArea = count * panelArea(type);
    f.yieldKWh = f.kwp * f.annualPOA * settings.performanceRatio;
    f.specificYield = f.annualPOA * settings.performanceRatio;
  }
  return results;
}
