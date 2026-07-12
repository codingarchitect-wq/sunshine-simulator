// Climatology: mean irradiance per (month, local clock hour) — the data structure that
// drives all energy numbers. Two providers fill it:
//   - buildSyntheticClimatology(): built-in fallback, synthesized from long-term monthly
//     GHI totals for Stuttgart (PVGIS/DWD magnitude) + Haurwitz clear-sky shape + Erbs split.
//   - weather.js: real hourly ERA5 data from Open-Meteo, aggregated to the same shape.
//
// Shape: { source, ghi[12][24], dni[12][24], dhi[12][24] }  (W/m², mean over the hour bin)

import { sunPosition, extraterrestrialNormal, clearSkyGHI, clearSkyDNI } from './solar.js';

// Long-term monthly mean daily GHI for Stuttgart, kWh/m²/day (annual ≈ 1149 kWh/m²)
export const STUTTGART_MONTHLY_GHI = [0.97, 1.79, 2.90, 4.30, 5.03, 5.50, 5.42, 4.61, 3.33, 2.00, 1.07, 0.77];

export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const REF_YEAR = 2025; // non-leap reference year for representative days

// Erbs correlation: split GHI into diffuse/direct given clearness index kt.
export function erbsSplit(ghi, elevationDeg, doy) {
  if (ghi <= 0 || elevationDeg <= 0) return { dni: 0, dhi: Math.max(0, ghi) };
  const cosZ = Math.sin((elevationDeg * Math.PI) / 180);
  const i0h = extraterrestrialNormal(doy) * cosZ;
  const kt = Math.min(1, ghi / Math.max(1e-6, i0h));
  let kd;
  if (kt <= 0.22) kd = 1 - 0.09 * kt;
  else if (kt <= 0.8)
    kd = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  else kd = 0.165;
  const dhi = kd * ghi;
  let dni = (ghi - dhi) / Math.max(0.026, cosZ); // avoid blow-up at very low sun
  dni = Math.min(dni, clearSkyDNI(elevationDeg) * 1.0);
  return { dni: Math.max(0, dni), dhi: Math.max(0, dhi) };
}

// Two-state sky model: each month is treated as a mix of clear days (Haurwitz GHI,
// Meinel DNI) and heavily overcast days (18% of clear-sky GHI, all diffuse), with the
// clear-day fraction calibrated so the month integrates to its long-term GHI mean.
// This reproduces realistic mean beam fractions, which a single "average dim day"
// (uniform scaling + Erbs) badly underestimates.
const OVERCAST_FRACTION = 0.18;

export function buildSyntheticClimatology(lat, lon, monthlyDailyGHI = STUTTGART_MONTHLY_GHI) {
  const ghi = [], dni = [], dhi = [];
  for (let m = 0; m < 12; m++) {
    const gRow = new Array(24).fill(0);
    const bRow = new Array(24).fill(0);
    const dRow = new Array(24).fill(0);

    // Clear-sky hourly profile (hour centers, local clock time)
    const cs = [];
    let csDaily = 0; // Wh/m²
    for (let h = 0; h < 24; h++) {
      const t = new Date(REF_YEAR, m, 15, h, 30);
      const { elevation } = sunPosition(t, lat, lon);
      cs.push({ g: clearSkyGHI(elevation), elevation });
      csDaily += cs[h].g;
    }
    const target = monthlyDailyGHI[m] * 1000; // Wh/m²
    const ratio = csDaily > 0 ? Math.min(1, target / csDaily) : 0;
    const fClear = Math.min(1, Math.max(0, (ratio - OVERCAST_FRACTION) / (1 - OVERCAST_FRACTION)));
    for (let h = 0; h < 24; h++) {
      const { g: gClear, elevation } = cs[h];
      if (gClear <= 0) continue;
      const cosZ = Math.sin((elevation * Math.PI) / 180);
      const dniClear = clearSkyDNI(elevation);
      const dhiClear = Math.max(0, gClear - dniClear * cosZ);
      const gOvercast = OVERCAST_FRACTION * gClear;
      gRow[h] = fClear * gClear + (1 - fClear) * gOvercast;
      bRow[h] = fClear * dniClear;
      dRow[h] = fClear * dhiClear + (1 - fClear) * gOvercast;
    }
    ghi.push(gRow); dni.push(bRow); dhi.push(dRow);
  }
  return { source: 'built-in climatology (Stuttgart long-term means)', builtin: true, ghi, dni, dhi };
}

// Linear interpolation between hour-bin centers (bin h covers h:00–h:59, center h+0.5)
export function climateAt(clim, month, hourFloat) {
  const x = hourFloat - 0.5;
  let h0 = Math.floor(x);
  const f = x - h0;
  let h1 = h0 + 1;
  if (h0 < 0) { h0 = 0; h1 = 0; }
  if (h1 > 23) { h0 = 23; h1 = 23; }
  const pick = (arr) => arr[month][h0] * (1 - f) + arr[month][h1] * f;
  return { ghi: pick(clim.ghi), dni: pick(clim.dni), dhi: pick(clim.dhi) };
}

// Annual GHI of a climatology, kWh/m²/yr — for the status display & sanity checks
export function annualGHI(clim) {
  let sum = 0;
  for (let m = 0; m < 12; m++)
    for (let h = 0; h < 24; h++) sum += clim.ghi[m][h] * DAYS_IN_MONTH[m];
  return sum / 1000;
}
