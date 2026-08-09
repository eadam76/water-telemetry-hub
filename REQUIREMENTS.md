# Vízellátó rendszer felügyelet – követelmények

## Hatókör

ESP32/ESPHome alapú felügyeleti rendszer az aknában lévő vízellátó rendszerhez. A Home Assistant biztosítja a historizálást, statisztikát és megjelenítést, de az ESP működése nem függhet a HA vagy a hálózat elérhetőségétől.

## Impulzusszámláló modul

### Hardver

- Impulzusadó: **IZAR PULSE** induktív (érintkezésmentes) impulzuskimenet, Diehl/MOM vízórákhoz.
  - Pontos elektromos jellemzők (terhelhetőség, kontaktustípus, impulzusérték) a gyártói dokumentáció alapján ellenőrizendők GPIO/pull-up tervezéskor.
- Vízóra: **MOM Corona D3 1"**.
- Két mérési pont, azonos modulstruktúrával, egymástól függetlenül:
  - **Fő vízmérő** – teljes fogyasztás (ház + kert).
  - **Locsoló mérő** – csak a kerti vízellátás (részhalmaza a fő mérőnek).
  - A ház-only fogyasztás (fő − locsoló) HA oldali származtatott szenzorral számolható, nem ESP feladat.

### Funkcionális követelmények

- Minden érvényes impulzust pontosan egyszer számoljon.
- Aktuális térfogatáram: `L/min`. Összesített fogyasztás: `m³`.
- Diagnosztika: összes impulzusszám, impulzusráta.
- Kézi óraállás-szinkron vízóránként független, elérhető Home Assistantból és az ESP saját webes felületéről is.
- Szinkron azonnal perzisztálódik, nem várja meg a checkpointot.

### Elszámolási modell

Vízóránként két perzisztens állapot:

- `pulse_count` – monoton növekvő impulzusszám (soha nem módosul szinkronnál).
- `offset_m3` – korrekciós eltolás.

```
Összes fogyasztás [m³] = offset_m3 + pulse_count × liters_per_pulse / 1000
```

Kézi szinkron a fizikai óra `célérték`-jére:

```
offset_m3 := célérték − pulse_count × liters_per_pulse / 1000
```

Ezzel a diagnosztikai impulzusszám törésmentes marad, a fogyasztás pedig azonnal a megadott értékre áll, és a rendszer minden mutatott adata konzisztens.

### Perzisztencia és hibakezelés

- Az ESP az elsődleges adatforrás; a működés nem függhet HA/MQTT/API/Wi-Fi elérhetőségétől.
- `pulse_count` RAM-ban él, checkpointként kerül NVS-be.
- Checkpoint időköz konfigurálható HA `number` entitásként (javasolt tartomány: 10–600 s, alapértelmezett: 60 s).
  - Rövidebb időköz → kevesebb elveszett impulzus tápvesztéskor, de több flash-írás.
  - Tipikus SPI flash élettartam ~100 000 törlési ciklus/szektor; NVS wear-leveling ezt szektorok közt szórja szét, de a checkpoint gyakorisága egyenesen arányos a kopással (pl. 60 s ≈ 1440 írás/nap, 10 s ≈ 8640 írás/nap).
  - A `number` entitás leírásába kerüljön ez a kompromisszum, hogy a felhasználó tájékozottan állíthassa.
- Kézi szinkron mindig azonnal perzisztál, checkpointtól függetlenül.
- Újraindítás után a számlálás az utolsó perzisztált `pulse_count`/`offset_m3` alapján folytatódik.
- Első implementáció nem igényel külső FRAM-ot vagy más kiegészítő nem felejtő memóriát.

### Hálózat és biztonság

- A kódban nem szerepelhet semmilyen secret (Wi-Fi jelszó, API kulcs) – ESPHome `secrets.yaml`, verziókezelésből kizárva.
- Első indításkor Wi-Fi beállítás elérhető legyen Bluetooth (BLE improv) és Wi-Fi hotspot (AP + captive portal) módon is.

### Home Assistant adatmodell

Vízóránként (Fő vízmérő, Locsoló mérő):

Üzemi entitások:

- `Térfogatáram` – `L/min`, `state_class: measurement`
- `Összes fogyasztás` – `m³`, `device_class: water`, `state_class: total_increasing`

Diagnosztikai entitások:

- `Impulzusráta` – `impulzus/min`, `state_class: measurement`
- `Összes impulzus` – `impulzus`, `state_class: total_increasing`

Beállító/szerviz entitások:

- fizikai vízóra állásának megadása (`m³`) + szinkronizálás
- checkpoint időköz (`number`, s)

### Idősoros adatok és statisztikák

- Az ESP nem tárol hosszú távú idősoros adatot; ez, valamint az aggregáció (óra/nap/hét/hónap) HA feladata.
- Térfogatáram és összesített fogyasztás legyen historizált a HA-ban.
- HA kiesése alatt az ESP folytatja a számlálást; a részletes térfogatáram-idősor megőrzése ESP oldalon nem követelmény.
- Visszakapcsolódáskor az ESP aktuális abszolút `pulse_count`/`offset_m3` alapú értéke az irányadó.

### Kalibráció

- Az impulzus–térfogat átváltás (`liters_per_pulse`) vízóránként konfigurálható.
- Az impulzusbemenet pergésmentesítése konfigurálható.

## Kezdeti implementációs döntések

- ESPHome `pulse_meter` az impulzusérzékeléshez és impulzusráta-méréshez.
- Közös logika egy ESPHome csomagban, vízóránkénti példányosítás `substitutions`-szel (pl. `fomero`/`locsolo` id-prefix).
- ESPHome `preferences`/NVS a `pulse_count` és `offset_m3` checkpointjaihoz.
- Checkpoint gyakoriság konfigurálható `number` entitással, alapértelmezett 60 s.

## Jelenleg nem követelmény

- Hibaészlelés/riasztás (szivárgás, csőtörés, tartós nulla fogyasztás stb.) – később, HA oldalon kerül definiálásra.
- Fizikai/környezeti kialakítás (ház, védettség, tápellátás) – nem szoftverkövetelmény.
