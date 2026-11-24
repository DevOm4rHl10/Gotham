// Hexagon grid maths and tile drawing. No Leaflet in here, so it can be tested on its own.
// Projection and cell maths mirror pipeline/grid.py; keep them in sync.

const R = 6371007.2;
const LAT0 = (52 * Math.PI) / 180;
const LON0 = (10 * Math.PI) / 180;
const SQ3 = Math.sqrt(3);

// Traffic-light scale: primary-route green -> route yellow -> warning red.
export const PALETTE = ['#0b4a33', '#0d6b3f', '#5f9a2a', '#ffd200', '#f59b00', '#e5501e', '#ff2a3a'];
// Low-harm classes stay faint so the map, not the safe areas, carries the eye.
const SOLID = [0.35, 0.45, 0.55, 0.7, 0.8, 0.88, 0.95];
export const NEIGHBOURS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

// WGS84 <-> Lambert azimuthal equal-area metres (the pipeline's grid projection)
export function project(lat, lng) {
  const phi = (lat * Math.PI) / 180;
  const lam = (lng * Math.PI) / 180 - LON0;
  const k = Math.sqrt(2 / (1 + Math.sin(LAT0) * Math.sin(phi) + Math.cos(LAT0) * Math.cos(phi) * Math.cos(lam)));
  return [
    R * k * Math.cos(phi) * Math.sin(lam),
    R * k * (Math.cos(LAT0) * Math.sin(phi) - Math.sin(LAT0) * Math.cos(phi) * Math.cos(lam)),
  ];
}

export function unproject(x, y) {
  const rho = Math.hypot(x, y);
  if (rho === 0) return [52, 10];
  const c = 2 * Math.asin(rho / (2 * R));
  const phi = Math.asin(Math.cos(c) * Math.sin(LAT0) + (y * Math.sin(c) * Math.cos(LAT0)) / rho);
  const lam = LON0 + Math.atan2(x * Math.sin(c),
    rho * Math.cos(LAT0) * Math.cos(c) - y * Math.sin(LAT0) * Math.sin(c));
  return [(phi * 180) / Math.PI, (lam * 180) / Math.PI];
}

// WGS84 <-> Web Mercator "world" units (0..1), the space map tiles live in
export function toWorld(lat, lng) {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

export function fromWorld(x, y) {
  const n = Math.PI - 2 * Math.PI * y;
  return [(180 / Math.PI) * Math.atan(Math.sinh(n)), x * 360 - 180];
}

// Which pointy-top hexagon of `size` metres contains LAEA point (x, y)
export function toCell(x, y, size) {
  const qf = ((SQ3 / 3) * x - y / 3) / size;
  const rf = ((2 / 3) * y) / size;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q, r];
}

export const cellCenter = (q, r, size) => [size * (SQ3 * q + (SQ3 / 2) * r), size * 1.5 * r];
export const areaKm2 = (size) => (1.5 * SQ3 * size * size) / 1e6;

// The 6 corners of a cell as [lat, lng]. Corner i sits at 60*i - 30 degrees,
// so edge i (corner i -> i+1) faces NEIGHBOURS[i].
export function cornersLatLng(q, r, size) {
  const [cx, cy] = cellCenter(q, r, size);
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i - 30) * Math.PI) / 180;
    out.push(unproject(cx + size * Math.cos(a), cy + size * Math.sin(a)));
  }
  return out;
}

export function colourClass(value, breaks) {
  let b = 0;
  while (b < breaks.length && value > breaks[b]) b++;
  return b;
}

// A set of hexagons with a spatial index, drawn onto 256px map tiles.
// cells: rows from the pipeline JSON, [q, r, score, ...]
// divisor: turns score into "per month" (number of months, or 1 for a single month)
// bucketBits: index resolution; 2^bits buckets across the world's width
export class HexSet {
  constructor(size, cells, divisor, breaks, bucketBits) {
    this.size = size;
    this.cells = cells;
    const n = cells.length;
    this.verts = new Float64Array(n * 12);
    this.box = new Float64Array(n * 4);
    this.colour = new Uint8Array(n);
    this.index = new Map();
    this.buckets = new Map();
    this.B = 2 ** bucketBits;
    const area = areaKm2(size);
    let pad = 0;
    for (let i = 0; i < n; i++) {
      const [q, r, score] = cells[i];
      const corners = cornersLatLng(q, r, size);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < 6; k++) {
        const [wx, wy] = toWorld(corners[k][0], corners[k][1]);
        this.verts[i * 12 + k * 2] = wx;
        this.verts[i * 12 + k * 2 + 1] = wy;
        x0 = Math.min(x0, wx); x1 = Math.max(x1, wx);
        y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
      }
      this.box.set([x0, y0, x1, y1], i * 4);
      pad = Math.max(pad, x1 - x0, y1 - y0);
      this.colour[i] = colourClass(score / divisor / area, breaks);
      this.index.set(`${q},${r}`, i);
      const key = this._bucket((x0 + x1) / 2, (y0 + y1) / 2);
      let list = this.buckets.get(key);
      if (!list) this.buckets.set(key, (list = []));
      list.push(i);
    }
    this.pad = pad; // largest cell extent, in world units
  }

  _bucket(x, y) { return Math.floor(x * this.B) * 1e6 + Math.floor(y * this.B); }

  find(q, r) {
    const i = this.index.get(`${q},${r}`);
    return i === undefined ? null : this.cells[i];
  }

  // Draw every cell overlapping tile (z, tx, ty) into ctx (tileSize CSS px square).
  drawTile(ctx, z, tx, ty, tileSize) {
    const scale = tileSize * 2 ** z;
    const wx0 = tx / 2 ** z, wy0 = ty / 2 ** z;
    const wx1 = (tx + 1) / 2 ** z, wy1 = (ty + 1) / 2 ** z;
    const bx0 = Math.floor((wx0 - this.pad) * this.B), bx1 = Math.floor((wx1 + this.pad) * this.B);
    const by0 = Math.floor((wy0 - this.pad) * this.B), by1 = Math.floor((wy1 + this.pad) * this.B);

    const byColour = PALETTE.map(() => []);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const list = this.buckets.get(bx * 1e6 + by);
        if (!list) continue;
        for (const i of list) {
          const j = i * 4;
          if (this.box[j + 2] < wx0 || this.box[j] > wx1 || this.box[j + 3] < wy0 || this.box[j + 1] > wy1) continue;
          byColour[this.colour[i]].push(i);
        }
      }
    }

    const paint = paintFor(z);
    for (let c = 0; c < PALETTE.length; c++) {
      const list = byColour[c];
      if (!list.length) continue;
      ctx.beginPath();
      for (const i of list) {
        const v = i * 12;
        ctx.moveTo((this.verts[v] - wx0) * scale, (this.verts[v + 1] - wy0) * scale);
        for (let k = 2; k < 12; k += 2) {
          ctx.lineTo((this.verts[v + k] - wx0) * scale, (this.verts[v + k + 1] - wy0) * scale);
        }
        ctx.closePath();
      }
      ctx.fillStyle = PALETTE[c];
      ctx.strokeStyle = PALETTE[c];
      ctx.globalAlpha = paint.fill(c);
      ctx.fill();
      const line = paint.line(c);
      if (line > 0) {
        ctx.globalAlpha = line;
        ctx.lineWidth = paint.width;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}

// How hexagons are painted at each zoom.
// Zoomed out: solid colour, which reads as a heat map.
// Street level: a soft tint on above-average areas only and no edges, so the
// streets and their names underneath stay readable. Hotspot outlines (drawn
// separately, outer edge only) give the shape.
export const STREET_ZOOM = 13;
export const FADE_ZOOM = 8;
export function paintFor(z) {
  if (z < FADE_ZOOM) {
    // Country view: solid. A same-colour edge closes the hairline gaps
    // anti-aliasing leaves between neighbouring hexagons.
    return { fill: (c) => SOLID[c], line: (c) => SOLID[c], width: 0.6 };
  }
  if (z < 11) {
    // Region view: partly see-through, so town names show.
    return { fill: (c) => SOLID[c] * 0.62, line: (c) => SOLID[c] * 0.62, width: 0.6 };
  }
  if (z < STREET_ZOOM) {
    return { fill: (c) => SOLID[c] * 0.45, line: () => 0, width: 0 };
  }
  return { fill: (c) => (c >= 3 ? 0.07 * (c - 1) : 0), line: () => 0, width: 0 };
}
