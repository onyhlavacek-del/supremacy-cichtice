// Zálohování databáze na Discord (pro hosting bez trvalého disku — Render free).
// Env: BACKUP_BOT_TOKEN, BACKUP_CHANNEL_ID. Bez nich je modul vypnutý (lokální vývoj).
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(ROOT, 'data', 'game.db');
const TOKEN = (process.env.BACKUP_BOT_TOKEN || '').trim();
const CHANNEL = (process.env.BACKUP_CHANNEL_ID || '').trim();
const API = 'https://discord.com/api/v10';
const UA = 'SupremacyCichtice-Backup/1.0';

const enabled = () => !!(TOKEN && CHANNEL);
const H = (extra = {}) => ({ Authorization: `Bot ${TOKEN}`, 'User-Agent': UA, ...extra });

// deník posledních kroků zálohování — vystavuje ho /api/health pro dálkovou diagnostiku
export const backupLog = [];
function blog(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  console.log('Záloha:', ...args);
  backupLog.push(line);
  if (backupLog.length > 60) backupLog.shift();
}

async function fetchRetry(url, opts, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status === 429) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
  }
  throw new Error(lastErr);
}

async function countPlayers(path) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const c = new DatabaseSync(path, { readOnly: true });
    const n = c.prepare('SELECT COUNT(*) AS n FROM players').get().n;
    c.close();
    return n;
  } catch {
    return -1; // nečitelná / poškozená
  }
}

// při startu: pokud lokální DB chybí, stáhni poslední zálohu z Discordu
export async function restoreBackup() {
  if (!enabled()) { blog('vypnutá (chybí env)'); return; }
  if (existsSync(DB_PATH)) { blog('lokální DB existuje, nestahuji'); return; }
  blog('lokální DB chybí — hledám zálohu v kanálu');
  try {
    const res = await fetchRetry(`${API}/channels/${CHANNEL}/messages?limit=50`, { headers: H() });
    const msgs = await res.json();
    if (!Array.isArray(msgs)) throw new Error('odpověď není pole: ' + JSON.stringify(msgs).slice(0, 150));
    const backs = msgs.filter((m) => (m.attachments || []).some((a) => a.filename === 'game.db'));
    blog(`zpráv: ${msgs.length}, záloh: ${backs.length}`);
    for (const m of backs) { // od nejnovější
      const att = m.attachments.find((a) => a.filename === 'game.db');
      try {
        const file = await fetchRetry(att.url, { headers: { 'User-Agent': UA } });
        mkdirSync(join(ROOT, 'data'), { recursive: true });
        const tmp = DB_PATH + '.download';
        writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
        const players = await countPlayers(tmp);
        if (players < 0) { blog(`záloha ${m.timestamp} je poškozená, zkouším starší`); continue; }
        renameSync(tmp, DB_PATH);
        blog(`OBNOVENO ${att.size} B z ${m.timestamp}, hráčů: ${players}`);
        return;
      } catch (e) {
        blog(`stažení zálohy ${m.timestamp} selhalo: ${e.message} — zkouším starší`);
      }
    }
    blog('žádná použitelná záloha — začínám s čistou hrou');
  } catch (e) {
    blog('OBNOVA SELHALA (hra pojede načisto!):', e.message);
  }
}

let lastUploadedMtime = 0;
let uploading = false;

let onlineFn = () => [];
export function setOnlineProvider(fn) { onlineFn = fn; }

async function uploadBackup(reason) {
  if (!enabled() || uploading) return;
  try {
    const mtime = statSync(DB_PATH).mtimeMs;
    if (mtime <= lastUploadedMtime && reason !== 'shutdown') return; // nic nového
    uploading = true;
    // konzistentní snímek: checkpoint WAL do hlavního souboru
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const c = new DatabaseSync(DB_PATH);
      c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      c.close();
    } catch { /* server drží zámek — soubor je i tak použitelný */ }
    const localPlayers = await countPlayers(DB_PATH);
    // POJISTKA: prázdnou hru nikdy nenahrávej přes zálohy, které hráče mají
    if (localPlayers === 0) {
      try {
        const res = await fetchRetry(`${API}/channels/${CHANNEL}/messages?limit=10`, { headers: H() });
        const msgs = await res.json();
        const latest = (Array.isArray(msgs) ? msgs : []).find((m) => (m.attachments || []).some((a) => a.filename === 'game.db'));
        const m = latest?.content?.match(/hráčů: (\d+)/);
        if (m && +m[1] > 0) {
          blog(`upload PŘESKOČEN: lokální hra je prázdná, ale poslední záloha má ${m[1]} hráčů`);
          return;
        }
      } catch { /* při pochybnostech nahraj */ }
    }
    const body = new FormData();
    let onlineTxt = '';
    try { const on = onlineFn(); onlineTxt = on.length ? ` (online: ${on.join(', ')})` : ' (online: nikdo)'; } catch { /* nevadí */ }
    body.append('payload_json', JSON.stringify({ content: `Záloha hry (${reason}) — ${new Date().toISOString()} — hráčů: ${localPlayers}${onlineTxt}` }));
    body.append('files[0]', new Blob([readFileSync(DB_PATH)]), 'game.db');
    const res = await fetchRetry(`${API}/channels/${CHANNEL}/messages`, { method: 'POST', headers: H(), body });
    lastUploadedMtime = mtime;
    blog(`nahráno (${reason}), hráčů: ${localPlayers}`);
    await pruneOld();
  } catch (e) {
    blog('upload selhal:', e.message);
  } finally {
    uploading = false;
  }
}

// drž 12 nejnovějších záloh + první zálohu každého dne za posledních 14 dní
async function pruneOld() {
  try {
    const res = await fetchRetry(`${API}/channels/${CHANNEL}/messages?limit=100`, { headers: H() });
    const msgs = (await res.json()).filter((m) => (m.attachments || []).some((a) => a.filename === 'game.db'));
    const keep = new Set(msgs.slice(0, 12).map((m) => m.id));
    const byDay = new Map();
    for (const m of msgs) {
      const day = m.timestamp.slice(0, 10);
      byDay.set(day, m.id); // zprávy jdou od nejnovější — poslední zápis = nejstarší (první) záloha dne
    }
    const cutoff = Date.now() - 14 * 86400_000;
    for (const [day, id] of byDay) {
      if (new Date(day).getTime() > cutoff) keep.add(id);
    }
    for (const m of msgs) {
      if (keep.has(m.id)) continue;
      await fetch(`${API}/channels/${CHANNEL}/messages/${m.id}`, { method: 'DELETE', headers: H() });
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch { /* nevadí */ }
}

export function startBackups() {
  if (!enabled()) { blog('vypnutá (chybí BACKUP_BOT_TOKEN / BACKUP_CHANNEL_ID)'); return; }
  setInterval(() => uploadBackup('pravidelná'), 10 * 60_000);
  setTimeout(() => uploadBackup('po startu'), 90_000);
  // Render posílá SIGTERM před uspáním/restartem — poslední šance uložit
  process.on('SIGTERM', async () => {
    await uploadBackup('shutdown');
    process.exit(0);
  });
}
