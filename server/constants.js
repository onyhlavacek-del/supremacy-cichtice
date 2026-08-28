// Herní konstanty — tempo B (partie 1–2 týdny). Vychází ze Supremacy 1914 (viz supremacy.md),
// přeškálováno na velikost Čichtic. Vše na jednom místě, ať se to snadno ladí.

export const TICK_MS = 60_000;            // zpracování hry: každou minutu
export const COMBAT_TICK_MIN = 20;        // 1 bojové kolo = 20 minut (originál 1 h)
export const SIBLING_PEACE_DAYS = 3;      // ochranná lhůta hráčů ve stejném domě

export const RESOURCES = ['grain', 'fish', 'lumber', 'iron', 'coal', 'oil', 'gas'];
export const CATEGORIES = {
  food: ['grain', 'fish'],
  material: ['lumber', 'iron'],
  energy: ['coal', 'oil', 'gas'],
};
export const RES_LABEL = {
  grain: 'Obilí', fish: 'Ryby', lumber: 'Dřevo', iron: 'Železo',
  coal: 'Uhlí', oil: 'Ropa', gas: 'Plyn', money: 'Peníze',
};

// Produkce provincie za hodinu (surovina, na kterou je specializovaná; double = 2×)
export const PROD_PER_H = 30;
// Domy produkují peníze (daně) za hodinu
export const HOUSE_MONEY_PER_H = 12;
// Spotřeba provincie za hodinu z každé kategorie (originál 800/den ≈ 33/h, škálováno dolů)
export const CONSUME_PER_H = 6;
// Nedostatek v kategorii: pokles morálky za hodinu
export const SHORTAGE_MORALE_PER_H = 1.5;

export const START_RESOURCES = { grain: 800, fish: 300, lumber: 800, iron: 400, coal: 250, oil: 250, gas: 150 };
export const START_MONEY = 1500;
export const START_INFANTRY = 6;

// Morálka provincie: míří k rovnováze ~ (70 + bonusy), rychlostí 12 %/h rozdílu
export const MORALE_BASE_EQ = 70;
export const MORALE_DRIFT = 0.12;
// Zotavování jednotek na vlastním území (%/den z rozdílu do 100), jinam míří k 50
export const UNIT_RECOVER_PER_DAY = 0.35;   // tempo B ≈ 2× originál (14–17 %/den)

// Jednotky (bez námořních, železnic a letadel — viz 13.3). ATK/DEF vs. HP dle originálu,
// speed v metrech/hod na naší mapě, cost = suroviny, time = hodiny výroby.
// speed v metrech/hod — schválně POMALÉ (pochod přes vesnici trvá hodiny),
// aby dávalo smysl jít s vojáky fyzicky (přítomnost = ×4 rychlost)
export const UNITS = {
  infantry:   { label: 'Pěchota',        atk: 1.5, def: 2.0, hp: 4,  speed: 110, cost: {},                            time: 0,   edu: 0 },
  cavalry:    { label: 'Kavalerie',      atk: 3.0, def: 2.0, hp: 5,  speed: 260, cost: { grain: 400, money: 150 },    time: 2,   edu: 1, needs: 'barracks' },
  armoredcar: { label: 'Obrněné auto',   atk: 2.5, def: 4.5, hp: 6,  speed: 320, cost: { iron: 300, oil: 120, money: 200 }, time: 3, edu: 2 },
  artillery:  { label: 'Dělostřelectvo', atk: 5.0, def: 1.5, hp: 5,  speed: 75,  cost: { iron: 400, lumber: 200, money: 300 }, time: 4, edu: 3, range: 260 },
  tank:       { label: 'Tank',           atk: 6.0, def: 5.5, hp: 8,  speed: 140, cost: { iron: 600, oil: 250, money: 450 }, time: 6, edu: 4 },
  heavytank:  { label: 'Těžký tank',     atk: 9.0, def: 7.0, hp: 12, speed: 95,  cost: { iron: 1000, oil: 450, money: 700 }, time: 9, edu: 5 },
};

// Size factor: efektivita klesá s počtem stejného typu ve stacku (viz sekce 5)
export const SIZE_FACTOR = {
  infantry:   [[5, 1.0], [15, 0.3], [40, 0.1]],
  cavalry:    [[6, 1.0], [15, 0.6], [25, 0.2], [40, 0.1]],
  armoredcar: [[6, 1.0], [15, 0.6], [25, 0.2], [40, 0.1]],
  tank:       [[5, 1.0], [10, 0.6], [25, 0.3]],
  heavytank:  [[5, 1.0], [10, 0.5], [25, 0.2]],
  artillery:  [[50, 1.0]],
};

// Pevnost: [redukce poškození, bonus morálky] podle levelu (novější tabulka z ledna 2023)
export const FORTRESS = [
  null,
  { dmgReduction: 0.30, moraleBonus: 5,  cost: { lumber: 300, iron: 150, money: 200 }, hours: 3 },
  { dmgReduction: 0.45, moraleBonus: 10, cost: { lumber: 500, iron: 300, money: 350 }, hours: 5 },
  { dmgReduction: 0.60, moraleBonus: 15, cost: { lumber: 800, iron: 500, money: 500 }, hours: 8 },
  { dmgReduction: 0.75, moraleBonus: 20, cost: { lumber: 1200, iron: 800, money: 800 }, hours: 12 },
  { dmgReduction: 0.90, moraleBonus: 25, cost: { lumber: 1800, iron: 1200, money: 1200 }, hours: 18 },
];
export const FORTRESS_HIDE_LVL = 2;   // od lvl 2 skrývá posádku

// Kasárna: bonus rychlosti verbování, denní spotřeba obilí
export const BARRACKS = [
  null,
  { recruitBonus: 0.5, grainPerDay: 60,  cost: { lumber: 400, iron: 150, money: 250 }, hours: 4 },
  { recruitBonus: 1.0, grainPerDay: 120, cost: { lumber: 700, iron: 300, money: 450 }, hours: 7 },
];

// Rekrutovací kancelář: automaticky v každém vlastněném DOMĚ, generuje pěchotu
export const RECRUIT_HOURS_PER_INF = 3;   // 1 pěšák za ~3 h při 100% morálce (jen domy)

// Vzdělání (škola) — tech strom, viz 13.8. Kurz se spouští fyzicky u školy.
export const EDUCATION = [
  { level: 1, label: 'Základní výcvik',   unlocks: 'cavalry',    hours: 6,  cost: { money: 300 } },
  { level: 2, label: 'Řidičský kurz',     unlocks: 'armoredcar', hours: 10, cost: { money: 600 } },
  { level: 3, label: 'Dělostřelecká škola', unlocks: 'artillery', hours: 14, cost: { money: 1000 } },
  { level: 4, label: 'Technická škola',   unlocks: 'tank',       hours: 20, cost: { money: 1600 } },
  { level: 5, label: 'Vojenská akademie', unlocks: 'heavytank',  hours: 28, cost: { money: 2500 } },
];

// GPS
export const PRESENCE_RADIUS_M = 80;       // takhle blízko = "jsi tam"
export const PRESENCE_TTL_MIN = 60;        // přítomnost platí 1 h (dle 13.4)
export const PRESENCE_MOVE_SPEEDUP = 4;    // vojáci jdou 4× rychleji, když jsi fyzicky s nimi / v cíli
export const PRESENCE_ARRIVAL_MORALE = 10; // bonus morálky armády po příchodu na místo s tebou
// Vzdálené rozkazy: příprava před vyražením (podle vzdálenosti cíle od tvého domu)
export const REMOTE_DELAY_MIN_PER_KM = 45; // není-li hráč na místě: +45 min přípravy za km

// Mini-Strava
export const TRIP_WALK_MAX_KMH = 8;
export const TRIP_BIKE_MAX_KMH = 28;
export const HILL_REWARD_BASE = 150;       // suroviny za kopec, roste se vzdáleností a výškou
export const HILL_SOLDIER_CHANCE = 0.35;   // šance na vojáky navíc
export const TOWN_REWARD_BASE = 80;        // menší odměna za město (hlavně obchod)
export const HILL_ACHIEVEMENTS = [
  { count: 3,  money: 500,  label: 'Turista' },
  { count: 10, money: 1500, label: 'Horal' },
  { count: 25, money: 4000, label: 'Král kopců' },
];

// Obchod ve městech: čím dál město, tím lepší kurz (80 km ≈ 3×)
export const townPriceMult = (km) => 1 + Math.min(km, 90) / 40;
export const BASE_PRICES = { grain: 1.0, fish: 1.3, lumber: 1.1, iron: 1.8, coal: 1.6, oil: 2.2, gas: 2.5 };
export const SHOP_NPC_SALES_PER_H = 15;    // kolik jednotek suroviny NPC koupí za hodinu z tvého obchodu

// Vylepšení přírodních území (pole/louky, rybníky, lesy, ložiska) — 5 na každý typ.
// bonus = +podíl produkce ZA ÚROVEŇ; costBase se u víceúrovňových násobí cílovou úrovní;
// upkeepDayBase = denní náklady ZA ÚROVEŇ (když na ně nemáš, vylepšení ten tick nefunguje);
// needs = [klíč, minimální úroveň jiného vylepšení]; morale = bonus rovnováhy morálky.
export const NATURE_UPGRADES = {
  field: [
    { key: 'farmers',    label: 'Farmáři',        max: 5, bonus: 0.20, costBase: { money: 200 }, upkeepDayBase: { money: 30 }, hours: 2 },
    { key: 'harvester',  label: 'Kombajn',        max: 1, bonus: 0.50, needs: ['farmers', 2], costBase: { money: 800, iron: 400, oil: 200 }, upkeepDayBase: { oil: 24 }, hours: 6 },
    { key: 'fertilizer', label: 'Hnojivo',        max: 3, bonus: 0.15, costBase: { money: 150, gas: 100 }, hours: 2 },
    { key: 'irrigation', label: 'Zavlažování',    max: 1, bonus: 0.25, costBase: { lumber: 300, iron: 150, money: 250 }, hours: 4 },
    { key: 'granary',    label: 'Sýpka',          max: 1, bonus: 0.10, morale: 5, costBase: { lumber: 400, money: 200 }, hours: 3 },
  ],
  pond: [
    { key: 'fishermen',  label: 'Rybáři',         max: 5, bonus: 0.20, costBase: { money: 200 }, upkeepDayBase: { money: 30 }, hours: 2 },
    { key: 'boat',       label: 'Loďka',          max: 1, bonus: 0.50, needs: ['fishermen', 2], costBase: { lumber: 500, money: 400 }, hours: 5 },
    { key: 'nets',       label: 'Sítě',           max: 3, bonus: 0.15, costBase: { money: 180 }, hours: 2 },
    { key: 'hatchery',   label: 'Líheň',          max: 1, bonus: 0.25, costBase: { lumber: 250, money: 350 }, hours: 4 },
    { key: 'feeding',    label: 'Krmení',         max: 3, bonus: 0.15, costBase: { money: 100 }, upkeepDayBase: { grain: 20 }, hours: 1 },
  ],
  forest: [
    { key: 'lumberjacks', label: 'Dřevorubci',    max: 5, bonus: 0.20, costBase: { money: 200 }, upkeepDayBase: { money: 30 }, hours: 2 },
    { key: 'chainsaw',    label: 'Motorová pila', max: 1, bonus: 0.50, needs: ['lumberjacks', 2], costBase: { iron: 300, oil: 150, money: 500 }, upkeepDayBase: { oil: 12 }, hours: 4 },
    { key: 'tractor',     label: 'Traktor',       max: 1, bonus: 0.25, costBase: { iron: 400, oil: 200, money: 400 }, upkeepDayBase: { oil: 12 }, hours: 5 },
    { key: 'sawmill',     label: 'Pila (katr)',   max: 1, bonus: 0.25, costBase: { lumber: 300, iron: 250, money: 400 }, hours: 6 },
    { key: 'planting',    label: 'Výsadba',       max: 3, bonus: 0.15, costBase: { money: 150 }, hours: 2 },
  ],
  mine: [ // železný a uhelný důl
    { key: 'miners',   label: 'Horníci',          max: 5, bonus: 0.20, costBase: { money: 250 }, upkeepDayBase: { money: 35 }, hours: 2 },
    { key: 'drill',    label: 'Vrtná souprava',   max: 1, bonus: 0.50, needs: ['miners', 2], costBase: { iron: 500, oil: 250, money: 800 }, upkeepDayBase: { oil: 24 }, hours: 8 },
    { key: 'cart',     label: 'Důlní vozík',      max: 3, bonus: 0.15, costBase: { iron: 250, lumber: 150, money: 250 }, hours: 4 },
    { key: 'lighting', label: 'Osvětlení',        max: 1, bonus: 0.15, costBase: { money: 250, iron: 100 }, upkeepDayBase: { coal: 12 }, hours: 2 },
    { key: 'storage',  label: 'Sklad',            max: 1, bonus: 0.10, morale: 5, costBase: { lumber: 350, money: 250 }, hours: 3 },
  ],
  oil: [ // ropné pole — "kývačka" (pumpjack) a spol.
    { key: 'drillers', label: 'Vrtaři',            max: 5, bonus: 0.20, costBase: { money: 250 }, upkeepDayBase: { money: 35 }, hours: 2 },
    { key: 'pumpjack', label: 'Těžní kývačka',     max: 3, bonus: 0.25, needs: ['drillers', 2], costBase: { iron: 350, money: 400 }, upkeepDayBase: { money: 25 }, hours: 5 },
    { key: 'derrick',  label: 'Vrtná věž',         max: 1, bonus: 0.50, needs: ['pumpjack', 1], costBase: { iron: 500, lumber: 300, money: 700 }, hours: 8 },
    { key: 'tanker',   label: 'Cisterna',          max: 1, bonus: 0.15, costBase: { iron: 250, money: 300 }, hours: 3 },
    { key: 'barrels',  label: 'Sklad barelů',      max: 1, bonus: 0.10, morale: 5, costBase: { lumber: 300, money: 250 }, hours: 3 },
  ],
  gas: [ // plynové pole — kompresorová stanice, věž s hořákem
    { key: 'drillers',   label: 'Vrtaři',              max: 5, bonus: 0.20, costBase: { money: 250 }, upkeepDayBase: { money: 35 }, hours: 2 },
    { key: 'compressor', label: 'Kompresorová stanice', max: 3, bonus: 0.25, needs: ['drillers', 2], costBase: { iron: 350, money: 450 }, upkeepDayBase: { money: 25 }, hours: 5 },
    { key: 'gastower',   label: 'Těžební věž s hořákem', max: 1, bonus: 0.50, needs: ['compressor', 1], costBase: { iron: 500, lumber: 250, money: 700 }, hours: 8 },
    { key: 'pipeline',   label: 'Potrubí',             max: 1, bonus: 0.15, costBase: { iron: 300, money: 250 }, hours: 4 },
    { key: 'gastank',    label: 'Zásobník plynu',      max: 1, bonus: 0.10, morale: 5, costBase: { iron: 250, money: 300 }, hours: 3 },
  ],
};
// která sada vylepšení patří k provincii
export function natureSetFor(prov) {
  if (!prov || prov.kind === 'house') return null;
  if (prov.kind === 'pond') return 'pond';
  if (prov.kind === 'forest') return 'forest';
  if (prov.resource === 'oil') return 'oil';
  if (prov.resource === 'gas') return 'gas';
  if (['iron', 'coal'].includes(prov.resource)) return 'mine';
  if (prov.kind === 'field' || prov.kind === 'meadow') return 'field';
  return null;
}
export const upgradeCost = (def, targetLvl) => {
  const mult = def.max > 1 ? targetLvl : 1;
  return Object.fromEntries(Object.entries(def.costBase).map(([r, v]) => [r, v * mult]));
};

// Aliance
// úrovně říše: XP za budování a pohyb, level = správní kapacita území.
// NAD kapacitu jde dobývat dál, ale morálka VŠECH území klesá (měkký strop).
export const EMPIRE = {
  capacityBase: 8,        // level 1 udrží 8 území bez postihu
  capacityPerLevel: 4,    // každý další level +4
  overCapMoralePer: 8,    // −rovnováha morálky za každé území nad kapacitu (28. 8. večer zpřísněno z 5)
  levelStep: 120,         // n-tý level stojí n × 120 XP
  xp: { upgrade: 15, building: 20, hill: 10, town: 15, battleWon: 25, capture: 10, perKmWalked: 2 },
};
export function levelFor(xp) {
  let lvl = 1, need = EMPIRE.levelStep, rest = xp;
  while (rest >= need) { rest -= need; lvl++; need = EMPIRE.levelStep * lvl; }
  return { lvl, into: rest, need };
}
export function capacityFor(lvl) { return EMPIRE.capacityBase + EMPIRE.capacityPerLevel * (lvl - 1); }

// vzpoura: území s morálkou pod prahem se může odtrhnout (šance roste s bídou);
// nikdy domov/hlavní město a nikdy území s posádkou vlastníka
export const REVOLT = { moraleBelow: 20, dailyMaxChance: 0.5 };

// válečné úsilí: reálný pohyb BĚHEM bitvy pomáhá v boji (okno od začátku bitvy)
export const WAR_EFFORT = {
  windowMs: 3 * 3600_000,  // jen první 3 h bitvy
  pctPerKm: 5,             // +5 % síla za každý ušlý km
  walkPctMax: 25,          // strop bonusu za chůzi
  townPct: 10,             // nově objevené město = +10 % síla
  townPctMax: 20,          // strop za města
  walkMaxKmh: 8,           // rychlejší pohyb se nepočítá (kolo/auto)
};

export const ALLIANCE_MAX_MEMBERS = 3;     // rozšířeno na 3 (28. 8.)

// Dobytí hlavního města (viz sekce 2)
export const CAPITAL_CAPTURE = { winnerMoraleBonus: 10, winnerMoneyShare: 0.5, loserMoralePenalty: 20, loserMaxMoralePenalty: 40 };

// Boj
export const COMBAT = { moraleFactorMin: 0.55, randomSpread: 0.25, damagedUnitMinFactor: 0.5 };

// Vítězství: 60 % všech provincií, NEBO nejvíc území po uplynutí délky partie (tempo B)
export const VICTORY_PROVINCE_SHARE = 0.6;
export const GAME_LENGTH_DAYS = 0; // 0 = bez časového limitu (dle Matěje 28. 8.)
