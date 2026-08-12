// Smaže celý herní stav (hráče, armády, vlastnictví) — mapa zůstává.
// Použití: zastav server, spusť `node scripts/reset-game.mjs`, nastartuj server.
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['game.db', 'game.db-wal', 'game.db-shm']) {
  const p = join(ROOT, 'data', f);
  if (existsSync(p)) { rmSync(p); console.log('Smazáno:', f); }
}
console.log('Hra je resetovaná. Po startu serveru začíná nová partie.');
