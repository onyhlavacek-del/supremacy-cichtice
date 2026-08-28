// HTTP server: statické soubory, API, SSE stream, autentizace
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import pc from 'polygon-clipping';
import * as C from './constants.js';
import { restoreBackup, startBackups, backupLog } from './backup.js';
const BOOT_TS = Date.now();

// před otevřením databáze zkus obnovit zálohu (hosting bez trvalého disku)
await restoreBackup();
const { db, q, metaGet, metaSet } = await import('./db.js');
const G = await import('./game.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = process.env.PORT || 8080;

const ADMIN_NAMES = (process.env.ADMIN_NAMES || 'Ondra H').split(',').map((x) => x.trim());
const isAdmin = (player) => player.id === 1 || ADMIN_NAMES.includes(player.name);

const COLORS = ['#2E7D32', '#C62828', '#1565C0', '#EF6C00', '#6A1B9A', '#00838F', '#AD1457', '#4E342E', '#33691E', '#283593', '#B8860B', '#37474F'];

// ---------- pomocníci ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function getCookie(req, name) {
  const c = req.headers.cookie;
  if (!c) return null;
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function auth(req) {
  const token = getCookie(req, 'sup_token');
  if (!token) return null;
  const s = q.get('SELECT * FROM sessions WHERE token = ?', token);
  if (!s) return null;
  return G.playerById(s.player_id);
}
function hashPass(pass, salt) { return scryptSync(pass, salt, 32).toString('hex'); }

// ---------- SSE ----------
const sseClients = new Map(); // playerId -> Set(res)
G.onPush((playerId, obj) => {
  const msg = `data: ${JSON.stringify(obj)}\n\n`;
  const targets = playerId == null ? [...sseClients.values()].flatMap((s) => [...s]) : [...(sseClients.get(playerId) || [])];
  // u týmů pošli i parťákovi
  if (playerId != null) {
    for (const p of q.all('SELECT id FROM players WHERE team_with = ?', playerId)) {
      for (const r of sseClients.get(p.id) || []) targets.push(r);
    }
  }
  for (const res of targets) { try { res.write(msg); } catch { /* zavřeno */ } }
});

// ---------- registrace / přihlášení ----------
function doRegister(body) {
  const name = String(body.name || '').trim().slice(0, 24);
  const pass = String(body.pass || '');
  const houseId = +body.houseId;
  const decision = body.decision; // undefined | 'team' | 'split'
  if (name.length < 2) return { code: 400, data: { error: 'Jméno musí mít aspoň 2 znaky.' } };
  if (pass.length < 4) return { code: 400, data: { error: 'Heslo musí mít aspoň 4 znaky.' } };
  if (q.get('SELECT id FROM players WHERE name = ? OR login_alias = ?', name, name)) return { code: 400, data: { error: 'Tohle jméno už někdo má.' } };
  const prov = G.provinces.get(houseId);
  if (!prov || prov.kind !== 'house') return { code: 400, data: { error: 'Vyber svůj dům na mapě.' } };
  const st = q.get('SELECT * FROM province_state WHERE id = ?', houseId);

  let finalHouseId = houseId;
  let siblingOf = null;

  if (st.owner_id) {
    const owner = G.playerById(st.owner_id);
    if (!decision) return { code: 200, data: { occupied: true, ownerName: owner.name } };
    if (decision === 'team') {
      // společná říše s vlastníkem domu
      const salt = randomBytes(8).toString('hex');
      q.run('INSERT INTO players (name, pass_hash, salt, color, team_with, created) VALUES (?, ?, ?, ?, ?, ?)',
        name, hashPass(pass, salt), salt, owner.color, G.effId(owner), Date.now());
      const p = q.get('SELECT * FROM players WHERE name = ?', name);
      G.notify(G.effId(owner), 'team', `${name} se přidal do tvé říše — hrajete spolu.`);
      return { code: 200, data: { ok: true, playerId: p.id } };
    }
    if (decision === 'split') {
      // rozdělit dům na dvě STEJNĚ velké poloviny (svislá čára, binární hledání)
      if (prov.custom) return { code: 400, data: { error: 'Tenhle dům už je rozdělený — vyber jinou část, nebo hraj spolu.' } };
      const [halfA, halfB] = fairSplit(prov.poly);
      if (!halfA || !halfB) return { code: 400, data: { error: 'Dům se nepodařilo rozdělit — napište adminovi.' } };
      // vlastníkova půlka = ta s jeho budovou (podle centroidu budovy)
      const bc = prov.building ? centroidRing(prov.building) : prov.c;
      const aHasB = G.pointInPoly(bc, halfA);
      const ownerHalf = aHasB ? halfA : halfB;
      const newHalf = aHasB ? halfB : halfA;
      const newId = 100000 + houseId;
      const adj = [...(prov.adjacent || []), newId];
      closeRing(ownerHalf); closeRing(newHalf);
      q.run('INSERT OR REPLACE INTO province_custom (id, base_id, name, poly, adjacent) VALUES (?, ?, ?, ?, ?)',
        houseId, houseId, prov.name + ' (půlka A)', JSON.stringify(ownerHalf), JSON.stringify(adj));
      q.run('INSERT OR REPLACE INTO province_custom (id, base_id, name, poly, adjacent) VALUES (?, ?, ?, ?, ?)',
        newId, houseId, prov.name + ' (půlka B)', JSON.stringify(newHalf), JSON.stringify([...(prov.adjacent || []), houseId]));
      // aktualizuj mapu v paměti
      G.provinces.set(houseId, { ...prov, poly: ownerHalf, adjacent: adj, name: prov.name + ' (půlka A)', custom: true });
      G.provinces.set(newId, { ...prov, id: newId, poly: newHalf, adjacent: [...(prov.adjacent || []), houseId], name: prov.name + ' (půlka B)', custom: true });
      q.run('INSERT OR IGNORE INTO province_state (id, morale) VALUES (?, 60)', newId);
      finalHouseId = newId;
      siblingOf = st.owner_id;
    }
  }

  const salt = randomBytes(8).toString('hex');
  const color = COLORS[(q.get('SELECT COUNT(*) AS n FROM players').n) % COLORS.length];
  q.run('INSERT INTO players (name, pass_hash, salt, color, capital_id, home_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
    name, hashPass(pass, salt), salt, color, finalHouseId, finalHouseId, Date.now());
  const p = q.get('SELECT * FROM players WHERE name = ?', name);
  q.run('UPDATE province_state SET owner_id = ?, morale = 75 WHERE id = ?', p.id, finalHouseId);
  const homeProv = G.provinces.get(finalHouseId);
  if (homeProv) G.addDiscovery(p.id, homeProv.c[0], homeProv.c[1], 320);
  for (const [r, v] of Object.entries(C.START_RESOURCES)) G.addRes(p.id, r, v);
  G.addRes(p.id, 'money', C.START_MONEY);
  G.addUnits(p.id, finalHouseId, 'infantry', C.START_INFANTRY);
  if (siblingOf) {
    const until = Date.now() + C.SIBLING_PEACE_DAYS * 86400_000;
    q.run('UPDATE players SET sibling_with = ?, sibling_until = ? WHERE id = ?', siblingOf, until, p.id);
    q.run('UPDATE players SET sibling_with = ?, sibling_until = ? WHERE id = ?', p.id, until, siblingOf);
    G.notify(siblingOf, 'sibling', `${name} si vzal půlku tvého domu. ${C.SIBLING_PEACE_DAYS} dny na sebe nemůžete útočit.`);
  }
  G.notify(null, 'join', `Do hry se přidal ${name}.`);
  G.pushRefresh();
  return { code: 200, data: { ok: true, playerId: p.id } };
}
function centroidRing(ring) {
  let x = 0, y = 0, n = ring.length - 1 || 1;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}
function closeRing(ring) {
  const f = ring[0], l = ring[ring.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}
// rozdělení polygonu svislou čarou na dvě stejně velké poloviny
function fairSplit(poly) {
  const BIG = 5000;
  const xs = poly.map((p) => p[0]);
  let lo = Math.min(...xs), hi = Math.max(...xs);
  const total = ringArea([...poly, poly[0]]);
  const leftPart = (cx) => {
    try {
      const r = pc.intersection([[poly]][0], [[[cx, -BIG], [-BIG, -BIG], [-BIG, BIG], [cx, BIG], [cx, -BIG]]]);
      return r[0]?.[0] || null;
    } catch { return null; }
  };
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const left = leftPart(mid);
    const a = left ? ringArea([...left, left[0]]) : 0;
    if (a < total / 2) lo = mid; else hi = mid;
  }
  const cx = (lo + hi) / 2;
  const halfA = leftPart(cx);
  let halfB = null;
  try {
    const r = pc.intersection([[poly]][0], [[[cx, -BIG], [BIG, -BIG], [BIG, BIG], [cx, BIG], [cx, -BIG]]]);
    halfB = r[0]?.[0] || null;
  } catch { /* níže */ }
  return [halfA, halfB];
}

// jednorázově (28. 8. 2026): hráč "sikokot" se všude ukazuje jako Milan Liščák, přihlašuje se postaru
{
  const t = q.get("SELECT id FROM players WHERE name = 'sikokot' AND login_alias IS NULL");
  if (t && !q.get("SELECT id FROM players WHERE name = 'Milan Liščák'")) {
    q.run("UPDATE players SET login_alias = name, name = 'Milan Liščák' WHERE id = ?", t.id);
    console.log('Hráč sikokot přejmenován na Milan Liščák (login zůstává sikokot).');
  }
}

// migrace: přepočítej existující rozdělené domy na férové poloviny (idempotentní)
{
  const rawProv = JSON.parse(readFileSync(join(ROOT, 'data', 'map', 'provinces.json'), 'utf8'));
  const rawById = new Map(rawProv.provinces.map((p) => [p.id, p]));
  const customs = q.all('SELECT * FROM province_custom WHERE id = base_id');
  for (const row of customs) {
    const orig = rawById.get(row.base_id);
    const partner = q.get('SELECT * FROM province_custom WHERE base_id = ? AND id != ?', row.base_id, row.base_id);
    if (!orig || !partner) continue;
    const [hA, hB] = fairSplit(orig.poly);
    if (!hA || !hB) continue;
    const bc = orig.building ? centroidRing(orig.building) : orig.c;
    const inA = G.pointInPoly(bc, hA);
    const ownerHalf = inA ? hA : hB;
    const newHalf = inA ? hB : hA;
    closeRing(ownerHalf); closeRing(newHalf);
    q.run('UPDATE province_custom SET poly = ? WHERE id = ?', JSON.stringify(ownerHalf), row.id);
    q.run('UPDATE province_custom SET poly = ? WHERE id = ?', JSON.stringify(newHalf), partner.id);
    const gp = G.provinces.get(row.id), gq = G.provinces.get(partner.id);
    if (gp) { gp.poly = ownerHalf; gp.c = centroidRing(ownerHalf); gp.area = ringArea(ownerHalf); }
    if (gq) { gq.poly = newHalf; gq.c = centroidRing(newHalf); gq.area = ringArea(newHalf); }
  }
  if (customs.length) console.log(`Přepočítány poloviny ${customs.length} rozdělených domů (férově 50/50).`);
}

// hodinová bilance surovin: produkce a spotřeba zvlášť (pro lištu i detail suroviny)
function balances(pid) {
  const owned = q.all('SELECT * FROM province_state WHERE owner_id = ?', pid);
  const prod = { money: 0 }, cons = { money: 0 };
  const src = {}; // rozpad: co surovinu vyrábí / spotřebovává
  for (const r of [...C.RESOURCES, 'money']) { prod[r] = prod[r] || 0; cons[r] = cons[r] || 0; src[r] = {}; }
  const addSrc = (r, label, v) => { src[r][label] = (src[r][label] || 0) + v; };
  const KIND_SRC = { field: 'Pole', meadow: 'Louky', forest: 'Lesy', pond: 'Rybníky' };
  for (const st of owned) {
    const prov = G.provinces.get(st.id);
    if (!prov) continue;
    const mf = st.morale / 100;
    if (prov.kind === 'house') {
      prod.money += C.HOUSE_MONEY_PER_H * mf;
      addSrc('money', 'Domy (daně)', C.HOUSE_MONEY_PER_H * mf);
      if (prov.resource && prov.resource !== 'money') {
        prod[prov.resource] += C.PROD_PER_H * mf;
        addSrc(prov.resource, 'Domy', C.PROD_PER_H * mf);
      }
    } else {
      // multiplikátor a náklady z vylepšení území
      let mult = 1;
      const set = C.natureSetFor(prov);
      if (set && st.upgrades) {
        const ups = JSON.parse(st.upgrades || '{}');
        for (const def of C.NATURE_UPGRADES[set]) {
          const lvl = ups[def.key] || 0;
          if (!lvl) continue;
          mult += def.bonus * lvl;
          if (def.upkeepDayBase) {
            for (const [r, v] of Object.entries(def.upkeepDayBase)) {
              const c = (v * lvl) / 24;
              cons[r] += c;
              addSrc(r, 'Vylepšení (' + def.label + ')', -c);
            }
          }
        }
      }
      const v = C.PROD_PER_H * (prov.double ? 2 : 1) * mf * mult;
      prod[prov.resource] += v;
      const label = ['iron', 'coal', 'oil', 'gas'].includes(prov.resource) ? 'Ložiska' : (KIND_SRC[prov.kind] || 'Území');
      addSrc(prov.resource, label, v);
    }
    if (st.barracks) {
      const g = C.BARRACKS[st.barracks].grainPerDay / 24;
      cons.grain += g;
      addSrc('grain', 'Kasárna', -g);
    }
  }
  // spotřeba jde z nejzásobenější suroviny každé kategorie (stejně jako tick)
  const res = G.resOf(pid);
  for (const list of Object.values(C.CATEGORIES)) {
    const pick = list.slice().sort((a, b) => (res[b] || 0) - (res[a] || 0))[0];
    cons[pick] += C.CONSUME_PER_H * owned.length;
    addSrc(pick, 'Údržba území', -C.CONSUME_PER_H * owned.length);
  }
  const net = {};
  for (const k of Object.keys(prod)) {
    prod[k] = Math.round(prod[k] * 10) / 10;
    cons[k] = Math.round(cons[k] * 10) / 10;
    net[k] = Math.round((prod[k] - cons[k]) * 10) / 10;
    for (const l of Object.keys(src[k])) {
      src[k][l] = Math.round(src[k][l] * 10) / 10;
      if (!src[k][l]) delete src[k][l];
    }
  }
  return { net, prod, cons, src };
}

// ---------- snapshot stavu pro hráče ----------
function snapshot(player) {
  const pid = G.effId(player);
  const now = Date.now();
  const teamNames = new Map();
  for (const t of q.all('SELECT id, name, team_with FROM players WHERE team_with IS NOT NULL')) {
    teamNames.set(t.team_with, [...(teamNames.get(t.team_with) || []), t.name]);
  }
  const allyOf = (playerId) => {
    const pl = G.playerById(playerId);
    if (!pl) return null;
    const r = q.get('SELECT a.name, a.symbol, a.bg FROM alliance_members m JOIN alliances a ON a.id = m.alliance_id WHERE m.player_id = ?', G.effId(pl));
    return r ? { name: r.name, symbol: r.symbol || 'swords', bg: r.bg || '#1565C0' } : null;
  };
  const players = q.all('SELECT id, name, color, capital_id, team_with FROM players').map((p) => ({
    id: p.id, name: p.name, color: p.color, capitalId: p.capital_id, teamWith: p.team_with,
    ally: allyOf(p.id),
    display: teamNames.has(p.id) ? [p.name, ...teamNames.get(p.id)].join(' + ') : p.name,
    provinceCount: q.get('SELECT COUNT(*) AS n FROM province_state WHERE owner_id = ?', p.id).n,
    unitCount: q.all('SELECT units FROM armies WHERE owner_id = ?', p.id)
      .reduce((s, a) => s + G.armySize(JSON.parse(a.units)), 0),
    score: p.team_with ? null : G.scoreOf(p.id),
  }));
  const circles = G.discoveryCircles(pid);
  const provs = [];
  for (const st of q.all('SELECT * FROM province_state')) {
    if (!G.provinces.has(st.id)) continue;
    const mine = st.owner_id === pid;
    const prov = G.provinces.get(st.id);
    // neprozkoumané území: žádné informace (mlha)
    if (!mine && !G.isDiscovered(circles, prov.c[0], prov.c[1])) {
      provs.push({ id: st.id, undiscovered: true });
      continue;
    }
    const hidden = !mine && st.fortress >= C.FORTRESS_HIDE_LVL;
    const armies = q.all('SELECT * FROM armies WHERE province_id = ? AND path IS NULL', st.id);
    let garrison = null;
    if (!hidden) {
      garrison = armies.map((a) => ({ owner: a.owner_id, size: G.armySize(JSON.parse(a.units)) }));
    }
    provs.push({
      id: st.id, owner: st.owner_id, morale: Math.round(st.morale),
      fortress: st.fortress, barracks: st.barracks,
      build: mine && st.build_kind ? { kind: st.build_kind, until: st.build_until } : (st.build_kind ? true : null),
      unit: mine && st.unit_kind ? { kind: st.unit_kind, until: st.unit_until } : null,
      recruitProgress: mine ? Math.round(st.recruit_progress * 100) : null,
      upgrades: mine ? JSON.parse(st.upgrades || '{}') : null,
      garrison, hidden,
    });
  }
  const myArmies = q.all('SELECT * FROM armies WHERE owner_id = ?', pid).map((a) => ({
    id: a.id, provinceId: a.province_id, units: JSON.parse(a.units), morale: Math.round(a.morale),
    path: a.path ? JSON.parse(a.path) : null, nextArrive: a.next_arrive, departAt: a.depart_delay_until, stance: a.stance,
  }));
  const movingForeign = q.all('SELECT * FROM armies WHERE owner_id != ? AND path IS NOT NULL', pid)
    .filter((a) => {
      const prov = G.provinces.get(a.province_id);
      return prov && G.isDiscovered(circles, prov.c[0], prov.c[1]) && !G.allied(a.owner_id, pid) ? true : (prov && G.allied(a.owner_id, pid));
    })
    .map((a) => ({
      id: a.id, owner: a.owner_id, provinceId: a.province_id, size: G.armySize(JSON.parse(a.units)),
      nextId: JSON.parse(a.path)[0] ?? null, nextArrive: a.next_arrive,
    }));
  const visits = new Set(q.all('SELECT poi_key FROM visits WHERE player_id = ?', pid).map((r) => r.poi_key));
  const trip = q.get("SELECT * FROM trips WHERE player_id = ? AND status = 'active'", player.id);
  const myAlliance = q.get('SELECT a.id, a.name, a.symbol, a.bg FROM alliances a JOIN alliance_members m ON m.alliance_id = a.id WHERE m.player_id = ?', pid);
  return {
    me: {
      id: player.id, effId: pid, name: player.name, color: player.color,
      education: G.playerById(pid).education,
      eduCourse: (() => { const p = G.playerById(pid); return p.edu_course_level ? { level: p.edu_course_level, until: p.edu_course_until } : null; })(),
      capitalId: G.playerById(pid).capital_id, homeId: G.playerById(pid).home_id,
      resources: G.resOf(pid), ...((b) => ({ balances: b.net, resFlow: { prod: b.prod, cons: b.cons, src: b.src } }))(balances(pid)),
      maxMorale: G.playerById(pid).max_morale,
      siblingWith: player.sibling_with, siblingUntil: player.sibling_until,
      isAdmin: isAdmin(player),
    },
    players, provinces: provs, armies: myArmies, movingForeign,
    discovery: circles.map((c) => ({ x: Math.round(c.x), y: Math.round(c.y), r: Math.round(c.r) })),
    battles: q.all('SELECT province_id AS provinceId, started, boosts FROM battles').map((b) => {
      const eff = (JSON.parse(b.boosts || '{}'))[pid];
      return {
        provinceId: b.provinceId, started: b.started,
        effortEnds: b.started + C.WAR_EFFORT.windowMs,
        myEffort: eff ? {
          pct: Math.min(C.WAR_EFFORT.walkPctMax, Math.floor((eff.walkM || 0) / 1000) * C.WAR_EFFORT.pctPerKm) + (eff.powerTowns || 0),
          km: Math.round((eff.walkM || 0) / 100) / 10, soldiers: eff.soldiers || 0,
        } : null,
      };
    })
      .filter((b) => { const p = G.provinces.get(b.provinceId); return p && G.isDiscovered(circles, p.c[0], p.c[1]); })
      .map((b) => {
        const s = G.battleSides(b.provinceId);
        const sum = (arr) => arr.map((a) => ({ owner: a.owner_id, size: G.armySize(JSON.parse(a.units)), morale: Math.round(a.morale) }));
        return { ...b, sides: { defenders: sum(s.defenders), attackers: sum(s.attackers) } };
      }),
    events: q.all('SELECT ts, type, text FROM events WHERE player_id IS NULL OR player_id = ? ORDER BY id DESC LIMIT 60', pid),
    trades: q.all("SELECT * FROM trades WHERE status = 'open' AND (to_id IS NULL OR to_id = ? OR from_id = ?)", pid, pid)
      .map((t) => ({ id: t.id, fromId: t.from_id, toId: t.to_id, give: JSON.parse(t.give), want: JSON.parse(t.want) })),
    shops: q.all('SELECT * FROM shops').map((s) => ({ id: s.id, playerId: s.player_id, town: s.town, res: s.res, stock: Math.floor(s.stock), earned: Math.floor(s.earned) })),
    alliance: myAlliance ? { ...myAlliance, members: q.all('SELECT player_id FROM alliance_members WHERE alliance_id = ?', myAlliance.id).map((r) => r.player_id) } : null,
    allianceInvites: q.all('SELECT i.alliance_id AS id, a.name FROM alliance_invites i JOIN alliances a ON a.id = i.alliance_id WHERE i.player_id = ?', pid),
    chat: q.all('SELECT c.id, c.player_id AS playerId, c.to_id AS toId, c.ts, c.text FROM chat c WHERE c.to_id IS NULL OR c.to_id = ? OR c.player_id = ? ORDER BY c.id DESC LIMIT 60', pid, pid).reverse(),
    pacts: q.all("SELECT a, b, status FROM pacts WHERE a = ? OR b = ?", pid, pid),
    visits: [...visits], trip: trip ? { kind: trip.kind, startTs: trip.start_ts } : null,
    badges: q.all('SELECT badge, ts FROM badges WHERE player_id = ?', pid),
    winner: metaGet('winner'), gameStart: +metaGet('game_start', 0),
    school: G.SCHOOL, serverNow: now,
  };
}

// ---------- mini-Strava: vyhodnocení pozice ----------
function checkPois(player, x, y, ts = ts) {
  const pid = G.effId(player);
  const results = [];
  const trip = q.get("SELECT * FROM trips WHERE player_id = ? AND status = 'active'", player.id);
  const pois = [
    ...G.POIS.towns.map((t) => ({ ...t, type: 'town' })),
    ...G.POIS.peaks.map((p) => ({ ...p, type: 'peak' })),
  ];
  for (const poi of pois) {
    const d = Math.hypot(poi.x - x, poi.y - y);
    const radius = poi.type === 'town' ? 400 : 150;
    if (d > radius) continue;
    const key = `${poi.type}:${poi.name}`;
    const already = q.get('SELECT 1 AS x FROM visits WHERE player_id = ? AND poi_key = ?', pid, key);
    if (already) continue;
    q.run('INSERT INTO visits (player_id, poi_key, ts) VALUES (?, ?, ?)', pid, key, ts);
    // zdolaný kopec odkryje velký kruh okolí (nápad Matěje: rozhled z vrcholu)
    if (poi.type === 'peak') G.addDiscovery(pid, poi.x, poi.y, 700);
    let rewardText = '';
    if (trip) {
      // ověření tempa: vzdálenost od startu výletu vs. čas
      const walkedKm = Math.hypot(x - trip.start_x, y - trip.start_y) / 1000;
      const hours = Math.max(0.02, (ts - trip.start_ts) / 3600_000);
      const speed = walkedKm / hours;
      const maxSpeed = trip.kind === 'bike' ? C.TRIP_BIKE_MAX_KMH : C.TRIP_WALK_MAX_KMH;
      // anti-auto: odměna se počítá z REÁLNĚ ušlé vzdálenosti (start výpravy -> cíl),
      // ne ze vzdálenosti cíle od vesnice — dojet autem k cíli a dojít 200 m nic nenese
      const effKm = Math.min(poi.km, walkedKm);
      if (speed <= maxSpeed && effKm >= 0.4) {
        if (poi.type === 'peak') {
          const bonus = 1 + effKm / 5 + (poi.ele ? Math.max(0, poi.ele - 450) / 300 : 0);
          const amounts = {};
          const kinds = ['grain', 'lumber', 'iron', 'coal', 'oil', 'gas'];
          const res1 = kinds[Math.floor(Math.random() * kinds.length)];
          amounts[res1] = Math.round(C.HILL_REWARD_BASE * bonus);
          G.addRes(pid, res1, amounts[res1]);
          let soldierTxt = '';
          if (Math.random() < C.HILL_SOLDIER_CHANCE) {
            const n = 1 + Math.floor(Math.random() * 3);
            G.addUnits(pid, G.playerById(pid).home_id, 'infantry', n);
            soldierTxt = ` a ${n}× pěchota (dorazí domů)`;
          }
          rewardText = `+${amounts[res1]} ${C.RES_LABEL[res1]}${soldierTxt} (ušlé ${walkedKm.toFixed(1)} km)`;
        } else {
          const r = Math.round(C.TOWN_REWARD_BASE * (1 + effKm / 20));
          G.addRes(pid, 'money', r);
          rewardText = `+${r} peněz, obchod odemčen (kurz ×${C.townPriceMult(poi.km).toFixed(1)})`;
        }
      } else if (speed <= maxSpeed && effKm < 0.4) {
        rewardText = 'objeveno — ale ušel jsi míň než 400 m (auto?), bez odměny';
        // achievementy za kopce
        if (poi.type === 'peak') {
          const n = q.all("SELECT poi_key FROM visits WHERE player_id = ? AND poi_key LIKE 'peak:%'", pid).length;
          for (const a of C.HILL_ACHIEVEMENTS) {
            if (n === a.count) {
              q.run('INSERT OR IGNORE INTO badges (player_id, badge, ts) VALUES (?, ?, ?)', pid, a.label, ts);
              G.addRes(pid, 'money', a.money);
              G.notify(pid, 'badge', `Odznak „${a.label}" za ${a.count} kopců! Odměna ${a.money} peněz.`);
            }
          }
        }
      } else {
        rewardText = 'moc rychlé tempo (auto?) — bez odměny, ale místo objeveno';
      }
    } else {
      rewardText = poi.type === 'town' ? 'objeveno — obchod odemčen (odměny jen s aktivním výletem)' : 'objeveno (odměny jen s aktivním výletem)';
    }
    const poiLabel = poi.type === 'peak' ? (poi.tower ? 'Rozhledna' : 'Kopec') : 'Město';
    q.run('INSERT OR IGNORE INTO badges (player_id, badge, ts) VALUES (?, ?, ?)', pid, `${poiLabel}: ${poi.name}`, ts);
    G.notify(pid, 'poi', `${poiLabel} ${poi.name} (${poi.km} km): ${rewardText}`);
    results.push(key);
  }
  return results;
}

// zpracování jedné polohy (živé i z offline záznamu): anti-auto, přítomnost, mlha, kopce/města
function applyPosition(player, lat, lon, ts) {
  const [x, y] = G.projLL(lat, lon);
  const prev = q.get('SELECT * FROM presence WHERE player_id = ?', player.id);
  let reveal = true;
  if (prev && ts > prev.ts) {
    const dtH = (ts - prev.ts) / 3600_000;
    if (dtH > 0.001 && dtH < 0.17) {
      const dist = Math.hypot(x - prev.x, y - prev.y);
      const kmh = (dist / 1000) / dtH;
      if (kmh > 30) reveal = false; // auto/autobus neodkrývá mlhu
      // pěší tempo se počítá do válečného úsilí (pomáhá v bitvách)
      if (kmh <= C.WAR_EFFORT.walkMaxKmh && dist > 5) q.run('INSERT INTO walk_log (player_id, ts, m) VALUES (?, ?, ?)', player.id, ts, dist);
    }
  }
  // přítomnost ukládej jen pokud je bod novější než dosavadní (dávka může být starší)
  if (!prev || ts >= prev.ts) {
    q.run('INSERT INTO presence (player_id, x, y, ts) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET x = ?, y = ?, ts = ?',
      player.id, x, y, ts, x, y, ts);
  }
  if (reveal) G.addDiscovery(G.effId(player), x, y, 150);
  const boosted = (Date.now() - ts < 10 * 60_000) ? G.applyPresenceBoosts(player) : [];
  const pois = checkPois(player, x, y, ts);
  return { x: Math.round(x), y: Math.round(y), reveal, boosted, pois };
}

// ---------- API router ----------
const routes = {
  'POST /api/register': async (req, res) => {
    const body = await readBody(req);
    const r = doRegister(body);
    if (r.data.ok) {
      const token = randomBytes(24).toString('hex');
      q.run('INSERT INTO sessions (token, player_id, created) VALUES (?, ?, ?)', token, r.data.playerId, Date.now());
      return send(res, 200, r.data, { 'Set-Cookie': `sup_token=${token}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax` });
    }
    send(res, r.code, r.data);
  },
  'POST /api/login': async (req, res) => {
    const { name, pass } = await readBody(req);
    const nm = String(name || '').trim();
    const p = q.get('SELECT * FROM players WHERE name = ? OR login_alias = ?', nm, nm);
    if (!p) return send(res, 401, { error: 'Hráč neexistuje.' });
    const h = hashPass(String(pass || ''), p.salt);
    if (!timingSafeEqual(Buffer.from(h), Buffer.from(p.pass_hash))) return send(res, 401, { error: 'Špatné heslo.' });
    const token = randomBytes(24).toString('hex');
    q.run('INSERT INTO sessions (token, player_id, created) VALUES (?, ?, ?)', token, p.id, Date.now());
    send(res, 200, { ok: true }, { 'Set-Cookie': `sup_token=${token}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax` });
  },
  'POST /api/logout': async (req, res) => {
    const token = getCookie(req, 'sup_token');
    if (token) q.run('DELETE FROM sessions WHERE token = ?', token);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'sup_token=; Path=/; Max-Age=0' });
  },
  'GET /api/map': (req, res) => {
    const layers = readFileSync(join(ROOT, 'data', 'map', 'layers.json'), 'utf8');
    const provs = [...G.provinces.values()].map((p) => ({
      id: p.id, kind: p.kind, name: p.name, resource: p.resource, double: p.double,
      poly: p.poly, c: p.c, area: p.area, adjacent: p.adjacent, building: p.building || null,
      houseNumber: p.houseNumber || null,
    }));
    send(res, 200, `{"layers":${layers},"provinces":${JSON.stringify(provs)},"pois":${JSON.stringify(G.POIS)},"school":${JSON.stringify(G.SCHOOL)},"routes":${JSON.stringify(G.ROUTES)}}`);
  },
  'POST /api/order/cancel': async (req, res, player) => {
    const { armyId } = await readBody(req);
    const pid = G.effId(player);
    const a = q.get('SELECT * FROM armies WHERE id = ?', +armyId);
    if (!a || a.owner_id !== pid) return send(res, 400, { error: 'Armáda nenalezena.' });
    if (!a.path) return send(res, 400, { error: 'Armáda nemá žádný rozkaz.' });
    // vrátí se do výchozího uzlu aktuálního úseku (bezpečné — nikdy neskončí na nepřátelském území)
    q.run("UPDATE armies SET path = NULL, next_arrive = NULL, depart_delay_until = NULL, stance = 'move' WHERE id = ?", a.id);
    G.notify(pid, 'order', 'Rozkaz zrušen — armáda se vrátila do posledního uzlu.');
    G.pushRefresh(pid);
    send(res, 200, { ok: true });
  },
  'GET /api/rules': (req, res) => send(res, 200, {
    units: C.UNITS, fortress: C.FORTRESS, barracks: C.BARRACKS, education: C.EDUCATION,
    prodPerH: C.PROD_PER_H, houseMoneyPerH: C.HOUSE_MONEY_PER_H, recruitHoursPerInf: C.RECRUIT_HOURS_PER_INF,
    hillRewardBase: C.HILL_REWARD_BASE, townRewardBase: C.TOWN_REWARD_BASE,
    gameLengthDays: C.GAME_LENGTH_DAYS, victoryShare: C.VICTORY_PROVINCE_SHARE,
    natureUpgrades: C.NATURE_UPGRADES,
  }),
  'GET /api/state': (req, res, player) => send(res, 200, snapshot(player)),
  'POST /api/position': async (req, res, player) => {
    const { lat, lon } = await readBody(req);
    if (typeof lat !== 'number' || typeof lon !== 'number') return send(res, 400, { error: 'Chybí poloha.' });
    const r = applyPosition(player, lat, lon, Date.now());
    send(res, 200, { ok: true, ...r });
  },
  // offline procházka: telefon uložil trasu bez dat a teď ji posílá najednou
  'POST /api/positions/batch': async (req, res, player) => {
    const { points } = await readBody(req);
    if (!Array.isArray(points)) return send(res, 400, { error: 'Chybí body.' });
    const now = Date.now();
    const pts = points
      .filter((p) => typeof p.lat === 'number' && typeof p.lon === 'number' && typeof p.ts === 'number')
      .filter((p) => p.ts < now + 5 * 60_000 && p.ts > now - 7 * 86400_000) // rozumné časy
      .sort((a, b) => a.ts - b.ts)
      .slice(-3000);
    const pois = [], boosted = [];
    let applied = 0, last = null;
    for (const p of pts) {
      const r = applyPosition(player, p.lat, p.lon, p.ts);
      pois.push(...r.pois); boosted.push(...r.boosted);
      applied++; last = r;
    }
    if (applied) G.pushRefresh(player.id);
    send(res, 200, { ok: true, applied, pois, boosted, x: last?.x, y: last?.y });
  },
  'POST /api/order/move': async (req, res, player) => {
    const { armyId, destId, stance } = await readBody(req);
    send(res, 200, G.orderMove(player, +armyId, +destId, stance));
  },
  'POST /api/army/split': async (req, res, player) => {
    const { armyId, units } = await readBody(req);
    send(res, 200, G.splitArmy(player, +armyId, units));
  },
  'POST /api/army/merge': async (req, res, player) => {
    const { armyId } = await readBody(req);
    const pid = G.effId(player);
    const a = q.get('SELECT * FROM armies WHERE id = ?', +armyId);
    if (!a || a.owner_id !== pid || a.path) return send(res, 400, { error: 'Armádu teď nejde slučovat.' });
    const others = q.all('SELECT * FROM armies WHERE owner_id = ? AND province_id = ? AND path IS NULL AND id != ?', pid, a.province_id, a.id);
    if (!others.length) return send(res, 400, { error: 'Žádná další armáda na místě.' });
    const units = JSON.parse(a.units);
    let totalSize = G.armySize(units), moraleSum = a.morale * totalSize;
    for (const o of others) {
      const ou = JSON.parse(o.units);
      const os = G.armySize(ou);
      for (const [k, v] of Object.entries(ou)) units[k] = (units[k] || 0) + v;
      moraleSum += o.morale * os;
      totalSize += os;
      q.run('DELETE FROM armies WHERE id = ?', o.id);
    }
    q.run('UPDATE armies SET units = ?, morale = ? WHERE id = ?', JSON.stringify(units), totalSize ? moraleSum / totalSize : a.morale, a.id);
    G.pushRefresh(pid);
    send(res, 200, { ok: true });
  },
  'POST /api/build': async (req, res, player) => {
    const { provinceId, kind } = await readBody(req);
    const pid = G.effId(player);
    const st = q.get('SELECT * FROM province_state WHERE id = ?', +provinceId);
    const prov = G.provinces.get(+provinceId);
    if (!st || !prov || st.owner_id !== pid) return send(res, 400, { error: 'Není tvoje provincie.' });
    if (st.build_kind) return send(res, 400, { error: 'Už tu něco stavíš.' });
    let def, level;
    if (kind === 'fortress') { level = st.fortress + 1; def = C.FORTRESS[level]; }
    else if (kind === 'barracks') {
      if (prov.kind !== 'house') return send(res, 400, { error: 'Kasárna jde stavět jen u domu.' });
      level = st.barracks + 1; def = C.BARRACKS[level];
    } else return send(res, 400, { error: 'Neznámá budova.' });
    if (!def) return send(res, 400, { error: 'Maximální level.' });
    if (!G.canAfford(pid, def.cost)) return send(res, 400, { error: 'Nedostatek surovin.' });
    G.pay(pid, def.cost);
    let hours = def.hours;
    q.run('UPDATE province_state SET build_kind = ?, build_until = ? WHERE id = ?', kind, Date.now() + hours * 3600_000, +provinceId);
    if (G.presenceAt(player.id, +provinceId)) G.applyPresenceBoosts(player);
    G.pushRefresh(pid);
    send(res, 200, { ok: true });
  },
  'POST /api/upgrade': async (req, res, player) => {
    const { provinceId, key } = await readBody(req);
    const pid = G.effId(player);
    const st = q.get('SELECT * FROM province_state WHERE id = ?', +provinceId);
    const prov = G.provinces.get(+provinceId);
    if (!st || !prov || st.owner_id !== pid) return send(res, 400, { error: 'Není tvoje provincie.' });
    const set = C.natureSetFor(prov);
    if (!set) return send(res, 400, { error: 'Tohle území nejde vylepšovat.' });
    const def = C.NATURE_UPGRADES[set].find((d) => d.key === key);
    if (!def) return send(res, 400, { error: 'Neznámé vylepšení.' });
    if (st.build_kind) return send(res, 400, { error: 'Už tu něco stavíš/vylepšuješ.' });
    const ups = JSON.parse(st.upgrades || '{}');
    const lvl = ups[def.key] || 0;
    if (lvl >= def.max) return send(res, 400, { error: 'Maximální úroveň.' });
    if (def.needs) {
      const [nk, nl] = def.needs;
      if ((ups[nk] || 0) < nl) {
        const ndef = C.NATURE_UPGRADES[set].find((d) => d.key === nk);
        return send(res, 400, { error: `Nejdřív potřebuješ: ${ndef?.label || nk} úroveň ${nl}.` });
      }
    }
    const cost = C.upgradeCost(def, lvl + 1);
    if (!G.canAfford(pid, cost)) return send(res, 400, { error: 'Nedostatek surovin.' });
    G.pay(pid, cost);
    q.run('UPDATE province_state SET build_kind = ?, build_until = ? WHERE id = ?', 'upg:' + def.key, Date.now() + def.hours * 3600_000, +provinceId);
    if (G.presenceAt(player.id, +provinceId)) G.applyPresenceBoosts(player);
    G.pushRefresh(pid);
    send(res, 200, { ok: true });
  },
  'POST /api/recruit': async (req, res, player) => {
    const { provinceId, kind } = await readBody(req);
    const pid = G.effId(player);
    const st = q.get('SELECT * FROM province_state WHERE id = ?', +provinceId);
    const prov = G.provinces.get(+provinceId);
    const u = C.UNITS[kind];
    if (!st || !prov || st.owner_id !== pid) return send(res, 400, { error: 'Není tvoje provincie.' });
    if (prov.kind !== 'house') return send(res, 400, { error: 'Jednotky se vyrábí u domů.' });
    if (!u || kind === 'infantry') return send(res, 400, { error: 'Neplatná jednotka.' });
    if (st.unit_kind) return send(res, 400, { error: 'Už tu něco vyrábíš.' });
    const me = G.playerById(pid);
    if (me.education < u.edu) return send(res, 400, { error: `Potřebuješ vzdělání: ${C.EDUCATION[u.edu - 1].label}.` });
    if (u.needs === 'barracks' && !st.barracks) return send(res, 400, { error: 'Potřebuješ kasárna.' });
    if (!G.canAfford(pid, u.cost)) return send(res, 400, { error: 'Nedostatek surovin.' });
    G.pay(pid, u.cost);
    q.run('UPDATE province_state SET unit_kind = ?, unit_until = ? WHERE id = ?', kind, Date.now() + u.time * 3600_000, +provinceId);
    if (G.presenceAt(player.id, +provinceId)) G.applyPresenceBoosts(player);
    G.pushRefresh(pid);
    send(res, 200, { ok: true });
  },
  'POST /api/education/start': async (req, res, player) => {
    const pid = G.effId(player);
    const me = G.playerById(pid);
    if (me.edu_course_level) return send(res, 400, { error: 'Kurz už běží.' });
    const next = C.EDUCATION[me.education];
    if (!next) return send(res, 400, { error: 'Máš nejvyšší vzdělání.' });
    if (!G.presenceAtPoint(player.id, G.SCHOOL.x, G.SCHOOL.y, 150)) return send(res, 400, { error: 'Musíš fyzicky dojít ke škole.' });
    if (!G.canAfford(pid, next.cost)) return send(res, 400, { error: 'Nedostatek peněz.' });
    G.pay(pid, next.cost);
    q.run('UPDATE players SET edu_course_level = ?, edu_course_until = ? WHERE id = ?', next.level, Date.now() + next.hours * 3600_000, pid);
    G.notify(pid, 'education', `Kurz „${next.label}" zapsán — hotovo za ${next.hours} h.`);
    send(res, 200, { ok: true });
  },
  'POST /api/trip/start': async (req, res, player) => {
    const { kind } = await readBody(req);
    if (!['walk', 'bike'].includes(kind)) return send(res, 400, { error: 'Vyber pěšky nebo kolo.' });
    const pr = q.get('SELECT * FROM presence WHERE player_id = ?', player.id);
    if (!pr || Date.now() - pr.ts > 5 * 60_000) return send(res, 400, { error: 'Nejdřív povol polohu (aktuální pozice je potřeba).' });
    q.run("UPDATE trips SET status = 'cancelled' WHERE player_id = ? AND status = 'active'", player.id);
    q.run('INSERT INTO trips (player_id, kind, start_ts, start_x, start_y) VALUES (?, ?, ?, ?, ?)', player.id, kind, Date.now(), pr.x, pr.y);
    send(res, 200, { ok: true });
  },
  'POST /api/trip/stop': async (req, res, player) => {
    q.run("UPDATE trips SET status = 'done' WHERE player_id = ? AND status = 'active'", player.id);
    send(res, 200, { ok: true });
  },
  'POST /api/town/trade': async (req, res, player) => {
    const { town, resName, amount, dir } = await readBody(req);
    const pid = G.effId(player);
    const t = G.POIS.towns.find((x) => x.name === town);
    if (!t) return send(res, 400, { error: 'Neznámé město.' });
    if (!q.get('SELECT 1 AS x FROM visits WHERE player_id = ? AND poi_key = ?', pid, `town:${town}`)) return send(res, 400, { error: 'Tohle město jsi ještě neobjevil — dojdi tam.' });
    if (!C.RESOURCES.includes(resName)) return send(res, 400, { error: 'Neplatná surovina.' });
    const n = Math.max(1, Math.floor(+amount || 0));
    const mult = C.townPriceMult(t.km);
    const price = C.BASE_PRICES[resName];
    if (dir === 'sell') {
      if ((G.resOf(pid)[resName] || 0) < n) return send(res, 400, { error: 'Tolik suroviny nemáš.' });
      G.addRes(pid, resName, -n);
      G.addRes(pid, 'money', Math.round(n * price * mult));
    } else {
      const cost = Math.round(n * price * (2 - Math.min(0.9, (mult - 1) / 2))); // nákup: sleva s dálkou menší než bonus prodeje
      if ((G.resOf(pid).money || 0) < cost) return send(res, 400, { error: 'Nedostatek peněz.' });
      G.addRes(pid, 'money', -cost);
      G.addRes(pid, resName, n);
    }
    G.pushRefresh(pid);
    send(res, 200, { ok: true });
  },
  'POST /api/shop/create': async (req, res, player) => {
    const { town, resName } = await readBody(req);
    const pid = G.effId(player);
    const t = G.POIS.towns.find((x) => x.name === town);
    if (!t) return send(res, 400, { error: 'Neznámé město.' });
    if (!C.RESOURCES.includes(resName)) return send(res, 400, { error: 'Neplatná surovina.' });
    if (!G.presenceAtPoint(player.id, t.x, t.y, 500)) return send(res, 400, { error: 'Obchod založíš jen, když jsi ve městě.' });
    if (q.get('SELECT 1 AS x FROM shops WHERE player_id = ? AND town = ?', pid, town)) return send(res, 400, { error: 'V tomhle městě už obchod máš.' });
    q.run('INSERT INTO shops (player_id, town, res) VALUES (?, ?, ?)', pid, town, resName);
    G.notify(pid, 'shop', `Založil jsi obchod v ${town} (${C.RES_LABEL[resName]}). Naskladni zboží a bude vydělávat.`);
    send(res, 200, { ok: true });
  },
  'POST /api/shop/stock': async (req, res, player) => {
    const { shopId, amount } = await readBody(req);
    const pid = G.effId(player);
    const s = q.get('SELECT * FROM shops WHERE id = ?', +shopId);
    if (!s || s.player_id !== pid) return send(res, 400, { error: 'Obchod nenalezen.' });
    const n = Math.max(1, Math.floor(+amount || 0));
    if ((G.resOf(pid)[s.res] || 0) < n) return send(res, 400, { error: 'Tolik suroviny nemáš.' });
    G.addRes(pid, s.res, -n);
    q.run('UPDATE shops SET stock = stock + ? WHERE id = ?', n, s.id);
    send(res, 200, { ok: true });
  },
  'POST /api/shop/buy': async (req, res, player) => {
    const { shopId, amount } = await readBody(req);
    const pid = G.effId(player);
    const s = q.get('SELECT * FROM shops WHERE id = ?', +shopId);
    if (!s) return send(res, 400, { error: 'Obchod nenalezen.' });
    const t = G.POIS.towns.find((x) => x.name === s.town);
    if (!G.presenceAtPoint(player.id, t.x, t.y, 500)) return send(res, 400, { error: 'Musíš být ve městě, kde obchod stojí.' });
    const n = Math.min(Math.max(1, Math.floor(+amount || 0)), Math.floor(s.stock));
    if (n < 1) return send(res, 400, { error: 'Obchod nemá zboží.' });
    const cost = Math.round(n * C.BASE_PRICES[s.res]); // mezi hráči za základní cenu
    if ((G.resOf(pid).money || 0) < cost) return send(res, 400, { error: 'Nedostatek peněz.' });
    G.addRes(pid, 'money', -cost);
    G.addRes(pid, s.res, n);
    q.run('UPDATE shops SET stock = stock - ?, earned = earned + ? WHERE id = ?', n, cost, s.id);
    G.addRes(s.player_id, 'money', cost);
    G.notify(s.player_id, 'shop', `${player.name} nakoupil v tvém obchodě v ${s.town} (${n}× ${C.RES_LABEL[s.res]}).`);
    send(res, 200, { ok: true });
  },
  'POST /api/trade/create': async (req, res, player) => {
    const { toId, give, want } = await readBody(req);
    const pid = G.effId(player);
    const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => ([...C.RESOURCES, 'money'].includes(k) && v > 0)).map(([k, v]) => [k, Math.floor(v)]));
    const g = clean(give), w = clean(want);
    if (!Object.keys(g).length || !Object.keys(w).length) return send(res, 400, { error: 'Vyplň, co dáváš a co chceš.' });
    if (!G.canAfford(pid, g)) return send(res, 400, { error: 'Nabízíš víc, než máš.' });
    q.run('INSERT INTO trades (from_id, to_id, give, want, status, created) VALUES (?, ?, ?, ?, ?, ?)',
      pid, toId ? +toId : null, JSON.stringify(g), JSON.stringify(w), 'open', Date.now());
    if (toId) G.notify(+toId, 'trade', `${player.name} ti poslal obchodní nabídku.`);
    else G.notify(null, 'trade', `${player.name} vystavil obchodní nabídku.`);
    send(res, 200, { ok: true });
  },
  'POST /api/trade/accept': async (req, res, player) => {
    const { id } = await readBody(req);
    const pid = G.effId(player);
    const t = q.get("SELECT * FROM trades WHERE id = ? AND status = 'open'", +id);
    if (!t) return send(res, 400, { error: 'Nabídka už neplatí.' });
    if (t.from_id === pid) return send(res, 400, { error: 'Vlastní nabídku nejde přijmout.' });
    if (t.to_id && t.to_id !== pid) return send(res, 400, { error: 'Nabídka je pro někoho jiného.' });
    const give = JSON.parse(t.give), want = JSON.parse(t.want);
    if (!G.canAfford(t.from_id, give)) { q.run("UPDATE trades SET status = 'cancelled' WHERE id = ?", t.id); return send(res, 400, { error: 'Nabízející už na to nemá — nabídka zrušena.' }); }
    if (!G.canAfford(pid, want)) return send(res, 400, { error: 'Nemáš na to, co chce protistrana.' });
    G.pay(t.from_id, give); for (const [r, v] of Object.entries(give)) G.addRes(pid, r, v);
    G.pay(pid, want); for (const [r, v] of Object.entries(want)) G.addRes(t.from_id, r, v);
    q.run("UPDATE trades SET status = 'accepted' WHERE id = ?", t.id);
    G.notify(t.from_id, 'trade', `${player.name} přijal tvou obchodní nabídku.`);
    G.pushRefresh();
    send(res, 200, { ok: true });
  },
  'POST /api/trade/cancel': async (req, res, player) => {
    const { id } = await readBody(req);
    const pid = G.effId(player);
    q.run("UPDATE trades SET status = 'cancelled' WHERE id = ? AND from_id = ?", +id, pid);
    send(res, 200, { ok: true });
  },
  // zpětná vazba hráčů -> Discord (bot token se bere z BACKUP_BOT_TOKEN)
  'POST /api/feedback': async (req, res, player) => {
    const { kind, text } = await readBody(req);
    const t = String(text || '').trim().slice(0, 900);
    const k = ['chyba', 'napad', 'dotaz', 'jine'].includes(kind) ? kind : 'jine';
    if (t.length < 3) return send(res, 400, { error: 'Napiš aspoň pár slov.' });
    const last = q.get('SELECT ts FROM feedback WHERE player_id = ? ORDER BY id DESC LIMIT 1', player.id);
    if (last && Date.now() - last.ts < 60_000) return send(res, 400, { error: 'Počkej minutku mezi hlášeními.' });
    q.run('INSERT INTO feedback (player_id, kind, text, ts) VALUES (?, ?, ?, ?)', player.id, k, t, Date.now());
    const fid = q.get('SELECT last_insert_rowid() AS id').id;
    let sent = false;
    const token = (process.env.BACKUP_BOT_TOKEN || '').trim();
    const channel = (process.env.FEEDBACK_CHANNEL_ID || '1533794658789101628').trim();
    if (token) {
      try {
        const label = { chyba: 'CHYBA', napad: 'NÁPAD', dotaz: 'DOTAZ', jine: 'POZNÁMKA' }[k];
        const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'SupremacyCichtice/1.0' },
          body: JSON.stringify({ content: `[hra] ${label} od **${player.name}**:\n${t}` }),
        });
        sent = r.ok;
      } catch { /* zůstane v DB */ }
    }
    if (sent) q.run('UPDATE feedback SET sent = 1 WHERE id = ?', fid);
    send(res, 200, { ok: true, sent });
  },
  'POST /api/chat/send': async (req, res, player) => {
    const { text, toId } = await readBody(req);
    const t = String(text || '').trim().slice(0, 400);
    if (!t) return send(res, 400, { error: 'Prázdná zpráva.' });
    const pid = G.effId(player);
    const to = toId ? +toId : null;
    if (to && !G.playerById(to)) return send(res, 400, { error: 'Neznámý příjemce.' });
    q.run('INSERT INTO chat (player_id, ts, text, to_id) VALUES (?, ?, ?, ?)', pid, Date.now(), t, to);
    if (to) { G.pushRefresh(pid); G.pushRefresh(to); } // soukromá: jen oběma stranám
    else G.pushRefresh();
    send(res, 200, { ok: true });
  },
  'POST /api/pact/offer': async (req, res, player) => {
    const { playerId } = await readBody(req);
    const pid = G.effId(player), other = +playerId;
    if (other === pid || !G.playerById(other)) return send(res, 400, { error: 'Neplatný hráč.' });
    if (G.pactActive(pid, other)) return send(res, 400, { error: 'Mír už platí.' });
    q.run("INSERT OR REPLACE INTO pacts (a, b, status, since) VALUES (?, ?, 'offered', ?)", pid, other, Date.now());
    G.notify(other, 'pact', `${player.name} ti nabízí mír (pakt o neútočení).`);
    send(res, 200, { ok: true });
  },
  'POST /api/pact/accept': async (req, res, player) => {
    const { playerId } = await readBody(req);
    const pid = G.effId(player), other = +playerId;
    const p = q.get("SELECT * FROM pacts WHERE a = ? AND b = ? AND status = 'offered'", other, pid);
    if (!p) return send(res, 400, { error: 'Žádná nabídka míru.' });
    q.run("UPDATE pacts SET status = 'active', since = ? WHERE a = ? AND b = ?", Date.now(), other, pid);
    G.notify(null, 'pact', `${G.playerById(other).name} a ${player.name} uzavřeli mír.`);
    send(res, 200, { ok: true });
  },
  'POST /api/pact/cancel': async (req, res, player) => {
    const { playerId } = await readBody(req);
    const pid = G.effId(player), other = +playerId;
    q.run('DELETE FROM pacts WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', pid, other, other, pid);
    G.notify(other, 'pact', `${player.name} vypověděl mír. Pozor na hranice.`);
    G.notify(null, 'pact', `${player.name} vypověděl mír s ${G.playerById(other)?.name}.`);
    send(res, 200, { ok: true });
  },
  'POST /api/alliance/create': async (req, res, player) => {
    const { name, symbol, bg } = await readBody(req);
    const pid = G.effId(player);
    if (q.get('SELECT 1 AS x FROM alliance_members WHERE player_id = ?', pid)) return send(res, 400, { error: 'Už jsi v alianci.' });
    const sym = ['swords', 'shield', 'crown', 'tower', 'star', 'tree'].includes(symbol) ? symbol : 'swords';
    const color = /^#[0-9A-Fa-f]{6}$/.test(String(bg || '')) ? bg : '#1565C0';
    q.run('INSERT INTO alliances (name, symbol, bg) VALUES (?, ?, ?)', String(name || 'Aliance').slice(0, 30), sym, color);
    const a = q.get('SELECT id FROM alliances ORDER BY id DESC LIMIT 1');
    q.run('INSERT INTO alliance_members (alliance_id, player_id) VALUES (?, ?)', a.id, pid);
    send(res, 200, { ok: true });
  },
  'POST /api/alliance/invite': async (req, res, player) => {
    const { playerId } = await readBody(req);
    const pid = G.effId(player);
    const my = q.get('SELECT alliance_id FROM alliance_members WHERE player_id = ?', pid);
    if (!my) return send(res, 400, { error: 'Nejdřív založ alianci.' });
    const count = q.get('SELECT COUNT(*) AS n FROM alliance_members WHERE alliance_id = ?', my.alliance_id).n;
    if (count >= C.ALLIANCE_MAX_MEMBERS) return send(res, 400, { error: `Aliance má max ${C.ALLIANCE_MAX_MEMBERS} členy.` });
    q.run('INSERT OR IGNORE INTO alliance_invites (alliance_id, player_id) VALUES (?, ?)', my.alliance_id, +playerId);
    G.notify(+playerId, 'alliance', `${player.name} tě zve do aliance.`);
    send(res, 200, { ok: true });
  },
  'POST /api/alliance/accept': async (req, res, player) => {
    const { allianceId } = await readBody(req);
    const pid = G.effId(player);
    if (q.get('SELECT 1 AS x FROM alliance_members WHERE player_id = ?', pid)) return send(res, 400, { error: 'Už jsi v alianci.' });
    if (!q.get('SELECT 1 AS x FROM alliance_invites WHERE alliance_id = ? AND player_id = ?', +allianceId, pid)) return send(res, 400, { error: 'Pozvánka neexistuje.' });
    const count = q.get('SELECT COUNT(*) AS n FROM alliance_members WHERE alliance_id = ?', +allianceId).n;
    if (count >= C.ALLIANCE_MAX_MEMBERS) return send(res, 400, { error: 'Aliance je plná.' });
    q.run('INSERT INTO alliance_members (alliance_id, player_id) VALUES (?, ?)', +allianceId, pid);
    q.run('DELETE FROM alliance_invites WHERE player_id = ?', pid);
    G.notify(null, 'alliance', `${player.name} vstoupil do aliance.`);
    send(res, 200, { ok: true });
  },
  'POST /api/alliance/leave': async (req, res, player) => {
    const pid = G.effId(player);
    q.run('DELETE FROM alliance_members WHERE player_id = ?', pid);
    send(res, 200, { ok: true });
  },
  // ---------- admin konzole ----------
  'GET /api/admin/overview': (req, res, player) => {
    if (!isAdmin(player)) return send(res, 403, { error: 'Jen admin.' });
    const players = q.all('SELECT id, name, home_id, created, team_with, education FROM players ORDER BY id').map((p) => {
      const home = G.provinces.get(p.home_id);
      const pres = q.get('SELECT ts FROM presence WHERE player_id = ?', p.id);
      const rs = G.resOf(p.id);
      return {
        id: p.id, name: p.name, teamWith: p.team_with, education: p.education,
        home: home ? home.name : (p.team_with ? 'tým' : '?'),
        provinces: q.get('SELECT COUNT(*) AS n FROM province_state WHERE owner_id = ?', p.id).n,
        units: q.all('SELECT units FROM armies WHERE owner_id = ?', p.id).reduce((a, r) => a + G.armySize(JSON.parse(r.units)), 0),
        money: Math.round(rs.money || 0),
        created: p.created, lastSeen: pres ? pres.ts : null,
        sessions: q.get('SELECT COUNT(*) AS n FROM sessions WHERE player_id = ?', p.id).n,
      };
    });
    send(res, 200, {
      players,
      events: q.all('SELECT ts, type, text, player_id AS playerId FROM events ORDER BY id DESC LIMIT 40'),
      battles: q.all('SELECT province_id AS provinceId, started FROM battles').map((b) => ({ ...b, name: G.provinces.get(b.provinceId)?.name })),
      backupLog: backupLog.slice(-15),
      boot: new Date(BOOT_TS).toISOString(),
      gameStart: +metaGet('game_start', 0),
    });
  },
  // přejmenování hráče: nové jméno se ukazuje všude, přihlašuje se dál postaru
  'POST /api/admin/rename': async (req, res, player) => {
    if (!isAdmin(player)) return send(res, 403, { error: 'Jen admin.' });
    const { playerId, newName } = await readBody(req);
    const nm = String(newName || '').trim().slice(0, 24);
    if (nm.length < 2) return send(res, 400, { error: 'Jméno musí mít aspoň 2 znaky.' });
    const target = G.playerById(+playerId);
    if (!target) return send(res, 400, { error: 'Hráč neexistuje.' });
    if (q.get('SELECT id FROM players WHERE (name = ? OR login_alias = ?) AND id != ?', nm, nm, +playerId)) {
      return send(res, 400, { error: 'Tohle jméno už někdo má.' });
    }
    q.run('UPDATE players SET login_alias = COALESCE(login_alias, name), name = ? WHERE id = ?', nm, +playerId);
    G.pushRefresh();
    send(res, 200, { ok: true });
  },
  'POST /api/admin/set-color': async (req, res, player) => {
    if (!isAdmin(player)) return send(res, 403, { error: 'Jen admin.' });
    const { playerId, color } = await readBody(req);
    if (!/^#[0-9A-Fa-f]{6}$/.test(String(color || ''))) return send(res, 400, { error: 'Barva musí být ve tvaru #RRGGBB.' });
    if (!G.playerById(+playerId)) return send(res, 400, { error: 'Hráč neexistuje.' });
    q.run('UPDATE players SET color = ? WHERE id = ?', color, +playerId);
    G.pushRefresh();
    send(res, 200, { ok: true });
  },
  'POST /api/admin/delete-player': async (req, res, player) => {
    if (!isAdmin(player)) return send(res, 403, { error: 'Jen admin.' });
    const { playerId } = await readBody(req);
    const pid = +playerId;
    const target = G.playerById(pid);
    if (!target) return send(res, 400, { error: 'Hráč neexistuje.' });
    if (pid === player.id) return send(res, 400, { error: 'Sám sebe nesmažeš.' });
    q.run('UPDATE province_state SET owner_id = NULL, morale = 60, upgrades = NULL, captured_ts = NULL, build_kind = NULL, build_until = NULL, unit_kind = NULL, unit_until = NULL WHERE owner_id = ?', pid);
    for (const [t, c] of [['armies', 'owner_id'], ['resources', 'player_id'], ['sessions', 'player_id'], ['presence', 'player_id'], ['discovery', 'player_id'], ['trips', 'player_id'], ['visits', 'player_id'], ['badges', 'player_id'], ['shops', 'player_id'], ['alliance_members', 'player_id'], ['alliance_invites', 'player_id'], ['chat', 'player_id']]) {
      q.run(`DELETE FROM ${t} WHERE ${c} = ?`, pid);
    }
    q.run('DELETE FROM trades WHERE from_id = ? OR to_id = ?', pid, pid);
    q.run('DELETE FROM pacts WHERE a = ? OR b = ?', pid, pid);
    q.run('UPDATE players SET team_with = NULL WHERE team_with = ?', pid);
    q.run('DELETE FROM players WHERE id = ?', pid);
    G.notify(null, 'admin', `Admin odstranil hráče ${target.name}.`);
    G.pushRefresh();
    send(res, 200, { ok: true });
  },
  'POST /api/admin/school': async (req, res, player) => {
    if (!isAdmin(player)) return send(res, 403, { error: 'Jen admin.' });
    const { lat, lon } = await readBody(req);
    const [x, y] = G.projLL(lat, lon);
    metaSet('school_x', x); metaSet('school_y', y);
    G.SCHOOL.x = x; G.SCHOOL.y = y;
    send(res, 200, { ok: true });
  },
  'POST /api/admin/give': async (req, res, player) => {
    if (!isAdmin(player)) return send(res, 403, { error: 'Jen admin.' });
    const { playerId, resName, amount } = await readBody(req);
    G.addRes(+playerId, resName, +amount);
    send(res, 200, { ok: true });
  },
};

const PUBLIC_ROUTES = new Set(['POST /api/register', 'POST /api/login', 'GET /api/map', 'GET /api/rules']);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;

  // SSE stream
  if (key === 'GET /api/stream') {
    const player = auth(req);
    if (!player) return send(res, 401, { error: 'Nepřihlášen.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: {"type":"hello"}\n\n');
    if (!sseClients.has(player.id)) sseClients.set(player.id, new Set());
    sseClients.get(player.id).add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* zavřeno */ } }, 25_000);
    req.on('close', () => { clearInterval(ping); sseClients.get(player.id)?.delete(res); });
    return;
  }

  if (routes[key]) {
    let player = null;
    if (!PUBLIC_ROUTES.has(key)) {
      player = auth(req);
      if (!player) return send(res, 401, { error: 'Nepřihlášen.' });
    }
    try {
      return await routes[key](req, res, player);
    } catch (e) {
      console.error(key, e);
      return send(res, 500, { error: 'Chyba serveru.' });
    }
  }
  if (url.pathname === '/api/health') {
    // dálková diagnostika: stav obnovy zálohy po studeném startu
    return send(res, 200, {
      boot: new Date(BOOT_TS).toISOString(),
      uptimeMin: Math.round((Date.now() - BOOT_TS) / 60_000),
      players: q.get('SELECT COUNT(*) AS n FROM players').n,
      envBackup: !!(process.env.BACKUP_BOT_TOKEN && process.env.BACKUP_CHANNEL_ID),
      backupLog,
    });
  }
  if (url.pathname === '/api/whoami') {
    const player = auth(req);
    return send(res, 200, player ? { id: player.id, name: player.name } : { id: null });
  }

  // statické soubory
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = normalize(file).replace(/^([.][.][/\\])+/, '');
  const full = join(PUBLIC, file);
  if (full.startsWith(PUBLIC) && existsSync(full)) {
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    return res.end(readFileSync(full));
  }
  send(res, 404, { error: 'Nenalezeno' });
});

G.startTicking();
startBackups();
server.listen(PORT, () => console.log(`Supremacy Čichtice běží na http://localhost:${PORT}`));
