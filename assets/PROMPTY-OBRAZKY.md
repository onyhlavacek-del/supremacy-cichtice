# Prompty pro AI obrázky (Gemini / ChatGPT)

## Jak na to

1. Generuj **1024×1024, jeden objekt na obrázek**, ideálně **průhledné pozadí (PNG)**.
   ChatGPT průhledné pozadí umí („transparent background"); pokud Gemini neumí, nech jednolité pozadí `#EDEBE6` — vyříznu ho.
2. Do promptu vlož **celý základní blok** níže a vyměň jen `[OBJEKT]` — tím budou všechny obrázky ve stejném stylu.
3. Ukládej pod názvy ze seznamu (např. `kombajn.png`) do složky `app/assets/img/`.
4. **Stroje a jednotky generuj otočené DOPRAVA** (kvůli animaci pohybu — obrázek pak natáčím podle směru jízdy).

## Základní blok (vlož vždy celý)

```
Minimalist flat vector game asset for a clean, modern map-style strategy game.
Single object only: [OBJEKT].
Top-down three-quarter view (bird's eye, about 45 degrees), facing right.
Soft matte colors, smooth rounded shapes, NO outlines, NO text, NO background scenery.
One gentle soft shadow directly beneath the object.
Muted warm palette matching these colors: warm off-white #EDEBE6, wheat yellow #EFDFA0,
soft green #A9C69B, sky blue #A9CCEA, pure white #FFFFFF, warm gray #D3CFC7,
ochre accent #C9A227, rust red accent #C62828, steel blue #6E7B8B, dark charcoal #2B2A28.
The object fills about 75% of a square canvas, perfectly centered.
Style: premium minimal "Tesla map UI" look, like an elegant board game piece.
Transparent background PNG (if not possible, solid #EDEBE6 background).
High resolution, crisp edges.
```

## Objekty k vygenerování

### Stroje (vylepšení území)
| Soubor | [OBJEKT] |
|---|---|
| kombajn.png | a small modern combine harvester in rust red with a wide golden header reel at the front |
| traktor.png | a small green farm tractor with a log trailer |
| motorova-pila.png | a chainsaw with ochre body |
| pumpjack.png | an oil pumpjack (nodding donkey pump) in dark charcoal with a rust red head |
| vrtna-vez.png | a tall steel oil derrick tower in steel blue |
| kompresor.png | a small industrial gas compressor station, steel blue box with pipes |
| tezebni-vez.png | a gas drilling tower with a small orange flame flare at the top |
| cisterna.png | a small tanker truck with a steel blue cylindrical tank |
| dulni-vozik.png | a mining cart on rails filled with dark coal |
| vrtna-souprava.png | a heavy mining drill rig in ochre |
| lodka.png | a small wooden rowing boat with a fishing net |
| sypka.png | a small wooden granary barn with a white roof |
| zavlazovani.png | a small irrigation sprinkler spraying light blue water droplets |

### Lidé (pracovníci a vojáci)
| Soubor | [OBJEKT] |
|---|---|
| farmar.png | a tiny farmer figure with a straw hat and a pitchfork |
| rybar.png | a tiny fisherman figure with a fishing rod and yellow raincoat |
| drevorubec.png | a tiny lumberjack figure with an axe and red plaid shirt |
| hornik.png | a tiny miner figure with a helmet and headlamp |
| pechota.png | a tiny soldier figure in dark green uniform with a rifle |
| kavalerie.png | a tiny soldier on a brown horse |

### Vojenská technika
| Soubor | [OBJEKT] |
|---|---|
| obrnene-auto.png | a small armored car in steel blue with round turret |
| delo.png | a small field artillery cannon in dark charcoal |
| tank.png | a small tank in muted green with a short barrel |
| tezky-tank.png | a bigger heavy tank in dark charcoal with a long barrel |

### Suroviny (ikony)
| Soubor | [OBJEKT] |
|---|---|
| obili.png | a golden wheat sheaf tied with string |
| ryba.png | a small blue fish |
| drevo.png | three stacked wooden logs |
| zelezo.png | two steel ingots |
| uhli.png | a small pile of black coal lumps |
| ropa.png | a dark oil barrel with a small ochre stripe |
| plyn.png | a purple gas canister with a small flame |
| penize.png | a small stack of golden coins |

## Tipy

- Když se styl „utrhne", přidej do promptu: *"same art style as the previous image, consistent series"* a generuj ve stejné konverzaci.
- Negeneruj stíny do stran — jen měkký stín přímo pod objektem, jinak to na mapě bude vypadat rozbitě.
- Až budou hotové, hoď je do `app/assets/img/` a napiš — zapojím je do hry (ikony v panelech, na mapě a animovaný kombajn jezdící po poli).
