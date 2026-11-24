// A small slippy map: raster basemap tiles + custom canvas layers.
// No dependencies. Web Mercator, 256px tiles, retina aware.

const TILE = 256;
const MAX_LAT = 85.05112878;

export function toWorld(lat, lng) {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

export function fromWorld(x, y) {
  const n = Math.PI - 2 * Math.PI * y;
  return [(180 / Math.PI) * Math.atan(Math.sinh(n)), x * 360 - 180];
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class SlippyMap {
  constructor(el, opts) {
    this.el = el;
    this.opts = { minZoom: 4.5, maxZoom: 16, tint: null, background: '#13202f', ...opts };
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', opts.label || 'Map. Drag or use arrow keys to pan, plus and minus to zoom.');
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.layers = [];
    this.tiles = new Map();
    this.view = { x: 0.5, y: 0.5, z: 6 };
    this.pointers = new Map();
    this.listeners = { move: [], click: [] };
    this._bind();
    new ResizeObserver(() => this._resize()).observe(el);
    this._resize();
  }

  on(evt, fn) { this.listeners[evt].push(fn); }
  _emit(evt, ...a) { this.listeners[evt].forEach((f) => f(...a)); }
  addLayer(layer) { this.layers.push(layer); this.redraw(); }

  get scale() { return TILE * 2 ** this.view.z; }
  get size() { return [this.w, this.h]; }

  setView(lat, lng, z) {
    const [x, y] = toWorld(lat, lng);
    this.view = { x, y, z: this._clampZ(z) };
    this.redraw();
    this._emit('move');
  }

  // padBottom: screen space covered by UI (e.g. a bottom sheet) to keep clear
  fitBounds(south, west, north, east, pad = 24, padBottom = 0) {
    const [x0, y1] = toWorld(south, west);
    const [x1, y0] = toWorld(north, east);
    const zx = Math.log2((this.w - pad * 2) / ((x1 - x0) * TILE));
    const zy = Math.log2((this.h - pad * 2 - padBottom) / ((y1 - y0) * TILE));
    const z = this._clampZ(Math.min(zx, zy));
    this.view = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 + padBottom / 2 / (TILE * 2 ** z), z };
    this.redraw();
    this._emit('move');
  }

  flyTo(lat, lng, z) {
    const [tx, ty] = toWorld(lat, lng);
    const from = { ...this.view };
    const to = { x: tx, y: ty, z: this._clampZ(z) };
    if (reducedMotion()) { this.view = to; this.redraw(); this._emit('move'); return; }
    const t0 = performance.now();
    const dur = 700;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.view = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        z: from.z + (to.z - from.z) * e,
      };
      this._draw();
      if (t < 1) requestAnimationFrame(step); else this._emit('move');
    };
    requestAnimationFrame(step);
  }

  // world <-> screen (CSS pixels)
  worldToScreen(x, y) {
    const s = this.scale;
    return [(x - this.view.x) * s + this.w / 2, (y - this.view.y) * s + this.h / 2];
  }
  screenToWorld(px, py) {
    const s = this.scale;
    return [this.view.x + (px - this.w / 2) / s, this.view.y + (py - this.h / 2) / s];
  }
  screenToLatLng(px, py) { return fromWorld(...this.screenToWorld(px, py)); }
  bounds() {
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(this.w, this.h);
    return { x0, y0, x1, y1 };
  }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _clampZ(z) { return Math.max(this.opts.minZoom, Math.min(this.opts.maxZoom, z)); }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this._draw();
  }

  _tile(template, z, x, y) {
    const k = `${template}|${z}/${x}/${y}`;
    let t = this.tiles.get(k);
    if (!t) {
      const img = new Image();
      t = { img, ok: false, failed: false };
      img.onload = () => { t.ok = true; this.redraw(); };
      img.onerror = () => { t.failed = true; };
      img.src = template.replace('{s}', 'abcd'[(x + y) % 4]).replace('{z}', z).replace('{x}', x).replace('{y}', y);
      this.tiles.set(k, t);
      if (this.tiles.size > 600) this.tiles.delete(this.tiles.keys().next().value);
    }
    return t;
  }

  _drawTiles(ctx, template) {
    if (!template) return;
    const tz = Math.max(0, Math.min(19, Math.round(this.view.z)));
    const n = 2 ** tz;
    const { x0, y0, x1, y1 } = this.bounds();
    const tsize = this.scale / n; // CSS px per tile
    for (let ty = Math.max(0, Math.floor(y0 * n)); ty <= Math.min(n - 1, Math.floor(y1 * n)); ty++) {
      for (let txr = Math.floor(x0 * n); txr <= Math.floor(x1 * n); txr++) {
        const tx = ((txr % n) + n) % n;
        const [sx, sy] = this.worldToScreen(txr / n, ty / n);
        const t = this._tile(template, tz, tx, ty);
        if (t.ok) { ctx.drawImage(t.img, sx, sy, tsize + 0.5, tsize + 0.5); continue; }
        // fall back to a loaded ancestor so zooming never flashes empty
        for (let up = 1; up <= 4 && tz - up >= 0; up++) {
          const f = 2 ** up;
          const p = this.tiles.get(`${template}|${tz - up}/${tx >> up}/${ty >> up}`);
          if (p && p.ok) {
            const sub = p.img.naturalWidth / f;
            ctx.drawImage(p.img, (tx % f) * sub, (ty % f) * sub, sub, sub, sx, sy, tsize + 0.5, tsize + 0.5);
            break;
          }
        }
      }
    }
  }

  _draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.opts.background;
    ctx.fillRect(0, 0, this.w, this.h);
    this._drawTiles(ctx, this.opts.tiles);
    if (this.opts.tint) {
      ctx.globalCompositeOperation = 'color';
      ctx.fillStyle = this.opts.tint;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = 'source-over';
    }
    for (const l of this.layers) if (l.below !== false) l.draw(ctx, this);
    this._drawTiles(ctx, this.opts.labels);
    for (const l of this.layers) if (l.below === false) l.draw(ctx, this);
  }

  _zoomAround(px, py, dz) {
    const [wx, wy] = this.screenToWorld(px, py);
    this.view.z = this._clampZ(this.view.z + dz);
    const s = this.scale;
    this.view.x = wx - (px - this.w / 2) / s;
    this.view.y = wy - (py - this.h / 2) / s;
    this.redraw();
  }

  zoomBy(dz) {
    if (reducedMotion()) { this._zoomAround(this.w / 2, this.h / 2, dz); this._emit('move'); return; }
    const [lat, lng] = fromWorld(this.view.x, this.view.y);
    this.flyTo(lat, lng, this.view.z + dz);
  }

  _bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let moveTimer;
    const settled = () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => this._emit('move'), 120); };

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this._zoomAround(...pos(e), -d * 0.0022);
      settled();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      this._down = { p, moved: 0, t: performance.now() };
      this._pinch = null;
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e);
      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (this._pinch) {
          this._zoomAround(...mid, Math.log2(dist / this._pinch.dist));
          const s = this.scale;
          this.view.x -= (mid[0] - this._pinch.mid[0]) / s;
          this.view.y -= (mid[1] - this._pinch.mid[1]) / s;
        }
        this._pinch = { dist, mid };
        if (this._down) this._down.moved = 99;
      } else {
        const s = this.scale;
        this.view.x -= (p[0] - prev[0]) / s;
        this.view.y -= (p[1] - prev[1]) / s;
        if (this._down) this._down.moved += Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]);
      }
      c.classList.add('dragging');
      this.redraw();
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      this._pinch = null;
      c.classList.remove('dragging');
      if (this._down && this._down.moved < 6 && this.pointers.size === 0) {
        const p = pos(e);
        this._emit('click', ...this.screenToLatLng(...p), p);
      }
      if (this.pointers.size === 0) { this._down = null; settled(); }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', (e) => { this._zoomAround(...pos(e), 1); settled(); });

    c.addEventListener('keydown', (e) => {
      const step = 80 / this.scale;
      const keys = {
        ArrowLeft: () => (this.view.x -= step), ArrowRight: () => (this.view.x += step),
        ArrowUp: () => (this.view.y -= step), ArrowDown: () => (this.view.y += step),
        '+': () => this._zoomAround(this.w / 2, this.h / 2, 1), '=': () => this._zoomAround(this.w / 2, this.h / 2, 1),
        '-': () => this._zoomAround(this.w / 2, this.h / 2, -1),
      };
      if (!keys[e.key]) return;
      e.preventDefault();
      keys[e.key]();
      this.redraw();
      settled();
    });
  }
}
