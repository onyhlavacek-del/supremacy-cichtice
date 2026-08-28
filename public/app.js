// Supremacy Čichtice — klient
'use strict';

const $ = (s) => document.querySelector(s);
const map = new TeslaMap($('#map'));
map.onMove = () => hideBubble(); // bublina nesmí "cestovat" s mapou
let MAPDATA = null, STATE = null, ME = null, RULES = null;
let pickMode = null; // {type: 'movetarget'|'house', armyId?, stance?}
let activeTab = 'map';
let sheetProvince = null;
let sheetPoi = null; // {type: 'town'|'peak'|'school', name}
let sheetArmy = null; // id vybrané armády

const RES_LABEL = { grain: 'Obilí', fish: 'Ryby', lumber: 'Dřevo', iron: 'Železo', coal: 'Uhlí', oil: 'Ropa', gas: 'Plyn', money: 'Peníze' };
const RES_ICON = {
  grain: '<svg viewBox="0 0 16 16"><path d="M8 15V6M8 6C8 3 6 2 4 2c0 3 2 4 4 4zm0 0c0-3 2-4 4-4 0 3-2 4-4 4zM8 10C8 8 6.5 7 5 7c0 2 1.5 3 3 3zm0 0c0-2 1.5-3 3-3 0 2-1.5 3-3 3z" fill="none" stroke="#C9A227" stroke-width="1.4" stroke-linecap="round"/></svg>',
  fish: '<svg viewBox="0 0 16 16"><ellipse cx="6.8" cy="8" rx="5" ry="3.1" fill="#4A90D9"/><path d="M11 8 L15 5 L13.8 8 L15 11 Z" fill="#4A90D9"/><circle cx="4.3" cy="7.1" r="0.95" fill="#fff"/></svg>',
  lumber: '<svg viewBox="0 0 16 16"><rect x="2" y="6" width="12" height="4" rx="2" fill="#7A5230"/><circle cx="13" cy="8" r="1.4" fill="#C9A227"/></svg>',
  iron: '<svg viewBox="0 0 16 16"><path d="M3 11h10l-2-5H5z" fill="#6E7B8B"/></svg>',
  coal: '<svg viewBox="0 0 16 16"><path d="M4 12l-1-4 3-3 5 1 2 4-3 3z" fill="#3A3A3A"/></svg>',
  oil: '<svg viewBox="0 0 16 16"><path d="M8 2C5 6 4 8 4 10a4 4 0 008 0c0-2-1-4-4-8z" fill="#1F1F1F"/></svg>',
  gas: '<svg viewBox="0 0 16 16"><path d="M8 2c2 3 4 4 4 7a4 4 0 01-8 0c0-1.5.7-2.6 1.6-3.8C6 6.5 7.5 4.5 8 2z" fill="#7B68B5"/></svg>',
  money: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#B8860B" stroke-width="1.6"/><text x="8" y="11" font-size="8" font-weight="700" text-anchor="middle" fill="#B8860B">K</text></svg>',
};
const UNITS = {
  infantry: { label: 'Pěchota', edu: 0 },
  cavalry: { label: 'Kavalerie', edu: 1 },
  armoredcar: { label: 'Obrněné auto', edu: 2 },
  artillery: { label: 'Dělostřelectvo', edu: 3 },
  tank: { label: 'Tank', edu: 4 },
  heavytank: { label: 'Těžký tank', edu: 5 },
};
// znaky aliancí (SVG, žádná emoji)
const ALLY_SYMBOLS = {
  swords: '<svg viewBox="0 0 16 16"><path d="M3 3l7 7M13 3L6 10M3 13l3-3M13 13l-3-3" stroke="#fff" stroke-width="1.7" stroke-linecap="round" fill="none"/></svg>',
  shield: '<svg viewBox="0 0 16 16"><path d="M8 2l5 1.5v4c0 3-2 5-5 6.5C5 12.5 3 10.5 3 7.5v-4z" fill="#fff"/></svg>',
  crown: '<svg viewBox="0 0 16 16"><path d="M3 11l-1-6 3.5 2.5L8 3l2.5 4.5L14 5l-1 6z" fill="#fff"/></svg>',
  tower: '<svg viewBox="0 0 16 16"><path d="M5 14V6H4V3h2v1h1V3h2v1h1V3h2v3h-1v8z" fill="#fff"/></svg>',
  star: '<svg viewBox="0 0 16 16"><path d="M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.4 4.3 13.5l.8-4.2L2 6.4l4.2-.5z" fill="#fff"/></svg>',
  tree: '<svg viewBox="0 0 16 16"><path d="M8 2l3.5 5H9.8l3 4.5H9v2.5H7V11.5H3.2l3-4.5H4.5z" fill="#fff"/></svg>',
};
const ALLY_LABEL = { swords: 'Meče', shield: 'Štít', crown: 'Koruna', tower: 'Věž', star: 'Hvězda', tree: 'Strom' };
const allyBanner = (ally, size = 16) => `<span class="ally-banner" style="background:${ally.bg};width:${size}px;height:${Math.round(size * 1.15)}px">${ALLY_SYMBOLS[ally.symbol] || ALLY_SYMBOLS.swords}</span>`;

const EDU = ['Základní výcvik', 'Řidičský kurz', 'Dělostřelecká škola', 'Technická škola', 'Vojenská akademie'];

// obrázky od Matěje (public/img)
const IMG = (name, size = 34) => name ? `<img class="aimg" style="width:${size}px;height:${size}px" src="img/${name}.png" alt="">` : '';
const UNIT_IMG = { infantry: 'pechota', cavalry: 'kavalerie', armoredcar: 'obrnene-auto', artillery: 'delo', tank: 'tank', heavytank: 'tezky-tank' };
const UPG_IMG = {
  farmers: 'farmar', harvester: 'kombajn', fertilizer: null, irrigation: 'zavlazovani', granary: 'sypka',
  fishermen: 'rybar', boat: 'lodka', nets: null, hatchery: null, feeding: 'obili',
  lumberjacks: 'drevorubec', chainsaw: 'motorova-pila', tractor: 'traktor', sawmill: null, planting: null,
  miners: 'hornik', drill: 'vrtna-souprava', cart: 'dulni-vozik', lighting: null, storage: null,
  drillers: 'hornik', pumpjack: 'pumpjack', derrick: 'vrtna-vez', tanker: 'cisterna', barrels: 'ropa',
  compressor: 'kompresor', gastower: 'tezebni-vez', pipeline: null, gastank: 'plyn',
};

// ---------- API ----------
async function api(path, body) {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opt);
  const data = await r.json().catch(() => ({}));
  if (data.error) toast(data.error);
  return data;
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function fmt(n) {
  n = Math.floor(n);
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function timeLeft(ts) {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return (s / 3600).toFixed(1) + ' h';
}

// ---------- načtení ----------
async function loadMapData() {
  [MAPDATA, RULES] = await Promise.all([
    (await fetch('/api/map')).json(),
    (await fetch('/api/rules')).json(),
  ]);
  map.setData(MAPDATA);
  map.centerOn(0, 0, 0.9);
}
async function refreshState() {
  let r;
  try { r = await fetch('/api/state'); } catch { return false; } // offline
  if (r.status === 401) return false;
  STATE = await r.json();
  ME = STATE.me;
  // nové provincie (rozdělené domy) — klient má starou mapu, stáhni ji znovu
  const known = new Set(MAPDATA.provinces.map((p) => p.id));
  if (STATE.provinces.some((p) => !known.has(p.id))) {
    MAPDATA = await (await fetch('/api/map')).json();
    map.setData(MAPDATA);
  }
  map._stateAt = Date.now();
  map.setState(STATE);
  renderTopbar();
  renderSheet();
  renderDrawer();
  // puntík u menu, když přišla nová zpráva do zavřeného chatu
  const lastMsg = STATE.chat?.[STATE.chat.length - 1];
  if (lastMsg && lastMsg.id > lastChatSeen && lastMsg.playerId !== ME.effId && $('#drawer').classList.contains('hidden')) {
    $('#menu-badge').classList.remove('hidden');
  }
  return true;
}

// ---------- SSE ----------
let sse = null;
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'hello') return;
      if (d.type === 'refresh') { refreshState(); return; }
      if (d.text) toast(d.text);
      refreshState();
    } catch { /* ignore */ }
  };
  sse.onerror = () => { setTimeout(connectSSE, 5000); };
}

// ---------- GPS ----------
// Wake lock: při zapnuté hře drž displej vzhůru (zhasnutý displej = žádná poloha)
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* nepodporováno / zamítnuto */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ME) keepAwake();
});

let gpsWatch = null;

// ---------- offline záznam trasy (bez dat GPS funguje, jen se nedá odeslat) ----------
const GPS_QUEUE_KEY = 'supGpsQueue';
function gpsQueue() { try { return JSON.parse(localStorage.getItem(GPS_QUEUE_KEY) || '[]'); } catch { return []; } }
function gpsQueueSave(qq) { try { localStorage.setItem(GPS_QUEUE_KEY, JSON.stringify(qq.slice(-3000))); } catch { /* plno */ } }
function gpsEnqueue(pt) {
  const qq = gpsQueue();
  const last = qq[qq.length - 1];
  // šetři místo: nový bod jen když se pohnul ~15 m nebo uplynulo 45 s
  if (last) {
    const dm = Math.hypot((pt.lat - last.lat) * 110574, (pt.lon - last.lon) * 72900);
    if (dm < 15 && pt.ts - last.ts < 45_000) return;
  }
  qq.push(pt);
  gpsQueueSave(qq);
  updateOfflineBadge();
  map.localReveal = qq; // mlha se odkrývá i offline (lokálně, do synchronizace)
  map.draw();
}
let flushing = false;
async function gpsFlush() {
  const qq = gpsQueue();
  if (!qq.length || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const r = await fetch('/api/positions/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: qq }) });
    if (r.ok) {
      const d = await r.json();
      gpsQueueSave([]);
      map.localReveal = [];
      toast(`Nahrána offline trasa: ${d.applied} bodů${d.pois?.length ? `, objeveno: ${d.pois.length}` : ''}.`);
      refreshState();
    }
  } catch { /* stále offline — zkusíme příště */ }
  flushing = false;
  updateOfflineBadge();
}
function updateOfflineBadge() {
  const el = $('#offline-badge');
  if (!el) return;
  const n = gpsQueue().length;
  const off = !navigator.onLine;
  el.classList.toggle('hidden', !off && n === 0);
  el.textContent = off ? `Offline · trasa se ukládá (${n})` : `Odesílám uloženou trasu (${n})…`;
}
addEventListener('online', () => { updateOfflineBadge(); gpsFlush(); });
addEventListener('offline', updateOfflineBadge);

function startGps() {
  if (!navigator.geolocation || gpsWatch) return;
  map.localReveal = gpsQueue();
  updateOfflineBadge();
  gpsFlush();
  gpsWatch = navigator.geolocation.watchPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    const pt = { lat: latitude, lon: longitude, ts: Date.now() };
    if (!navigator.onLine) { gpsEnqueue(pt); return; }
    if (gpsQueue().length) await gpsFlush();
    try {
      const r = await fetch('/api/position', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pt) });
      if (!r.ok) throw new Error('http');
      const d = await r.json();
      if (d.ok) { map.gps = [d.x, d.y]; map.draw(); }
    } catch {
      gpsEnqueue(pt); // síť selhala (např. slabý signál) — ulož a pošli později
    }
  }, () => { /* zamítnuto */ }, { enableHighAccuracy: true, maximumAge: 20_000, timeout: 15_000 });
}

// ---------- horní lišta ----------
function renderTopbar() {
  const bar = $('#resbar');
  const r = ME.resources, b = ME.balances || {};
  const day = STATE.gameStart ? Math.floor((Date.now() - STATE.gameStart) / 86400_000) + 1 : 1;
  bar.innerHTML = `<span class="res day" data-rlabel="Herní den" data-day="1">Den ${day}</span>`
    + ['money', 'grain', 'fish', 'lumber', 'iron', 'coal', 'oil', 'gas']
    .map((k) => {
      const v = b[k] || 0;
      const trend = `<i class="${v >= 0 ? 'plus' : 'minus'}">${v >= 0 ? '+' : ''}${Math.abs(v) >= 10 ? Math.round(v) : v}</i>`;
      return `<span class="res" data-rlabel="${RES_LABEL[k]}" data-res="${k}">${RES_ICON[k]}${fmt(r[k] || 0)}${trend}</span>`;
    }).join('');
}

// ---------- mapa: tap ----------
map.onTap = (x, y) => {
  if (!pickMode) hideBubble();
  const prov = map.provinceAt(x, y);
  if (pickMode?.type === 'house') {
    if (prov && prov.kind === 'house') {
      gate.pickedHouse = prov;
      $('#g-house-name').textContent = `${prov.name}`;
      $('#g-register').disabled = false;
      map.select(prov.id, [x, y]);
      map.animateTo(prov.c[0], prov.c[1], Math.max(map.scale, 2.2));
    }
    return;
  }
  if (pickMode?.type === 'movetarget') {
    if (!prov) return;
    const pm = pickMode;
    endPick();
    api('/api/order/move', { armyId: pm.armyId, destId: prov.id, stance: pm.stance }).then((r) => {
      if (r.ok) toast(r.delayMin > 0 ? `Rozkaz přijat — příprava ${r.delayMin} min (na dálku).` : 'Rozkaz přijat — vyráží hned.');
      refreshState();
    });
    return;
  }
  // armáda (tečka s vojáky) má přednost
  const armyId = map.armyAt(x, y);
  if (armyId) {
    sheetArmy = armyId;
    sheetPoi = null;
    sheetProvince = null;
    map.selectedArmy = armyId;
    map.select(null, [x, y]);
    activeTab = 'map';
    updateTabs();
    renderSheet();
    return;
  }
  map.selectedArmy = null;
  sheetArmy = null;
  // města / kopce / škola — klikací vždy (i neobjevené: ukáže se info)
  const poi = findPoiAt(x, y);
  if (poi) {
    sheetPoi = poi;
    sheetProvince = null;
    map.select(null, [x, y]);
    activeTab = 'map';
    updateTabs();
    renderSheet();
    return;
  }
  sheetPoi = null;
  hideBubble();
  if (prov) {
    const st = STATE?.provinces.find((p) => p.id === prov.id);
    const mine = st && st.owner === ME?.effId;
    map.select(prov.id, [x, y]);
    if (mine) {
      // vlastní území: plný panel
      sheetProvince = prov.id;
      activeTab = 'map';
      updateTabs();
      renderSheet();
    } else {
      // cizí/volné území: malá bublina u místa ťuknutí
      sheetProvince = null;
      $('#sheet').classList.add('hidden');
      showBubble(prov, st, x, y);
    }
    return;
  }
  sheetProvince = null;
  map.select(null, null);
  renderSheet();
};

// ---------- bublina provincie (cizí/volné území) ----------
function hideBubble() { $('#pbubble')?.remove(); }
function showBubble(prov, st, wx, wy) {
  hideBubble();
  const el = document.createElement('div');
  el.id = 'pbubble';
  let html;
  if (!st || st.undiscovered) {
    html = `<b>Neprozkoumané území</b><p class="sub">Dojdi sem pěšky, nebo zdolej blízký kopec.</p>`;
  } else {
    const kindLabel = { house: 'Dům', field: 'Pole', meadow: 'Louka', forest: 'Les', pond: 'Rybník' }[prov.kind] || prov.kind;
    const hostile = !!st.owner;
    html = `<b>${prov.name}</b>
      <p class="sub">${kindLabel} · ${st.owner ? ownerName(st.owner) : 'volné území'}${st.owner ? ` · morálka ${st.morale} %` : ''}</p>
      <div class="chips"><span class="chip" data-rlabel="${RES_LABEL[prov.resource]}">${RES_ICON[prov.resource]}${RES_LABEL[prov.resource]}${prov.double ? ' 2×' : ''}</span>
      ${prov.kind === 'house' ? `<span class="chip" data-rlabel="Peníze (daně)">${RES_ICON.money}daně</span>` : ''}</div>`;
    if (st.fortress) html += `<p class="sub">Pevnost lvl ${st.fortress}</p>`;
    if (st.hidden) html += `<p class="sub">Posádka skrytá (pevnost)</p>`;
    else if (st.garrison?.length) html += st.garrison.map((g) => `<p class="sub">${ownerName(g.owner)}: ${g.size} jednotek</p>`).join('');
    if (STATE.battles.some((b) => b.provinceId === prov.id)) html += `<p class="sub" style="color:#C62828;font-weight:700">Probíhá bitva!</p>`;
    const idle = STATE.armies.filter((a) => !a.path && Object.values(a.units).reduce((s, v) => s + v, 0) > 0);
    if (idle.length) {
      html += `<div class="btn-row" style="margin-top:6px">`;
      for (const a of idle.slice(0, 2)) {
        const size = Object.values(a.units).reduce((s, v) => s + v, 0);
        html += `<button class="btn small ${hostile ? 'danger' : ''}" data-act="sendhere" data-army="${a.id}" data-dest="${prov.id}" data-stance="${hostile ? 'attack' : 'move'}">${hostile ? 'Útok' : 'Poslat'} (${size})</button>`;
      }
      html += `</div>`;
    }
  }
  el.innerHTML = html;
  document.body.appendChild(el);
  const px = map.sx(wx), py = map.sy(wy);
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(innerWidth - w - 8, px - w / 2)) + 'px';
  el.style.top = Math.max(8, py - h - 18 < 8 ? py + 14 : py - h - 18) + 'px';
  bindSheetActions(el);
}

// najdi POI do ~24 px na obrazovce od místa ťuknutí
function findPoiAt(wx, wy) {
  const maxPx = 26;
  let best = null, bestD = maxPx;
  const check = (x, y, obj) => {
    const d = Math.hypot((x - wx) * map.scale, (y - wy) * map.scale);
    if (d < bestD) { bestD = d; best = obj; }
  };
  if (MAPDATA.school) check(MAPDATA.school.x, MAPDATA.school.y, { type: 'school' });
  if (map.scale < 0.6) {
    for (const t of MAPDATA.pois.towns) check(t.x, t.y, { type: 'town', name: t.name });
  }
  if (map.scale < 0.2) {
    for (const p of MAPDATA.pois.peaks) check(p.x, p.y, { type: 'peak', name: p.name });
  }
  return best;
}

function startPick(mode, text) {
  pickMode = mode;
  $('#picktext').textContent = text;
  $('#pickbar').classList.remove('hidden');
  $('#sheet').classList.add('hidden');
}
function endPick() {
  pickMode = null;
  $('#pickbar').classList.add('hidden');
}
$('#pickcancel').onclick = endPick;

// ---------- záložky ----------
document.querySelectorAll('#tabs button').forEach((b) => {
  b.onclick = () => { activeTab = b.dataset.tab; hideBubble(); if (activeTab !== 'map') { sheetProvince = null; sheetPoi = null; sheetArmy = null; map.selected = null; map.selectedArmy = null; map.draw(); } updateTabs(); renderSheet(); };
});
function updateTabs() {
  let activeBtn = null;
  document.querySelectorAll('#tabs button').forEach((b) => {
    const on = b.dataset.tab === activeTab;
    b.classList.toggle('active', on);
    if (on) activeBtn = b;
  });
  // klouzající pilulka
  const pill = $('#tab-pill');
  if (pill && activeBtn) {
    const pad = 10;
    pill.style.left = (activeBtn.offsetLeft + pad) + 'px';
    pill.style.width = (activeBtn.offsetWidth - pad * 2) + 'px';
  }
}

// ---------- menu (tři čárky): žebříček / chat / diplomacie ----------
let drawerTab = 'board';
const allyPick = { symbol: 'swords', bg: '#1565C0' };
let lastChatSeen = 0;
let knownBoot = null;
$('#refresh-btn').onclick = async () => {
  const el = $('#refresh-btn');
  el.style.transform = 'rotate(360deg)';
  await refreshState();
  // nová verze hry na serveru? přenačti celou aplikaci
  try {
    const h = await (await fetch('/api/health')).json();
    if (knownBoot && h.boot !== knownBoot) { toast('Nová verze hry — načítám…'); setTimeout(() => location.reload(), 600); return; }
    knownBoot = h.boot;
  } catch { /* offline */ }
  toast('Aktualizováno.');
  setTimeout(() => { el.style.transform = ''; }, 400);
};
$('#menu-btn').onclick = () => {
  $('#drawer').classList.remove('hidden');
  $('#drawer-overlay').classList.remove('hidden');
  $('#menu-badge').classList.add('hidden');
  renderDrawer();
};
$('#drawer-overlay').onclick = closeDrawer;
function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#drawer-overlay').classList.add('hidden');
}
document.querySelectorAll('#drawer-tabs button').forEach((b) => {
  b.onclick = () => { drawerTab = b.dataset.d; renderDrawer(); };
});
$('#chat-send').onclick = sendChat;
$('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
async function sendChat() {
  const t = $('#chat-text').value.trim();
  if (!t) return;
  $('#chat-text').value = '';
  await api('/api/chat/send', { text: t, toId: $('#chat-to').value || null });
  refreshState();
}

function renderDrawer() {
  if ($('#drawer').classList.contains('hidden') || !STATE) return;
  document.querySelectorAll('#drawer-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.d === drawerTab));
  const c = $('#drawer-content');
  $('#chat-row').classList.toggle('hidden', drawerTab !== 'chat');
  let html = '';
  if (drawerTab === 'board') {
    const board = STATE.players.filter((p) => !p.teamWith)
      .sort((a, b) => (b.provinceCount - a.provinceCount) || (b.unitCount - a.unitCount));
    board.forEach((p, i) => {
      html += `<div class="row"><span><b>${i + 1}.</b> ${ownerDot(p.id)} ${p.display || p.name}</span>
        <span class="meta">${p.provinceCount} území · ${p.unitCount} vojáků</span></div>`;
    });
  } else if (drawerTab === 'chat') {
    // výběr příjemce (Všichni / soukromě)
    const sel = $('#chat-to');
    const prevVal = sel.value;
    sel.innerHTML = `<option value="">Všem</option>` + STATE.players
      .filter((p) => p.id !== ME.effId && !p.teamWith)
      .map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.value = prevVal || '';
    if (!STATE.chat?.length) html = '<p class="sub" style="margin-top:10px">Zatím žádné zprávy. Napiš první!</p>';
    for (const m of STATE.chat || []) {
      const priv = m.toId ? ` <span class="priv">soukromě → ${ownerName(m.toId)}</span>` : '';
      html += `<div class="chatmsg ${m.toId ? 'private' : ''}"><span class="who" style="color:${STATE.players.find((p) => p.id === m.playerId)?.color || '#888'}">${ownerName(m.playerId)}</span>${priv}<span class="when">${new Date(m.ts).toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' })}</span><br>${m.text.replace(/</g, '&lt;')}</div>`;
    }
    html += `<button class="btn ghost small" data-act="gototrade" style="margin-top:8px">Vytvořit obchodní nabídku</button>`;
    if (STATE.chat?.length) lastChatSeen = STATE.chat[STATE.chat.length - 1].id;
  } else if (drawerTab === 'diplo') {
    html += '<h3>Vztahy</h3>';
    for (const p of STATE.players.filter((p) => p.id !== ME.effId && !p.teamWith)) {
      const isAlly = STATE.alliance?.members.includes(p.id);
      const pactAct = STATE.pacts.some((x) => x.status === 'active' && (x.a === p.id || x.b === p.id));
      const offerFromThem = STATE.pacts.some((x) => x.status === 'offered' && x.a === p.id);
      const offerFromMe = STATE.pacts.some((x) => x.status === 'offered' && x.a === ME.effId && x.b === p.id);
      let rel = isAlly ? 'spojenec' : pactAct ? 'mír' : '—';
      html += `<div class="row"><span>${ownerDot(p.id)} ${p.name}<br><span class="meta">${rel}${offerFromMe ? ' · nabídka odeslána' : ''}</span></span><span>`;
      if (offerFromThem && !pactAct) html += `<button class="btn small" data-act="pactaccept" data-id="${p.id}">Přijmout mír</button>`;
      else if (pactAct) html += `<button class="btn small ghost" data-act="pactcancel" data-id="${p.id}">Vypovědět</button>`;
      else if (!isAlly && !offerFromMe) html += `<button class="btn small ghost" data-act="pactoffer" data-id="${p.id}">Nabídnout mír</button>`;
      html += `</span></div>`;
    }
    html += '<h3>Aliance</h3>';
    if (STATE.alliance) {
      html += `<div class="row"><span style="display:flex;align-items:center;gap:8px">${STATE.alliance.symbol ? allyBanner({ symbol: STATE.alliance.symbol, bg: STATE.alliance.bg }, 20) : ''}${STATE.alliance.name}</span><span class="meta">${STATE.alliance.members.map(ownerName).join(', ')}</span></div>
        <select id="ally-invite">${STATE.players.filter((p) => p.id !== ME.effId && !p.teamWith).map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
        <button class="btn" data-act="allyinvite">Pozvat do aliance</button>
        <button class="btn ghost" data-act="allyleave">Opustit alianci</button>`;
    } else {
      for (const inv of STATE.allianceInvites) {
        html += `<div class="row"><span>Pozvánka: ${inv.name}</span><button class="btn small" data-act="allyaccept" data-id="${inv.id}">Přijmout</button></div>`;
      }
      html += `<input id="ally-name" placeholder="Název aliance" maxlength="30">
        <p class="sub" style="margin-top:8px">Znak aliance:</p>
        <div class="ally-pick" id="ally-symbols">${Object.keys(ALLY_SYMBOLS).map((k) => `<button data-sym="${k}" class="${k === allyPick.symbol ? 'on' : ''}" style="background:${allyPick.bg}" title="${ALLY_LABEL[k]}">${ALLY_SYMBOLS[k]}</button>`).join('')}</div>
        <div class="ally-pick" id="ally-colors">${['#1565C0', '#C62828', '#2E7D32', '#6A1B9A', '#EF6C00', '#37474F'].map((c) => `<button data-bg="${c}" class="${c === allyPick.bg ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>
        <button class="btn" data-act="allycreate">Založit alianci (max 3 členové)</button>`;
    }
    html += `<p class="sub" style="margin-top:10px">Aliance (max 3) = spojenci: sdílí mapu, nemůžou na sebe útočit. Mír = jen pakt o neútočení.</p>`;
  }
  c.innerHTML = html;
  if (drawerTab === 'chat') c.scrollTop = c.scrollHeight;
  c.querySelectorAll('#ally-symbols button').forEach((b) => { b.onclick = () => { allyPick.symbol = b.dataset.sym; renderDrawer(); }; });
  c.querySelectorAll('#ally-colors button').forEach((b) => { b.onclick = () => { allyPick.bg = b.dataset.bg; renderDrawer(); }; });
  bindSheetActions(c);
}

// ---------- spodní panel ----------
function renderSheet() {
  if (!STATE) return;
  const sheet = $('#sheet'), content = $('#sheet-content');
  let html = '';
  if (activeTab === 'map') {
    if (sheetArmy) html = renderArmy(sheetArmy);
    else if (sheetPoi) html = renderPoi(sheetPoi);
    else if (sheetProvince) html = renderProvince(sheetProvince);
    else { sheet.classList.add('hidden'); return; }
    if (html === '') { sheet.classList.add('hidden'); return; }
  } else if (activeTab === 'armies') html = renderArmies();
  else if (activeTab === 'trade') html = renderTrade();
  else if (activeTab === 'trips') html = renderTrips();
  else if (activeTab === 'empire') html = renderEmpire();
  content.innerHTML = html;
  sheet.classList.remove('hidden');
  bindSheetActions(content);
}

function ownerName(id) {
  if (!id) return 'volné území';
  const p = STATE.players.find((p) => p.id === id);
  return p?.display || p?.name || '?';
}
function ownerDot(id) {
  const p = STATE.players.find((p) => p.id === id);
  if (p?.ally) return allyBanner(p.ally);
  return `<span class="owner-dot" style="background:${p?.color || '#8B877F'}"></span>`;
}

// cenovky se surovinami; červeně, co chybí
function costChips(cost) {
  return `<span class="chips">${Object.entries(cost).map(([r, v]) =>
    `<span class="chip ${(ME.resources[r] || 0) < v ? 'miss' : ''}" data-rlabel="${RES_LABEL[r]}">${RES_ICON[r]}${fmt(v)}</span>`).join('')}</span>`;
}

// malá bublina s názvem suroviny: na PC hover, na mobilu ťuknutí
const rtip = document.createElement('div');
rtip.id = 'rtip';
rtip.className = 'hidden';
document.body.appendChild(rtip);
let rtipTimer = null;
function showRtip(el, autohide) {
  const r = el.getBoundingClientRect();
  // v horní liště ukaž i rozpad: produkce vs. spotřeba za hodinu
  const flow = el.dataset.res && ME?.resFlow;
  if (el.dataset.day && STATE?.gameStart) {
    if (STATE.winner) {
      rtip.innerHTML = `<b>Partie skončila</b><br>Vítěz: ${STATE.winner}`;
    } else if (!RULES?.gameLengthDays) {
      rtip.innerHTML = `<b>Den ${Math.floor((Date.now() - STATE.gameStart) / 86400_000) + 1}</b><br>
        <span style="opacity:.75">bez časového limitu — vyhrává,<br>kdo ovládne ${Math.round((RULES?.victoryShare || 0.6) * 100)} % mapy</span>`;
    } else {
      const end = STATE.gameStart + RULES.gameLengthDays * 86400_000;
      const ms = Math.max(0, end - Date.now());
      const d = Math.floor(ms / 86400_000), h = Math.floor((ms % 86400_000) / 3600_000);
      rtip.innerHTML = `<b>Den ${Math.floor((Date.now() - STATE.gameStart) / 86400_000) + 1} z ${RULES.gameLengthDays}</b><br>
        konec partie za ${d} d ${h} h<br>
        <span style="opacity:.75">vyhrává, kdo má na konci nejvíc území,<br>nebo dřív ovládne ${Math.round(RULES.victoryShare * 100)} % mapy</span>`;
    }
  } else if (flow) {
    const k = el.dataset.res;
    const p = ME.resFlow.prod[k] || 0, c = ME.resFlow.cons[k] || 0;
    const n = Math.round((p - c) * 10) / 10;
    // rozpad podle zdrojů: z čeho příjem a za co výdaje
    const lines = Object.entries(ME.resFlow.src?.[k] || {})
      .sort((a, b) => b[1] - a[1])
      .map(([label, v]) => `<span style="color:${v >= 0 ? '#7CC47F' : '#FF8A80'}">${label} ${v >= 0 ? '+' : ''}${v}/h</span>`)
      .join('<br>');
    rtip.innerHTML = `<b>${el.dataset.rlabel}</b><br>${lines || '<span style="opacity:.7">žádný pohyb</span>'}<br><b>bilance ${n >= 0 ? '+' : ''}${n}/h</b>`;
  } else {
    rtip.textContent = el.dataset.rlabel;
  }
  rtip.classList.remove('hidden');
  const w = rtip.offsetWidth;
  rtip.style.left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + 'px';
  rtip.style.top = (r.top - 32 < 6 ? r.bottom + 6 : r.top - 32) + 'px';
  clearTimeout(rtipTimer);
  if (autohide) rtipTimer = setTimeout(() => rtip.classList.add('hidden'), flow || el.dataset.day ? 3500 : 1400);
}
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-rlabel]');
  if (el) showRtip(el, false);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('[data-rlabel]')) { clearTimeout(rtipTimer); rtip.classList.add('hidden'); }
});
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-rlabel]');
  if (el && !e.target.closest('button')) showRtip(el, true);
});
function canPay(cost) { return Object.entries(cost || {}).every(([r, v]) => (ME.resources[r] || 0) >= v); }
function natureSetFor(prov) {
  if (!prov || prov.kind === 'house') return null;
  if (prov.kind === 'pond') return 'pond';
  if (prov.kind === 'forest') return 'forest';
  if (prov.resource === 'oil') return 'oil';
  if (prov.resource === 'gas') return 'gas';
  if (['iron', 'coal'].includes(prov.resource)) return 'mine';
  if (prov.kind === 'field' || prov.kind === 'meadow') return 'field';
  return null;
}
// multiplikátor produkce z vylepšení (pro zobrazení)
function upgradeMult(prov, st) {
  const set = natureSetFor(prov);
  if (!set || !st?.upgrades) return 1;
  let m = 1;
  for (const def of RULES.natureUpgrades[set]) m += def.bonus * (st.upgrades[def.key] || 0);
  return m;
}
function upgLabel(key, prov) {
  const set = natureSetFor(prov);
  const def = set ? RULES.natureUpgrades[set].find((d) => d.key === key) : null;
  return def?.label || key;
}

function renderProvince(id) {
  const prov = MAPDATA.provinces.find((p) => p.id === id);
  const st = STATE.provinces.find((p) => p.id === id);
  if (!prov || !st) return '';
  if (st.undiscovered) {
    return `<h2>Neprozkoumané území</h2>
      <p class="sub">Tohle místo jsi ještě neobjevil. Dojdi tam pěšky, nebo zdolej blízký kopec — z vrcholu se odkryje celé okolí.</p>`;
  }
  const mine = st.owner === ME.effId;
  const kindLabel = { house: 'Dům', field: 'Pole', meadow: 'Louka', forest: 'Les', pond: 'Rybník' }[prov.kind] || prov.kind;
  let html = `<h2>${ownerDot(st.owner)} ${prov.name}</h2>
    <div class="sub">${kindLabel} · ${st.owner ? ownerName(st.owner) : 'volné území'}</div>`;

  if (st.owner) {
    // morálka s barevným pruhem
    const mc = st.morale >= 60 ? '#2E7D32' : st.morale >= 35 ? '#EF6C00' : '#C62828';
    html += `<div class="row"><span>Morálka</span><b style="color:${mc}">${st.morale} %</b></div>
      <div class="bar"><i style="width:${st.morale}%;background:${mc}"></i></div>`;
    // produkce (dům: surovina + daně, jako v Supremacy)
    if (prov.kind === 'house') {
      const resH = Math.round(RULES.prodPerH * st.morale / 100);
      const monH = Math.round(RULES.houseMoneyPerH * st.morale / 100);
      html += `<div class="row"><span>Produkce</span><span class="chips">
        <span class="chip" data-rlabel="${RES_LABEL[prov.resource]}">${RES_ICON[prov.resource]}+${resH}/h</span>
        <span class="chip" data-rlabel="Peníze (daně)">${RES_ICON.money}+${monH}/h</span></span></div>`;
    } else {
      const mult = upgradeMult(prov, st);
      const perH = Math.round(RULES.prodPerH * (prov.double ? 2 : 1) * (st.morale / 100) * mult);
      html += `<div class="row"><span>Produkce</span><span class="chips"><span class="chip" data-rlabel="${RES_LABEL[prov.resource]}">${RES_ICON[prov.resource]}+${perH}/h${prov.double ? ' (2×)' : ''}${mult > 1 ? ` (vylepšení ×${mult.toFixed(2)})` : ''}</span></span></div>`;
    }
    if (st.fortress) html += `<div class="row"><span>Pevnost</span><b>lvl ${st.fortress} (−${RULES.fortress[st.fortress].dmgReduction * 100} % poškození)</b></div>`;
    if (st.barracks) html += `<div class="row"><span>Kasárna</span><b>lvl ${st.barracks} (+${RULES.barracks[st.barracks].recruitBonus * 100} % verbování)</b></div>`;
  } else {
    html += `<div class="row"><span>Produkce po obsazení</span><span class="chips"><span class="chip">${RES_ICON[prov.resource]}${RES_LABEL[prov.resource]}${prov.double ? ' 2×' : ''}</span>${prov.kind === 'house' ? `<span class="chip">${RES_ICON.money}daně</span>` : ''}</span></div>`;
  }

  const battle = STATE.battles.find((b) => b.provinceId === id);
  if (battle) {
    html += `<div class="warnbox">Probíhá bitva!</div>`;
    html += renderBattle(battle);
  }

  // posádka
  if (st.hidden) html += `<div class="row"><span>Posádka</span><span class="meta">skrytá (pevnost)</span></div>`;
  else if (st.garrison?.length) {
    for (const g of st.garrison) html += `<div class="row"><span>${ownerDot(g.owner)} ${ownerName(g.owner)}</span><b>${g.size} jednotek</b></div>`;
  }

  if (mine) {
    // stavební slot (jako v Supremacy: jeden slot na stavbu)
    html += `<h3>Stavba</h3>`;
    if (st.build) {
      const buildLabel = st.build.kind === 'fortress' ? 'Pevnost lvl ' + (st.fortress + 1)
        : st.build.kind === 'barracks' ? 'Kasárna lvl ' + (st.barracks + 1)
        : String(st.build.kind).startsWith('upg:') ? 'Vylepšení: ' + upgLabel(st.build.kind.slice(4), prov)
        : st.build.kind;
      html += `<div class="prod"><div><b>${buildLabel}</b><br><span class="meta">staví se</span></div><b>${timeLeft(st.build.until)}</b></div>`;
    } else {
      let any = false;
      if (st.fortress < 5) {
        const f = RULES.fortress[st.fortress + 1];
        any = true;
        html += `<div class="prod"><div><b>Pevnost lvl ${st.fortress + 1}</b>${costChips(f.cost)}</div>
          <div class="prod-right"><span class="meta">${f.hours} h</span><button class="btn small" data-act="build" data-kind="fortress" data-prov="${id}" ${canPay(f.cost) ? '' : 'disabled'}>Stavět</button></div></div>`;
      }
      if (prov.kind === 'house' && st.barracks < 2) {
        const b = RULES.barracks[st.barracks + 1];
        any = true;
        html += `<div class="prod"><div><b>Kasárna lvl ${st.barracks + 1}</b>${costChips(b.cost)}</div>
          <div class="prod-right"><span class="meta">${b.hours} h</span><button class="btn small" data-act="build" data-kind="barracks" data-prov="${id}" ${canPay(b.cost) ? '' : 'disabled'}>Stavět</button></div></div>`;
      }
      if (!any) html += `<p class="sub">Vše postaveno na maximum.</p>`;
    }

    // vylepšení přírodního území (farmáři, kombajn, rybáři, dřevorubci…)
    const upgSet = natureSetFor(prov);
    if (upgSet) {
      html += `<h3>Vylepšení</h3>`;
      const ups = st.upgrades || {};
      const busy = !!st.build;
      for (const def of RULES.natureUpgrades[upgSet]) {
        const lvl = ups[def.key] || 0;
        const atMax = lvl >= def.max;
        const needsMet = !def.needs || (ups[def.needs[0]] || 0) >= def.needs[1];
        const needsDef = def.needs ? RULES.natureUpgrades[upgSet].find((d) => d.key === def.needs[0]) : null;
        const cost = atMax ? null : Object.fromEntries(Object.entries(def.costBase).map(([r, v]) => [r, v * (def.max > 1 ? lvl + 1 : 1)]));
        const upkeep = def.upkeepDayBase
          ? Object.entries(def.upkeepDayBase).map(([r, v]) => `${v * Math.max(1, lvl)} ${RES_LABEL[r]}/den`).join(', ')
          : null;
        html += `<div class="prod ${!needsMet ? 'locked' : ''}">${IMG(UPG_IMG[def.key])}<div style="flex:1">
          <b>${def.label}</b> <span class="meta" style="display:inline">${lvl}/${def.max} · +${Math.round(def.bonus * 100)} %${def.max > 1 ? '/úroveň' : ''}${def.morale ? ` · +${def.morale} morálka` : ''}</span>
          ${atMax ? '' : costChips(cost)}
          ${upkeep ? `<span class="meta">náklady: ${upkeep}</span>` : ''}
          ${!needsMet ? `<span class="meta">potřebuje: ${needsDef?.label} úroveň ${def.needs[1]}</span>` : ''}
        </div>
        <div class="prod-right">${atMax ? '<b>MAX</b>' : `<span class="meta">${def.hours} h</span>
          <button class="btn small" data-act="upgrade" data-key="${def.key}" data-prov="${id}" ${busy || !needsMet || !canPay(cost) ? 'disabled' : ''}>${lvl ? 'Vylepšit' : 'Pořídit'}</button>`}</div></div>`;
      }
    }

    if (prov.kind === 'house') {
      // automatické verbování pěchoty
      html += `<h3>Verbování</h3>
        <div class="prod"><div><b>Pěchota</b><br><span class="meta">verbuje se automaticky${st.barracks ? ` (kasárna +${RULES.barracks[st.barracks].recruitBonus * 100} %)` : ''}</span></div>
        <div style="min-width:90px"><div class="bar"><i style="width:${st.recruitProgress || 0}%"></i></div><span class="meta">${st.recruitProgress || 0} %</span></div></div>`;
      // výroba jednotek
      html += `<h3>Výroba jednotek</h3>`;
      if (st.unit) {
        html += `<div class="prod"><div><b>${UNITS[st.unit.kind].label}</b><br><span class="meta">vyrábí se</span></div><b>${timeLeft(st.unit.until)}</b></div>`;
      } else {
        for (const [k, u] of Object.entries(RULES.units)) {
          if (k === 'infantry') continue;
          const locked = ME.education < u.edu;
          const noBarracks = u.needs === 'barracks' && !st.barracks;
          const affordable = canPay(u.cost);
          html += `<div class="prod ${locked ? 'locked' : ''}">${IMG(UNIT_IMG[k])}<div style="flex:1"><b>${u.label}</b>${costChips(u.cost)}
            ${locked ? `<span class="meta">potřebuje vzdělání: ${EDU[u.edu - 1]}</span>` : noBarracks ? '<span class="meta">potřebuje kasárna</span>' : ''}</div>
            <div class="prod-right"><span class="meta">${u.time} h</span><button class="btn small" data-act="recruit" data-kind="${k}" data-prov="${id}" ${locked || noBarracks || !affordable ? 'disabled' : ''}>Vyrobit</button></div></div>`;
        }
      }
    }

    // armády tady
    const myArmies = STATE.armies.filter((a) => a.provinceId === id && !a.path);
    for (const a of myArmies) {
      const size = Object.values(a.units).reduce((s, v) => s + v, 0);
      if (!size) continue;
      html += `<h3>Tvoje armáda (${size})</h3>`;
      html += `<div class="sub">${Object.entries(a.units).filter(([, v]) => v > 0).map(([k, v]) => `${v}× ${UNITS[k].label}`).join(', ')} · morálka ${a.morale} %</div>`;
      html += `<div class="btn-row">
        <button class="btn small" data-act="move" data-army="${a.id}">Přesun</button>
        <button class="btn small danger" data-act="attackmove" data-army="${a.id}">Útok</button>
        <button class="btn small ghost" data-act="split" data-army="${a.id}">Rozdělit</button>
      </div>`;
    }
  } else if (st.owner || prov.kind !== 'house') {
    const hostile = !!st.owner;
    html += `<p class="sub" style="margin-top:10px">${hostile ? 'Cizí území.' : 'Volné území — kdo ho obsadí první, ten ho má.'}</p>`;
    // rychlá akce: pošli sem některou svou stojící armádu (jako útok/obsazení)
    const idle = STATE.armies.filter((a) => !a.path && Object.values(a.units).reduce((s, v) => s + v, 0) > 0);
    if (idle.length) {
      html += `<h3>${hostile ? 'Zaútočit' : 'Obsadit'}</h3>`;
      for (const a of idle.slice(0, 4)) {
        const from = MAPDATA.provinces.find((p) => p.id === a.provinceId)?.name || '?';
        const size = Object.values(a.units).reduce((s, v) => s + v, 0);
        html += `<div class="prod"><div><b>Armáda (${size})</b><br><span class="meta">stojí: ${from}</span></div>
          <button class="btn small ${hostile ? 'danger' : ''}" data-act="sendhere" data-army="${a.id}" data-dest="${id}" data-stance="${hostile ? 'attack' : 'move'}">${hostile ? 'Útok' : 'Poslat'}</button></div>`;
      }
    } else {
      html += `<p class="sub">Nemáš žádnou volnou armádu.</p>`;
    }
  }
  return html;
}

function renderPoi(poi) {
  if (poi.type === 'school') {
    let html = `<h2>Škola Čichtice</h2><div class="sub">Dům čp. 91 · vzdělání odemyká lepší jednotky</div>`;
    if (ME.eduCourse) html += `<div class="row"><span>Kurz: ${EDU[ME.eduCourse.level - 1]}</span><b>${timeLeft(ME.eduCourse.until)}</b></div>`;
    else if (ME.education >= 5) html += `<p class="sub">Máš nejvyšší vzdělání.</p>`;
    else {
      const next = RULES.education[ME.education];
      html += `<div class="row"><span>Tvoje úroveň</span><b>${ME.education} / 5</b></div>
      <div class="prod"><div><b>${next.label}</b>${costChips(next.cost)}<span class="meta">odemkne: ${UNITS[next.unlocks].label}</span></div>
      <div class="prod-right"><span class="meta">${next.hours} h</span><button class="btn small" data-act="edustart">Zapsat</button></div></div>
      <p class="sub">Kurz zapíšeš, jen když ke škole fyzicky dojdeš.</p>`;
    }
    return html;
  }
  const isTown = poi.type === 'town';
  const data = isTown
    ? MAPDATA.pois.towns.find((t) => t.name === poi.name)
    : MAPDATA.pois.peaks.find((p) => p.name === poi.name);
  if (!data) return '';
  const visited = STATE.visits.includes(`${poi.type}:${poi.name}`);
  let html = `<h2>${data.name}</h2>
    <div class="sub">${isTown ? (data.city ? 'Město' : 'Městečko') : (data.tower ? 'Rozhledna' : 'Kopec')} · ${data.km} km od Čichtic${!isTown && data.ele ? ` · ${data.ele} m n. m.` : ''}</div>`;
  if (isTown) {
    html += `<div class="row"><span>Obchodní kurz</span><b>×${(1 + Math.min(data.km, 90) / 40).toFixed(1)}</b></div>`;
    if (visited) {
      html += `<p class="sub">Objeveno — můžeš obchodovat.</p><button class="btn" data-act="towntrade" data-town="${data.name}">Obchodovat</button>`;
    } else {
      html += `<p class="sub">Ještě neobjeveno. Vyraz na výpravu (záložka Výpravy) a dojdi sem — odemkneš obchod, dostaneš peníze a odznak. Čím dál město, tím výhodnější ceny.</p>`;
    }
  } else {
    html += visited
      ? `<p class="sub">Zdoláno. Kopce jsou pro všechny — nedají se dobýt.</p>`
      : `<p class="sub">Ještě nezdoláno. Vyraz na výpravu (záložka Výpravy) a dojdi/dojeď sem — na vrcholu dostaneš suroviny, možná i vojáky, a počítá se do odznaků (3, 10, 25 kopců).</p>`;
  }
  return html;
}

// karta armády ve stylu Supremacy: akční lišta + jednotky + stav
function renderArmy(id) {
  const a = STATE.armies.find((x) => x.id === id);
  if (!a) { sheetArmy = null; map.selectedArmy = null; return ''; }
  const provName = (pid) => MAPDATA.provinces.find((p) => p.id === pid)?.name || '?';
  const size = Object.values(a.units).reduce((s, v) => s + v, 0);
  // stav + celkový odhad času do cíle
  let status = 'Stojí — ' + provName(a.provinceId);
  let etaTotal = null;
  if (a.departAt && a.departAt > Date.now()) {
    status = `Příprava rozkazu (vyrazí za ${timeLeft(a.departAt)})`;
  }
  if (a.path?.length) {
    const dest = a.path[a.path.length - 1];
    status = `Pochoduje: ${provName(dest)}`;
    // odhad: zbytek aktuálního úseku + další úseky dle nejpomalejší jednotky
    const speed = Math.min(...Object.entries(a.units).filter(([, v]) => v > 0).map(([k]) => RULES.units[k].speed));
    let ms = a.nextArrive ? Math.max(0, a.nextArrive - Date.now()) : 0;
    let cur = a.provinceId;
    const hops = a.nextArrive ? a.path.slice(1) : a.path;
    if (a.nextArrive) cur = a.path[0];
    for (const n of hops) {
      ms += (routeLen(cur, n) / speed) * 3600_000;
      cur = n;
    }
    etaTotal = Date.now() + ms;
  }
  let html = `<h2>${ownerDot(ME.effId)} Armáda (${size})</h2>
    <div class="sub">${status}${etaTotal ? ` · celkem ${timeLeft(etaTotal)}` : ''}</div>`;
  if (etaTotal) html += `<p class="sub">Odhad bez zrychlení — když půjdeš fyzicky s nimi nebo dojdeš do cíle, jdou 4× rychleji.</p>`;
  // akční lišta jako v Supremacy
  html += `<div class="btn-row" style="flex-wrap:wrap">`;
  if (!a.path) {
    html += `<button class="btn small" data-act="move" data-army="${a.id}">Přesun</button>
      <button class="btn small danger" data-act="attackmove" data-army="${a.id}">Útok</button>
      <button class="btn small ghost" data-act="split" data-army="${a.id}">Rozdělit</button>`;
    const others = STATE.armies.filter((x) => x.id !== a.id && !x.path && x.provinceId === a.provinceId);
    if (others.length) html += `<button class="btn small ghost" data-act="merge" data-army="${a.id}">Sloučit (${others.length + 1})</button>`;
  } else {
    html += `<button class="btn small danger" data-act="cancelorder" data-army="${a.id}">Zrušit rozkaz</button>`;
  }
  html += `</div>`;
  // jednotky
  html += '<h3>Jednotky</h3>';
  for (const [k, v] of Object.entries(a.units)) {
    if (v <= 0) continue;
    html += `<div class="row"><span style="display:flex;align-items:center;gap:8px">${IMG(UNIT_IMG[k], 26)}${UNITS[k].label}</span><b>${v}×</b></div>`;
  }
  html += `<div class="row"><span>Morálka</span><b>${a.morale} %</b></div>
    <div class="bar"><i style="width:${a.morale}%"></i></div>`;
  const speed = size ? Math.min(...Object.entries(a.units).filter(([, v]) => v > 0).map(([k]) => RULES.units[k].speed)) : 0;
  const strength = Object.entries(a.units).reduce((s, [k, v]) => s + RULES.units[k].atk * v, 0);
  html += `<div class="row"><span>Síla (útok)</span><b>${strength.toFixed(1)}</b></div>
    <div class="row"><span>Rychlost</span><b>${speed} m/h</b></div>`;
  // probíhající bitva v místě armády
  const battle = STATE.battles.find((b) => b.provinceId === a.provinceId);
  if (battle && !a.path) html += renderBattle(battle);
  return html;
}

function renderBattle(battle) {
  let html = `<h3 style="color:#C62828">Bitva — ${MAPDATA.provinces.find((p) => p.id === battle.provinceId)?.name || ''}</h3>`;
  if (battle.sides) {
    html += `<div class="row"><span>Obránci</span><span></span></div>`;
    for (const d of battle.sides.defenders) html += `<div class="row"><span>${ownerDot(d.owner)} ${ownerName(d.owner)}</span><b>${d.size} jednotek · ${d.morale} %</b></div>`;
    html += `<div class="row"><span>Útočníci</span><span></span></div>`;
    for (const d of battle.sides.attackers) html += `<div class="row"><span>${ownerDot(d.owner)} ${ownerName(d.owner)}</span><b>${d.size} jednotek · ${d.morale} %</b></div>`;
  }
  html += `<p class="sub">Kolo boje každých 20 minut. Pošli posily, dokud bitva běží.</p>`;
  return html;
}

function routeLen(aId, bId) {
  const key = aId < bId ? `${aId}-${bId}` : `${bId}-${aId}`;
  const pts = MAPDATA.routes?.[key];
  if (!pts) {
    const a = MAPDATA.provinces.find((p) => p.id === aId), b = MAPDATA.provinces.find((p) => p.id === bId);
    return a && b ? Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) : 0;
  }
  let l = 0;
  for (let i = 0; i < pts.length - 1; i++) l += Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]);
  return l;
}

function renderArmies() {
  let html = '<h2>Armády</h2>';
  const provName = (pid) => MAPDATA.provinces.find((p) => p.id === pid)?.name || '?';
  if (!STATE.armies.length) html += '<p class="sub">Zatím žádné armády. Pěchota se verbuje sama u tvých domů.</p>';
  for (const a of STATE.armies) {
    const size = Object.values(a.units).reduce((s, v) => s + v, 0);
    if (!size) continue;
    const units = Object.entries(a.units).filter(([, v]) => v > 0).map(([k, v]) => `${v}× ${UNITS[k].label}`).join(', ');
    let status;
    if (a.departAt && a.departAt > Date.now()) status = `příprava, vyrazí za ${timeLeft(a.departAt)}`;
    else if (a.path?.length) status = `na cestě do ${provName(a.path[a.path.length - 1])}, další uzel za ${a.nextArrive ? timeLeft(a.nextArrive) : '…'}`;
    else status = `stojí: ${provName(a.provinceId)}`;
    html += `<div class="row"><div><b>${units}</b><br><span class="meta">${status} · morálka ${a.morale} %</span></div>
      <div>${a.path ? `<button class="btn small ghost" data-act="cancelorder" data-army="${a.id}">Zrušit</button>` : `<button class="btn small ghost" data-act="goto" data-prov="${a.provinceId}">Ukázat</button>`}</div></div>`;
  }
  return html;
}

function renderTrade() {
  let html = '<h2>Obchod</h2>';
  // nabídky hráčů
  html += '<h3>Nabídky mezi hráči</h3>';
  const open = STATE.trades;
  if (!open.length) html += '<p class="sub">Žádné otevřené nabídky.</p>';
  for (const t of open) {
    const gv = Object.entries(t.give).map(([k, v]) => `${v} ${RES_LABEL[k]}`).join(' + ');
    const wt = Object.entries(t.want).map(([k, v]) => `${v} ${RES_LABEL[k]}`).join(' + ');
    const mine = t.fromId === ME.effId;
    html += `<div class="row"><div><b>${ownerName(t.fromId)}</b> dává ${gv}<br><span class="meta">chce ${wt}${t.toId ? ` · pro: ${ownerName(t.toId)}` : ''}</span></div>
      <div>${mine ? `<button class="btn small ghost" data-act="tradecancel" data-id="${t.id}">Zrušit</button>` : `<button class="btn small" data-act="tradeaccept" data-id="${t.id}">Přijmout</button>`}</div></div>`;
  }
  html += `<h3>Nová nabídka</h3>
  <div class="inline"><select id="tr-give-res">${Object.keys(RES_LABEL).map((k) => `<option value="${k}">${RES_LABEL[k]}</option>`).join('')}</select>
  <input id="tr-give-n" type="number" placeholder="dávám" min="1"></div>
  <div class="inline"><select id="tr-want-res">${Object.keys(RES_LABEL).map((k) => `<option value="${k}">${RES_LABEL[k]}</option>`).join('')}</select>
  <input id="tr-want-n" type="number" placeholder="chci" min="1"></div>
  <select id="tr-to"><option value="">Veřejná nabídka (kdokoli)</option>${STATE.players.filter((p) => p.id !== ME.effId && !p.teamWith).map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
  <button class="btn" data-act="tradecreate">Vystavit nabídku</button>`;

  // města
  const visitedTowns = STATE.visits.filter((v) => v.startsWith('town:')).map((v) => v.slice(5));
  html += '<h3>Města (NPC obchod)</h3>';
  if (!visitedTowns.length) html += '<p class="sub">Zatím jsi neobjevil žádné město — dojdi tam na výpravě. Čím dál město, tím lepší ceny.</p>';
  for (const name of visitedTowns) {
    const t = MAPDATA.pois.towns.find((x) => x.name === name);
    if (!t) continue;
    const myShop = STATE.shops.find((s) => s.town === name && s.playerId === ME.effId);
    html += `<div class="row"><div><b>${name}</b> <span class="meta">${t.km} km · kurz ×${(1 + Math.min(t.km, 90) / 40).toFixed(1)}</span>
      ${myShop ? `<br><span class="meta">Tvůj obchod: ${RES_LABEL[myShop.res]}, sklad ${myShop.stock}, vyděláno ${myShop.earned}</span>` : ''}</div>
      <button class="btn small ghost" data-act="towntrade" data-town="${name}">Obchodovat</button></div>`;
  }
  return html;
}

function renderTrips() {
  let html = '<h2>Výpravy</h2>';
  if (STATE.trip) {
    html += `<div class="row"><div><b>Výprava běží</b> (${STATE.trip.kind === 'bike' ? 'kolo' : 'pěšky'})<br>
      <span class="meta">od ${new Date(STATE.trip.startTs).toLocaleTimeString('cs')} — dojdi na kopec nebo do města a odměna přijde sama</span></div>
      <button class="btn small ghost" data-act="tripstop">Ukončit</button></div>`;
  } else {
    html += `<p class="sub">Vyraž pěšky nebo na kole na kopec či do města. Na místě dostaneš suroviny, vojáky a odznaky. Kopce jsou pro všechny — nedají se dobýt.</p>
    <div class="btn-row">
      <button class="btn" data-act="tripstart" data-kind="walk">Jdu pěšky</button>
      <button class="btn ghost" data-act="tripstart" data-kind="bike">Jedu na kole</button>
    </div>`;
  }
  const visited = new Set(STATE.visits);
  const peaks = MAPDATA.pois.peaks.slice(0, 25);
  html += '<h3>Nejbližší kopce</h3>';
  for (const p of peaks.slice(0, 10)) {
    const done = visited.has('peak:' + p.name);
    html += `<div class="row"><span>${p.name} <span class="meta">${p.ele ? p.ele + ' m n. m. · ' : ''}${p.km} km</span></span><b>${done ? 'zdoláno' : ''}</b></div>`;
  }
  html += '<h3>Nejbližší města</h3>';
  for (const t of MAPDATA.pois.towns.slice(0, 8)) {
    const done = visited.has('town:' + t.name);
    html += `<div class="row"><span>${t.name} <span class="meta">${t.km} km</span></span><b>${done ? 'objeveno' : ''}</b></div>`;
  }
  const peakCount = STATE.visits.filter((v) => v.startsWith('peak:')).length;
  html += `<h3>Odznaky</h3><p class="sub">Zdolané kopce: ${peakCount} (odměny za 3, 10 a 25)</p>`;
  for (const b of STATE.badges) html += `<div class="row"><span>${b.badge}</span><span class="meta">${new Date(b.ts).toLocaleDateString('cs')}</span></div>`;
  return html;
}

function renderEmpire() {
  const my = STATE.players.find((p) => p.id === ME.effId);
  let html = `<h2>${ownerDot(ME.effId)} ${my?.name || ME.name}</h2>`;
  html += `<div class="row"><span>Provincie</span><b>${my?.provinceCount || 0}</b></div>`;
  if (STATE.winner) html += `<div class="row"><b>Vítěz hry: ${STATE.winner}</b></div>`;
  // vzdělání
  html += '<h3>Vzdělání (škola)</h3>';
  if (ME.eduCourse) {
    html += `<div class="row"><span>Kurz: ${EDU[ME.eduCourse.level - 1]}</span><b>${timeLeft(ME.eduCourse.until)}</b></div>`;
  } else if (ME.education >= 5) {
    html += '<p class="sub">Máš nejvyšší vzdělání.</p>';
  } else {
    html += `<div class="row"><span>Aktuální úroveň</span><b>${ME.education} / 5${ME.education ? ' — ' + EDU[ME.education - 1] : ''}</b></div>
    <p class="sub">Další: ${EDU[ME.education]} — zapíšeš fyzicky u školy (fialový bod na mapě).</p>
    <button class="btn" data-act="edustart">Zapsat kurz (jsem u školy)</button>`;
  }
  html += `<p class="sub" style="margin-top:8px">Aliance, mír a žebříček najdeš v menu (tři čárky vpravo nahoře).</p>`;
  // události
  html += '<h3>Události</h3>';
  for (const e of STATE.events.slice(0, 25)) {
    html += `<div class="row"><span style="font-size:13px">${e.text}</span><span class="meta">${new Date(e.ts).toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' })}</span></div>`;
  }
  html += `<button class="btn ghost" data-act="feedback" style="margin-top:12px">Zpětná vazba — nahlásit chybu / nápad</button>`;
  if (ME.isAdmin) html += `<button class="btn" data-act="admin" style="margin-top:6px">Admin konzole</button>`;
  html += `<div class="btn-row" style="margin-top:14px">
    <button class="btn ghost small" data-act="tutorial">Tutoriál</button>
    <button class="btn ghost small" data-act="fullscreen">Celá obrazovka</button>
    <button class="btn ghost small" data-act="logout">Odhlásit se</button>
  </div>`;
  return html;
}

// ---------- akce v panelu ----------
function bindSheetActions(root) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = async () => {
      const act = el.dataset.act;
      if (act === 'build') { await api('/api/build', { provinceId: +el.dataset.prov, kind: el.dataset.kind }); refreshState(); }
      if (act === 'recruit') { await api('/api/recruit', { provinceId: +el.dataset.prov, kind: el.dataset.kind }); refreshState(); }
      if (act === 'upgrade') { const r = await api('/api/upgrade', { provinceId: +el.dataset.prov, key: el.dataset.key }); if (r.ok) refreshState(); }
      if (act === 'move') startPick({ type: 'movetarget', armyId: +el.dataset.army, stance: 'move' }, 'Ťukni na cíl přesunu');
      if (act === 'attackmove') startPick({ type: 'movetarget', armyId: +el.dataset.army, stance: 'attack' }, 'Ťukni na cíl útoku');
      if (act === 'split') {
        const n = prompt('Kolik pěchoty oddělit do nové armády?');
        if (n > 0) { await api('/api/army/split', { armyId: +el.dataset.army, units: { infantry: +n } }); refreshState(); }
      }
      if (act === 'cancelorder') { const r = await api('/api/order/cancel', { armyId: +el.dataset.army }); if (r.ok) refreshState(); }
      if (act === 'merge') { const r = await api('/api/army/merge', { armyId: +el.dataset.army }); if (r.ok) { toast('Armády sloučeny.'); refreshState(); } }
      if (act === 'sendhere') {
        const r = await api('/api/order/move', { armyId: +el.dataset.army, destId: +el.dataset.dest, stance: el.dataset.stance });
        if (r.ok) { toast(r.delayMin > 0 ? `Rozkaz přijat — příprava ${r.delayMin} min (na dálku).` : 'Rozkaz přijat — vyráží hned.'); refreshState(); }
      }
      if (act === 'goto') {
        const prov = MAPDATA.provinces.find((p) => p.id === +el.dataset.prov);
        if (prov) { map.animateTo(prov.c[0], prov.c[1], Math.max(map.scale, 0.9), 600); activeTab = 'map'; sheetProvince = prov.id; map.select(prov.id); updateTabs(); renderSheet(); }
      }
      if (act === 'tradecreate') {
        const give = { [$('#tr-give-res').value]: +$('#tr-give-n').value };
        const want = { [$('#tr-want-res').value]: +$('#tr-want-n').value };
        const toId = $('#tr-to').value || null;
        const r = await api('/api/trade/create', { toId, give, want });
        if (r.ok) { toast('Nabídka vystavena.'); refreshState(); }
      }
      if (act === 'tradeaccept') { const r = await api('/api/trade/accept', { id: +el.dataset.id }); if (r.ok) toast('Obchod proběhl.'); refreshState(); }
      if (act === 'tradecancel') { await api('/api/trade/cancel', { id: +el.dataset.id }); refreshState(); }
      if (act === 'towntrade') showTownTrade(el.dataset.town);
      if (act === 'tripstart') { const r = await api('/api/trip/start', { kind: el.dataset.kind }); if (r.ok) toast('Výprava zahájena. Šťastnou cestu!'); refreshState(); }
      if (act === 'tripstop') { await api('/api/trip/stop', {}); refreshState(); }
      if (act === 'edustart') { const r = await api('/api/education/start', {}); if (r.ok) refreshState(); }
      if (act === 'allycreate') { const r = await api('/api/alliance/create', { name: $('#ally-name').value, symbol: allyPick.symbol, bg: allyPick.bg }); if (r.ok) refreshState(); }
      if (act === 'allyinvite') { const r = await api('/api/alliance/invite', { playerId: +$('#ally-invite').value }); if (r.ok) toast('Pozvánka odeslána.'); }
      if (act === 'allyaccept') { const r = await api('/api/alliance/accept', { allianceId: +el.dataset.id }); if (r.ok) refreshState(); }
      if (act === 'allyleave') { await api('/api/alliance/leave', {}); refreshState(); }
      if (act === 'pactoffer') { const r = await api('/api/pact/offer', { playerId: +el.dataset.id }); if (r.ok) { toast('Nabídka míru odeslána.'); refreshState(); } }
      if (act === 'pactaccept') { const r = await api('/api/pact/accept', { playerId: +el.dataset.id }); if (r.ok) refreshState(); }
      if (act === 'pactcancel') { if (confirm('Opravdu vypovědět mír?')) { const r = await api('/api/pact/cancel', { playerId: +el.dataset.id }); if (r.ok) refreshState(); } }
      if (act === 'gototrade') { closeDrawer(); activeTab = 'trade'; updateTabs(); renderSheet(); }
      if (act === 'logout') { await api('/api/logout', {}); location.reload(); }
      if (act === 'tutorial') showTutorial(0);
      if (act === 'admin') renderAdmin();
      if (act === 'feedback') $('#dlg-feedback').classList.remove('hidden');
      if (act === 'admin-refresh') renderAdmin();
      if (act === 'admin-color') {
        const color = prompt(`Nová barva hráče ${el.dataset.name} (#RRGGBB):\nmodrá #1565C0 · zelená #2E7D32 · fialová #6A1B9A · oranžová #EF6C00 · tyrkys #00838F`, '#1565C0');
        if (color) {
          const r = await api('/api/admin/set-color', { playerId: +el.dataset.id, color: color.trim() });
          if (r.ok) { toast('Barva změněna.'); refreshState(); renderAdmin(); }
        }
      }
      if (act === 'tab-empire') { activeTab = 'empire'; updateTabs(); renderSheet(); }
      if (act === 'admin-delete') {
        if (confirm(`Opravdu smazat hráče ${el.dataset.name}? Uvolní se jeho území, armády i vše ostatní. Nejde vrátit.`)) {
          const r = await api('/api/admin/delete-player', { playerId: +el.dataset.id });
          if (r.ok) { toast('Hráč smazán.'); renderAdmin(); }
        }
      }
      if (act === 'admin-give') {
        const amount = prompt(`Kolik surovin (každé) přidat hráči ${el.dataset.name}?`, '1000');
        if (amount > 0) {
          for (const r of ['money', 'grain', 'fish', 'lumber', 'iron', 'coal', 'oil', 'gas']) await api('/api/admin/give', { playerId: +el.dataset.id, resName: r, amount: +amount });
          toast('Přidáno.'); renderAdmin();
        }
      }
      if (act === 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => toast('Celá obrazovka tu nejde — přidej si appku na plochu.'));
      }
    };
  });
}

function showTownTrade(town) {
  const t = MAPDATA.pois.towns.find((x) => x.name === town);
  const myShop = STATE.shops.find((s) => s.town === town && s.playerId === ME.effId);
  const others = STATE.shops.filter((s) => s.town === town && s.playerId !== ME.effId);
  let html = `<h2>${town}</h2><div class="sub">${t.km} km od Čichtic · prodejní kurz ×${(1 + Math.min(t.km, 90) / 40).toFixed(1)}</div>
  <h3>Prodej / nákup (NPC trh)</h3>
  <div class="inline"><select id="tt-res">${Object.keys(RES_LABEL).filter((k) => k !== 'money').map((k) => `<option value="${k}">${RES_LABEL[k]}</option>`).join('')}</select>
  <input id="tt-n" type="number" placeholder="množství" min="1"></div>
  <div class="btn-row">
    <button class="btn" data-tact="sell">Prodat</button>
    <button class="btn ghost" data-tact="buy">Koupit</button>
  </div>`;
  if (myShop) {
    html += `<h3>Tvůj obchod (${RES_LABEL[myShop.res]})</h3>
    <div class="row"><span>Sklad</span><b>${myShop.stock}</b></div>
    <div class="row"><span>Celkem vyděláno</span><b>${myShop.earned}</b></div>
    <div class="inline"><input id="ts-n" type="number" placeholder="naskladnit" min="1"><button class="btn small" data-tact="stock" data-shop="${myShop.id}">Naskladnit</button></div>`;
  } else {
    html += `<h3>Založit obchod</h3><p class="sub">Musíš být fyzicky ve městě. Obchod pak sám prodává NPC zákazníkům.</p>
    <div class="inline"><select id="ts-res">${Object.keys(RES_LABEL).filter((k) => k !== 'money').map((k) => `<option value="${k}">${RES_LABEL[k]}</option>`).join('')}</select>
    <button class="btn small" data-tact="create">Založit</button></div>`;
  }
  if (others.length) {
    html += '<h3>Obchody ostatních</h3>';
    for (const s of others) {
      html += `<div class="row"><span>${ownerName(s.playerId)} — ${RES_LABEL[s.res]} (${s.stock})</span>
      <div class="inline"><input id="tb-n-${s.id}" type="number" placeholder="ks" min="1" style="width:70px"><button class="btn small ghost" data-tact="buyshop" data-shop="${s.id}">Koupit</button></div></div>`;
    }
  }
  $('#sheet-content').innerHTML = html;
  $('#sheet-content').querySelectorAll('[data-tact]').forEach((el) => {
    el.onclick = async () => {
      const act = el.dataset.tact;
      if (act === 'sell' || act === 'buy') {
        const r = await api('/api/town/trade', { town, resName: $('#tt-res').value, amount: +$('#tt-n').value, dir: act });
        if (r.ok) { toast(act === 'sell' ? 'Prodáno.' : 'Koupeno.'); refreshState(); }
      }
      if (act === 'create') { const r = await api('/api/shop/create', { town, resName: $('#ts-res').value }); if (r.ok) refreshState(); }
      if (act === 'stock') { const r = await api('/api/shop/stock', { shopId: +el.dataset.shop, amount: +$('#ts-n').value }); if (r.ok) { toast('Naskladněno.'); refreshState(); } }
      if (act === 'buyshop') { const r = await api('/api/shop/buy', { shopId: +el.dataset.shop, amount: +$(`#tb-n-${el.dataset.shop}`).value }); if (r.ok) { toast('Koupeno.'); refreshState(); } }
    };
  });
}

// ---------- zpětná vazba ----------
$('#fb-close').onclick = () => $('#dlg-feedback').classList.add('hidden');
$('#fb-send').onclick = async () => {
  const r = await api('/api/feedback', { kind: $('#fb-kind').value, text: $('#fb-text').value });
  if (r.ok) {
    $('#fb-text').value = '';
    $('#dlg-feedback').classList.add('hidden');
    toast(r.sent ? 'Díky! Posláno Matějovi na Discord.' : 'Díky! Uloženo (Discord teď nejel, ale hlášení se neztratí).');
  }
};

// ---------- admin konzole (jen správce) ----------
async function renderAdmin() {
  const d = await api('/api/admin/overview');
  if (!d.players) return;
  const fmtT = (ts) => ts ? new Date(ts).toLocaleString('cs', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  let html = `<h2>Admin konzole</h2>
    <div class="sub">server běží od ${fmtT(Date.parse(d.boot))} · partie od ${fmtT(d.gameStart)}</div>
    <button class="btn ghost small" data-act="admin-refresh">Obnovit</button>
    <h3>Hráči (${d.players.length})</h3>`;
  for (const p of d.players) {
    html += `<div class="prod"><div style="flex:1"><b>#${p.id} ${p.name}</b>${p.teamWith ? ` <span class="meta" style="display:inline">(tým s #${p.teamWith})</span>` : ''}
      <span class="meta">${p.home} · ${p.provinces} území · ${p.units} vojáků · ${p.money} peněz · vzdělání ${p.education}</span>
      <span class="meta">registrace ${fmtT(p.created)} · naposledy GPS ${fmtT(p.lastSeen)} · přihlášení: ${p.sessions}</span></div>
      <div class="prod-right" style="flex-direction:column;gap:4px">
        <button class="btn small ghost" data-act="admin-give" data-id="${p.id}" data-name="${p.name}">+ suroviny</button>
        <button class="btn small ghost" data-act="admin-color" data-id="${p.id}" data-name="${p.name}">Barva</button>
        ${p.id !== ME.id ? `<button class="btn small danger" data-act="admin-delete" data-id="${p.id}" data-name="${p.name}">Smazat</button>` : ''}
      </div></div>`;
  }
  if (d.battles.length) { html += '<h3>Bitvy</h3>'; for (const b of d.battles) html += `<div class="row"><span>${b.name}</span><span class="meta">od ${fmtT(b.started)}</span></div>`; }
  html += '<h3>Poslední události (všichni)</h3>';
  for (const e of d.events) html += `<div class="row"><span style="font-size:12.5px">${e.text}</span><span class="meta">${fmtT(e.ts)}</span></div>`;
  html += '<h3>Deník záloh</h3>';
  for (const l of d.backupLog.slice().reverse()) html += `<div class="row"><span style="font-size:11.5px;font-family:monospace">${l.replace(/</g, '&lt;')}</span></div>`;
  html += `<button class="btn ghost" data-act="tab-empire" style="margin-top:12px">Zpět</button>`;
  $('#sheet-content').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  bindSheetActions($('#sheet-content'));
}

// ---------- tutoriál ----------
const TUTORIAL = [
  { t: 'Vítej v Supremacy Čichtice', x: 'Hraje se na skutečné mapě vesnice. Tvůj dům je tvoje hlavní město — produkuje surovinu a daně. Cíl: ovládnout co největší část Čichtic. Vše ostatní ti vysvětlí následující karty.' },
  { t: 'Mapa a území', x: 'Každý dům produkuje jednu ze 7 surovin + peníze z daní. Pole, louky, lesy a rybníky jsou bonusová území — na startu nikomu nepatří a kdo je obsadí první (dojde tam jeho armáda), ten je má. Ťukni na území a uvidíš, co vyrábí.' },
  { t: 'Mlha a objevování', x: 'Mapa je zpočátku zahalená — vidíš jen okolí svého domu. Odkrýváš ji CHŮZÍ s otevřenou aplikací (poloha musí být povolená). Zdolaný kopec odkryje velký kruh okolí. Z auta se mapa neodkrývá — hlídá se tempo. BEZ DAT to jde taky: appka trasu uloží do telefonu a až budeš na Wi-Fi, sama ji nahraje — mlha, kopce i města se započítají zpětně. Výpravu jen zapni ještě doma, dokud máš internet.' },
  { t: 'Vojsko', x: 'Pěchota se u tvých domů verbuje sama (rychleji s kasárnami). Lepší jednotky odemkneš vzděláním — kurzy se zapisují FYZICKY u školy (čp. 91). Armádu pošleš ťuknutím na ni → Přesun/Útok → cíl. Pochody jsou pomalé — když jdeš fyzicky s vojáky nebo dojdeš do cíle, jdou 4× rychleji!' },
  { t: 'Boj', x: 'Bitva probíhá v kolech po 20 minutách. Sílu ovlivňuje morálka, počet a typ jednotek; obráncům pomáhá pevnost (−poškození). Když na tebe někdo útočí, přijde ti oznámení — pošli posily, dokud bitva běží. Rozkaz jde zrušit, armáda se vrátí do posledního uzlu.' },
  { t: 'Výpravy (mini-Strava)', x: 'V záložce Výpravy zapni „Jdu pěšky" nebo „Jedu na kole" a vyraž na kopec či do města. Na místě dostaneš odměnu podle REÁLNĚ ušlé vzdálenosti — autem to nejde ošidit. Kopce dávají suroviny a vojáky, města odemykají obchod. Za 3/10/25 kopců jsou odznaky s penězi.' },
  { t: 'Obchod', x: 'S kamarády obchoduješ napřímo (záložka Obchod → nabídka „dám X za Y"). V objevených městech je NPC trh — čím dál město, tím lepší kurz. A když ve městě fyzicky stojíš, můžeš si tam založit obchod, který pak sám vydělává.' },
  { t: 'Diplomacie a chat', x: 'V menu (tři čárky vpravo nahoře) najdeš žebříček, společný i soukromý chat a diplomacii — nabídky míru (pakt o neútočení) a aliance (max 2 hráči, sdílí mapu). Sourozenci v rozděleném domě na sebe 3 dny nemůžou útočit.' },
  { t: 'Suroviny a morálka', x: 'Ťukni na surovinu v horní liště — uvidíš, co ji vyrábí a co spotřebovává. Hlídej, ať nic nepadne do minusu: nedostatek sráží morálku, a morálka řídí produkci, verbování i sílu v boji. Morálku zvedá pevnost a plné zásoby. Hodně štěstí!' },
];
let tutStep = 0;
function showTutorial(step = 0) {
  tutStep = step;
  const s = TUTORIAL[tutStep];
  $('#tut-title').textContent = s.t;
  $('#tut-text').textContent = s.x;
  $('#tut-dots').innerHTML = TUTORIAL.map((_, i) => `<i class="${i === tutStep ? 'on' : ''}"></i>`).join('');
  $('#tut-prev').style.visibility = tutStep === 0 ? 'hidden' : 'visible';
  $('#tut-next').textContent = tutStep === TUTORIAL.length - 1 ? 'Hotovo' : 'Další';
  $('#tutorial').classList.remove('hidden');
}
function closeTutorial() {
  $('#tutorial').classList.add('hidden');
  localStorage.setItem('supTutorialSeen', '1');
}
$('#tut-next').onclick = () => { if (tutStep >= TUTORIAL.length - 1) closeTutorial(); else showTutorial(tutStep + 1); };
$('#tut-prev').onclick = () => showTutorial(Math.max(0, tutStep - 1));
$('#tut-close').onclick = closeTutorial;

// ---------- přihlašovací brána ----------
const gate = { pickedHouse: null, name: '', pass: '' };
$('#g-to-register').onclick = () => {
  gate.name = $('#g-name').value.trim();
  gate.pass = $('#g-pass').value;
  if (gate.name.length < 2) { $('#g-msg').textContent = 'Vyplň jméno (aspoň 2 znaky).'; return; }
  if (gate.pass.length < 4) { $('#g-msg').textContent = 'Vyplň heslo (aspoň 4 znaky).'; return; }
  $('#gate-step-login').classList.add('hidden');
  $('#gate-step-house').classList.remove('hidden');
  pickMode = { type: 'house' };
  map.centerOn(0, 0, 1.4);
};
$('#g-back').onclick = () => {
  $('#gate-step-house').classList.add('hidden');
  $('#gate-step-login').classList.remove('hidden');
  pickMode = null;
};
$('#g-login').onclick = async () => {
  const r = await api('/api/login', { name: $('#g-name').value.trim(), pass: $('#g-pass').value });
  if (r.ok) enterGame();
  else $('#g-msg').textContent = r.error || 'Přihlášení se nepovedlo.';
};
$('#g-register').onclick = () => tryRegister();

async function tryRegister(decision) {
  const r = await api('/api/register', { name: gate.name, pass: gate.pass, houseId: gate.pickedHouse.id, decision });
  if (r.occupied) {
    $('#dlg-owner').textContent = r.ownerName;
    $('#dlg-occupied').classList.remove('hidden');
    return;
  }
  if (r.ok) enterGame();
  else $('#g-msg2').textContent = r.error || 'Registrace se nepovedla.';
}
$('#dlg-change').onclick = () => { $('#dlg-occupied').classList.add('hidden'); };
$('#dlg-really').onclick = () => {
  $('#dlg-occupied').classList.add('hidden');
  $('#dlg-sibling').classList.remove('hidden');
};
$('#dlg-team').onclick = () => { $('#dlg-sibling').classList.add('hidden'); tryRegister('team'); };
$('#dlg-split').onclick = () => { $('#dlg-sibling').classList.add('hidden'); tryRegister('split'); };

async function enterGame() {
  pickMode = null;
  $('#gate').classList.add('hidden');
  $('#topbar').classList.remove('hidden');
  $('#tabs').classList.remove('hidden');
  $('#menu-btn').classList.remove('hidden');
  $('#refresh-btn').classList.remove('hidden');
  fetch('/api/health').then((r) => r.json()).then((h) => { knownBoot = h.boot; }).catch(() => {});
  requestAnimationFrame(() => updateTabs());
  await loadMapData(); // čerstvá mapa (rozdělené domy po registraci)
  await refreshState();
  connectSSE();
  startGps();
  keepAwake();
  // příjezd kamerou na můj dům
  const home = MAPDATA.provinces.find((p) => p.id === ME.homeId);
  if (home) { map.centerOn(0, 0, 0.35); map.animateTo(home.c[0], home.c[1], 1.7, 1000); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // poprvé na tomhle zařízení: pusť tutoriál
  if (!localStorage.getItem('supTutorialSeen')) setTimeout(() => showTutorial(0), 1200);
}

// ---------- start ----------
(async () => {
  await loadMapData();
  const who = await (await fetch('/api/whoami')).json();
  if (who.id) enterGame();
})();

// pravidelný refresh času ve UI
setInterval(() => { if (STATE && !$('#sheet').classList.contains('hidden')) renderSheet(); }, 30_000);
