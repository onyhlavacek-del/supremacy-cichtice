// Herní jádro: statická mapa, tick engine, boj, pohyb, ekonomika, GPS mechaniky
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, q, metaGet, metaSet } from './db.js';
import * as C from './constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- statická mapa ----------
const provData = JSON.parse(readFileSync(join(ROOT, 'data', 'map', 'provinces.json'), 'utf8'));
export const POIS = JSON.parse(readFileSync(join(ROOT, 'data', 'map', 'pois.json'), 'utf8'));
export const CENTER = provData.center;

// Škola (vzdělání): dům čp. 91 (dle Matěje); jde přepsat v meta (school_x/school_y)
export const SCHOOL = { x: 0, y: 0, name: 'Škola Čichtice' };

// trasy po cestách mezi sousedy: "menšíId-většíId" -> [[x,y],...]
export const ROUTES = JSON.parse(readFileSync(join(ROOT, 'data', 'map', 'routes.json'), 'utf8'));
export function routeBetween(aId, bId) {
  const pts = aId < bId ? ROUTES[`${aId}-${bId}`] : ROUTES[`${bId}-${aId}`];
  if (!pts) return null;
  return aId < bId ? pts : pts.slice().reverse();
}
export function polylineLen(pts) {
  let l = 0;
  for (let i = 0; i < pts.length - 1; i++) l += Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]);
  return l;
}
export function hopLen(aId, bId) {
  const r = routeBetween(aId, bId);
  if (r) return polylineLen(r);
  const a = provinces.get(aId), b = provinces.get(bId);
  return a && b ? Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) : 0;
}

export const provinces = new Map(); // id -> statická data (vč. custom z rozdělených domů)
for (const p of provData.provinces) provinces.set(p.id, p);
for (const r of q.all('SELECT * FROM province_custom')) {
  const poly = JSON.parse(r.poly);
  provinces.set(r.id, {
    id: r.id, kind: 'house', name: r.name, resource: provinces.get(r.base_id)?.resource || 'grain', double: false,
    poly, c: centroidOf(poly), area: areaOf(poly), adjacent: JSON.parse(r.adjacent), custom: true,
    building: provinces.get(r.base_id)?.building, houseNumber: provinces.get(r.base_id)?.houseNumber,
  });
}

// pozice školy: meta override > dům čp. 91 > střed vesnice
{
  const mx = metaGet('school_x'), my = metaGet('school_y');
  if (mx != null && my != null) { SCHOOL.x = +mx; SCHOOL.y = +my; }
  else {
    const sk = [...provinces.values()].find((p) => p.houseNumber === '91');
    if (sk) { SCHOOL.x = sk.c[0]; SCHOOL.y = sk.c[1]; }
  }
}

function centroidOf(ring) {
  let x = 0, y = 0, n = ring.length - 1 || 1;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}
function areaOf(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}
export function pointInPoly(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const M_LAT = 110574;
export const M_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);
export const projLL = (lat, lon) => [(lon - CENTER.lon) * M_LON, (lat - CENTER.lat) * M_LAT];
export const distM = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// init province_state řádků
{
  const ins = db.prepare('INSERT OR IGNORE INTO province_state (id, morale) VALUES (?, 60)');
  for (const id of provinces.keys()) ins.run(id);
}
if (!metaGet('game_start')) metaSet('game_start', Date.now());

// ---------- notifikace / SSE ----------
let pushFn = () => {};
export function onPush(fn) { pushFn = fn; }
export function notify(playerId, type, text) {
  q.run('INSERT INTO events (player_id, ts, type, text) VALUES (?, ?, ?, ?)', playerId, Date.now(), type, text);
  pushFn(playerId, { type, text, ts: Date.now() });
}
export function pushRefresh(playerId = null) { pushFn(playerId, { type: 'refresh' }); }

// ---------- hráči, suroviny ----------
export const effId = (player) => player.team_with || player.id; // tým sdílí říši
export function playerById(id) { return q.get('SELECT * FROM players WHERE id = ?', id); }
export function resOf(pid) {
  const out = { money: 0 };
  for (const r of C.RESOURCES) out[r] = 0;
  for (const row of q.all('SELECT res, amount FROM resources WHERE player_id = ?', pid)) out[row.res] = row.amount;
  return out;
}
export function addRes(pid, res, amount) {
  q.run(`INSERT INTO resources (player_id, res, amount) VALUES (?, ?, MAX(0, ?))
         ON CONFLICT(player_id, res) DO UPDATE SET amount = MAX(0, amount + ?)`, pid, res, amount, amount);
}
export function canAfford(pid, cost) {
  const have = resOf(pid);
  return Object.entries(cost).every(([r, v]) => (have[r] || 0) >= v);
}
export function pay(pid, cost) { for (const [r, v] of Object.entries(cost)) addRes(pid, r, -v); }

export function allied(aId, bId) {
  if (aId === bId) return true;
  const pa = playerById(aId), pb = playerById(bId);
  if (!pa || !pb) return false;
  if (effId(pa) === effId(pb)) return true;
  return !!q.get(
    'SELECT 1 AS x FROM alliance_members m1 JOIN alliance_members m2 ON m1.alliance_id = m2.alliance_id WHERE m1.player_id = ? AND m2.player_id = ?',
    effId(pa), effId(pb),
  );
}
export function pactActive(aId, bId) {
  const pa = playerById(aId), pb = playerById(bId);
  if (!pa || !pb) return false;
  const x = effId(pa), y = effId(pb);
  return !!q.get("SELECT 1 AS z FROM pacts WHERE status = 'active' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))", x, y, y, x);
}
export function siblingPeaceActive(aId, bId) {
  const pa = playerById(aId), pb = playerById(bId);
  const now = Date.now();
  return (pa?.sibling_with === bId && pa.sibling_until > now) || (pb?.sibling_with === aId && pb.sibling_until > now);
}
export function siblingProtected(attackerId, ownerId, provinceId) {
  if (!siblingPeaceActive(attackerId, ownerId)) return false;
  const pa = playerById(attackerId), po = playerById(ownerId);
  return provinceId === pa?.home_id || provinceId === po?.home_id;
}
export function presenceAt(playerId, provinceId) {
  const pr = q.get('SELECT * FROM presence WHERE player_id = ?', playerId);
  if (!pr || Date.now() - pr.ts > C.PRESENCE_TTL_MIN * 60_000) return false;
  const prov = provinces.get(provinceId);
  if (!prov) return false;
  if (pointInPoly([pr.x, pr.y], prov.poly)) return true;
  return distM([pr.x, pr.y], prov.c) < C.PRESENCE_RADIUS_M + Math.sqrt(prov.area || 400) / 2;
}
export function presenceAtPoint(playerId, x, y, radius = C.PRESENCE_RADIUS_M) {
  const pr = q.get('SELECT * FROM presence WHERE player_id = ?', playerId);
  if (!pr || Date.now() - pr.ts > C.PRESENCE_TTL_MIN * 60_000) return false;
  return distM([pr.x, pr.y], [x, y]) < radius;
}

// ---------- objevování mapy (mlha) ----------
// Kruhy: start kolem domu, GPS pochůzky (malé), zdolané kopce (velké). Sdílí tým i aliance.
export function addDiscovery(pid, x, y, r) {
  const near = q.all('SELECT x, y, r FROM discovery WHERE player_id = ?', pid);
  for (const c of near) {
    if (distM([c.x, c.y], [x, y]) + r <= c.r + 20) return; // nový kruh je už celý odkrytý
  }
  q.run('INSERT INTO discovery (player_id, x, y, r, ts) VALUES (?, ?, ?, ?, ?)', pid, x, y, r, Date.now());
}
export function discoveryCircles(pid) {
  // vlastní + tým + aliance
  const ids = new Set([pid]);
  for (const p of q.all('SELECT id FROM players WHERE team_with = ?', pid)) ids.add(p.id);
  const me = playerById(pid);
  if (me?.team_with) ids.add(me.team_with);
  const ally = q.get('SELECT alliance_id FROM alliance_members WHERE player_id = ?', pid);
  if (ally) for (const m of q.all('SELECT player_id FROM alliance_members WHERE alliance_id = ?', ally.alliance_id)) ids.add(m.player_id);
  const circles = [];
  for (const id of ids) {
    for (const c of q.all('SELECT x, y, r FROM discovery WHERE player_id = ?', id)) circles.push(c);
    // vlastněné provincie jsou vždy viditelné (s okolím)
    for (const st of q.all('SELECT id FROM province_state WHERE owner_id = ?', id)) {
      const prov = provinces.get(st.id);
      if (prov) circles.push({ x: prov.c[0], y: prov.c[1], r: Math.sqrt(prov.area || 2000) + 180 });
    }
  }
  return circles;
}
export function isDiscovered(circles, x, y) {
  for (const c of circles) if (distM([c.x, c.y], [x, y]) <= c.r) return true;
  return false;
}
// migrace: každý hráč musí mít aspoň startovní kruh kolem domova
for (const p of q.all('SELECT * FROM players WHERE home_id IS NOT NULL')) {
  if (!q.get('SELECT 1 AS x FROM discovery WHERE player_id = ?', p.id)) {
    const prov = provinces.get(p.home_id);
    if (prov) addDiscovery(p.id, prov.c[0], prov.c[1], 320);
  }
}

// ---------- armády ----------
export function garrisonArmy(pid, provinceId, create = false) {
  let a = q.get('SELECT * FROM armies WHERE owner_id = ? AND province_id = ? AND path IS NULL', pid, provinceId);
  if (!a && create) {
    q.run("INSERT INTO armies (owner_id, province_id, units, morale) VALUES (?, ?, '{}', 80)", pid, provinceId);
    a = q.get('SELECT * FROM armies WHERE owner_id = ? AND province_id = ? AND path IS NULL', pid, provinceId);
  }
  return a;
}
export function addUnits(pid, provinceId, kind, count) {
  const a = garrisonArmy(pid, provinceId, true);
  const units = JSON.parse(a.units);
  units[kind] = (units[kind] || 0) + count;
  q.run('UPDATE armies SET units = ? WHERE id = ?', JSON.stringify(units), a.id);
}
export function armySize(units) { return Object.values(units).reduce((s, v) => s + v, 0); }
export function armySpeed(units) {
  let sp = Infinity;
  for (const [k, v] of Object.entries(units)) if (v > 0) sp = Math.min(sp, C.UNITS[k].speed);
  return sp === Infinity ? 400 : sp;
}

// nejkratší cesta grafem (Dijkstra dle vzdálenosti centroidů)
export function findPath(fromId, toId, avoidPonds = true) {
  if (fromId === toId) return [];
  const dist = new Map([[fromId, 0]]), prev = new Map(), open = new Set([fromId]);
  while (open.size) {
    let cur = null, best = Infinity;
    for (const id of open) if (dist.get(id) < best) { best = dist.get(id); cur = id; }
    open.delete(cur);
    if (cur === toId) break;
    const p = provinces.get(cur);
    for (const n of p.adjacent || []) {
      if (!provinces.has(n)) continue;
      if (avoidPonds && n !== toId && provinces.get(n).kind === 'pond') continue; // vojáci neplavou — rybník jen jako cíl
      const d = dist.get(cur) + hopLen(cur, n);
      if (d < (dist.get(n) ?? Infinity)) { dist.set(n, d); prev.set(n, cur); open.add(n); }
    }
  }
  if (!prev.has(toId)) return avoidPonds ? findPath(fromId, toId, false) : null; // nouzově i přes rybník
  const path = [];
  for (let at = toId; at !== fromId; at = prev.get(at)) path.unshift(at);
  return path;
}

export function orderMove(player, armyId, destId, stance) {
  const a = q.get('SELECT * FROM armies WHERE id = ?', armyId);
  const pid = effId(player);
  if (!a || a.owner_id !== pid) return { error: 'Armáda nenalezena.' };
  if (a.path) return { error: 'Armáda je na cestě — počkej, až dorazí do dalšího uzlu.' };
  if (!provinces.has(destId)) return { error: 'Neplatný cíl.' };
  const units = JSON.parse(a.units);
  if (armySize(units) === 0) return { error: 'Armáda je prázdná.' };
  const path = findPath(a.province_id, destId);
  if (!path || !path.length) return { error: 'Cesta nenalezena.' };
  const destOwner = q.get('SELECT owner_id FROM province_state WHERE id = ?', destId)?.owner_id;
  if (destOwner && destOwner !== pid && allied(pid, destOwner) && stance === 'attack') {
    return { error: 'Na spojence útočit nemůžeš — pošli armádu jako Přesun (posily).' };
  }
  if (destOwner && !allied(pid, destOwner)) {
    if (stance !== 'attack') return { error: 'Cíl patří nepříteli — pošli armádu jako útok.' };
    if (siblingProtected(pid, destOwner, destId)) return { error: 'Ochranná lhůta: na společný dům zatím nemůžeš útočit.' };
    if (pactActive(pid, destOwner)) return { error: 'Máte mír — nejdřív ho musíš vypovědět (Diplomacie).' };
  }
  // vzdálený rozkaz: příprava podle délky trasy; fyzická přítomnost u armády = vyráží hned
  let delay = 0;
  if (!presenceAt(player.id, a.province_id)) {
    let len = 0, cur = a.province_id;
    for (const n of path) { len += hopLen(cur, n); cur = n; }
    delay = (len / 1000) * C.REMOTE_DELAY_MIN_PER_KM * 60_000;
  }
  q.run('UPDATE armies SET path = ?, next_arrive = NULL, depart_delay_until = ?, stance = ? WHERE id = ?',
    JSON.stringify(path), Date.now() + delay, stance === 'attack' ? 'attack' : 'move', a.id);
  pushRefresh();
  return { ok: true, delayMin: Math.round(delay / 60_000) };
}

export function splitArmy(player, armyId, take) {
  const a = q.get('SELECT * FROM armies WHERE id = ?', armyId);
  const pid = effId(player);
  if (!a || a.owner_id !== pid || a.path) return { error: 'Armádu nejde teď rozdělit.' };
  const units = JSON.parse(a.units);
  const newUnits = {};
  for (const [k, v] of Object.entries(take || {})) {
    const n = Math.min(units[k] || 0, Math.max(0, Math.floor(v)));
    if (n > 0) { newUnits[k] = n; units[k] -= n; }
  }
  if (!armySize(newUnits)) return { error: 'Vyber aspoň jednu jednotku.' };
  q.run('UPDATE armies SET units = ? WHERE id = ?', JSON.stringify(units), a.id);
  q.run('INSERT INTO armies (owner_id, province_id, units, morale) VALUES (?, ?, ?, ?)', pid, a.province_id, JSON.stringify(newUnits), a.morale);
  pushRefresh(player.id);
  return { ok: true };
}

// ---------- boj ----------
function sizeFactor(kind, n) {
  const table = C.SIZE_FACTOR[kind] || [[50, 1.0]];
  let eff = 1.0;
  for (const [threshold, factor] of table) if (n >= threshold) eff = factor;
  return eff;
}
// síla strany za kolo; obránce používá DEF, útočník ATK (jako v originále)
function sidePower(armies, useDef) {
  let power = 0;
  for (const a of armies) {
    const units = JSON.parse(a.units);
    let base = 0;
    for (const [k, n] of Object.entries(units)) {
      if (n <= 0) continue;
      base += (useDef ? C.UNITS[k].def : C.UNITS[k].atk) * n * sizeFactor(k, n);
    }
    const mf = (a.morale / 100) * 0.45 + C.COMBAT.moraleFactorMin;
    const rand = 1 + (Math.random() * 2 - 1) * C.COMBAT.randomSpread;
    power += base * mf * rand;
  }
  return power;
}
const ROUND_SCALE = 0.9; // kolik síly se přetaví ve ztráty za jedno kolo (6v6 pěchoty ≈ 4–6 kol)

function applyDamage(armyRows, totalDmg) {
  const sizes = armyRows.map((a) => armySize(JSON.parse(a.units)));
  const total = sizes.reduce((s, v) => s + v, 0) || 1;
  let killedTotal = 0;
  armyRows.forEach((a, i) => {
    const units = JSON.parse(a.units);
    const dmg = totalDmg * (sizes[i] / total);
    const kinds = Object.keys(units).filter((k) => units[k] > 0);
    const hpPool = kinds.reduce((s, k) => s + units[k] * C.UNITS[k].hp, 0) || 1;
    for (const k of kinds) {
      const share = (units[k] * C.UNITS[k].hp) / hpPool;
      const killed = Math.min(units[k], Math.floor((dmg * share) / C.UNITS[k].hp + Math.random() * 0.7));
      units[k] -= killed;
      killedTotal += killed;
    }
    q.run('UPDATE armies SET units = ?, morale = MAX(5, morale - 5) WHERE id = ?', JSON.stringify(units), a.id);
  });
  return killedTotal;
}
function cleanupEmptyArmies() {
  q.run("DELETE FROM armies WHERE units = '{}'");
  for (const a of q.all('SELECT * FROM armies')) {
    if (armySize(JSON.parse(a.units)) === 0) q.run('DELETE FROM armies WHERE id = ?', a.id);
  }
}

export function battleSides(provinceId) {
  const st = q.get('SELECT * FROM province_state WHERE id = ?', provinceId);
  // brání i armády, které se teprve chystají vyrazit (ještě nejsou na cestě)
  const here = q.all('SELECT * FROM armies WHERE province_id = ? AND (path IS NULL OR next_arrive IS NULL)', provinceId);
  const defenders = [], attackers = [];
  for (const a of here) {
    if (st.owner_id && allied(a.owner_id, st.owner_id)) defenders.push(a);
    else if (!st.owner_id || !allied(a.owner_id, st.owner_id)) {
      // sourozenci v ochranné lhůtě a mírové pakty NIKDY neútočí (ani průchodem)
      if (st.owner_id && (siblingProtected(a.owner_id, st.owner_id, provinceId) || pactActive(a.owner_id, st.owner_id))) continue;
      if (a.stance === 'attack') attackers.push(a);
    }
  }
  return { st, defenders, attackers };
}

export function capture(provinceId, newOwnerId) {
  const st = q.get('SELECT * FROM province_state WHERE id = ?', provinceId);
  const prov = provinces.get(provinceId);
  const oldOwner = st.owner_id;
  q.run(`UPDATE province_state SET owner_id = ?, morale = 30, captured_ts = ?,
         build_kind = NULL, build_until = NULL, unit_kind = NULL, unit_until = NULL WHERE id = ?`,
    newOwnerId, Date.now(), provinceId);
  const winner = playerById(newOwnerId);
  if (oldOwner) notify(oldOwner, 'lost', `Ztratil jsi ${prov.name} — dobyl ho ${winner.name}.`);
  notify(null, 'capture', `${winner.name} ${oldOwner ? 'dobyl' : 'obsadil'} ${prov.name}.`);
  if (oldOwner) {
    const loser = playerById(oldOwner);
    if (loser && loser.capital_id === provinceId) {
      const loserRes = resOf(oldOwner);
      const taken = Math.floor((loserRes.money || 0) * C.CAPITAL_CAPTURE.winnerMoneyShare);
      addRes(oldOwner, 'money', -taken);
      addRes(newOwnerId, 'money', taken);
      q.run('UPDATE province_state SET morale = MIN(100, morale + ?) WHERE owner_id = ?', C.CAPITAL_CAPTURE.winnerMoraleBonus, newOwnerId);
      q.run('UPDATE province_state SET morale = MAX(5, morale - ?) WHERE owner_id = ?', C.CAPITAL_CAPTURE.loserMoralePenalty, oldOwner);
      q.run('UPDATE players SET max_morale = MAX(20, max_morale - ?) WHERE id = ?', C.CAPITAL_CAPTURE.loserMaxMoralePenalty, oldOwner);
      notify(null, 'capital', `${winner.name} dobyl hlavní město hráče ${loser.name}!`);
      const rest = q.all('SELECT id FROM province_state WHERE owner_id = ? AND id != ?', oldOwner, provinceId);
      q.run('UPDATE players SET capital_id = ? WHERE id = ?', rest.length ? rest[0].id : null, oldOwner);
    }
  }
  checkVictory();
  pushRefresh();
}

function runBattles(now) {
  for (const b of q.all('SELECT * FROM battles WHERE next_round <= ?', now)) {
    const { st, defenders, attackers } = battleSides(b.province_id);
    const prov = provinces.get(b.province_id);
    if (!attackers.length) { q.run('DELETE FROM battles WHERE id = ?', b.id); continue; }
    if (!defenders.length) {
      capture(b.province_id, attackers[0].owner_id);
      q.run("UPDATE armies SET stance = 'move' WHERE province_id = ?", b.province_id);
      q.run('DELETE FROM battles WHERE id = ?', b.id);
      continue;
    }
    const fort = st.fortress ? C.FORTRESS[st.fortress].dmgReduction : 0;
    const atkPower = sidePower(attackers, false);
    const defPower = sidePower(defenders, true);
    const lossDef = applyDamage(defenders, atkPower * (1 - fort) * ROUND_SCALE);
    const lossAtk = applyDamage(attackers, defPower * ROUND_SCALE);
    cleanupEmptyArmies();
    const after = battleSides(b.province_id);
    if (!after.attackers.length && !after.defenders.length) {
      q.run('DELETE FROM battles WHERE id = ?', b.id);
      notify(null, 'battle', `Bitva o ${prov.name} skončila — obě strany padly.`);
    } else if (!after.attackers.length) {
      q.run('DELETE FROM battles WHERE id = ?', b.id);
      notify(st.owner_id, 'battle', `Ubránil jsi ${prov.name} (ztráty: útočník ${lossAtk}, ty ${lossDef}).`);
    } else if (!after.defenders.length) {
      capture(b.province_id, after.attackers[0].owner_id);
      q.run("UPDATE armies SET stance = 'move' WHERE province_id = ?", b.province_id);
      q.run('DELETE FROM battles WHERE id = ?', b.id);
    } else {
      q.run('UPDATE battles SET next_round = ? WHERE id = ?', now + C.COMBAT_TICK_MIN * 60_000, b.id);
    }
  }
}

function startBattleIfNeeded(provinceId) {
  const { st, defenders, attackers } = battleSides(provinceId);
  if (!attackers.length) return false;
  if (!defenders.length && !st.owner_id) return false; // volné území — rovnou obsadit (řeší arrival)
  if (!q.get('SELECT 1 AS x FROM battles WHERE province_id = ?', provinceId)) {
    q.run('INSERT INTO battles (province_id, next_round, started) VALUES (?, ?, ?)', provinceId, Date.now(), Date.now());
    const prov = provinces.get(provinceId);
    if (st.owner_id) {
      const atkNames = [...new Set(attackers.map((a) => playerById(a.owner_id)?.name))].join(', ');
      notify(st.owner_id, 'attack', `Útok na ${prov.name}! Útočí ${atkNames}. Pošli posily, dokud je čas.`);
    }
  }
  return true;
}

// ---------- pohyb armád ----------
function processArmies(now) {
  for (const a of q.all('SELECT * FROM armies WHERE path IS NOT NULL')) {
    if (a.depart_delay_until && now < a.depart_delay_until) continue;
    const path = JSON.parse(a.path);
    if (!path.length) { q.run('UPDATE armies SET path = NULL, next_arrive = NULL WHERE id = ?', a.id); continue; }
    if (!a.next_arrive) {
      // vyraž k dalšímu uzlu (province_id zůstává = odkud jde)
      const units = JSON.parse(a.units);
      let hopH = hopLen(a.province_id, path[0]) / armySpeed(units);
      const owner = playerById(a.owner_id);
      if (owner && (presenceAt(owner.id, path[0]) || presenceAt(owner.id, a.province_id))) hopH /= C.PRESENCE_MOVE_SPEEDUP;
      q.run('UPDATE armies SET next_arrive = ?, depart_delay_until = NULL WHERE id = ?', Math.round(now + hopH * 3600_000), a.id);
      continue;
    }
    if (now >= a.next_arrive) {
      const arrivedId = path.shift();
      q.run('UPDATE armies SET province_id = ?, path = ?, next_arrive = NULL WHERE id = ?',
        arrivedId, path.length ? JSON.stringify(path) : null, a.id);
      const owner = playerById(a.owner_id);
      const st = q.get('SELECT * FROM province_state WHERE id = ?', arrivedId);
      const prov = provinces.get(arrivedId);
      const hostile = st.owner_id && !allied(a.owner_id, st.owner_id);
      const enemyArmies = q.all('SELECT * FROM armies WHERE province_id = ? AND path IS NULL AND owner_id != ?', arrivedId, a.owner_id)
        .filter((e) => !allied(e.owner_id, a.owner_id));
      if (owner && presenceAt(owner.id, arrivedId)) {
        q.run('UPDATE armies SET morale = MIN(100, morale + ?) WHERE id = ?', C.PRESENCE_ARRIVAL_MORALE, a.id);
      }
      if (hostile || enemyArmies.length) {
        if (a.stance === 'attack') {
          q.run('UPDATE armies SET path = NULL WHERE id = ?', a.id); // boj přeruší pochod
          if (!st.owner_id || hostile ? true : enemyArmies.length) startBattleIfNeeded(arrivedId);
          if (!st.owner_id && !enemyArmies.length) capture(arrivedId, a.owner_id);
        } else if (hostile && !siblingProtected(a.owner_id, st.owner_id, arrivedId) && !pactActive(a.owner_id, st.owner_id)) {
          // pochod přes nepřátelské území bez útoku: boj se stejně spustí (viz sekce 5)
          q.run("UPDATE armies SET path = NULL, stance = 'attack' WHERE id = ?", a.id);
          startBattleIfNeeded(arrivedId);
        }
      } else if (!st.owner_id && !path.length && armySize(JSON.parse(a.units)) > 0) {
        capture(arrivedId, a.owner_id); // obsazení volné přírody
      }
      if (!path.length) {
        if (owner) notify(a.owner_id, 'arrive', `Armáda dorazila: ${prov.name}.`);
        pushRefresh();
      }
    }
  }
}

// ---------- ekonomika (tick po minutě) ----------
function economyTick(now, minutes) {
  const h = minutes / 60;
  const players = q.all('SELECT * FROM players WHERE team_with IS NULL');
  for (const pl of players) {
    const owned = q.all('SELECT * FROM province_state WHERE owner_id = ?', pl.id);
    if (!owned.length) continue;
    const res = resOf(pl.id);
    // spotřeba: každá provincie bere z každé kategorie (nejzásobenější surovinu)
    const shortages = new Set();
    for (const [cat, list] of Object.entries(C.CATEGORIES)) {
      let need = C.CONSUME_PER_H * owned.length * h;
      const sorted = list.slice().sort((x, y) => (res[y] || 0) - (res[x] || 0));
      for (const r of sorted) {
        const take = Math.min(res[r] || 0, need);
        if (take > 0) { addRes(pl.id, r, -take); res[r] -= take; need -= take; }
      }
      if (need > 0.01) shortages.add(cat);
    }
    // kasárna žerou obilí
    for (const st of owned) {
      if (st.barracks) {
        const g = (C.BARRACKS[st.barracks].grainPerDay / 24) * h;
        if ((res.grain || 0) >= g) { addRes(pl.id, 'grain', -g); res.grain -= g; }
      }
    }
    for (const st of owned) {
      const prov = provinces.get(st.id);
      if (!prov) continue;
      const moraleF = st.morale / 100;
      // vylepšení přírodního území: bonusy produkce + denní náklady (mzdy, palivo, krmení)
      let upgMult = 1, upgMorale = 0;
      const upgSet = C.natureSetFor(prov);
      if (upgSet && st.upgrades) {
        const ups = JSON.parse(st.upgrades || '{}');
        for (const def of C.NATURE_UPGRADES[upgSet]) {
          const lvl = ups[def.key] || 0;
          if (!lvl) continue;
          let active = true;
          if (def.upkeepDayBase) {
            const needs = Object.entries(def.upkeepDayBase).map(([r, v]) => [r, (v * lvl / 24) * h]);
            if (needs.some(([r, need]) => (res[r] || 0) < need)) active = false; // není na mzdy/palivo -> stojí
            else for (const [r, need] of needs) { addRes(pl.id, r, -need); res[r] -= need; }
          }
          if (active) { upgMult += def.bonus * lvl; upgMorale += def.morale || 0; }
        }
      }
      // produkce: dům = surovina + daně (jako v Supremacy); příroda = bonusová surovina
      if (prov.kind === 'house') {
        addRes(pl.id, 'money', C.HOUSE_MONEY_PER_H * moraleF * h);
        if (prov.resource && prov.resource !== 'money') addRes(pl.id, prov.resource, C.PROD_PER_H * moraleF * h);
      } else {
        addRes(pl.id, prov.resource, C.PROD_PER_H * (prov.double ? 2 : 1) * moraleF * upgMult * h);
      }
      // morálka: drift k rovnováze
      let eq = C.MORALE_BASE_EQ + upgMorale;
      if (st.fortress) eq += C.FORTRESS[st.fortress].moraleBonus;
      if (shortages.size) eq -= 25 * shortages.size;
      eq = Math.min(eq, pl.max_morale);
      const drift = (eq - st.morale) * Math.min(1, C.MORALE_DRIFT * h); // omezené, ať spánek serveru nepřestřelí
      // verbování pěchoty (jen domy)
      let rp = st.recruit_progress;
      if (prov.kind === 'house') {
        let rate = (1 / C.RECRUIT_HOURS_PER_INF) * moraleF;
        if (st.barracks) rate *= 1 + C.BARRACKS[st.barracks].recruitBonus;
        rp += rate * h;
        if (rp >= 1) {
          const n = Math.floor(rp);
          rp -= n;
          addUnits(pl.id, st.id, 'infantry', n);
        }
      }
      q.run('UPDATE province_state SET morale = ?, recruit_progress = ? WHERE id = ?',
        Math.max(5, Math.min(100, st.morale + drift)), rp, st.id);
      // dokončené stavby
      if (st.build_kind && st.build_until <= now) {
        if (st.build_kind === 'fortress') {
          q.run('UPDATE province_state SET fortress = fortress + 1, build_kind = NULL, build_until = NULL WHERE id = ?', st.id);
          notify(pl.id, 'build', `Stavba dokončena: pevnost — ${prov.name}.`);
        } else if (st.build_kind === 'barracks') {
          q.run('UPDATE province_state SET barracks = barracks + 1, build_kind = NULL, build_until = NULL WHERE id = ?', st.id);
          notify(pl.id, 'build', `Stavba dokončena: kasárna — ${prov.name}.`);
        } else if (st.build_kind.startsWith('upg:')) {
          const key = st.build_kind.slice(4);
          const ups = JSON.parse(st.upgrades || '{}');
          ups[key] = (ups[key] || 0) + 1;
          q.run('UPDATE province_state SET upgrades = ?, build_kind = NULL, build_until = NULL WHERE id = ?', JSON.stringify(ups), st.id);
          const def = upgSet ? C.NATURE_UPGRADES[upgSet].find((d) => d.key === key) : null;
          notify(pl.id, 'build', `Vylepšení hotovo: ${def?.label || key}${ups[key] > 1 ? ` (úroveň ${ups[key]})` : ''} — ${prov.name}.`);
        }
      }
      // dokončené jednotky
      if (st.unit_kind && st.unit_until <= now) {
        addUnits(pl.id, st.id, st.unit_kind, 1);
        q.run('UPDATE province_state SET unit_kind = NULL, unit_until = NULL WHERE id = ?', st.id);
        notify(pl.id, 'unit', `Jednotka vyrobena: ${C.UNITS[st.unit_kind].label} — ${prov.name}.`);
      }
    }
    // vzdělání
    if (pl.edu_course_level && pl.edu_course_until <= now) {
      q.run('UPDATE players SET education = ?, edu_course_level = NULL, edu_course_until = NULL WHERE id = ?', pl.edu_course_level, pl.id);
      const lvl = C.EDUCATION[pl.edu_course_level - 1];
      notify(pl.id, 'education', `Vzdělání dokončeno: ${lvl.label}. Odemčeno: ${C.UNITS[lvl.unlocks].label}.`);
    }
  }
  // obchody ve městech: NPC prodeje
  for (const s of q.all('SELECT * FROM shops WHERE stock > 0')) {
    const town = POIS.towns.find((t) => t.name === s.town);
    if (!town) continue;
    const sold = Math.min(s.stock, C.SHOP_NPC_SALES_PER_H * h);
    const income = sold * C.BASE_PRICES[s.res] * C.townPriceMult(town.km);
    q.run('UPDATE shops SET stock = stock - ?, earned = earned + ? WHERE id = ?', sold, income, s.id);
    addRes(s.player_id, 'money', income);
  }
  // zotavování morálky armád: na vlastním území k 100, jinde k 50
  for (const a of q.all('SELECT * FROM armies WHERE path IS NULL')) {
    const st = q.get('SELECT owner_id FROM province_state WHERE id = ?', a.province_id);
    const target = st && st.owner_id && allied(a.owner_id, st.owner_id) ? 100 : 50;
    const rate = Math.min(1, (C.UNIT_RECOVER_PER_DAY / 24) * h);
    const m = a.morale + (target - a.morale) * rate;
    q.run('UPDATE armies SET morale = ? WHERE id = ?', m, a.id);
  }
}

export function checkVictory() {
  if (metaGet('winner')) return;
  const total = provinces.size;
  const counts = q.all('SELECT * FROM players WHERE team_with IS NULL').map((pl) => ({
    pl, n: q.get('SELECT COUNT(*) AS n FROM province_state WHERE owner_id = ?', pl.id).n,
  }));
  for (const { pl, n } of counts) {
    if (n >= total * C.VICTORY_PROVINCE_SHARE) {
      metaSet('winner', pl.name);
      notify(null, 'victory', `${pl.name} ovládl ${Math.round((n / total) * 100)} % území a vyhrává hru!`);
      return;
    }
  }
  // konec na čas: po uplynutí délky partie vyhrává, kdo má nejvíc území (0 = bez limitu)
  const start = +metaGet('game_start', Date.now());
  if (C.GAME_LENGTH_DAYS > 0 && Date.now() - start >= C.GAME_LENGTH_DAYS * 86400_000 && counts.length) {
    counts.sort((a, b) => b.n - a.n);
    metaSet('winner', counts[0].pl.name);
    notify(null, 'victory', `Partie skončila po ${C.GAME_LENGTH_DAYS} dnech — vítězí ${counts[0].pl.name} s ${counts[0].n} územími!`);
  }
}

// ---------- fyzická přítomnost: okamžité dokončení akcí ----------
export function applyPresenceBoosts(player) {
  const pid = effId(player);
  let boosted = [];
  for (const st of q.all('SELECT * FROM province_state WHERE owner_id = ? AND (build_kind IS NOT NULL OR unit_kind IS NOT NULL)', pid)) {
    if (!presenceAt(player.id, st.id)) continue;
    const prov = provinces.get(st.id);
    if (st.build_kind && st.build_until > Date.now()) {
      q.run('UPDATE province_state SET build_until = ? WHERE id = ?', Date.now(), st.id);
      boosted.push(`stavba v ${prov.name}`);
    }
    if (st.unit_kind && st.unit_until > Date.now()) {
      q.run('UPDATE province_state SET unit_until = ? WHERE id = ?', Date.now(), st.id);
      boosted.push(`výroba v ${prov.name}`);
    }
  }
  if (boosted.length) notify(player.id, 'presence', `Jsi na místě — dokončeno hned: ${boosted.join(', ')}.`);
  return boosted;
}

// úklid: aliance bez členů smaž
q.run('DELETE FROM alliances WHERE id NOT IN (SELECT DISTINCT alliance_id FROM alliance_members)');

// při startu: armádám s trasou přes rybník (staré rozkazy) trasu přepočítej
{
  for (const a of q.all('SELECT id, province_id, path FROM armies WHERE path IS NOT NULL')) {
    try {
      const path = JSON.parse(a.path);
      const transitsPond = path.slice(0, -1).some((id) => provinces.get(id)?.kind === 'pond');
      if (!transitsPond || !path.length) continue;
      const target = path[path.length - 1];
      const fresh = findPath(a.province_id, target);
      if (fresh && fresh.length) {
        q.run('UPDATE armies SET path = ?, next_arrive = NULL WHERE id = ?', JSON.stringify(fresh), a.id);
        console.log(`Armáda ${a.id}: trasa přepočítána mimo rybník (${path.length} -> ${fresh.length} uzlů)`);
      }
    } catch { /* nevadí */ }
  }
}

// ---------- tick ----------
let lastTick = Date.now();
export function tick() {
  const now = Date.now();
  // po uspání serveru (free hosting) se dožene až týden herního času
  const minutes = Math.min(7 * 24 * 60, (now - lastTick) / 60_000);
  lastTick = now;
  try {
    economyTick(now, minutes);
    // dlouhý výpadek: přehraj časovou osu po krocích, ať armády ujdou víc uzlů a bitvy víc kol
    if (minutes > 30) {
      const steps = Math.min(80, Math.ceil(minutes / C.COMBAT_TICK_MIN));
      const startT = now - minutes * 60_000;
      for (let i = 1; i <= steps; i++) {
        const t = startT + minutes * 60_000 * (i / steps);
        processArmies(t);
        runBattles(t);
      }
    }
    processArmies(now);
    runBattles(now);
    checkVictory();
  } catch (e) {
    console.error('Tick error:', e);
  }
}
export function startTicking() {
  tick();
  setInterval(tick, C.TICK_MS);
}
