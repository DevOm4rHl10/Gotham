import { SlippyMap, toWorld } from './map.js';

const DATA = './data/';
const DETAIL_ZOOM = 11;            // switch from 1.6 km to 400 m hexes
const PALETTE = ['#2e4a66', '#4f7390', '#8c8b6e', '#c98a2b', '#f0a93a', '#ffd46b', '#fff3c4'];
const fmt = new Intl.NumberFormat('en-GB');
const fmt1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const monthName = (m, style = 'long') =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: style, year: 'numeric' });

// ---------- grid: mirrors pipeline/grid.py ----------
const R = 6371007.2, LAT0 = (52 * Math.PI) / 180, LON0 = (10 * Math.PI) / 180, SQ3 = Math.sqrt(3);
function project(lat, lng) {
  const phi = (lat * Math.PI) / 180, lam = (lng * Math.PI) / 180 - LON0;
  const k = Math.sqrt(2 / (1 + Math.sin(LAT0) * Math.sin(phi) + Math.cos(LAT0) * Math.cos(phi) * Math.cos(lam)));
  return [R * k * Math.cos(phi) * Math.sin(lam),
    R * k * (Math.cos(LAT0) * Math.sin(phi) - Math.sin(LAT0) * Math.cos(phi) * Math.cos(lam))];
}
function unproject(x, y) {
  const rho = Math.hypot(x, y);
  if (rho === 0) return [52, 10];
  const c = 2 * Math.asin(rho / (2 * R));
  const phi = Math.asin(Math.cos(c) * Math.sin(LAT0) + (y * Math.sin(c) * Math.cos(LAT0)) / rho);
  const lam = LON0 + Math.atan2(x * Math.sin(c), rho * Math.cos(LAT0) * Math.cos(c) - y * Math.sin(LAT0) * Math.sin(c));
  return [(phi * 180) / Math.PI, (lam * 180) / Math.PI];
}
function toCell(x, y, size) {
  const qf = ((SQ3 / 3) * x - y / 3) / size, rf = ((2 / 3) * y) / size, sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf);
  const s = Math.round(sf), dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
  return [q, r];
}
const center = (q, r, size) => [size * (SQ3 * q + (SQ3 / 2) * r), size * 1.5 * r];
const areaKm2 = (size) => (1.5 * SQ3 * size * size) / 1e6;
const NEIGHBOURS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
function cornersWorld(q, r, size) {
  const [cx, cy] = center(q, r, size);
  const out = new Float64Array(12);
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i - 30) * Math.PI) / 180;
    const [w0, w1] = toWorld(...unproject(cx + size * Math.cos(a), cy + size * Math.sin(a)));
    out[i * 2] = w0; out[i * 2 + 1] = w1;
  }
  return out;
}

// ---------- state ----------
const state = { meta: null, month: null, monthCache: new Map(), zones: [], selected: -1,
  detailIndex: null, detail: new Map(), shown: 10 };

// ---------- hex layer ----------
class HexLayer {
  constructor(size, cells, density, breaks) {
    this.size = size;
    this.n = cells.length;
    this.cells = cells;
    this.verts = new Float64Array(this.n * 12);
    this.box = new Float64Array(this.n * 4);
    this.bucket = new Uint8Array(this.n);
    this.index = new Map();
    const area = areaKm2(size);
    cells.forEach((c, i) => {
      const v = cornersWorld(c[0], c[1], size);
      this.verts.set(v, i * 12);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < 12; k += 2) { x0 = Math.min(x0, v[k]); x1 = Math.max(x1, v[k]); y0 = Math.min(y0, v[k + 1]); y1 = Math.max(y1, v[k + 1]); }
      this.box.set([x0, y0, x1, y1], i * 4);
      this.bucket[i] = bucketOf(density(c[2]) / area, breaks);
      this.index.set(`${c[0]},${c[1]}`, i);
    });
  }
  find(q, r) { const i = this.index.get(`${q},${r}`); return i === undefined ? null : this.cells[i]; }
  draw(ctx, map) {
    const { x0, y0, x1, y1 } = map.bounds();
    const s = map.scale, ox = map.w / 2 - map.view.x * s, oy = map.h / 2 - map.view.y * s;
    const px = this.size * 2 * s / 2.5e7; // rough on-screen size, for seam fix
    for (let b = 0; b < PALETTE.length; b++) {
      ctx.beginPath();
      for (let i = 0; i < this.n; i++) {
        if (this.bucket[i] !== b) continue;
        const j = i * 4;
        if (this.box[j + 2] < x0 || this.box[j] > x1 || this.box[j + 3] < y0 || this.box[j + 1] > y1) continue;
        const v = i * 12;
        ctx.moveTo(this.verts[v] * s + ox, this.verts[v + 1] * s + oy);
        for (let k = 2; k < 12; k += 2) ctx.lineTo(this.verts[v + k] * s + ox, this.verts[v + k + 1] * s + oy);
        ctx.closePath();
      }
      ctx.fillStyle = PALETTE[b];
      ctx.globalAlpha = 0.5 + 0.07 * b;
      ctx.fill();
      if (px < 8) { ctx.strokeStyle = PALETTE[b]; ctx.lineWidth = 0.6; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }
}

function bucketOf(v, br) {
  let b = 0;
  while (b < br.length && v > br[b]) b++;
  return b;
}

// ---------- zone outlines ----------
function zoneSegments(zone, size) {
  const set = new Set(zone.cells.map(([q, r]) => `${q},${r}`));
  const segs = [];
  for (const [q, r] of zone.cells) {
    const v = cornersWorld(q, r, size);
    NEIGHBOURS.forEach(([dq, dr], i) => {
      if (set.has(`${q + dq},${r + dr}`)) return;
      const j = (i + 1) % 6;
      segs.push(v[i * 2], v[i * 2 + 1], v[j * 2], v[j * 2 + 1]);
    });
  }
  return new Float64Array(segs);
}

const zoneLayer = {
  draw(ctx, map) {
    const s = map.scale, ox = map.w / 2 - map.view.x * s, oy = map.h / 2 - map.view.y * s;
    const path = (segs) => {
      ctx.beginPath();
      for (let k = 0; k < segs.length; k += 4) {
        ctx.moveTo(segs[k] * s + ox, segs[k + 1] * s + oy);
        ctx.lineTo(segs[k + 2] * s + ox, segs[k + 3] * s + oy);
      }
    };
    if (map.view.z < 7.5) return;
    ctx.lineCap = 'round';
    state.zones.forEach((z, i) => {
      if (i === state.selected) return;
      path(z.segs);
      ctx.strokeStyle = 'rgba(19,32,47,.85)'; ctx.lineWidth = 3.5; ctx.stroke();
      ctx.strokeStyle = '#fff3c4'; ctx.lineWidth = 1.4; ctx.stroke();
    });
    const sel = state.zones[state.selected];
    if (sel) {
      path(sel.segs);
      ctx.strokeStyle = 'rgba(19,32,47,.9)'; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
    }
  },
};

// ---------- coverage notes drawn on the map ----------
const notesLayer = {
  below: false,
  draw(ctx, map) {
    if (map.view.z > 9.5 || !state.meta) return;
    const notes = [[56.6, -4.3, 'Scotland', 'Only British Transport Police data']];
    for (const f of state.meta.coverage.missing) if (f.at) notes.push([f.at[0], f.at[1], f.name, 'No published data']);
    ctx.textAlign = 'center';
    for (const [lat, lng, title, body] of notes) {
      const [x, y] = map.worldToScreen(...toWorld(lat, lng));
      ctx.font = '700 13px "Atkinson Hyperlegible", system-ui, sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(19,32,47,.9)'; ctx.fillStyle = '#e9e4d8';
      ctx.strokeText(title, x, y); ctx.fillText(title, x, y);
      ctx.font = '12px "Atkinson Hyperlegible", system-ui, sans-serif';
      ctx.fillStyle = '#a9b4bf';
      ctx.strokeText(body, x, y + 16); ctx.fillText(body, x, y + 16);
    }
  },
};

// ---------- active layer switching ----------
let districtAll = null;
const activeLayer = {
  draw(ctx, map) {
    if (!state.meta) return;
    if (map.view.z >= DETAIL_ZOOM && state.month === null) {
      for (const l of state.detail.values()) if (l) l.draw(ctx, map);
    } else {
      const l = state.month === null ? districtAll : state.monthCache.get(state.month);
      if (l) l.draw(ctx, map);
    }
  },
};

const popupLayer = { draw(_, map) { positionPopup(map); } };

// ---------- data ----------
const getJSON = async (p) => {
  const r = await fetch(DATA + p);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};

async function loadMonth(m) {
  if (state.monthCache.has(m)) return state.monthCache.get(m);
  const d = await getJSON(`months/${m}.json`);
  const layer = new HexLayer(d.size, d.cells, (v) => v, state.meta.breaks.district);
  state.monthCache.set(m, layer);
  return layer;
}

async function loadVisibleDetail(map) {
  if (!state.detailIndex || map.view.z < DETAIL_ZOOM - 0.5 || state.month !== null) return;
  const { chunk, tiles } = state.detailIndex;
  const xs = [], ys = [];
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) {
    const [x, y] = project(...map.screenToLatLng(map.w * fx, map.h * fy));
    xs.push(x); ys.push(y);
  }
  const want = [];
  for (let cx = Math.floor(Math.min(...xs) / chunk); cx <= Math.floor(Math.max(...xs) / chunk); cx++)
    for (let cy = Math.floor(Math.min(...ys) / chunk); cy <= Math.floor(Math.max(...ys) / chunk); cy++) {
      const k = `${cx}_${cy}`;
      if (tiles.has(k) && !state.detail.has(k)) want.push(k);
    }
  await Promise.all(want.slice(0, 12).map(async (k) => {
    state.detail.set(k, null);
    try {
      const d = await getJSON(`detail/${k}.json`);
      const n = state.meta.months.length;
      state.detail.set(k, new HexLayer(d.size, d.cells, (v) => v / n, state.meta.breaks.detail));
    } catch { state.detail.delete(k); }
  }));
  if (want.length) map.redraw();
}

// ---------- popup ----------
const popup = document.getElementById('popup');
let popupAt = null;

function positionPopup(map) {
  if (!popupAt) return;
  const [x, y] = map.worldToScreen(...toWorld(...popupAt));
  const off = x < 0 || y < 0 || x > map.w || y > map.h;
  popup.hidden = off;
  const pw = popup.offsetWidth, ph = popup.offsetHeight;
  const left = Math.max(8, Math.min(map.w - pw - 8, x - pw / 2));
  const top = y - ph - 14 < 8 ? y + 14 : y - ph - 14;
  popup.style.transform = `translate(${left}px, ${top}px)`;
}

function closePopup() { popupAt = null; popup.hidden = true; }

function sparkline(values) {
  const max = Math.max(...values, 1), w = 168, h = 34, bw = w / values.length;
  const bars = values.map((v, i) => {
    const bh = Math.max(1, (v / max) * (h - 2));
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${bars}</svg>`;
}

function showPopup(map, lat, lng) {
  const meta = state.meta, n = meta.months.length;
  const detail = map.view.z >= DETAIL_ZOOM && state.month === null;
  const size = detail ? meta.grid.detail : meta.grid.district;
  const [q, r] = toCell(...project(lat, lng), size);
  let cell = null;
  if (detail) {
    for (const l of state.detail.values()) if (l && (cell = l.find(q, r))) break;
  } else {
    const l = state.month === null ? districtAll : state.monthCache.get(state.month);
    cell = l && l.find(q, r);
  }
  if (!cell) { closePopup(); return; }
  const perMonth = state.month === null ? cell[2] / n : cell[2];
  const label = (i) => meta.categories[i]?.label ?? 'Other';
  let html = `<p class="pop-score"><strong>${fmt1.format(perMonth / areaKm2(size))}</strong> harm per km² ${state.month === null ? 'per month' : `in ${monthName(state.month)}`}</p>`;
  if (state.month === null) html += `<p>${fmt.format(cell[3])} recorded crimes over ${n} months</p>`;
  const sig = state.month === null ? cell[5] : cell[3];
  if (sig) html += `<p class="pop-hot">Statistically significant hotspot</p>`;
  if (detail) {
    const cats = [...cell[6]].filter(([c]) => meta.categories[c].weight > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (cats.length) html += `<ul class="pop-cats">${cats.map(([c, k]) => `<li><span>${label(c)}</span><span>${fmt.format(k)}</span></li>`).join('')}</ul>`;
    html += sparkline(cell[7]) + `<p class="pop-axis"><span>${monthName(meta.months[0].month, 'short')}</span><span>${monthName(meta.months[n - 1].month, 'short')}</span></p>`;
  } else if (state.month === null && cell[6] >= 0) {
    html += `<p>Most harm from ${label(cell[6]).toLowerCase()}</p>`;
  }
  if (!detail && map.view.z < DETAIL_ZOOM && state.month === null) html += `<p class="pop-hint">Zoom in for street-level detail</p>`;
  popup.querySelector('.pop-body').innerHTML = html;
  popupAt = [lat, lng];
  popup.hidden = false;
  positionPopup(map);
}

// ---------- panel ----------
function renderScrubber() {
  const el = document.getElementById('scrubber');
  const months = state.meta.months, max = Math.max(...months.map((m) => m.score));
  el.innerHTML = months.map((m, i) => {
    const pct = Math.max(6, (m.score / max) * 100);
    return `<button type="button" class="bar" data-i="${i}" aria-pressed="${state.month === m.month}"
      aria-label="${monthName(m.month)}: ${fmt.format(m.crimes)} crimes" title="${monthName(m.month)}">
      <span class="bar-fill" style="height:${pct}%"></span><span class="bar-tick">${monthName(m.month, 'narrow').slice(0, 1)}</span></button>`;
  }).join('');
  const first = monthName(months[0].month), last = monthName(months[months.length - 1].month);
  document.getElementById('period-text').textContent = state.month === null
    ? `Showing all ${months.length} months, ${first} to ${last}.`
    : `Showing ${monthName(state.month)} only.`;
  document.getElementById('all-months').hidden = state.month === null;
}

function renderZones() {
  const list = document.getElementById('zones');
  const meta = state.meta, top = state.zones[0]?.score || 1, n = meta.months.length;
  list.innerHTML = state.zones.slice(0, state.shown).map((z, i) => {
    const lead = z.cats[0] ? meta.categories[z.cats[0][0]].label : '';
    return `<li><button type="button" class="zone" data-i="${i}" aria-current="${i === state.selected}">
      <span class="zone-rank">${i + 1}</span>
      <span class="zone-name">${escapeHtml(z.name)}</span>
      <span class="zone-meta">${escapeHtml(meta.coverage.forces[z.force] || z.force)}</span>
      <span class="zone-meter" aria-hidden="true"><span style="width:${(z.score / top) * 100}%"></span></span>
      <span class="zone-meta">${fmt.format(Math.round(z.crimes / n))} crimes a month across ${fmt1.format(z.area)} km². ${lead ? `${z.cats[0][1]}% of harm from ${lead.toLowerCase()}.` : ''}</span>
    </button></li>`;
  }).join('');
  const more = document.getElementById('more-zones');
  more.hidden = state.shown >= state.zones.length;
}

function renderMethod() {
  const m = state.meta;
  document.getElementById('headline').textContent =
    `1% of street-level areas hold ${fmt1.format(m.quality.top1_share)}% of all recorded harm.`;
  document.getElementById('weights').innerHTML = m.categories
    .slice().sort((a, b) => b.weight - a.weight)
    .map((c) => `<tr><td>${c.label}</td><td>${c.weight === 0 ? 'Not scored' : c.weight}</td></tr>`).join('');
  const missing = m.coverage.missing.filter((f) => f.id !== 'btp');
  document.getElementById('coverage').textContent = missing.length
    ? `${missing.map((f) => f.name).join(', ')} published no data for this period, so ${missing.length === 1 ? 'its area appears' : 'their areas appear'} empty.`
    : 'Every force published data for this period.';
  document.getElementById('stability').textContent =
    `Month to month, ${Math.round(m.quality.stability * 100)}% of hotspot cells stay hotspots (Jaccard overlap), so these are persistent patterns rather than one-off spikes.`;
  document.getElementById('generated').textContent = `Data built ${m.generated}.`;
  document.getElementById('demo').hidden = !m.demo;
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// ---------- boot ----------
async function main() {
  const map = new SlippyMap(document.getElementById('map'), {
    tiles: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
    labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png',
    tint: 'rgba(36, 72, 112, 0.55)',
    label: 'Crime harm map of the UK. Drag or use arrow keys to pan, plus and minus keys to zoom.',
  });
  const sheet = matchMedia('(max-width: 760px)').matches ? document.querySelector('.sheet').offsetHeight : 0;
  map.fitBounds(49.9, -8.2, 58.7, 1.8, 24, sheet);
  window.gothamMap = map;

  try {
    const [meta, district, zones, detailIndex] = await Promise.all([
      getJSON('meta.json'), getJSON('district.json'), getJSON('zones.json'), getJSON('detail/index.json')]);
    state.meta = meta;
    const n = meta.months.length;
    districtAll = new HexLayer(district.size, district.cells, (v) => v / n, meta.breaks.district);
    state.zones = zones.zones.map((z) => ({ ...z, segs: zoneSegments(z, zones.size) }));
    state.detailIndex = { chunk: detailIndex.chunk, tiles: new Set(detailIndex.tiles) };
  } catch (err) {
    console.error(err);
    document.getElementById('error').hidden = false;
    document.body.classList.add('no-data');
    return;
  }

  map.addLayer(activeLayer);
  map.addLayer(zoneLayer);
  map.addLayer(notesLayer);
  map.addLayer(popupLayer);
  renderLegend();
  renderScrubber();
  renderZones();
  renderMethod();
  document.body.classList.add('ready');

  map.on('move', () => { loadVisibleDetail(map); });
  map.on('click', (lat, lng) => showPopup(map, lat, lng));
  popup.querySelector('.pop-close').addEventListener('click', closePopup);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });

  document.getElementById('scrubber').addEventListener('click', async (e) => {
    const b = e.target.closest('.bar');
    if (!b) return;
    const m = state.meta.months[+b.dataset.i].month;
    state.month = state.month === m ? null : m;
    closePopup();
    renderScrubber();
    if (state.month) await loadMonth(state.month);
    map.redraw();
    document.querySelector(`.bar[data-i="${b.dataset.i}"]`)?.focus();
  });
  document.getElementById('scrubber').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const bars = [...document.querySelectorAll('.bar')];
    const i = bars.indexOf(document.activeElement);
    const next = bars[Math.max(0, Math.min(bars.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
    next?.focus();
    e.preventDefault();
  });
  document.getElementById('all-months').addEventListener('click', () => {
    state.month = null; closePopup(); renderScrubber(); map.redraw(); loadVisibleDetail(map);
  });

  document.getElementById('zones').addEventListener('click', (e) => {
    const b = e.target.closest('.zone');
    if (!b) return;
    state.selected = +b.dataset.i;
    const z = state.zones[state.selected];
    closePopup();
    renderZones();
    const zoom = Math.min(14, Math.max(11.5, 14.5 - Math.log2(Math.max(1, z.area)) / 1.6));
    map.flyTo(z.center[0], z.center[1], zoom);
    document.body.classList.remove('sheet-open');
  });
  document.getElementById('more-zones').addEventListener('click', () => { state.shown += 10; renderZones(); });

  document.getElementById('zoom-in').addEventListener('click', () => map.zoomBy(1));
  document.getElementById('zoom-out').addEventListener('click', () => map.zoomBy(-1));
  document.getElementById('sheet-toggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('sheet-open');
    document.getElementById('sheet-toggle').setAttribute('aria-expanded', open);
  });
}

function renderLegend() {
  document.getElementById('legend-ramp').innerHTML = PALETTE.map((c) => `<span style="background:${c}"></span>`).join('');
}

main();
