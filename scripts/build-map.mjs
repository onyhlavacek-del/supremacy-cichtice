// Build skript: surová OSM data -> herní mapa (vrstvy pro vykreslení + provincie + sousednost)
// Vstup:  data/raw/village.json, data/raw/pois.json
// Výstup: data/map/layers.json, data/map/provinces.json, data/map/pois.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Delaunay } from 'd3-delaunay';
import pc from 'polygon-clipping';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT = join(ROOT, 'data', 'map');
mkdirSync(OUT, { recursive: true });

// ---- projekce: lon/lat -> metry vůči středu Čichtic (x východ, y sever) ----
const CENTER = { lat: 49.0987, lon: 14.0884 };
const M_LAT = 110574; // metrů na stupeň šířky
const M_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);
const proj = (lat, lon) => [
  Math.round((lon - CENTER.lon) * M_LON * 10) / 10,
  Math.round((lat - CENTER.lat) * M_LAT * 10) / 10,
];

const village = JSON.parse(readFileSync(join(RAW, 'village.json'), 'utf8'));

// ---- parsování OSM elementů ----
function wayPolygon(el) {
  if (!el.geometry) return null;
  const pts = el.geometry.map((g) => proj(g.lat, g.lon));
  const first = pts[0], last = pts[pts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);
  return pts;
}
function wayLine(el) {
  if (!el.geometry) return null;
  return el.geometry.map((g) => proj(g.lat, g.lon));
}
function polyArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}
function centroid(ring) {
  let x = 0, y = 0, n = ring.length - 1;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [Math.round((x / n) * 10) / 10, Math.round((y / n) * 10) / 10];
}
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

const layers = { water: [], forest: [], field: [], meadow: [], residential: [], buildings: [], roads: [], streams: [] };
const naturePolys = []; // kandidáti na provincie
const buildings = [];

for (const el of village.elements) {
  const t = el.tags || {};
  if (el.type === 'way' && t.building) {
    const p = wayPolygon(el);
    if (!p) continue;
    const b = { poly: p, kind: t.building, area: polyArea(p), c: centroid(p), tags: t };
    buildings.push(b);
    layers.buildings.push({ p, k: t.building });
  } else if (el.type === 'way' && (t.natural === 'water')) {
    const p = wayPolygon(el);
    if (!p) continue;
    layers.water.push(p);
    naturePolys.push({ kind: 'pond', poly: p, name: t.name || null });
  } else if (el.type === 'relation' && t.natural === 'water') {
    for (const m of el.members || []) {
      if (m.role === 'outer' && m.geometry) {
        const pts = m.geometry.map((g) => proj(g.lat, g.lon));
        if (pts.length > 3) {
          const first = pts[0], last = pts[pts.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);
          layers.water.push(pts);
          naturePolys.push({ kind: 'pond', poly: pts, name: t.name || null });
        }
      }
    }
  } else if (el.type === 'way' && (t.landuse === 'forest' || t.natural === 'wood')) {
    const p = wayPolygon(el);
    if (!p) continue;
    layers.forest.push(p);
    naturePolys.push({ kind: 'forest', poly: p, name: t.name || null });
  } else if (el.type === 'way' && t.landuse === 'farmland') {
    const p = wayPolygon(el);
    if (!p) continue;
    layers.field.push(p);
    naturePolys.push({ kind: 'field', poly: p, name: t.name || null });
  } else if (el.type === 'way' && ['meadow', 'grass', 'orchard', 'vineyard'].includes(t.landuse) || t.natural === 'grassland' || t.natural === 'scrub') {
    const p = wayPolygon(el);
    if (!p) continue;
    layers.meadow.push(p);
    naturePolys.push({ kind: 'meadow', poly: p, name: t.name || null });
  } else if (el.type === 'way' && (t.landuse === 'residential' || t.landuse === 'farmyard')) {
    const p = wayPolygon(el);
    if (!p) continue;
    layers.residential.push({ p, farmyard: t.landuse === 'farmyard' });
  } else if (el.type === 'way' && t.highway) {
    const l = wayLine(el);
    if (!l) continue;
    const major = ['secondary', 'tertiary', 'primary'].includes(t.highway);
    const minor = ['residential', 'unclassified', 'service', 'living_street'].includes(t.highway);
    const kind = major ? 'major' : minor ? 'minor' : 'track';
    layers.roads.push({ l, k: kind });
  } else if (el.type === 'way' && t.waterway) {
    const l = wayLine(el);
    if (l) layers.streams.push(l);
  }
}

// ---- domy Čichtic: obytné budovy do 600 m od středu ----
const HOUSE_KINDS = new Set(['yes', 'house', 'residential', 'detached', 'farm', 'apartments', 'semidetached_house']);
// budovy s neurčitým tagem (yes/farm) bereme jen s číslem popisným — jinak jsou to stodoly
const SURE_KINDS = new Set(['house', 'residential', 'detached', 'apartments', 'semidetached_house']);
const VILLAGE_R = 600;
const houseCandidates = buildings.filter(
  (b) => HOUSE_KINDS.has(b.kind) && b.area >= 45 && Math.hypot(b.c[0], b.c[1]) < VILLAGE_R
);

// ---- čísla popisná: adresní body RÚIAN (samostatné uzly) -> napárovat na budovy ----
function ringContains(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
try {
  const addrData = JSON.parse(readFileSync(join(RAW, 'addresses.json'), 'utf8'));
  const addrs = addrData.elements
    .filter((e) => e.tags?.['addr:housenumber'] && (e.tags['addr:place'] === 'Čichtice' || !e.tags['addr:place']))
    .map((e) => ({ num: e.tags['addr:housenumber'], p: proj(e.lat, e.lon), used: false }));
  // Globální párování: vzdálenost adresního bodu k OBRYSU budovy (uvnitř = 0),
  // obytné budovy mají přednost před neurčitými (kůlny), přiřazuje se od nejlepší shody.
  const distToRing = (pt, ring) => {
    if (ringContains(pt, ring)) return 0;
    let best = Infinity;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((pt[0] - x1) * dx + (pt[1] - y1) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(pt[0] - (x1 + dx * t), pt[1] - (y1 + dy * t)));
    }
    return best;
  };
  const pairs = [];
  for (const b of houseCandidates) {
    for (const a of addrs) {
      const d = distToRing(a.p, b.poly);
      if (d > 40) continue;
      pairs.push({ b, a, score: d + (SURE_KINDS.has(b.kind) ? 0 : 8) });
    }
  }
  pairs.sort((x, y) => x.score - y.score);
  for (const { b, a } of pairs) {
    if (b.houseNumber || a.used) continue;
    b.houseNumber = a.num;
    a.used = true;
  }
  const matched = houseCandidates.filter((b) => b.houseNumber).length;
  console.log(`Čísla popisná: ${matched}/${houseCandidates.length} kandidátů (adresních bodů ${addrs.length})`);
} catch (e) {
  console.warn('addresses.json chybí — domy budou bez čísel popisných:', e.message);
}

const houseBuildings = houseCandidates.filter((b) => b.houseNumber || SURE_KINDS.has(b.kind));
console.log('Obytných domů v Čichticích:', houseBuildings.length);

// ---- rezidenční plocha Čichtic (union) pro ořez zahrad ----
const resNear = layers.residential.filter((r) => Math.hypot(...centroid(r.p)) < VILLAGE_R + 250).map((r) => [r.p]);
let resUnion = null;
try {
  resUnion = pc.union(...resNear);
} catch (e) {
  console.warn('Union rezidenčních ploch selhal, používám buffer domů:', e.message);
}

// ---- katastrální parcely (ČÚZK INSPIRE WFS) — skutečné hranice pozemků ----
let parcels = [];
try {
  const gml = readFileSync(join(RAW, 'parcels.gml'), 'utf8');
  for (const block of gml.match(/<cp:CadastralParcel[\s\S]*?<\/cp:CadastralParcel>/g) || []) {
    const pos = block.match(/<gml:exterior>[\s\S]*?<gml:posList>([^<]+)</);
    if (!pos) continue;
    const nums = pos[1].trim().split(/\s+/).map(Number);
    const ring = [];
    for (let i = 0; i < nums.length - 1; i += 2) ring.push(proj(nums[i], nums[i + 1]));
    if (ring.length < 4) continue;
    const label = (block.match(/<cp:label>([^<]+)</) || [])[1] || '?';
    parcels.push({ ring, label, area: polyArea(ring), c: centroid(ring) });
  }
  console.log('Katastrálních parcel:', parcels.length);
} catch { console.warn('parcels.gml chybí — zahrady jen z Voronoi'); }
function ringsTouch(a, b) {
  const sa = edgeSamples(a, 4), sb = edgeSamples(b, 4);
  for (const p of sa) for (const q of sb) if (dist2(p, q) < 2.25) return true;
  return false;
}
function parcelYard(b, allHouses) {
  const base = parcels.find((p) => pointInRing(b.c, p.ring));
  if (!base) return null;
  const parts = [[[base.ring]][0]];
  for (const p of parcels) {
    if (p === base || p.area > 2500) continue;
    if (Math.hypot(p.c[0] - b.c[0], p.c[1] - b.c[1]) > 70) continue;
    if (allHouses.some((o) => o !== b && pointInRing(o.c, p.ring))) continue;
    // zahrada patří nejbližšímu domu
    let nearest = null, nd = Infinity;
    for (const o of allHouses) {
      const d = dist2(o.c, p.c);
      if (d < nd) { nd = d; nearest = o; }
    }
    if (nearest !== b) continue;
    if (!ringsTouch(p.ring, base.ring)) continue;
    parts.push([[p.ring]][0]);
  }
  try {
    const R = 55;
    const cap = [[[b.c[0] - R, b.c[1] - R], [b.c[0] + R, b.c[1] - R], [b.c[0] + R, b.c[1] + R], [b.c[0] - R, b.c[1] + R], [b.c[0] - R, b.c[1] - R]]];
    const u = pc.intersection(pc.union(...parts), cap);
    for (const mp of u) if (pointInRing(b.c, mp[0])) return mp[0];
    let bigger = null, ba = 0;
    for (const mp of u) { const a = polyArea(mp[0]); if (a > ba) { ba = a; bigger = mp[0]; } }
    return bigger;
  } catch { return null; }
}

// ---- Voronoi zahrady (fallback, kde parcela chybí) ----
const seeds = houseBuildings.map((b) => b.c);
const delaunay = Delaunay.from(seeds);
const bound = 900;
const voronoi = delaunay.voronoi([-bound, -bound, bound, bound]);

function bboxBuffer(b, m) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of b.poly) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
  return [[[minx - m, miny - m], [maxx + m, miny - m], [maxx + m, maxy + m], [minx - m, maxy + m], [minx - m, miny - m]]];
}

const provinces = [];
let pid = 1;
let parcelYards = 0;
houseBuildings.forEach((b, i) => {
  const cell = voronoi.cellPolygon(i);
  let yard = parcelYard(b, houseBuildings);
  if (yard) parcelYards++;
  if (!yard && cell && resUnion) {
    try {
      // strop velikosti zahrady: max R metrů od domu (jinak se okrajové buňky táhnou do dálky)
      const R = 38;
      const capBox = [[[b.c[0] - R, b.c[1] - R], [b.c[0] + R, b.c[1] - R], [b.c[0] + R, b.c[1] + R], [b.c[0] - R, b.c[1] + R], [b.c[0] - R, b.c[1] - R]]];
      const isect = pc.intersection([ [cell.map(([x, y]) => [x, y]) ] ][0], resUnion, capBox);
      // vezmi část obsahující dům
      let best = null;
      for (const mp of isect) for (const ring of [mp[0]]) {
        if (polyArea(ring.concat([ring[0]])) > 80 && pointInRing(b.c, ring)) best = mp;
      }
      if (!best) { // dům mimo rezidenční plochu — vezmi největší kus nebo fallback
        let bestA = 0;
        for (const mp of isect) { const a = polyArea(mp[0].concat([mp[0][0]])); if (a > bestA) { bestA = a; best = mp; } }
        if (bestA < 120) best = null;
      }
      if (best) yard = best[0];
    } catch { /* fallback níže */ }
  }
  if (!yard) yard = bboxBuffer(b, 14)[0];
  if (yard[0][0] !== yard[yard.length - 1][0] || yard[0][1] !== yard[yard.length - 1][1]) yard.push(yard[0]);
  // zahrada musí obsahovat celý půdorys domu (Voronoi hranice jinak dům ořízne)
  try {
    const u = pc.union([[yard]][0], [[b.poly]][0]);
    for (const mp of u) {
      if (pointInRing(b.c, mp[0])) { yard = mp[0]; closeYard(yard); break; }
    }
  } catch { /* necháme původní zahradu */ }
  const hn = b.houseNumber || b.tags['addr:housenumber'] || null;
  provinces.push({
    id: pid++,
    kind: 'house',
    name: hn ? `Dům čp. ${hn}` : `Dům bez čp. (${provinces.filter((p) => p.kind === 'house' && !p.houseNumber).length + 1})`,
    houseNumber: hn,
    resource: 'money',
    double: false,
    poly: yard.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    building: b.poly,
    c: b.c,
    area: Math.round(polyArea(yard.concat([yard[0]]))),
  });
});

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function closeYard(ring) {
  const f = ring[0], l = ring[ring.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
}

// ---- suroviny domů: každý dům produkuje jednu ze 7 surovin (+ daně) jako v Supremacy ----
// Férovost: vyrovnané počty všech surovin a stejná surovina co nejdál od sebe.
{
  const HOUSE_RES = ['grain', 'fish', 'lumber', 'iron', 'coal', 'oil', 'gas'];
  const counts = Object.fromEntries(HOUSE_RES.map((r) => [r, 0]));
  const houses = provinces.filter((p) => p.kind === 'house');
  for (const h of houses) {
    let best = null, bestScore = -Infinity;
    for (const r of HOUSE_RES) {
      const same = houses.filter((x) => x.resource === r && x !== h);
      const minD = same.length ? Math.min(...same.map((x) => dist2(x.c, h.c))) : 1e9;
      const score = -counts[r] * 1e10 + Math.min(minD, 300 * 300);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    h.resource = best;
    counts[best]++;
  }
  console.log('Suroviny domů:', counts);
}

// ---- přírodní provincie: dost velké plochy do 1600 m od středu ----
const NATURE_R = 1600;
const MIN_AREA = { pond: 1500, forest: 2500, field: 4000, meadow: 3000 };
const counters = { pond: 0, forest: 0, field: 0, meadow: 0 };
const KIND_LABEL = { pond: 'Rybník', forest: 'Les', field: 'Pole', meadow: 'Louka' };
const KIND_RESOURCE = { pond: 'fish', forest: 'lumber', field: 'grain', meadow: 'grain' };
for (const np of naturePolys) {
  const a = polyArea(np.poly);
  const c = centroid(np.poly);
  if (a < MIN_AREA[np.kind] || Math.hypot(...c) > NATURE_R) continue;
  counters[np.kind]++;
  provinces.push({
    id: pid++,
    kind: np.kind,
    name: np.name || `${KIND_LABEL[np.kind]} ${counters[np.kind]}`,
    resource: KIND_RESOURCE[np.kind],
    double: false,
    poly: np.poly.map(([x, y]) => [x, y]),
    c,
    area: Math.round(a),
  });
}
console.log('Zahrad z katastru:', parcelYards, 'z', houseBuildings.length);
console.log('Přírodní provincie:', counters);

// ---- rozložení vzácných surovin (železo, uhlí, ropa, plyn) ----
// Vesnice nemá přirozená ložiska, hra ale potřebuje všech 7 surovin. Přednostně se
// přemění LOUKY (pole ať pěstují obilí); rozprostřeno po mapě (farthest-point sampling),
// aby nikdo neměl všechno za rohem. Přeměněné provincie dostanou smysluplné jméno.
const scarce = ['iron', 'coal', 'oil', 'gas'];
const DEPOSIT_NAME = { iron: 'Železný důl', coal: 'Uhelný důl', oil: 'Ropné pole', gas: 'Plynové pole' };
const meadowsFirst = [
  ...provinces.filter((p) => p.kind === 'meadow'),
  ...provinces.filter((p) => p.kind === 'field'),
];
const totalNature = provinces.filter((p) => p.kind !== 'house').length;
const perScarce = Math.max(2, Math.floor(totalNature / 7));
const assigned = [];
const depositCounter = { iron: 0, coal: 0, oil: 0, gas: 0 };
for (const res of scarce) {
  for (let k = 0; k < perScarce; k++) {
    let best = null, bestScore = -1;
    for (const p of meadowsFirst) {
      if (p.resource !== 'grain') continue;
      // louky mají přednost: pole dostanou malus na skóre
      const minD = assigned.length ? Math.min(...assigned.map((q) => dist2(p.c, q.c))) : dist2(p.c, [0, 0]);
      const score = p.kind === 'meadow' ? minD * 4 : minD;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) break;
    best.resource = res;
    depositCounter[res]++;
    best.name = `${DEPOSIT_NAME[res]} ${depositCounter[res]}`;
    assigned.push(best);
  }
}
console.log('Ložiska:', depositCounter);

// ---- dvojité provincie: největší plocha od každé suroviny ----
for (const res of ['grain', 'fish', 'lumber', 'iron', 'coal', 'oil', 'gas']) {
  const cand = provinces.filter((p) => p.resource === res && p.kind !== 'house');
  if (!cand.length) continue;
  cand.sort((a, b) => b.area - a.area);
  cand[0].double = true;
}

// ---- turistické značené trasy (KČT barvy z OSM, jako na Mapy.cz) ----
layers.trails = [];
try {
  const tr = JSON.parse(readFileSync(join(RAW, 'trails.json'), 'utf8'));
  for (const rel of tr.elements || []) {
    const color = ((rel.tags || {})['osmc:symbol'] || 'red').split(':')[0];
    for (const m of rel.members || []) {
      if (m.type !== 'way' || !m.geometry) continue;
      const pts = m.geometry.map((g) => proj(g.lat, g.lon));
      // kresli jen úseky v širším okolí vesnice
      if (pts.some((p) => Math.hypot(p[0], p[1]) < 6000)) layers.trails.push({ l: pts, c: color });
    }
  }
  console.log('Turistických úseků:', layers.trails.length);
} catch { console.warn('trails.json chybí — bez turistických tras'); }

// ---- silniční graf: vojáci chodí po cestách ----
const roadGraph = new Map(); // "x|y" -> {p: [x,y], edges: Map(key -> délka)}
const rkey = (p) => `${Math.round(p[0])}|${Math.round(p[1])}`;
function addRoadNode(p) {
  const k = rkey(p);
  if (!roadGraph.has(k)) roadGraph.set(k, { p: [p[0], p[1]], edges: new Map() });
  return k;
}
for (const r of layers.roads) {
  for (let i = 0; i < r.l.length - 1; i++) {
    const a = addRoadNode(r.l[i]), b = addRoadNode(r.l[i + 1]);
    const len = Math.hypot(r.l[i][0] - r.l[i + 1][0], r.l[i][1] - r.l[i + 1][1]);
    roadGraph.get(a).edges.set(b, len);
    roadGraph.get(b).edges.set(a, len);
  }
}
const roadNodes = [...roadGraph.entries()];
function nearestRoadNode(pt, maxD = 120) {
  let best = null, bestD = maxD * maxD;
  for (const [k, n] of roadNodes) {
    const d = dist2(pt, n.p);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
// binární halda pro Dijkstru
class MinHeap {
  constructor() { this.a = []; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}
// Dijkstra od jednoho uzlu; vrací {dist: Map, prev: Map}
function dijkstra(startKey, maxDist = 5000) {
  const dist = new Map([[startKey, 0]]), prev = new Map();
  const heap = new MinHeap();
  heap.push([0, startKey]);
  const seen = new Set();
  while (heap.size) {
    const [d, k] = heap.pop();
    if (seen.has(k) || d > maxDist) continue;
    seen.add(k);
    for (const [n, len] of roadGraph.get(k).edges) {
      const nd = d + len;
      if (nd < (dist.get(n) ?? Infinity)) { dist.set(n, nd); prev.set(n, k); heap.push([nd, n]); }
    }
  }
  return { dist, prev };
}
console.log('Silniční graf:', roadGraph.size, 'uzlů');

// ---- sousednost: hrany polygonů blíž než PRÁH metrů ----
const ADJ_M = 28;
function edgeSamples(poly, step = 12) {
  const out = [];
  for (let i = 0; i < poly.length - 1; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  }
  return out;
}
const samples = provinces.map((p) => edgeSamples(p.poly));
const adj = new Map(provinces.map((p) => [p.id, new Set()]));
for (let i = 0; i < provinces.length; i++) {
  for (let j = i + 1; j < provinces.length; j++) {
    const a = provinces[i], b = provinces[j];
    if (Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) > Math.sqrt(a.area) + Math.sqrt(b.area) + 250) continue;
    let close = false;
    outer: for (const s of samples[i]) for (const t of samples[j]) {
      if (dist2(s, t) < ADJ_M * ADJ_M) { close = true; break outer; }
    }
    if (close) { adj.get(a.id).add(b.id); adj.get(b.id).add(a.id); }
  }
}
// ---- trasy po cestách + "ulice" propojení ----
const provById = new Map(provinces.map((p) => [p.id, p]));
const provRoadNode = new Map();
for (const p of provinces) {
  const k = nearestRoadNode(p.c, p.kind === 'house' ? 90 : 260);
  if (k) provRoadNode.set(p.id, k);
}
const nodeToProv = new Map();
for (const [pid, k] of provRoadNode) {
  if (!nodeToProv.has(k)) nodeToProv.set(k, []);
  nodeToProv.get(k).push(pid);
}
const routes = {};
const polylineLen = (pts) => { let l = 0; for (let i = 0; i < pts.length - 1; i++) l += Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]); return l; };
function buildRoute(a, b, prev, kb) {
  const pts = [];
  for (let at = kb; at; at = prev.get(at)) pts.unshift(roadGraph.get(at).p);
  const route = [[a.c[0], a.c[1]], ...pts, [b.c[0], b.c[1]]].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  return route;
}
function storeRoute(a, b, route) {
  if (a.id < b.id) routes[`${a.id}-${b.id}`] = route;
  else routes[`${b.id}-${a.id}`] = route.slice().reverse();
}
let streetLinks = 0;
for (const a of provinces) {
  const ka = provRoadNode.get(a.id);
  if (!ka) continue;
  const { dist, prev } = dijkstra(ka, 1200);
  // trasy pro stávající sousedy (jen jednou na dvojici)
  for (const bId of adj.get(a.id)) {
    if (bId < a.id || routes[`${a.id}-${bId}`]) continue;
    const b = provById.get(bId);
    const kb = provRoadNode.get(bId);
    if (!b || !kb || !dist.has(kb)) continue;
    const route = buildRoute(a, b, prev, kb);
    const straight = Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]);
    if (polylineLen(route) < straight * 3 + 120) storeRoute(a, b, route);
  }
  // "ulice": domy u stejné cesty do 180 m po cestě jsou sousedi (řeší domy za domy)
  for (const [k2, pids] of nodeToProv) {
    const d = dist.get(k2);
    if (d == null || d > 180) continue;
    for (const bId of pids) {
      if (bId === a.id || adj.get(a.id).has(bId)) continue;
      const b = provById.get(bId);
      adj.get(a.id).add(bId);
      adj.get(bId).add(a.id);
      storeRoute(a, b, buildRoute(a, b, prev, k2));
      streetLinks++;
    }
  }
}
console.log('Tras po cestách:', Object.keys(routes).length, '| nových uličních spojů:', streetLinks);

// ---- spojitost grafu: propojit komponenty nejbližší dvojicí ----
function components() {
  const seen = new Set(), comps = [];
  for (const p of provinces) {
    if (seen.has(p.id)) continue;
    const comp = [], stack = [p.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id); comp.push(id);
      for (const n of adj.get(id)) stack.push(n);
    }
    comps.push(comp);
  }
  return comps;
}
let comps = components();
while (comps.length > 1) {
  const byId = new Map(provinces.map((p) => [p.id, p]));
  let best = null;
  for (let i = 1; i < comps.length; i++) {
    for (const a of comps[0]) for (const b of comps[i]) {
      const d = dist2(byId.get(a).c, byId.get(b).c);
      if (!best || d < best.d) best = { a, b, d };
    }
  }
  adj.get(best.a).add(best.b); adj.get(best.b).add(best.a);
  comps = components();
}
for (const p of provinces) p.adjacent = [...adj.get(p.id)].sort((a, b) => a - b);
console.log('Provincie celkem:', provinces.length, '| průměrně sousedů:', (provinces.reduce((s, p) => s + p.adjacent.length, 0) / provinces.length).toFixed(1));

// ---- POI: města a kopce ----
const poisRaw = JSON.parse(readFileSync(join(RAW, 'pois.json'), 'utf8'));
const towns = [], peaks = [];
for (const e of poisRaw.elements) {
  const t = e.tags || {};
  const [x, y] = proj(e.lat, e.lon);
  const km = Math.round(Math.hypot(x, y) / 100) / 10;
  if (t.place === 'city' || t.place === 'town') towns.push({ name: t.name, x, y, km, city: t.place === 'city', pop: +t.population || null });
  else if (t.natural === 'peak' && t.name) peaks.push({ name: t.name, x, y, km, ele: +t.ele || null });
}
// rozhledny z OSM (pokud se povedlo stáhnout towers.json) + ruční doplňky (extra-pois.json)
try {
  const tw = JSON.parse(readFileSync(join(RAW, 'towers.json'), 'utf8'));
  for (const e of tw.elements || []) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (!lat || !t.name) continue;
    const [x, y] = proj(lat, lon);
    peaks.push({ name: t.name, x, y, km: Math.round(Math.hypot(x, y) / 100) / 10, ele: +t.ele || null, tower: true });
  }
} catch { /* towers.json není — nevadí */ }
try {
  const extra = JSON.parse(readFileSync(join(RAW, 'extra-pois.json'), 'utf8'));
  for (const p of extra.peaks || []) {
    const [x, y] = proj(p.lat, p.lon);
    peaks.push({ name: p.name, x, y, km: Math.round(Math.hypot(x, y) / 100) / 10, ele: p.ele || null, tower: !!p.tower });
  }
  console.log('Ruční POI:', (extra.peaks || []).map((p) => p.name).join(', '));
} catch { /* žádné ruční doplňky */ }

towns.sort((a, b) => a.km - b.km);
peaks.sort((a, b) => a.km - b.km);
// dedupe kopců stejného jména blízko sebe
const seenPeak = new Set();
const peaksOut = peaks.filter((p) => {
  const key = p.name + '|' + Math.round(p.x / 500) + '|' + Math.round(p.y / 500);
  if (seenPeak.has(key)) return false;
  seenPeak.add(key);
  return true;
});
console.log('Měst:', towns.length, '| kopců:', peaksOut.length);

// ---- výstup ----
writeFileSync(join(OUT, 'layers.json'), JSON.stringify({ center: CENTER, layers }));
writeFileSync(join(OUT, 'provinces.json'), JSON.stringify({ center: CENTER, provinces }));
writeFileSync(join(OUT, 'pois.json'), JSON.stringify({ center: CENTER, towns, peaks: peaksOut }));
writeFileSync(join(OUT, 'routes.json'), JSON.stringify(routes));
console.log('Hotovo -> data/map/{layers,provinces,pois,routes}.json');
