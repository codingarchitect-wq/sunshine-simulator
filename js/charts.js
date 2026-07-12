// Monthly bar chart (single series → series-1 blue, no legend; title carries the name).
// Follows the dataviz mark specs: thin bars, 4px rounded top data-ends anchored to the
// baseline, recessive hairline grid, muted axis ink, per-mark hover tooltip.

const INK_MUTED = '#898781';
const GRID = '#2c2c2a';
const BASELINE = '#383835';
const BAR = '#3987e5';
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

let tooltip = null;
function getTooltip() {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'viz-tooltip';
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

export function renderMonthlyChart(container, values, { unit = 'kWh/m²', decimals = 0 } = {}) {
  const W = 312, H = 160;
  const padL = 34, padR = 6, padT = 10, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vmax = Math.max(...values, 1e-9);
  // round the axis max up to a tidy step
  const step = niceStep(vmax / 3);
  const axisMax = Math.ceil(vmax / step) * step;

  const slot = plotW / 12;
  const barW = slot * 0.55;
  const y = (v) => padT + plotH * (1 - v / axisMax);

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly values">`;
  // hairline grid + y labels
  for (let g = 0; g <= axisMax + 1e-9; g += step) {
    const gy = y(g);
    s += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${g === 0 ? BASELINE : GRID}" stroke-width="1"/>`;
    s += `<text x="${padL - 5}" y="${gy + 3.5}" text-anchor="end" font-size="9.5" fill="${INK_MUTED}">${fmt(g, decimals)}</text>`;
  }
  // bars: rounded top corners, square bottom, anchored to the baseline
  values.forEach((v, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const top = y(v), bot = y(0);
    const h = Math.max(0, bot - top);
    const r = Math.min(4, h, barW / 2);
    const d = `M${x},${bot} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${bot} Z`;
    s += `<path class="bar" d="${d}" fill="${BAR}" data-i="${i}"/>`;
    // invisible hover target wider than the mark
    s += `<rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent" data-i="${i}"/>`;
    s += `<text x="${x + barW / 2}" y="${H - 7}" text-anchor="middle" font-size="9.5" fill="${INK_MUTED}">${MONTHS[i]}</text>`;
  });
  s += '</svg>';
  container.innerHTML = s;

  const tip = getTooltip();
  const svg = container.querySelector('svg');
  svg.addEventListener('pointermove', (e) => {
    const t = e.target.closest('[data-i]');
    if (!t) { tip.style.display = 'none'; return; }
    const i = +t.dataset.i;
    tip.innerHTML = `<span class="k">${MONTH_FULL[i]}</span> &nbsp;<b>${fmt(values[i], Math.max(decimals, 1))}</b> ${unit}`;
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 180) + 'px';
    tip.style.top = e.clientY - 34 + 'px';
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
}

function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const n = raw / mag;
  if (n <= 1) return mag;
  if (n <= 2) return 2 * mag;
  if (n <= 5) return 5 * mag;
  return 10 * mag;
}

function fmt(v, decimals) {
  return v.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}
