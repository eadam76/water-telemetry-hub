# Vízellátó rendszer felügyelet – követelmények

## Scope

ESP32/ESPHome alapú felügyeleti rendszer az aknában lévő vízellátó rendszerhez. A Home Assistant biztosítja a historizálást, statisztikát és megjelenítést, de az ESP működése nem függhet a HA vagy a hálózat elérhetőségétől.

## Impulzusszámláló modul

### Hardver

- Impulzusadó: **IZAR PULSE i, 4-wire 5m** (Diehl Metering, P/N 3108333), induktív érzékelésű, **open collector** kimenet, saját lítium elemmel (a jeladó nem igényel tápellátást az ESP-től).
  - Dokumentáció: [`docs/hardver/izar-pulse-i-adatlap.pdf`](docs/hardver/izar-pulse-i-adatlap.pdf), [`izar-pulse-i-telepitesi-utmutato.pdf`](docs/hardver/izar-pulse-i-telepitesi-utmutato.pdf).
  - **A beszerzett egységen ellenőrzött bekötés** (a konkrét darab címkéje alapján, 3-kimenetes, egyidejűleg 3 eltérő felbontású jelet ad):
    - fehér = impulzus, `RATIO 1:1` → 1 impulzus = 1 liter
    - sárga = impulzus, `RATIO 10:1` → 1 impulzus = 10 liter
    - zöld = impulzus, `RATIO 100:1` → 1 impulzus = 100 liter
    - barna = föld (közös GND)
  - Csak a **fehér (1:1) vezetéket** kötjük az ESP GPIO-jára a legjobb felbontásért, + barna GND. Sárga/zöld nem kerül bekötésre.
  - Kimenet nyitott kollektoros → ESP oldali pull-up szükséges.
  - `liters_per_pulse = 1` (a fehér vezetékkel), a paraméter így is konfigurálható marad.
  - Max. impulzusfrekvencia: 8 Hz, impulzushossz: 50–500 ms.
  - Kompatibilis Diehl/MOM óracsalád (a gyártói lista kifejezetten tartalmazza a **Corona M**-et).
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

### Pillanatnyi átfolyás számítása

- A Térfogatáram és az Impulzusráta **egymást követő impulzusok közti időből** (periódusidő) származik, nem fix időablakos impulzusszámlálásból – ez alacsony átfolyásnál is pontos, gyors reakciójú értéket ad. A kettő ugyanabból a mérésből számolt, egymással konzisztens (ugyanaz az arány köztük, mint `liters_per_pulse`).
- **Nulla-átfolyás timeout**: ha egy vízórán X másodpercig nem érkezik új impulzus, a Térfogatáram/Impulzusráta explicit 0-ra áll (különben az utolsó periódusidőből számolt érték érvénytelenül "befagyva" maradna).
  - Alapértelmezett: `15 s`, vízóránként konfigurálható – elsősorban az ESP saját webes felületéről, opcionálisan HA-ból is.
  - Kompromisszum: rövidebb timeout → gyorsabb, pontosabb "elzárva" jelzés, de tartós alacsony átfolyásnál (ahol az impulzusköz meghaladja a timeoutot) a kijelzett érték szaggatottan 0 és a tényleges ráta közt ugrál. Hosszabb timeout → simább alacsony átfolyás, de lassabb "elzárva" jelzés valódi leálláskor.
  - Ez csak a pillanatnyi Térfogatáram/Impulzusráta kijelzést érinti; az Összes fogyasztás (`pulse_count` alapú) ettől függetlenül pontos marad.

### Perzisztencia és hibakezelés

- Az ESP az elsődleges adatforrás; a működés nem függhet HA/MQTT/API/Wi-Fi elérhetőségétől.
- `pulse_count` RAM-ban él, periodikusan checkpointként kerül NVS-be. Az `offset_m3` **nem** része a periodikus checkpointnak – csak szinkronkor változik, és akkor azonnal, önálló írással perzisztálódik, nincs mit rajta rendszeresen menteni.
- Checkpoint időköz konfigurálható, **kizárólag az ESP saját webes felületéről** (javasolt tartomány: 10–600 s, alapértelmezett: 60 s), figyelmeztető szöveggel és az ajánlott értékkel a felületen – nem HA-entitás.
  - Rövidebb időköz → kevesebb elveszett impulzus tápvesztéskor, de több flash-írás.
  - Tipikus SPI flash élettartam ~100 000 törlési ciklus/szektor; NVS wear-leveling ezt szektorok közt szórja szét, de a checkpoint gyakorisága egyenesen arányos a kopással (pl. 60 s ≈ 1440 írás/nap, 10 s ≈ 8640 írás/nap).
- Kézi szinkron (`offset_m3`) mindig azonnal perzisztál, checkpointtól függetlenül.
- Újraindítás után a számlálás az utolsó perzisztált `pulse_count`/`offset_m3` alapján folytatódik.
  - Tápvesztéskor legfeljebb egy checkpoint-nyi impulzus veszhet el, emiatt újraindítás után az `Összes fogyasztás` a korábban HA által látott értéknél kisebb lehet egy pillanatra. A `total_increasing` HA-szemantika ezt korrekt módon számlálóresetként kezeli (nem negatív fogyasztásként) – ez elfogadott, dokumentált mellékhatása a checkpoint-alapú perzisztenciának, nem hiba.
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
- nulla-átfolyás timeout (`number`, s)

Checkpoint időköz **nem** HA-entitás, kizárólag az ESP saját webes felületén állítható (lásd Perzisztencia és hibakezelés).

### Idősoros adatok és statisztikák

- Az ESP nem tárol hosszú távú idősoros adatot; ez, valamint az aggregáció (óra/nap/hét/hónap) HA feladata.
- Térfogatáram és összesített fogyasztás legyen historizált a HA-ban.
- HA kiesése alatt az ESP folytatja a számlálást; a részletes térfogatáram-idősor megőrzése ESP oldalon nem követelmény.
- Visszakapcsolódáskor az ESP aktuális abszolút `pulse_count`/`offset_m3` alapú értéke az irányadó.

### Kalibráció

- Az impulzus–térfogat átváltás (`liters_per_pulse`) vízóránként konfigurálható.
- Az impulzusbemenet pergésmentesítése konfigurálható (ESPHome `pulse_meter` `internal_filter` paramétere, nem külön logika).

## Kezdeti implementációs döntések

- ESPHome `pulse_meter` az impulzusérzékeléshez, a pergésmentesítéshez (`internal_filter`) és a rátaszámításhoz (`timeout`).
- Közös logika egy ESPHome csomagban, vízóránkénti példányosítás `substitutions`-szel (pl. `fomero`/`locsolo` id-prefix).
- ESPHome `preferences`/NVS a `pulse_count` (periodikus checkpoint) és `offset_m3` (szinkronkor, azonnali írás) tárolásához.
  - A futásidőben állítható checkpoint-időköz miatt ez nem oldható meg a statikus `flash_write_interval` YAML-paraméterrel – saját ütemezés kell (pl. `interval:` komponens + lambda, ami az aktuálisan beállított időköz szerint hívja a `save()`-t).
- Checkpoint időköz kizárólag az ESP saját webes felületén állítható, alapértelmezett 60 s, figyelmeztető szöveggel.

## Jelenleg nem követelmény

- Hibaészlelés/riasztás (szivárgás, csőtörés, tartós nulla fogyasztás stb.) – később, HA oldalon kerül definiálásra. A szükséges nyers adat (historizált `Összes fogyasztás`) már rendelkezésre áll ehhez, a jelenlegi adatmodell emiatt nem igényel bővítést. Felbontási korlát: `liters_per_pulse`-nál (1 l) kisebb szivárgás egy impulzusköznyi időn belül nem észlelhető.
- Fizikai/környezeti kialakítás (ház, védettség, tápellátás) – nem szoftverkövetelmény.
