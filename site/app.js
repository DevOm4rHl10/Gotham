/* global L */
import {
  HexSet, PALETTE, NEIGHBOURS, STREET_ZOOM, FADE_ZOOM, project, toCell, areaKm2, cornersLatLng,
} from './hexgrid.js';

// ---------- settings ----------
const DATA = './data/';
const LIST_MIN = 10;      // the top 10 are always listed
const LIST_MAX = 30;      // the list grows 10 at a time up to this
const DETAIL_ZOOM = 11;   // from this zoom, 400 m hexagons replace 1.6 km ones
const OUTLINE_ZOOM = 8;   // hotspot outlines appear from this zoom
const PLATE_ZOOM = 9;     // zoomed out: top-10 warning triangles; from here: a rank plate on every hotspot
const NOTES_MAX_ZOOM = 9; // coverage notes disappear after this zoom

// Area the data covers, and how far people can pan. To add other countries,
// widen these two boxes (south-west, north-east corners).
const COVERAGE = [[49.9, -8.2], [58.7, 1.8]];
const PAN_LIMIT = [[47.5, -13.5], [62.0, 6.5]];
// On phones the bottom panel covers the lower part of the map, so allow panning
// further south to keep the country visible above it.
const PAN_LIMIT_MOBILE = [[40.0, -13.5], [62.0, 6.5]];

const fmt = new Intl.NumberFormat('en-GB');
const fmt1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const monthName = (m, style = 'long') =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: style, year: 'numeric' });
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  district: null,        // HexSet, all 12 months
  months: new Map(),     // month -> Promise<HexSet>
  chunks: new Map(),     // "cx_cy" -> Promise<HexSet|null>
  chunkIndex: null,      // { size, tiles: Set }
  zoneSets: new Map(),   // 'all' or month -> Promise<zone set>
  zones: null,           // current zone set
  month: null,           // selected month, or null for all 12 months
  lastMonth: null,
  selected: -1,
  shown: LIST_MIN,
  token: 0,              // guards against out-of-order loads
};

// ---------- the warning triangle ----------
function triangle(rank, width = 40) {
  const h = Math.round(width * 0.9);
  const size = rank > 99 ? 12 : rank > 9 ? 14 : 17;
  return `<svg viewBox="0 0 40 36" width="${width}" height="${h}" aria-hidden="true">
    <path d="M20 3 L37.5 33 H2.5 Z" fill="#fff" stroke="#c8102e" stroke-width="5" stroke-linejoin="round"/>
    <text x="20" y="29" text-anchor="middle" font-size="${size}" fill="#000">${rank}</text></svg>`;
}

// ---------- data ----------
async function getJSON(path) {
  const res = await fetch(DATA + path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function monthSet(m) {
  if (!state.months.has(m)) {
    state.months.set(m, getJSON(`months/${m}.json`)
      .then((d) => new HexSet(d.size, d.cells, 1, state.meta.breaks.district, 8)));
  }
  return state.months.get(m);
}

function chunkSet(key) {
  if (!state.chunkIndex.tiles.has(key)) return Promise.resolve(null);
  if (!state.chunks.has(key)) {
    const n = state.meta.months.length;
    state.chunks.set(key, getJSON(`detail/${key}.json`)
      .then((d) => new HexSet(d.size, d.cells, n, state.meta.breaks.detail, 12))
      .catch(() => { state.chunks.delete(key); return null; }));
  }
  return state.chunks.get(key);
}

function chunksFor(south, west, north, east) {
  const xs = [], ys = [];
  for (const lat of [south, (south + north) / 2, north]) {
    for (const lng of [west, (west + east) / 2, east]) {
      const [x, y] = project(lat, lng);
      xs.push(x); ys.push(y);
    }
  }
  const c = state.chunkIndex.size, pad = state.meta.grid.detail * 2;
  const keys = [];
  for (let cx = Math.floor((Math.min(...xs) - pad) / c); cx <= Math.floor((Math.max(...xs) + pad) / c); cx++) {
    for (let cy = Math.floor((Math.min(...ys) - pad) / c); cy <= Math.floor((Math.max(...ys) + pad) / c); cy++) {
      keys.push(`${cx}_${cy}`);
    }
  }
  return Promise.all(keys.map(chunkSet)).then((sets) => sets.filter(Boolean));
}

function setsForTile(z, bounds) {
  if (state.month) return monthSet(state.month).then((s) => [s]);
  if (z < DETAIL_ZOOM) return Promise.resolve([state.district]);
  return chunksFor(bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast());
}

// ---------- hexagon layer: each 256px tile is drawn once, then Leaflet just moves it ----------
const HexLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const size = this.getTileSize().x;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const tile = document.createElement('canvas');
    tile.width = tile.height = size * dpr;
    setsForTile(coords.z, this._tileCoordsToBounds(coords))
      .then((sets) => {
        const ctx = tile.getContext('2d');
        ctx.scale(dpr, dpr);
        for (const s of sets) s.drawTile(ctx, coords.z, coords.x, coords.y, size);
        done(null, tile);
      })
      .catch((err) => done(err, tile));
    return tile;
  },
});

// ---------- hotspot zones: outline + warning triangle ----------
function zoneOutline(zone, size) {
  const inZone = new Set(zone.cells.map(([q, r]) => `${q},${r}`));
  const segments = [];
  for (const [q, r] of zone.cells) {
    const corners = cornersLatLng(q, r, size);
    NEIGHBOURS.forEach(([dq, dr], i) => {
      if (!inZone.has(`${q + dq},${r + dr}`)) segments.push([corners[i], corners[(i + 1) % 6]]);
    });
  }
  return segments;
}

const HALO = { color: '#000000', opacity: 0.7, weight: 4.5, interactive: false, lineCap: 'round', pane: 'zones' };
const LINE = { color: '#ffffff', opacity: 1, weight: 1.8, interactive: false, lineCap: 'round', pane: 'zones' };

function zonesFor(key) {
  if (!state.zoneSets.has(key)) {
    const path = key === 'all' ? 'zones.json' : `zones/${key}.json`;
    state.zoneSets.set(key, getJSON(path).then((d) => {
      const list = d.zones.map((z, i) => {
        const outline = zoneOutline(z, d.size);
        const w = i < 3 ? 38 : i < 10 ? 32 : 26;
        const marker = L.marker(z.center, {
          title: `${i + 1}. ${z.name}`,
          alt: `Hotspot ${i + 1}: ${z.name}`,
          riseOnHover: true,
          zIndexOffset: 1000 - i,
          icon: L.divIcon({ className: 'tri-marker', html: triangle(i + 1, w), iconSize: [w, w * 0.9], iconAnchor: [w / 2, w * 0.6] }),
        });
        // Zoomed in, the rank moves to a route-number plate just above the outline,
        // so nothing covers the streets inside the hotspot.
        const top = outline.flat().reduce((a, b) => (b[0] > a[0] ? b : a));
        const plate = L.marker(top, {
          title: `${i + 1}. ${z.name}`,
          alt: `Hotspot ${i + 1}: ${z.name}`,
          riseOnHover: true,
          zIndexOffset: 1000 - i,
          icon: L.divIcon({ className: 'rank-plate', iconSize: null, html: `<span>${i + 1}</span>` }),
        });
        return { ...z, rank: i + 1, top, halo: L.polyline(outline, HALO), line: L.polyline(outline, LINE), marker, plate };
      });
      return {
        key,
        list,
        outlines: L.layerGroup(list.flatMap((z) => [z.halo, z.line])),
        topTen: L.layerGroup(list.slice(0, 10).map((z) => z.marker)),
        plates: L.layerGroup(list.map((z) => z.plate)),
      };
    }));
  }
  return state.zoneSets.get(key);
}

function styleSelected() {
  state.zones.list.forEach((z, i) => {
    const on = i === state.selected;
    z.halo.setStyle({ weight: on ? 8 : HALO.weight, color: on ? '#000000' : HALO.color });
    z.line.setStyle({ weight: on ? 3.5 : LINE.weight, color: on ? '#ffd200' : LINE.color });
    if (on) { z.halo.bringToFront(); z.line.bringToFront(); }
    z.marker.getElement()?.classList.toggle('selected', on);
    z.plate.getElement()?.classList.toggle('selected', on);
  });
}

// ---------- popup ----------
function sparkline(values) {
  const max = Math.max(...values, 1), w = 168, h = 34, bw = w / values.length;
  const bars = values.map((v, i) => {
    const bh = Math.max(1, (v / max) * (h - 2));
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${bars}</svg>`;
}

async function findCell(latlng, detail) {
  const size = detail ? state.meta.grid.detail : state.meta.grid.district;
  const [q, r] = toCell(...project(latlng.lat, latlng.lng), size);
  let sets;
  if (state.month && !detail) sets = [await monthSet(state.month)];
  else if (!detail) sets = [state.district];
  else {
    const d = 0.01;
    sets = await chunksFor(latlng.lat - d, latlng.lng - d, latlng.lat + d, latlng.lng + d);
  }
  for (const s of sets) {
    const cell = s.find(q, r);
    if (cell) return { cell, size };
  }
  return null;
}

async function showPopup(map, latlng) {
  const meta = state.meta, n = meta.months.length;
  const detail = !state.month && Math.round(map.getZoom()) >= DETAIL_ZOOM;
  const found = await findCell(latlng, detail);
  if (!found) { map.closePopup(); return; }
  const { cell, size } = found;
  const label = (i) => meta.categories[i]?.label ?? 'Other';
  const perMonth = state.month ? cell[2] : cell[2] / n;

  let html = `<p class="pop-score"><strong>${fmt1.format(perMonth / areaKm2(size))}</strong>harm per km² ${state.month ? `in ${monthName(state.month)}` : 'per month'}</p>`;
  if (!state.month) html += `<p>${fmt.format(cell[3])} recorded crimes over ${n} months</p>`;
  if (state.month ? cell[3] : cell[5]) html += `<p class="pop-hot">${triangle('!', 18)}Statistically significant hotspot</p>`;
  if (detail) {
    const cats = [...cell[6]].filter(([c]) => meta.categories[c].weight > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (cats.length) html += `<ul class="pop-cats">${cats.map(([c, k]) => `<li><span>${label(c)}</span><span>${fmt.format(k)}</span></li>`).join('')}</ul>`;
    html += sparkline(cell[7]) + `<p class="pop-axis"><span>${monthName(meta.months[0].month, 'short')}</span><span>${monthName(meta.months[n - 1].month, 'short')}</span></p>`;
  } else if (!state.month) {
    if (cell[6] >= 0) html += `<p>Most harm from ${label(cell[6]).toLowerCase()}</p>`;
    html += '<p class="pop-hint">Zoom in for street-level detail</p>';
  }
  L.popup({ className: 'gotham-popup', minWidth: 220, maxWidth: 260, autoPanPadding: [24, 24] })
    .setLatLng(latlng).setContent(html).openOn(map);
}

// ---------- side panel ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderPeriod() {
  const months = state.meta.months, max = Math.max(...months.map((m) => m.score));
  $('scrubber').innerHTML = months.map((m, i) => `
    <button type="button" class="bar" data-i="${i}" aria-pressed="${state.month === m.month}"
      aria-label="${monthName(m.month)}: ${fmt.format(m.crimes)} crimes" title="${monthName(m.month)}">
      <span class="bar-fill" style="height:${Math.max(6, (m.score / max) * 100)}%"></span>
      <span class="bar-tick">${monthName(m.month, 'narrow').slice(0, 1)}</span>
    </button>`).join('');
  const first = monthName(months[0].month), last = monthName(months[months.length - 1].month);
  $('view-all').setAttribute('aria-pressed', String(!state.month));
  $('view-month').setAttribute('aria-pressed', String(!!state.month));
  // The slider shows in both views. In "All 12 months" every dot is lit and
  // there is no knob; picking a point on it switches to that month.
  const idx = months.findIndex((m) => m.month === state.month);
  const slider = $('month-slider');
  $('slider-wrap').style.setProperty('--n', months.length);
  $('slider-wrap').classList.toggle('whole-year', !state.month);
  slider.max = months.length - 1;
  slider.value = idx >= 0 ? idx : months.findIndex((m) => m.month === state.lastMonth) >= 0
    ? months.findIndex((m) => m.month === state.lastMonth) : months.length - 1;
  slider.setAttribute('aria-valuetext', state.month ? monthName(state.month) : 'All 12 months');
  $('slider-dots').innerHTML = months.map((_, i) => `<span${i === idx ? ' class="on"' : ''}></span>`).join('');
  $('overlap').hidden = !state.month;
  if (!state.month) {
    $('period-text').textContent = `${first} to ${last}. Pick a month on the slider to see it on its own.`;
    return;
  }
  const info = months.find((m) => m.month === state.month);
  $('period-text').textContent = `Showing ${monthName(state.month)}.`;
  $('overlap').innerHTML = info.top10_count
    ? `<strong>${info.top10_overlap} of ${info.top10_count}</strong> of this month's top hotspots are also in the 12-month top 10.`
    : 'No significant hotspots this month.';
}

function renderZones() {
  const meta = state.meta, list = state.zones.list, top = list[0]?.score || 1;
  const perMonth = state.month ? 1 : meta.months.length;
  $('zones-hint').textContent = state.month
    ? `Ranked for ${monthName(state.month)}. Select one to see it on the map.`
    : 'Ranked by total harm over 12 months. Select one to see it on the map.';
  $('zones').innerHTML = list.slice(0, state.shown).map((z, i) => {
    const lead = z.cats[0] ? meta.categories[z.cats[0][0]].label : '';
    return `<li><button type="button" class="zone" data-i="${i}" aria-current="${i === state.selected}">
      ${triangle(i + 1, 40)}
      <span>
        <span class="zone-name">${escapeHtml(z.name)}</span>
        <span class="zone-meta">${escapeHtml(meta.coverage.forces[z.force] || z.force)}. ${fmt.format(Math.round(z.crimes / perMonth))} crimes ${state.month ? 'that month' : 'a month'} across ${fmt1.format(z.area)} km².${lead ? ` ${z.cats[0][1]}% of harm from ${lead.toLowerCase()}.` : ''}</span>
      </span>
    </button></li>`;
  }).join('') || '<li class="hint">No significant hotspots in this period.</li>';
  $('more-zones').hidden = state.shown >= Math.min(LIST_MAX, list.length);
  $('fewer-zones').hidden = state.shown <= LIST_MIN;
  $('top-zones').hidden = state.shown < LIST_MAX;
}

function renderStatic() {
  const m = state.meta;
  $('headline').textContent = `1% of street-level areas hold ${fmt1.format(m.quality.top1_share)}% of all recorded harm.`;
  $('weights').innerHTML = m.categories.slice().sort((a, b) => b.weight - a.weight)
    .map((c) => `<tr><td>${c.label}</td><td>${c.weight === 0 ? 'Not scored' : c.weight}</td></tr>`).join('');
  const missing = m.coverage.missing.filter((f) => f.id !== 'btp');
  $('coverage').textContent = missing.length
    ? `${missing.map((f) => f.name).join(', ')} published no data for this period, so ${missing.length === 1 ? 'its area appears' : 'their areas appear'} empty.`
    : 'Every force published data for this period.';
  $('stability').textContent =
    `Month to month, ${Math.round(m.quality.stability * 100)}% of hotspot cells stay hotspots (Jaccard overlap), so these are persistent patterns rather than one-off spikes.`;
  $('generated').textContent = `Data built ${m.generated}.`;
  $('demo').hidden = !m.demo;
  $('legend-ramp').innerHTML = PALETTE.map((c) => `<span style="background:${c}"></span>`).join('');
}

// ---------- boot ----------
async function main() {
  const map = L.map('map', {
    zoomControl: false, minZoom: isMobile() ? 4 : 5, maxZoom: 16, zoomSnap: 0.25,
    maxBounds: isMobile() ? PAN_LIMIT_MOBILE : PAN_LIMIT, maxBoundsViscosity: 1,
  });
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'basemap',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const sheet = isMobile() ? document.querySelector('.panel').offsetHeight : 0;
  map.fitBounds(COVERAGE, { paddingTopLeft: [16, 16], paddingBottomRight: [16, 16 + sheet] });

  const legend = L.control({ position: isMobile() ? 'topleft' : 'bottomright' });
  legend.onAdd = () => $('legend');
  legend.addTo(map);
  map.createPane('zones').style.zIndex = 450;

  try {
    const [meta, district, chunkIndex] = await Promise.all([
      getJSON('meta.json'), getJSON('district.json'), getJSON('detail/index.json'),
    ]);
    state.meta = meta;
    state.district = new HexSet(district.size, district.cells, meta.months.length, meta.breaks.district, 8);
    state.chunkIndex = { size: chunkIndex.chunk, tiles: new Set(chunkIndex.tiles) };
    state.zones = await zonesFor('all');
  } catch (err) {
    console.error(err);
    $('error').hidden = false;
    document.body.classList.add('no-data');
    return;
  }

  const hexes = new HexLayer({ className: 'hexes', bounds: PAN_LIMIT, updateWhenZooming: false, keepBuffer: 3 }).addTo(map);

  // coverage notes, styled as small white local-road signs
  const notes = [[56.6, -4.3, 'Scotland', 'No published data']];
  for (const f of state.meta.coverage.missing) if (f.at) notes.push([f.at[0], f.at[1], f.name, 'No published data']);
  const noteGroup = L.layerGroup(notes.map(([lat, lng, title, body]) => L.marker([lat, lng], {
    interactive: false, keyboard: false,
    icon: L.divIcon({
      className: 'map-note', iconSize: null,
      html: `<div><p><strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span></p></div>`,
    }),
  })));

  let shownZones = null;
  const syncLayers = () => {
    const z = map.getZoom();
    $('map').classList.toggle('street', Math.round(z) >= STREET_ZOOM);
    $('map').classList.toggle('region', Math.round(z) >= FADE_ZOOM);
    if (shownZones && shownZones !== state.zones) {
      shownZones.outlines.remove(); shownZones.topTen.remove(); shownZones.plates.remove();
    }
    shownZones = state.zones;
    if (z >= PLATE_ZOOM) { state.zones.topTen.remove(); state.zones.plates.addTo(map); }
    else { state.zones.plates.remove(); state.zones.topTen.addTo(map); }
    if (z >= OUTLINE_ZOOM) state.zones.outlines.addTo(map); else state.zones.outlines.remove();
    if (z <= NOTES_MAX_ZOOM) noteGroup.addTo(map); else noteGroup.remove();
    styleSelected();
    declutter();
  };

  // Hide a triangle when it would sit on top of a higher-ranked one; zooming in
  // separates them and brings it back. The selected hotspot always wins.
  const declutter = () => {
    const list = state.zones.list;
    const order = list.map((_, i) => i);
    if (state.selected >= 0) order.unshift(state.selected);
    const kept = [], seen = new Set();
    for (const i of order) {
      if (seen.has(i)) continue;
      seen.add(i);
      const z = list[i];
      const m = map.hasLayer(z.plate) ? z.plate : z.marker, el = m.getElement();
      if (!el || !map.hasLayer(m)) continue;
      const p = map.latLngToContainerPoint(m.getLatLng());
      const w = m === z.plate ? 30 : i < 3 ? 38 : 32;
      const clash = kept.some((k) => Math.abs(k.x - p.x) < (k.w + w) * 0.42 && Math.abs(k.y - p.y) < (k.w + w) * 0.38);
      el.style.visibility = clash ? 'hidden' : '';
      if (!clash) kept.push({ x: p.x, y: p.y, w });
    }
  };
  map.on('zoomend', syncLayers);

  const selectZone = (i) => {
    state.selected = i;
    const z = state.zones.list[i];
    map.closePopup();
    // Grow the list to show a hotspot picked on the map, within the 30 cap.
    if (i >= state.shown && i < LIST_MAX) state.shown = Math.ceil((i + 1) / 10) * 10;
    renderZones();
    styleSelected();
    const zoom = Math.min(14, Math.max(12, 14.5 - Math.log2(Math.max(1, z.area)) / 1.6));
    map.flyTo(z.center, zoom, { animate: !reduceMotion(), duration: 0.8 });
    document.body.classList.remove('sheet-open');
    $('sheet-toggle').setAttribute('aria-expanded', 'false');
  };

  const wireMarkers = (set) => set.list.forEach((z, i) => {
    z.marker.off('click').on('click', () => selectZone(i));
    z.plate.off('click').on('click', () => selectZone(i));
  });
  wireMarkers(state.zones);

  // switch period: null = all 12 months
  const setMonth = async (m) => {
    const token = ++state.token;
    const [zones] = await Promise.all([zonesFor(m || 'all'), m ? monthSet(m) : null]);
    if (token !== state.token) return;
    state.month = m;
    if (m) state.lastMonth = m;
    state.zones = zones;
    wireMarkers(zones);
    state.selected = -1;
    state.shown = LIST_MIN;
    map.closePopup();
    renderPeriod();
    renderZones();
    hexes.redraw();
    syncLayers();
  };

  // Month slider: drag it, or use the arrow keys, to move through the months
  $('month-slider').addEventListener('input', (e) => {
    setMonth(state.meta.months[+e.target.value].month);
  });
  // In "All 12 months", a click on the knob's hidden position doesn't change the
  // value, so no 'input' fires; catch it here so any click enters that month.
  $('month-slider').addEventListener('pointerup', (e) => {
    if (!state.month) setMonth(state.meta.months[+e.target.value].month);
  });

  $('view-all').addEventListener('click', () => setMonth(null));
  $('view-month').addEventListener('click', () => {
    if (state.month) return;
    const months = state.meta.months;
    setMonth(state.lastMonth || months[months.length - 1].month);
  });
  $('scrubber').addEventListener('click', (e) => {
    const b = e.target.closest('.bar');
    if (!b) return;
    const i = +b.dataset.i;
    setMonth(state.meta.months[i].month).then(() => document.querySelector(`.bar[data-i="${i}"]`)?.focus());
  });
  $('scrubber').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const bars = [...document.querySelectorAll('.bar')];
    const i = bars.indexOf(document.activeElement);
    bars[Math.max(0, Math.min(bars.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus();
    e.preventDefault();
  });

  $('zones').addEventListener('click', (e) => {
    const b = e.target.closest('.zone');
    if (b) selectZone(+b.dataset.i);
  });
  $('more-zones').addEventListener('click', () => {
    state.shown = Math.min(LIST_MAX, state.shown + 10);
    renderZones();
  });
  // After the list shrinks, bring its heading back into view.
  const shrinkTo = (n) => {
    state.shown = n;
    renderZones();
    $('zones-title').scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
    if ($('fewer-zones').hidden) $('more-zones').focus({ preventScroll: true });
  };
  $('fewer-zones').addEventListener('click', () => shrinkTo(Math.max(LIST_MIN, state.shown - 10)));
  $('top-zones').addEventListener('click', () => shrinkTo(LIST_MIN));

  $('sheet-toggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('sheet-open');
    $('sheet-toggle').setAttribute('aria-expanded', open);
  });

  map.on('click', (e) => showPopup(map, e.latlng));

  renderStatic();
  renderPeriod();
  renderZones();
  syncLayers();
}

main();
