// Real historical weather: Open-Meteo Historical Weather API (ERA5 reanalysis,
// free for non-commercial use, CORS-enabled — https://open-meteo.com/en/docs/historical-weather-api).
// We pull hourly GHI / DNI / DHI for 5 full years and aggregate them into the same
// month × hour climatology shape that climate.js produces.

const YEARS = [2020, 2021, 2022, 2023, 2024];

export async function fetchOpenMeteoClimatology(lat, lon, onProgress = () => {}) {
  const sums = { ghi: zeros(), dni: zeros(), dhi: zeros() };
  const counts = zeros();

  for (let i = 0; i < YEARS.length; i++) {
    const y = YEARS[i];
    onProgress(i / YEARS.length, `Downloading ${y} hourly irradiance…`);
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&start_date=${y}-01-01&end_date=${y}-12-31` +
      `&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation` +
      `&timezone=Europe%2FBerlin`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();
    const H = data.hourly;
    if (!H || !H.time) throw new Error('Open-Meteo: unexpected response shape');
    for (let k = 0; k < H.time.length; k++) {
      const g = H.shortwave_radiation[k];
      const b = H.direct_normal_irradiance[k];
      const d = H.diffuse_radiation[k];
      if (g == null || b == null || d == null) continue;
      // time format: "2020-01-01T00:00" (local). Bin by month & hour.
      const month = +H.time[k].slice(5, 7) - 1;
      const hour = +H.time[k].slice(11, 13);
      sums.ghi[month][hour] += g;
      sums.dni[month][hour] += b;
      sums.dhi[month][hour] += d;
      counts[month][hour]++;
    }
  }
  onProgress(1, 'Aggregating…');

  const clim = { ghi: zeros(), dni: zeros(), dhi: zeros() };
  for (let m = 0; m < 12; m++)
    for (let h = 0; h < 24; h++) {
      const n = counts[m][h] || 1;
      clim.ghi[m][h] = sums.ghi[m][h] / n;
      clim.dni[m][h] = sums.dni[m][h] / n;
      clim.dhi[m][h] = sums.dhi[m][h] / n;
    }
  clim.source = `Open-Meteo ERA5 ${YEARS[0]}–${YEARS.at(-1)} @ ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  clim.builtin = false;
  return clim;
}

function zeros() {
  return Array.from({ length: 12 }, () => new Array(24).fill(0));
}

const CACHE_KEY = 'sunshine-sim-weather-v1';

export function cacheClimatology(clim) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(clim)); } catch { /* quota */ }
}

export function loadCachedClimatology(lat, lon) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const clim = JSON.parse(raw);
    // Only reuse if it was fetched for (roughly) the same spot
    if (clim.source && clim.source.includes(`${lat.toFixed(3)}, ${lon.toFixed(3)}`)) return clim;
    return null;
  } catch { return null; }
}
