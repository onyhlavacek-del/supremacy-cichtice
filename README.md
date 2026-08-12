# Supremacy Čichtice

Realtime strategie inspirovaná Supremacy 1914, hraná na skutečné mapě Čichtic a okolí. Kompletní herní design je v `../supremacy.md` (sekce 13 = naše verze).

## Spuštění

```
npm install          # jen poprvé
npm start            # server na http://localhost:8080
```

Hra se otevře v prohlížeči (na mobilu „Přidat na plochu" → chová se jako aplikace). První registrovaný hráč je admin (id 1).

## Užitečné příkazy

- `npm run build-map` — znovu vygeneruje mapu ze surových OSM dat (`data/raw/`); přepíše `data/map/`.
- `node scripts/reset-game.mjs` — smaže herní stav (hráče, armády, vlastnictví), mapa zůstává. Server musí být zastavený.
- `npm run dev` — server s automatickým restartem při změně kódu.

## Struktura

- `server/constants.js` — všechna herní čísla (tempo, jednotky, ceny, GPS pravidla). Ladit tady.
- `server/game.js` — herní jádro: tick, ekonomika, boj, pohyb, GPS mechaniky.
- `server/index.js` — HTTP API + SSE + autentizace (vč. sourozenecké logiky dělení domu).
- `scripts/build-map.mjs` — OSM data → vrstvy mapy + provincie (Voronoi zahrady, suroviny, sousednost).
- `public/` — klient: `map.js` (Tesla-styl canvas mapa), `app.js` (UI), PWA soubory.
- `data/map/` — vygenerovaná mapa; `data/game.db` — herní stav (SQLite).

## Admin

- Umístění školy: `POST /api/admin/school {lat, lon}` (zatím je na středu vesnice).
- Přidání surovin hráči: `POST /api/admin/give {playerId, resName, amount}`.

## Co zatím není (další kroky)

- Push notifikace na zamčený telefon (teď jen oznámení v otevřené aplikaci přes SSE).
- Nasazení na veřejný server, aby hru viděli kamarádi mimo domácí síť.
- Špionáž, válka/mír formálně (útok = válka automaticky), vlastní obrázky jednotek od Matěje.
