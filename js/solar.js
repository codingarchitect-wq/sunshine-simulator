// Solar geometry — NOAA solar position algorithm (accuracy ~0.1°, fine for PV work).
// Coordinate convention used across the app: X = east, Y = up, Z = south.
// Azimuth: degrees clockwise from north (0=N, 90=E, 180=S, 270=W).

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const SOLAR_CONSTANT = 1361; // W/m²

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Core NOAA computation for a JS Date (which is an absolute instant — timezone-safe).
export function sunPosition(date, lat, lon) {
  const jd = julianDay(date);
  const T = (jd - 2451545.0) / 36525.0;

  const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = (125.04 - 1934.136 * T) * RAD;
  const lambda = (trueLong - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;

  const eps0 =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;

  const declination = Math.asin(Math.sin(eps) * Math.sin(lambda)); // rad

  // Equation of time (minutes)
  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * RAD;
  const eot =
    4 * DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));

  // Minutes past UTC midnight
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (utcMinutes + eot + 4 * lon + 1440 * 4) % 1440; // true solar time
  const H = (tst / 4 - 180) * RAD; // hour angle, rad (negative = morning)

  const latR = lat * RAD;
  const cosZ =
    Math.sin(latR) * Math.sin(declination) +
    Math.cos(latR) * Math.cos(declination) * Math.cos(H);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  const elevation = 90 - zenith * DEG;

  // Azimuth from north, clockwise
  let azimuth =
    180 +
    DEG *
      Math.atan2(
        Math.sin(H),
        Math.cos(H) * Math.sin(latR) - Math.tan(declination) * Math.cos(latR)
      );
  azimuth = ((azimuth % 360) + 360) % 360;

  return { azimuth, elevation, declination: declination * DEG, eot };
}

// Unit vector pointing FROM the scene TOWARDS the sun. X=E, Y=up, Z=S.
export function sunDirection(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * RAD;
  const el = elevationDeg * RAD;
  return {
    x: Math.sin(az) * Math.cos(el),
    y: Math.sin(el),
    z: -Math.cos(az) * Math.cos(el),
  };
}

// Sunrise / sunset for the local calendar day of `date` (scan-based, robust at high lat).
export function sunTimes(date, lat, lon) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
  let sunrise = null, sunset = null;
  let prevUp = sunPosition(start, lat, lon).elevation > -0.833;
  for (let m = 2; m <= 1440; m += 2) {
    const t = new Date(start.getTime() + m * 60000);
    const up = sunPosition(t, lat, lon).elevation > -0.833;
    if (up && !prevUp && !sunrise) sunrise = t;
    if (!up && prevUp) sunset = t;
    prevUp = up;
  }
  return { sunrise, sunset };
}

export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.floor((date - start) / 86400000) + 1;
}

// Sun–earth distance correction factor E0
export function eccentricityFactor(doy) {
  return 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
}

// Extraterrestrial normal irradiance for a day of year (W/m²)
export function extraterrestrialNormal(doy) {
  return SOLAR_CONSTANT * eccentricityFactor(doy);
}

// Kasten & Young relative air mass
export function airMass(elevationDeg) {
  if (elevationDeg <= 0) return Infinity;
  const z = 90 - elevationDeg;
  return 1 / (Math.cos(z * RAD) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
}

// Haurwitz clear-sky global horizontal irradiance (W/m²)
export function clearSkyGHI(elevationDeg) {
  if (elevationDeg <= 0) return 0;
  const cosZ = Math.cos((90 - elevationDeg) * RAD);
  return 1098 * cosZ * Math.exp(-0.057 / cosZ);
}

// Simple clear-sky DNI (Meinel) — used only to cap the Erbs decomposition
export function clearSkyDNI(elevationDeg) {
  if (elevationDeg <= 0) return 0;
  const am = airMass(elevationDeg);
  return SOLAR_CONSTANT * 0.7 ** (am ** 0.678);
}
