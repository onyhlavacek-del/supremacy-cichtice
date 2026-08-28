// Tesla-styl mapa: vlastní canvas vykreslení OSM dat + herní vrstva
// Souřadnice: metry, x východ, y sever (na obrazovce se y překlápí)
'use strict';

class TeslaMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cx = 0; this.cy = 0;        // střed pohledu (m)
    this.scale = 1.1;                // px na metr
    this.data = null;                // {layers, provinces, pois, school}
    this.state = null;               // herní stav (od serveru)
    this.playersById = new Map();
    this.selected = null;
    this.gps = null;                 // [x, y]
    this.onTap = null;
    this.dark = matchMedia('(prefers-color-scheme: dark)').matches;
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => { this.dark = e.matches; this.draw(); });
    this.selPulse = null;   // animace ťuknutí {x, y, t0}
    this.camAnim = null;    // plynulý přejezd kamery
    this._lastDraw = 0;
    this.imgs = {};         // načtené obrázky strojů
    this.particles = [];    // zrnka obilí za kombajnem
    this._machinesVisible = false;
    this._initInput();
    this._resize();
    addEventListener('resize', () => this._resize());
    requestAnimationFrame((t) => this._loop(t));
  }

  _loop(ts) {
    let active = false;
    if (this.camAnim) {
      const a = this.camAnim;
      const t = Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = 1 - Math.pow(1 - t, 3); // ease-out
      this.cx = a.x0 + (a.x1 - a.x0) * e;
      this.cy = a.y0 + (a.y1 - a.y0) * e;
      this.scale = a.s0 + (a.s1 - a.s0) * e;
      if (t >= 1) this.camAnim = null;
      active = true;
    }
    if (this.selPulse && performance.now() - this.selPulse.t0 < 750) active = true;
    else if (this.selPulse) this.selPulse = null;
    const armiesMoving = this.state?.armies?.some((a) => a.path) || this.state?.movingForeign?.length;
    if (active) this.draw();
    else if (this._machinesVisible && performance.now() - this._lastDraw > 35) this.draw(); // animace strojů (~28 fps)
    else if (armiesMoving && performance.now() - this._lastDraw > 1500) this.draw();
    requestAnimationFrame((t) => this._loop(t));
  }

  _img(name) {
    if (!this.imgs[name]) {
      const im = new Image();
      im.src = 'img/' + name + '.png';
      im.onload = () => this.draw();
      this.imgs[name] = im;
    }
    return this.imgs[name].complete && this.imgs[name].naturalWidth ? this.imgs[name] : null;
  }

  select(id, atWorld) {
    this.selected = id;
    if (atWorld) this.selPulse = { x: atWorld[0], y: atWorld[1], t0: performance.now() };
    this.draw();
  }

  animateTo(x, y, scale, dur = 500) {
    this.camAnim = { x0: this.cx, y0: this.cy, s0: this.scale, x1: x, y1: y, s1: scale ?? this.scale, t0: performance.now(), dur };
  }

  get colors() {
    return this.dark ? {
      bg: '#191A1C', water: '#28425C', forest: '#26382A', field: '#3A382A', meadow: '#2C3529',
      residential: '#222427', building: '#3E4046', buildingStroke: '#54565C', road: '#2E3033',
      roadMajor: '#3A3D42', stream: '#28425C', label: '#B9B6AF', poi: '#8B98A8',
    } : {
      bg: '#EDEBE6', water: '#A9CCEA', forest: '#A9C69B', field: '#EFDFA0', meadow: '#D3E2BA',
      residential: '#E4E1DA', building: '#FFFFFF', buildingStroke: '#D3CFC7', road: '#DDD9D1',
      roadMajor: '#D3CFC7', stream: '#A9CCEA', label: '#6B675F', poi: '#7C8896',
    };
  }

  setData(data) { this.data = data; this.draw(); }
  setState(state) {
    this.state = state;
    this.playersById = new Map((state?.players || []).map((p) => [p.id, p]));
    this.draw();
  }

  // náklon kamery: čím větší zoom, tím víc "pohled ze silnice" (stlačení osy y)
  get tiltY() { return 1 - Math.min(0.38, Math.max(0, (this.scale - 0.9) / 4)); }

  // m -> px
  sx(x) { return (x - this.cx) * this.scale + this.canvas.width / 2 / devicePixelRatio; }
  sy(y) { return (this.cy - y) * this.scale * this.tiltY + this.canvas.height / 2 / devicePixelRatio; }
  // px -> m
  mx(px) { return (px - this.canvas.width / 2 / devicePixelRatio) / this.scale + this.cx; }
  my(py) { return this.cy - (py - this.canvas.height / 2 / devicePixelRatio) / (this.scale * this.tiltY); }

  _resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.canvas.style.width = innerWidth + 'px';
    this.canvas.style.height = innerHeight + 'px';
    this.draw();
  }

  _initInput() {
    const c = this.canvas;
    const pointers = new Map();
    let lastDist = 0, moved = false, downAt = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      moved = false; downAt = [e.clientX, e.clientY];
    });
    c.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 1) {
        const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
        if (Math.abs(e.clientX - downAt[0]) + Math.abs(e.clientY - downAt[1]) > 6) { moved = true; this.onMove?.(); }
        this.cx -= dx / this.scale; this.cy += dy / (this.scale * this.tiltY);
        this.draw();
      } else if (pointers.size === 2) {
        moved = true;
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
        if (lastDist) {
          const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
          this._zoomAt(mid[0], mid[1], d / lastDist);
        }
        lastDist = d;
      }
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastDist = 0;
      if (!moved && downAt && this.onTap) {
        this.onTap(this.mx(downAt[0]), this.my(downAt[1]));
      }
      downAt = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
  }
  _zoomAt(px, py, f) {
    this.onMove?.();
    const wx = this.mx(px), wy = this.my(py);
    this.scale = Math.min(8, Math.max(0.004, this.scale * f));
    this.cx = wx - (px - innerWidth / 2) / this.scale;
    this.cy = wy + (py - innerHeight / 2) / (this.scale * this.tiltY);
    this.draw();
  }

  centerOn(x, y, scale) {
    this.cx = x; this.cy = y;
    if (scale) this.scale = scale;
    this.draw();
  }

  _poly(ring) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(this.sx(ring[0][0]), this.sy(ring[0][1]));
    for (let i = 1; i < ring.length; i++) ctx.lineTo(this.sx(ring[i][0]), this.sy(ring[i][1]));
    ctx.closePath();
  }
  _line(pts) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(this.sx(pts[0][0]), this.sy(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(this.sx(pts[i][0]), this.sy(pts[i][1]));
  }
  _visible(ring, pad = 50) {
    const w = innerWidth, h = innerHeight;
    for (const [x, y] of ring) {
      const px = this.sx(x), py = this.sy(y);
      if (px > -pad && px < w + pad && py > -pad && py < h + pad) return true;
    }
    return false;
  }

  draw() {
    const { ctx } = this;
    if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = this.colors;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    if (!this.data) return;
    const L = this.data.layers.layers;
    const far = this.scale < 0.05; // daleko: jen POI přehled

    if (!far) {
      // krajina
      for (const p of L.field) if (this._visible(p)) { this._poly(p); ctx.fillStyle = C.field; ctx.fill(); }
      for (const p of L.meadow) if (this._visible(p)) { this._poly(p); ctx.fillStyle = C.meadow; ctx.fill(); }
      for (const p of L.forest) if (this._visible(p)) { this._poly(p); ctx.fillStyle = C.forest; ctx.fill(); }
      for (const r of L.residential) if (this._visible(r.p)) { this._poly(r.p); ctx.fillStyle = C.residential; ctx.fill(); }
      for (const p of L.water) if (this._visible(p)) { this._poly(p); ctx.fillStyle = C.water; ctx.fill(); }
      // potoky
      ctx.strokeStyle = C.stream; ctx.lineWidth = Math.max(1, this.scale * 1.5); ctx.lineCap = 'round';
      for (const s of L.streams) if (this._visible(s)) { this._line(s); ctx.stroke(); }
      // cesty
      for (const r of L.roads) {
        if (!this._visible(r.l)) continue;
        this._line(r.l);
        ctx.strokeStyle = r.k === 'major' ? C.roadMajor : C.road;
        ctx.lineWidth = Math.max(r.k === 'major' ? 2 : 1, this.scale * (r.k === 'major' ? 5 : r.k === 'minor' ? 3.5 : 1.2));
        ctx.stroke();
      }
      // turistické značené trasy (KČT barvy)
      if (L.trails?.length && this.scale > 0.04) {
        const TRAIL = { red: '#C62828', blue: '#1565C0', green: '#2E7D32', yellow: '#C9A227' };
        ctx.lineCap = 'round';
        ctx.setLineDash([8, 7]);
        for (const t of L.trails) {
          if (!this._visible(t.l)) continue;
          this._line(t.l);
          ctx.strokeStyle = (TRAIL[t.c] || '#C62828') + 'B8';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      this._drawProvinces();
      // budovy: při přiblížení 3D vytažení (Tesla styl), jinak ploché se stínem
      if (this.scale > 0.55) this._drawBuildings3D(L.buildings);
      else if (this.scale > 0.25) {
        ctx.save();
        ctx.shadowColor = this.dark ? '#00000088' : '#00000030';
        ctx.shadowBlur = 3 * this.scale;
        ctx.shadowOffsetY = 1.5 * this.scale;
        for (const b of L.buildings) {
          if (!this._visible(b.p, 10)) continue;
          this._poly(b.p);
          ctx.fillStyle = C.building;
          ctx.fill();
        }
        ctx.restore();
        ctx.strokeStyle = C.buildingStroke;
        ctx.lineWidth = 1;
        for (const b of L.buildings) {
          if (!this._visible(b.p, 10)) continue;
          this._poly(b.p); ctx.stroke();
        }
      }
      this._drawHouseNumbers();
      this._drawMachines();
      this._drawArmies();
    }
    this._drawSelection();
    this._drawFog();
    this._drawPois(far);
    this._drawGps();
    this._lastDraw = performance.now();
  }

  // mlha neprozkoumaného území — díry podle objevených kruhů
  _drawFog() {
    let circles = this.state?.discovery || [];
    // offline nasbírané body: odkrývej lokálně už teď (server je započítá po synchronizaci)
    if (this.localReveal?.length && this.data) {
      const lat0 = this.data.layers?.center?.lat ?? 49.0987, lon0 = this.data.layers?.center?.lon ?? 14.0884;
      const mlon = 111320 * Math.cos(lat0 * Math.PI / 180);
      circles = circles.concat(this.localReveal.map((p) => ({ x: (p.lon - lon0) * mlon, y: (p.lat - lat0) * 110574, r: 150 })));
    }
    if (!circles.length) return;
    const dpr = devicePixelRatio || 1;
    if (!this._fogCanvas) this._fogCanvas = document.createElement('canvas');
    const f = this._fogCanvas;
    if (f.width !== this.canvas.width || f.height !== this.canvas.height) { f.width = this.canvas.width; f.height = this.canvas.height; }
    const fx = f.getContext('2d');
    fx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.globalCompositeOperation = 'source-over';
    fx.clearRect(0, 0, innerWidth, innerHeight);
    fx.fillStyle = this.dark ? 'rgba(9,10,12,0.86)' : 'rgba(225,222,214,0.88)';
    fx.fillRect(0, 0, innerWidth, innerHeight);
    fx.globalCompositeOperation = 'destination-out';
    for (const c of circles) {
      const px = this.sx(c.x), py = this.sy(c.y), pr = c.r * this.scale;
      if (px < -pr || px > innerWidth + pr || py < -pr || py > innerHeight + pr) continue;
      fx.save();
      fx.translate(px, py);
      fx.scale(1, this.tiltY);
      const g = fx.createRadialGradient(0, 0, pr * 0.6, 0, 0, pr);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      fx.fillStyle = g;
      fx.beginPath();
      fx.arc(0, 0, pr, 0, Math.PI * 2);
      fx.fill();
      fx.restore();
    }
    this.ctx.drawImage(f, 0, 0, f.width, f.height, 0, 0, innerWidth, innerHeight);
  }

  // výška vytažení budov v px (roste s přiblížením a náklonem kamery)
  _extrusion() {
    if (this.scale <= 0.55) return 0;
    const tiltBoost = 1 + (1 - this.tiltY) * 2.2;
    return Math.min(30, this.scale * 5 * tiltBoost);
  }

  _drawBuildings3D(buildings) {
    const { ctx } = this;
    const C = this.colors;
    const h = this._extrusion();
    // kreslit odzadu (severní dřív), ať se překryvy skládají správně
    const vis = buildings.filter((b) => this._visible(b.p, 20))
      .sort((a, b) => this.sy(a.p[0][1]) - this.sy(b.p[0][1]));
    const wall = this.dark ? '#2E3036' : '#DCD8D0';
    const wallDark = this.dark ? '#282A2F' : '#CFCBC2';
    for (const b of vis) {
      // stěny: kvád z každé hrany půdorysu nahoru
      for (let i = 0; i < b.p.length - 1; i++) {
        const [x1, y1] = b.p[i], [x2, y2] = b.p[i + 1];
        const sx1 = this.sx(x1), sy1 = this.sy(y1), sx2 = this.sx(x2), sy2 = this.sy(y2);
        ctx.beginPath();
        ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2);
        ctx.lineTo(sx2, sy2 - h); ctx.lineTo(sx1, sy1 - h);
        ctx.closePath();
        // jednoduché stínování: západní stěny tmavší
        ctx.fillStyle = x2 > x1 ? wall : wallDark;
        ctx.fill();
      }
      // střecha (posunutá nahoru)
      ctx.beginPath();
      ctx.moveTo(this.sx(b.p[0][0]), this.sy(b.p[0][1]) - h);
      for (let i = 1; i < b.p.length; i++) ctx.lineTo(this.sx(b.p[i][0]), this.sy(b.p[i][1]) - h);
      ctx.closePath();
      ctx.fillStyle = C.building;
      ctx.fill();
      ctx.strokeStyle = C.buildingStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  _drawHouseNumbers() {
    if (this.scale < 0.8 || !this.data) return;
    const { ctx } = this;
    const h = this._extrusion();
    ctx.font = `600 ${Math.min(13, 6 + this.scale * 4)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = this.dark ? '#FFFFFF77' : '#00000066';
    for (const p of this.data.provinces) {
      if (p.kind !== 'house' || !p.houseNumber) continue;
      if (!this._visible(p.poly, 10)) continue;
      ctx.fillText(p.houseNumber, this.sx(p.c[0]), this.sy(p.c[1]) - h);
    }
    // při velkém přiblížení ukaž i surovinu domu (malá ikona nad střechou)
    if (this.scale > 1.6) {
      for (const p of this.data.provinces) {
        if (p.kind !== 'house' || !p.resource || p.resource === 'money') continue;
        if (!this._visible(p.poly, 10)) continue;
        this._resIcon(p.resource, p.c[0], p.c[1], false, false, -h - 16, 0.75);
      }
    }
  }

  // stroje na vylepšených územích (vlastní provincie) + animovaný kombajn a kývačka
  _drawMachines() {
    const { ctx } = this;
    this._machinesVisible = false;
    if (!this.state || !this.data || this.scale < 0.3) return;
    // vlajkový obrázek za sadu: první vlastněné vylepšení v tomhle pořadí
    // jen STROJE — postavy (horník, farmář…) chodí malé mezi dělníky, ne jako velký stroj
    const FLAGSHIP = {
      field: [['harvester', 'kombajn'], ['irrigation', 'zavlazovani'], ['granary', 'sypka']],
      pond: [['boat', 'lodka']],
      forest: [['tractor', 'traktor'], ['chainsaw', 'motorova-pila']],
      mine: [['drill', 'vrtna-souprava'], ['cart', 'dulni-vozik']],
      oil: [['derrick', 'vrtna-vez'], ['pumpjack', 'pumpjack'], ['tanker', 'cisterna']],
      gas: [['gastower', 'tezebni-vez'], ['compressor', 'kompresor']],
    };
    const SET_FOR = (p) => p.kind === 'pond' ? 'pond' : p.kind === 'forest' ? 'forest'
      : p.resource === 'oil' ? 'oil' : p.resource === 'gas' ? 'gas'
      : ['iron', 'coal'].includes(p.resource) ? 'mine'
      : (p.kind === 'field' || p.kind === 'meadow') ? 'field' : null;
    const now = performance.now();
    for (const st of this.state.provinces) {
      if (!st.upgrades || !Object.keys(st.upgrades).length) continue;
      const prov = this.data.provinces.find((p) => p.id === st.id);
      if (!prov || !this._visible(prov.poly, 30)) continue;
      const set = SET_FOR(prov);
      if (!set) continue;
      // vše se kreslí jen UVNITŘ hranic území (ořez polygonem)
      ctx.save();
      this._poly(prov.poly);
      ctx.clip();
      const size = Math.min(46, Math.max(18, this.scale * 26));
      // pohyblivé stroje: kombajn po poli, loďka po rybníce (za nimi částice)
      const mobile = set === 'field' && st.upgrades.harvester ? { img: 'kombajn', part: 'grain', speed: 24000 }
        : set === 'pond' && st.upgrades.boat ? { img: 'lodka', part: 'wake', speed: 34000 } : null;
      if (mobile) {
        this._machinesVisible = true;
        const img = this._img(mobile.img);
        if (img) {
          // pojezd po "řádcích": rovné převážně vodorovné úseky uvnitř polygonu, předkem po směru
          if (!this._scenes) this._scenes = new Map();
          const key = 'm' + prov.id;
          let s = this._scenes.get(key);
          const R = Math.sqrt(prov.area || 2000) * 0.34;
          const pickRow = (fx, fy) => {
            for (let k = 0; k < 14; k++) {
              const a = Math.random() * Math.PI * 2;
              const d = R * (0.4 + Math.random() * 0.6);
              const tx = prov.c[0] + Math.cos(a) * d, ty = prov.c[1] + Math.sin(a) * d;
              if (Math.abs(ty - fy) > 0.25 * Math.abs(tx - fx)) continue; // rovné řádky
              if (Math.hypot(tx - fx, ty - fy) < R * 0.5) continue;
              if (this.pointInPoly([tx, ty], prov.poly)) return [tx, ty];
            }
            return [fx + (Math.random() < 0.5 ? -1 : 1) * R * 0.7, fy + (Math.random() - 0.5) * R * 0.1];
          };
          if (!s) {
            s = { x: prov.c[0], y: prov.c[1], tPrev: now, faceRight: true };
            [s.tx, s.ty] = pickRow(s.x, s.y);
            this._scenes.set(key, s);
          }
          const SPEED = mobile.img === 'kombajn' ? 5.5 : 3.5; // m/s — klidné tempo
          const dt = Math.min(0.2, (now - s.tPrev) / 1000);
          s.tPrev = now;
          const dx = s.tx - s.x, dy = s.ty - s.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 2) [s.tx, s.ty] = pickRow(s.x, s.y);
          else {
            const step = Math.min(dist, SPEED * dt);
            s.x += (dx / dist) * step;
            s.y += (dy / dist) * step;
            s.faceRight = dx > 0;
          }
          const msize = mobile.img === 'kombajn' ? size * 1.6 : size * 1.15; // kombajn pořádně velký
          if (Math.random() < 0.5) this.particles.push({ x: s.x, y: s.y, t0: now, seed: Math.random(), kind: mobile.part });
          ctx.save();
          ctx.translate(this.sx(s.x), this.sy(s.y));
          if (s.faceRight) ctx.scale(-1, 1); // obrázek jede doleva; doprava = zrcadlo
          ctx.drawImage(img, -msize / 2, -msize / 2, msize, msize);
          ctx.restore();
        }
      } else if (!(set === 'forest' && st.upgrades.lumberjacks && this.scale > 0.5)) { // les se scénkou stroj nekreslí
        const flag = (FLAGSHIP[set] || []).find(([k]) => st.upgrades[k]);
        if (flag) {
          const img = this._img(flag[1]);
          if (img) {
            let bob = 0;
            const PART = { pumpjack: 'oil', 'vrtna-souprava': 'dust', 'tezebni-vez': 'flame', kompresor: 'smoke', 'vrtna-vez': 'oil' };
            const part = PART[flag[1]];
            if (flag[1] === 'pumpjack') { bob = Math.sin(now / 450) * size * 0.05; }
            if (part || bob) this._machinesVisible = true;
            // stroj napravo od středu, dělníci budou nalevo — ať se nepřekrývají
            const mx = prov.c[0] + 26 / this.scale, my = prov.c[1] + 8 / this.scale;
            if (part && Math.random() < 0.16) this.particles.push({ x: mx, y: my + size * 0.3 / this.scale, t0: now, seed: Math.random(), kind: part });
            ctx.drawImage(img, this.sx(mx) - size / 2, this.sy(my) - size / 2 + bob, size, size);
          }
        }
      }
      // animovaná scénka: dřevorubec CHODÍ po lese (fáze 1) a na místě kácí strom (fáze 2)
      if (set === 'forest' && st.upgrades.lumberjacks && this.scale > 0.5) {
        this._machinesVisible = true;
        const sheet = this._img('anim-drevorubec');
        if (sheet) {
          const FW = 300, FH = 140, COLS = 10;
          const WALK_END = 19, CHOP_END = 85; // 0–18 chůze, 19–84 strom+kácení+pád
          const FRAME_MS = 62;
          const ANCHORS = [147,148,149,150,150,149,149,148,148,148,148,148,148,148,147,147,147,147,146,145,152,187,212,228,234,234,227,219,212,204,197,190,184,177,171,167,163,160,157,154,152,150,149,148,147,147,148,150,154,156,156,154,153,152,149,148,147,147,147,146,146,146,146,146,148,154,161,163,165,168,170,172,173,177,181,184,185,186,187,182,172,170,168,167,165,164,163,161,160,158,156,154,152,151,148,145,143,141];
          const dw = Math.min(110, Math.max(44, this.scale * 42));
          const dh = dw * FH / FW;
          // víc dřevorubců podle úrovně vylepšení (max 3, každý vlastní stav)
          if (!this._scenes) this._scenes = new Map();
          const crew = Math.min(3, st.upgrades.lumberjacks || 1);
          const pickTarget = (fx, fy) => {
            const R = Math.sqrt(prov.area || 2000) * 0.32;
            for (let k = 0; k < 14; k++) {
              const a = Math.random() * Math.PI * 2;
              const d = R * (0.35 + Math.random() * 0.6);
              const tx = prov.c[0] + Math.cos(a) * d, ty = prov.c[1] + Math.sin(a) * d;
              // trasa musí být převážně VODOROVNÁ (sprite neumí chodit nahoru/dolů)
              if (Math.abs(ty - fy) > 0.5 * Math.abs(tx - fx)) continue;
              if (Math.hypot(tx - fx, ty - fy) < R * 0.4) continue;
              if (this.pointInPoly([tx, ty], prov.poly)) return [tx, ty];
            }
            // nouzově: krok do strany s minimálním svislým posunem
            const dir = Math.random() < 0.5 ? -1 : 1;
            return [fx + dir * R * 0.6, fy + (Math.random() - 0.5) * R * 0.2];
          };
          const SPEED = 11; // m/s chůze scénky
          for (let ci = 0; ci < crew; ci++) {
            const key = 'f' + prov.id + ':' + ci;
            let s = this._scenes.get(key);
            if (!s) {
              s = { mode: 'walk', x: prov.c[0] + (ci - 1) * 14, y: prov.c[1] + (ci - 1) * 9, t0: now, faceRight: true };
              [s.tx, s.ty] = pickTarget(s.x, s.y);
              this._scenes.set(key, s);
            }
            if (s.mode === 'walk') {
              const dt = Math.min(0.2, (now - (s.tPrev || now)) / 1000);
              const dx = s.tx - s.x, dy = s.ty - s.y;
              const dist = Math.hypot(dx, dy);
              if (dist < 2) {
                s.mode = 'chop';
                s.t0 = now;
              } else {
                const step = Math.min(dist, SPEED * dt);
                s.x += (dx / dist) * step;
                s.y += (dy / dist) * step;
                s.faceRight = dx > 0;
              }
            } else if (s.mode === 'chop' && now - s.t0 > (CHOP_END - WALK_END) * FRAME_MS) {
              s.mode = 'walk';
              [s.tx, s.ty] = pickTarget(s.x, s.y);
            }
            s.tPrev = now;
            const fi = s.mode === 'walk'
              ? Math.floor(now / FRAME_MS + ci * 7) % WALK_END
              : Math.min(WALK_END + Math.floor((now - s.t0) / FRAME_MS), CHOP_END - 1);
            ctx.save();
            ctx.translate(this.sx(s.x), this.sy(s.y));
            if (!s.faceRight) ctx.scale(-1, 1); // postava ve videu chodí DOPRAVA
            ctx.translate(-(ANCHORS[fi] - 147) * (dw / FW), 0); // ukotvení těžiště
            ctx.drawImage(sheet, (fi % COLS) * FW, Math.floor(fi / COLS) * FH, FW, FH, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
          }
        }
      }
      // dělníci: chodí sem a tam po území (počet podle úrovně, max 3)
      const WORKER = { field: ['farmers', 'farmar'], pond: ['fishermen', 'rybar'], forest: ['lumberjacks', 'drevorubec'], mine: ['miners', 'hornik'], oil: ['drillers', 'hornik'], gas: ['drillers', 'hornik'] };
      const [wKey, wImg] = WORKER[set];
      const lvl = st.upgrades[wKey] || 0;
      if (lvl > 0 && this.scale > 0.55 && set !== 'forest') { // les má animovanou scénku
        this._machinesVisible = true;
        const wi = this._img(wImg);
        if (wi) {
          const wsize = size * 0.55;
          const n = Math.min(3, lvl);
          for (let i = 0; i < n; i++) {
            const phase = now / 2600 + i * 2.1 + (prov.id % 5);
            const walk = Math.sin(phase);
            let bx, by;
            if (set === 'pond') {
              // rybáři stojí na BŘEHU (vrchol polygonu, kousek do vnitřku kvůli ořezu)
              const v = prov.poly[Math.floor((i + 1) * (prov.poly.length - 1) / (n + 1))];
              bx = v[0] + (prov.c[0] - v[0]) * 0.14;
              by = v[1] + (prov.c[1] - v[1]) * 0.14;
            } else {
              // ostatní nalevo od stroje, s rozestupy
              bx = prov.c[0] - 30 / this.scale + i * 16 / this.scale;
              by = prov.c[1] + (2 + i * 9) / this.scale;
            }
            const wx = bx + (set === 'pond' ? 0 : walk * 14 / this.scale);
            const flip = set === 'pond' ? (bx > prov.c[0]) : Math.cos(phase) < 0;
            ctx.save();
            ctx.translate(this.sx(wx), this.sy(by));
            if (flip) ctx.scale(-1, 1);
            ctx.drawImage(wi, -wsize / 2, -wsize / 2, wsize, wsize);
            ctx.restore();
          }
        }
      }
      ctx.restore(); // konec ořezu polygonem území
    }
    // částice: zrnka, brázda, prach, kouř, plamen, kapky ropy
    const keep = [];
    for (const p of this.particles) {
      const age = (now - p.t0) / 1400;
      if (age >= 1) continue;
      keep.push(p);
      const drift = { grain: 6, wake: 2, dust: -3, smoke: -9, flame: -7, oil: 7 }[p.kind] || 5;
      const px = this.sx(p.x + (p.seed - 0.5) * 8), py = this.sy(p.y + (p.seed - 0.5) * 5) + age * drift;
      const color = {
        grain: `rgba(201,162,39,${0.8 * (1 - age)})`,
        wake: `rgba(255,255,255,${0.75 * (1 - age)})`,
        dust: `rgba(140,132,120,${0.55 * (1 - age)})`,
        smoke: `rgba(120,120,125,${0.45 * (1 - age)})`,
        flame: `rgba(235,${140 - age * 80},60,${0.8 * (1 - age)})`,
        oil: `rgba(35,32,30,${0.7 * (1 - age)})`,
      }[p.kind] || `rgba(201,162,39,${0.8 * (1 - age)})`;
      ctx.beginPath();
      ctx.arc(px, py, (p.kind === 'smoke' ? 2.4 + age * 3 : 1.6) + this.scale * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    this.particles = keep.slice(-160);
  }

  _drawSelection() {
    const { ctx } = this;
    // glow obrys vybrané provincie
    if (this.selected && this.data) {
      const prov = this.data.provinces.find((p) => p.id === this.selected);
      if (prov && this._visible(prov.poly)) {
        ctx.save();
        ctx.shadowColor = this.dark ? '#FFFFFFAA' : '#00000055';
        ctx.shadowBlur = 14;
        this._poly(prov.poly);
        ctx.strokeStyle = this.dark ? '#FFFFFF' : '#2B2A28';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
      }
    }
    // pulz v místě ťuknutí
    if (this.selPulse) {
      const t = (performance.now() - this.selPulse.t0) / 750;
      if (t < 1) {
        const px = this.sx(this.selPulse.x), py = this.sy(this.selPulse.y);
        ctx.beginPath();
        ctx.arc(px, py, 6 + t * 42, 0, Math.PI * 2);
        ctx.strokeStyle = (this.dark ? '#FFFFFF' : '#2B2A28') + Math.round((1 - t) * 160).toString(16).padStart(2, '0');
        ctx.lineWidth = 2.5 * (1 - t) + 0.5;
        ctx.stroke();
      }
    }
  }

  ownerColor(id) { return this.playersById.get(id)?.color || '#8B877F'; }

  _drawProvinces() {
    const { ctx } = this;
    if (!this.state) return;
    const stById = new Map(this.state.provinces.map((p) => [p.id, p]));
    for (const prov of this.data.provinces) {
      if (!this._visible(prov.poly)) continue;
      const st = stById.get(prov.id);
      const owner = st?.owner;
      const isSel = this.selected === prov.id;
      if (owner) {
        this._poly(prov.poly);
        ctx.fillStyle = this.ownerColor(owner) + (isSel ? '55' : '2E');
        ctx.fill();
        ctx.strokeStyle = this.ownerColor(owner);
        ctx.lineWidth = isSel ? 3 : 1.6;
        ctx.stroke();
        // pevnost = "hradby" (dvojitý zubatý obrys jako v Supremacy)
        if (st?.fortress > 0) {
          this._poly(prov.poly);
          ctx.strokeStyle = this.dark ? '#B9B6AF' : '#6B675F';
          ctx.lineWidth = 2 + st.fortress * 0.6;
          ctx.setLineDash([7, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (prov.kind !== 'house') {
        // volná příroda: jemný obrys, ať je vidět, že jde obsadit
        this._poly(prov.poly);
        ctx.strokeStyle = this.dark ? '#FFFFFF20' : '#00000018';
        ctx.lineWidth = isSel ? 3 : 1;
        if (isSel) ctx.strokeStyle = this.dark ? '#FFFFFF88' : '#00000066';
        ctx.stroke();
      } else if (isSel) {
        this._poly(prov.poly);
        ctx.strokeStyle = this.dark ? '#FFFFFF88' : '#00000066';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      // ikona suroviny + bitva
      if (this.scale > 0.35 && prov.kind !== 'house') {
        const battle = this.state.battles?.some((b) => b.provinceId === prov.id);
        this._resIcon(prov.resource, prov.c[0], prov.c[1], prov.double, battle);
      }
    }
    // bitvy na domech
    if (this.state.battles) {
      for (const b of this.state.battles) {
        const prov = this.data.provinces.find((p) => p.id === b.provinceId);
        if (prov && this._visible(prov.poly)) this._battleIcon(prov.c[0], prov.c[1]);
      }
    }
  }

  _resIcon(res, x, y, double, battle, dy = 0, sizeMult = 1) {
    const { ctx } = this;
    const px = this.sx(x), py = this.sy(y) + dy;
    const r = Math.min(11, Math.max(6, this.scale * 9)) * sizeMult;
    const ICON = { grain: '#C9A227', fish: '#4A90D9', lumber: '#7A5230', iron: '#6E7B8B', coal: '#3A3A3A', oil: '#1F1F1F', gas: '#7B68B5', money: '#B8860B' };
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = this.dark ? '#202226E8' : '#FFFFFFE8';
    ctx.fill();
    ctx.strokeStyle = ICON[res] || '#888';
    ctx.lineWidth = double ? 2.5 : 1.3;
    ctx.stroke();
    ctx.fillStyle = ICON[res] || '#888';
    ctx.font = `700 ${r * 1.05}px -apple-system, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const CH = { grain: 'O', fish: 'R', lumber: 'D', iron: 'Ž', coal: 'U', oil: 'N', gas: 'P', money: 'K' };
    ctx.fillText(CH[res] || '?', px, py + 0.5);
    if (double) {
      ctx.font = `700 ${r * 0.8}px sans-serif`;
      ctx.fillText('2×', px, py - r - 5);
    }
  }
  _battleIcon(x, y) {
    const { ctx } = this;
    const px = this.sx(x), py = this.sy(y) - 16;
    ctx.font = '700 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#C62828';
    ctx.fillText('BOJ', px, py);
  }

  // trasa mezi sousedy (z routes.json), fallback rovná čára
  _route(aId, bId) {
    const key = aId < bId ? `${aId}-${bId}` : `${bId}-${aId}`;
    const pts = this.data?.routes?.[key];
    const a = this.data.provinces.find((p) => p.id === aId), b = this.data.provinces.find((p) => p.id === bId);
    const straight = a && b ? Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) : 0;
    if (pts && straight) {
      // stejné pravidlo jako server: silnice jen když nezachází o >30 %
      let rl = 0;
      for (let i = 0; i < pts.length - 1; i++) rl += Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]);
      if (rl > 1.3 * straight) return [a.c, b.c];
    }
    if (!pts) return a && b ? [a.c, b.c] : null;
    return aId < bId ? pts : pts.slice().reverse();
  }
  _pointAlong(pts, frac) {
    let total = 0;
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]);
      segs.push(l); total += l;
    }
    let want = total * Math.min(1, Math.max(0, frac));
    for (let i = 0; i < segs.length; i++) {
      if (want <= segs[i]) {
        const t = segs[i] ? want / segs[i] : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
      }
      want -= segs[i];
    }
    return pts[pts.length - 1];
  }
  _strokeRoute(pts, fromPos, color, width) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(this.sx(fromPos[0]), this.sy(fromPos[1]));
    for (const p of pts) ctx.lineTo(this.sx(p[0]), this.sy(p[1]));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawArmies() {
    const { ctx } = this;
    if (!this.state) return;
    this.armyHits = [];
    const provById = new Map(this.data.provinces.map((p) => [p.id, p]));
    // praporek se špičkou dolů jako v Supremacy 1914
    const drawDot = (x, y, color, size, moving) => {
      const px = this.sx(x), py = this.sy(y);
      const w = Math.max(24, 10 + String(size).length * 8), h = 16, tip = 7;
      ctx.beginPath();
      ctx.moveTo(px - w / 2, py - h - tip);
      ctx.lineTo(px + w / 2, py - h - tip);
      ctx.lineTo(px + w / 2, py - tip);
      ctx.lineTo(px, py);
      ctx.lineTo(px - w / 2, py - tip);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = this.dark ? '#191A1C' : '#FFFFFF';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 10.5px -apple-system, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(size), px, py - tip - h / 2 + 0.5);
      if (moving) {
        ctx.beginPath();
        ctx.arc(px, py + 3, 4, 0, Math.PI * 2);
        ctx.fillStyle = color + '66';
        ctx.fill();
      }
    };
    // vlastní armády — pochodují po cestách, klikací; stojící na stejném místě se rozestoupí
    const standCount = new Map();
    for (const a of this.state.armies || []) {
      const size = Object.values(a.units).reduce((s, v) => s + v, 0);
      if (!size) continue;
      const prov = provById.get(a.provinceId);
      if (!prov) continue;
      let stackOff = 0;
      if (!a.path) {
        const n = standCount.get(a.provinceId) || 0;
        standCount.set(a.provinceId, n + 1);
        stackOff = n * 42; // px doprava za každou další armádu
      }
      let pos = [prov.c[0] + stackOff / this.scale, prov.c[1]];
      let currentRoute = null, frac = 0;
      if (a.path && a.path.length && a.nextArrive) {
        currentRoute = this._route(a.provinceId, a.path[0]);
        if (currentRoute) {
          const total = a.nextArrive - (this._stateAt || Date.now());
          frac = Math.min(1, Math.max(0, 1 - (a.nextArrive - Date.now()) / Math.max(1, total || 1)));
          pos = this._pointAlong(currentRoute, frac);
        }
      }
      const isSel = this.selectedArmy === a.id;
      // trasa po cestách: zbytek aktuálního úseku + další úseky
      if (a.path && a.path.length) {
        const color = this.ownerColor(this.state.me.effId);
        const restPts = [];
        if (currentRoute) {
          // část aktuálního úseku od pozice dál
          let acc = 0, total = 0;
          const segs = [];
          for (let i = 0; i < currentRoute.length - 1; i++) {
            const l = Math.hypot(currentRoute[i][0] - currentRoute[i + 1][0], currentRoute[i][1] - currentRoute[i + 1][1]);
            segs.push(l); total += l;
          }
          let want = total * frac;
          for (let i = 0; i < segs.length; i++) {
            if (want < segs[i]) restPts.push(currentRoute[i + 1]);
            else want -= segs[i];
          }
        }
        let cur = a.path[0];
        for (let i = 1; i < a.path.length; i++) {
          const r = this._route(cur, a.path[i]);
          if (r) restPts.push(...r.slice(1));
          cur = a.path[i];
        }
        if (restPts.length) {
          this._strokeRoute(restPts, pos, color + (isSel ? 'FF' : '88'), isSel ? 4 : 2.5);
          const last = restPts[restPts.length - 1];
          ctx.beginPath();
          ctx.arc(this.sx(last[0]), this.sy(last[1]), isSel ? 7 : 5, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.lineWidth = isSel ? 3 : 2;
          ctx.stroke();
        }
        if (a.nextArrive) {
          const s = Math.max(0, Math.round((a.nextArrive - Date.now()) / 1000));
          const txt = s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
          ctx.font = '700 11px -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = this.dark ? '#E8E6E1' : '#2B2A28';
          ctx.fillText(txt, this.sx(pos[0]), this.sy(pos[1]) - 16);
        }
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(this.sx(pos[0]), this.sy(pos[1]), 15, 0, Math.PI * 2);
        ctx.strokeStyle = this.dark ? '#FFFFFFCC' : '#2B2A28CC';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      drawDot(pos[0], pos[1], this.ownerColor(this.state.me.effId), size, !!a.path);
      this.armyHits.push({ id: a.id, px: this.sx(pos[0]), py: this.sy(pos[1]) - 14 });
    }
    // cizí garnizony (viditelné)
    for (const p of this.state.provinces) {
      if (!p.garrison) continue;
      for (const g of p.garrison) {
        if (g.owner === this.state.me.effId) continue;
        const prov = provById.get(p.id);
        if (prov) drawDot(prov.c[0] + 14 / this.scale, prov.c[1] + 14 / this.scale, this.ownerColor(g.owner), g.size, false);
      }
    }
    // cizí pochodující armády
    for (const a of this.state.movingForeign || []) {
      const from = provById.get(a.provinceId), to = provById.get(a.nextId);
      if (!from) continue;
      let x = from.c[0], y = from.c[1];
      if (to && a.nextArrive) {
        const frac = 0.5;
        x = from.c[0] + (to.c[0] - from.c[0]) * frac;
        y = from.c[1] + (to.c[1] - from.c[1]) * frac;
      }
      drawDot(x, y, this.ownerColor(a.owner), a.size, true);
    }
  }

  _drawPois(far) {
    const { ctx } = this;
    if (!this.data.pois) return;
    const C = this.colors;
    ctx.textAlign = 'center';
    // škola
    if (!far && this.data.school) {
      const px = this.sx(this.data.school.x), py = this.sy(this.data.school.y);
      ctx.fillStyle = '#6A1B9A';
      ctx.font = '700 12px sans-serif';
      ctx.fillText('ŠKOLA', px, py - 8);
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
    }
    const showTowns = this.scale < 0.5;
    if (!showTowns) return;
    for (const t of this.data.pois.towns) {
      const px = this.sx(t.x), py = this.sy(t.y);
      if (px < -60 || px > innerWidth + 60 || py < -30 || py > innerHeight + 30) continue;
      ctx.fillStyle = C.poi;
      ctx.beginPath();
      const s = t.city ? 6 : 4;
      ctx.rect(px - s / 2, py - s / 2, s, s);
      ctx.fill();
      ctx.font = `${t.city ? 700 : 600} ${t.city ? 13 : 11}px -apple-system, sans-serif`;
      ctx.fillStyle = C.label;
      ctx.fillText(t.name, px, py - 7);
    }
    if (this.scale < 0.15) {
      for (const p of this.data.pois.peaks.slice(0, 60)) {
        const px = this.sx(p.x), py = this.sy(p.y);
        if (px < -40 || px > innerWidth + 40 || py < -20 || py > innerHeight + 20) continue;
        ctx.fillStyle = C.poi;
        ctx.beginPath();
        ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py + 3); ctx.lineTo(px - 5, py + 3);
        ctx.closePath(); ctx.fill();
        if (this.scale > 0.02) {
          ctx.font = '600 10px -apple-system, sans-serif';
          ctx.fillStyle = C.label;
          ctx.fillText(p.name, px, py - 8);
        }
      }
    }
  }

  _drawGps() {
    if (!this.gps) return;
    const { ctx } = this;
    const px = this.sx(this.gps[0]), py = this.sy(this.gps[1]);
    ctx.beginPath();
    ctx.arc(px, py, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#1565C033';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#1565C0';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  pointInPoly(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  armyAt(x, y) {
    if (!this.armyHits) return null;
    const px = this.sx(x), py = this.sy(y);
    let best = null, bestD = 20;
    for (const h of this.armyHits) {
      const d = Math.hypot(h.px - px, h.py - py);
      if (d < bestD) { best = h.id; bestD = d; }
    }
    return best;
  }
  provinceAt(x, y) {
    if (!this.data) return null;
    // domy mají přednost (jsou menší)
    const houses = [], rest = [];
    for (const p of this.data.provinces) (p.kind === 'house' ? houses : rest).push(p);
    for (const p of houses) if (this.pointInPoly([x, y], p.poly)) return p;
    for (const p of rest) if (this.pointInPoly([x, y], p.poly)) return p;
    return null;
  }
}

window.TeslaMap = TeslaMap;
