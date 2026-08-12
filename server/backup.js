// Zálohování databáze na Discord (pro hosting bez trvalého disku — Render free).
// Env: BACKUP_BOT_TOKEN, BACKUP_CHANNEL_ID. Bez nich je modul vypnutý (lokální vývoj).
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = join(ROOT, 'data', 'game.db');
const TOKEN = process.env.BACKUP_BOT_TOKEN;
const CHANNEL = process.env.BACKUP_CHANNEL_ID;
const API = 'https://discord.com/api/v10';

const enabled = () => !!(TOKEN && CHANNEL);
const H = () => ({ Authorization: `Bot ${TOKEN}` });

// při startu: pokud lokální DB chybí, stáhni poslední zálohu z Discordu
export async function restoreBackup() {
  if (!enabled()) return;
  if (existsSync(DB_PATH)) { console.log('Záloha: lokální DB existuje, nestahuji.'); return; }
  try {
    const res = await fetch(`${API}/channels/${CHANNEL}/messages?limit=25`, { headers: H() });
    if (!res.ok) { console.error('Záloha: čtení kanálu selhalo', res.status); return; }
    const msgs = await res.json();
    for (const m of msgs) { // od nejnovější
      const att = (m.attachments || []).find((a) => a.filename === 'game.db');
      if (!att) continue;
      const file = await fetch(att.url);
      if (!file.ok) continue;
      mkdirSync(join(ROOT, 'data'), { recursive: true });
      writeFileSync(DB_PATH, Buffer.from(await file.arrayBuffer()));
      console.log(`Záloha: obnoveno ${att.size} B z ${m.timestamp}`);
      return;
    }
    console.log('Záloha: v kanálu žádná záloha — začínám s čistou hrou.');
  } catch (e) {
    console.error('Záloha: obnova selhala:', e.message);
  }
}

let lastUploadedMtime = 0;
let uploading = false;

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
    const body = new FormData();
    body.append('payload_json', JSON.stringify({ content: `Záloha hry (${reason}) — ${new Date().toISOString()}` }));
    body.append('files[0]', new Blob([readFileSync(DB_PATH)]), 'game.db');
    const res = await fetch(`${API}/channels/${CHANNEL}/messages`, { method: 'POST', headers: H(), body });
    if (res.ok) {
      lastUploadedMtime = mtime;
      console.log('Záloha: nahráno na Discord,', reason);
      await pruneOld();
    } else {
      console.error('Záloha: upload selhal', res.status, await res.text());
    }
  } catch (e) {
    console.error('Záloha: upload selhal:', e.message);
  } finally {
    uploading = false;
  }
}

// drž jen posledních 12 záloh, starší smaž
async function pruneOld() {
  try {
    const res = await fetch(`${API}/channels/${CHANNEL}/messages?limit=50`, { headers: H() });
    if (!res.ok) return;
    const msgs = (await res.json()).filter((m) => (m.attachments || []).some((a) => a.filename === 'game.db'));
    for (const m of msgs.slice(12)) {
      await fetch(`${API}/channels/${CHANNEL}/messages/${m.id}`, { method: 'DELETE', headers: H() });
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch { /* nevadí */ }
}

export function startBackups() {
  if (!enabled()) { console.log('Záloha: vypnutá (chybí BACKUP_BOT_TOKEN / BACKUP_CHANNEL_ID).'); return; }
  setInterval(() => uploadBackup('pravidelná'), 10 * 60_000);
  setTimeout(() => uploadBackup('po startu'), 90_000);
  // Render posílá SIGTERM před uspáním/restartem — poslední šance uložit
  process.on('SIGTERM', async () => {
    await uploadBackup('shutdown');
    process.exit(0);
  });
}
