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
- ESP board (tervezett, szállítás alatt): **Waveshare ESP32-S3-RS485-CAN**, izolált RS485/CAN, DIN-sínes. Dokumentáció: [`docs/hardver/esp32-s3-rs485-can-board.md`](docs/hardver/esp32-s3-rs485-can-board.md) (+ eredeti PDF ugyanott). A jeladók a board SH1.0 csatlakozójára kerülnek: `Fő vízmérő → GPIO1`, `Locsoló mérő → GPIO2`. A kezdeti teszteléshez másik (nem S3) boardot használunk, ezért a `board:` típus és a pulzus-GPIO-k a YAML-ban `substitutions`-ként paraméterezettek.
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

- `pulse_count` – normál futás közben monoton növekvő impulzusszám (soha nem módosul szinkronnál); tápvesztés utáni restore esetén legfeljebb egy checkpoint-időszaknyit visszaállhat (lásd Perzisztencia és hibakezelés).
- `offset_m3` – korrekciós eltolás.

```
Összes fogyasztás [m³] = offset_m3 + pulse_count × liters_per_pulse / 1000
```

Kézi szinkron a fizikai óra `célérték`-jére:

```
offset_m3 := célérték − pulse_count × liters_per_pulse / 1000
```

Ezzel a diagnosztikai impulzusszám törésmentes marad, a fogyasztás pedig azonnal a megadott értékre áll, és a rendszer minden mutatott adata konzisztens.

A kézi szinkron az `Összes fogyasztás`-t **lefelé is** mozgathatja (ha a fizikai óra állása kisebb, mint amit az ESP addig mutatott) – ilyenkor ugyanaz a HA `total_increasing` statisztikai következmény jelentkezik, mint a tápvesztés utáni visszaugrásnál, csak itt szándékosan. A kézi szinkron ritka, karbantartási jellegű esemény; ha a HA hosszú távú statisztikáját ez érzékenyen érinti, azt szükség esetén kézzel kell korrigálni – emiatt nem indokolt az ESP adatmodelljét bonyolítani.

### Pillanatnyi átfolyás számítása

- A Térfogatáram és az Impulzusráta **egymást követő impulzusok közti időből** (periódusidő) származik, nem fix időablakos impulzusszámlálásból – ez a fix időablakos számlálásnál jobb felbontást és reakciót ad alacsony átfolyásnál. A kettő ugyanabból a mérésből számolt, egymással konzisztens (ugyanaz az arány köztük, mint `liters_per_pulse`).
- **Nulla-átfolyás timeout**: ha egy vízórán X másodpercig nem érkezik új impulzus, a Térfogatáram/Impulzusráta explicit 0-ra áll (különben az utolsó periódusidőből számolt érték érvénytelenül "befagyva" maradna).
  - Alapértelmezett: `60 s`, vízóránként konfigurálható – futásidőben állítható, alacsony szintű paraméter, elsősorban az ESP saját webes felületéről, opcionálisan HA-ból is (nem fordításidőben beégetett érték).
  - A korábban javasolt `15 s` túl agresszívnak bizonyult: 1 l/impulzus mellett már egy hétköznapi, nem is lassú folyás (2–5 L/perc, pl. kézmosás) impulzusköze is 12–30 mp – ennél rövidebb timeout ezt is szaggatottá tenné. `60 s` a jóval lassabb, de még hétköznapi (~1 L/perc, csordogálás) folyást is villogás nélkül lefedi.
  - Kompromisszum: rövidebb timeout → gyorsabb, pontosabb "elzárva" jelzés, de tartós alacsony átfolyásnál (ahol az impulzusköz meghaladja a timeoutot) a kijelzett érték szaggatottan 0 és a tényleges ráta közt ugrál. Hosszabb timeout → simább alacsony átfolyás, de lassabb "elzárva" jelzés valódi leálláskor.
  - Ez csak a pillanatnyi Térfogatáram/Impulzusráta kijelzést érinti; az Összes fogyasztás (`pulse_count` alapú) ettől függetlenül pontos marad.

### Perzisztencia és hibakezelés

- Az ESP az elsődleges adatforrás; a működés nem függhet HA/MQTT/API/Wi-Fi elérhetőségétől.
- `pulse_count` RAM-ban él, periodikusan checkpointként kerül NVS-be. Az `offset_m3` **nem** része a periodikus checkpointnak – csak szinkronkor változik, és akkor azonnal, önálló írással perzisztálódik, nincs mit rajta rendszeresen menteni.
- Checkpoint időköz **fix `60 s`, fordítási időben rögzített** érték (nem futásidőben állítható, sem HA-ból, sem ESP webről) – az ESPHome `web_server` ugyanazokat az entitásokat adná ki az API-n (HA) keresztül is, mint a helyi weboldalon, tehát a "csak ESP-n állítható" elkülönítés egyedi komponenst igényelne. Az egyszerűség kedvéért ezt nem vállaljuk be.
  - A 60 s jó kompromisszum az adatvesztési ablak (tápvesztéskor legfeljebb ennyi impulzus veszhet el) és a flash-terhelés között. A tényleges fizikai írásszám ennél kevesebb is lehet, mert csak akkor kell írni, ha a `pulse_count` valóban változott az adott időszakban (lásd Kezdeti implementációs döntések) – nincs fogyasztás, nincs felesleges írás.
  - Ha később mégis más érték kellene, az egy YAML/`substitutions` módosítás + újraflashelés, nem éles konfigurációs paraméter.
- Kézi szinkron (`offset_m3`) mindig azonnal perzisztál, checkpointtól függetlenül.
- Újraindítás után a számlálás az utolsó perzisztált `pulse_count`/`offset_m3` alapján folytatódik.
  - Tápvesztéskor legfeljebb egy checkpoint-nyi impulzus veszhet el, emiatt újraindítás után az `Összes fogyasztás` kis mértékben visszaugorhat. Ez elfogadott mellékhatása a checkpoint-alapú perzisztenciának. A HA `total_increasing` szenzortípus alapvetően monoton növekvő értéket vár; a csökkenést bizonyos esetekben resetként kezeli, de ennek pontos viselkedése (pl. a kis mértékű csökkenésekre vonatkozó tolerancia) HA-verziófüggő és nem garantált – a hosszú távú statisztikák helyes működését implementáció közben külön ellenőrizni kell.
- Első implementáció nem igényel külső FRAM-ot vagy más kiegészítő nem felejtő memóriát.

### Hálózat és biztonság

- **Wi-Fi SSID/jelszó soha nem kerül fordítási időbe** (se `secrets.yaml`-ba, se máshova a firmware-t generáló repóban) – az eszköz Wi-Fi hitelesítő adat nélkül bootol, azt kizárólag futásidőben, az első indításkor kapja meg Bluetooth (BLE improv) vagy Wi-Fi hotspot (AP + captive portal) útján, és az ESP a saját flash-ébe menti (nem a build tárolja).
- Egyéb, eszköz-specifikus secretek (API titkosítási kulcs, OTA jelszó, admin jelszó az ESP saját webes felületéhez) ESPHome `secrets.yaml`-ban, verziókezelésből kizárva – ezeknek nincs futásidejű provisioning megfelelőjük az ESPHome-ban, de nem hálózati hitelesítők, nem szivárogtatnak semmit az otthoni hálózatról.

### Home Assistant adatmodell

Vízóránként (Fő vízmérő, Locsoló mérő):

Üzemi entitások:

- `Térfogatáram` – `L/min`, `state_class: measurement`
- `Összes fogyasztás` – `m³`, `device_class: water`, `state_class: total_increasing`

Diagnosztikai entitások:

- `Impulzusráta` – `impulzus/min`, `state_class: measurement`
- `Összes impulzus` – `impulzus`, state class nélkül (nincs szükség rá HA-statisztikában – arra az `Összes fogyasztás` szolgál –, és ugyanúgy visszaugorhatna tápvesztéskor, mint a `pulse_count`)

Beállító/szerviz entitások:

- fizikai vízóra állásának megadása (`m³`) + szinkronizálás
- nulla-átfolyás timeout (`number`, s)

Checkpoint időköz nem entitás, fix `60 s`, fordítási időben rögzítve (lásd Perzisztencia és hibakezelés).

### Idősoros adatok és statisztikák

- Az ESP nem tárol hosszú távú idősoros adatot; ez, valamint az aggregáció (óra/nap/hét/hónap) HA feladata.
- Térfogatáram és összesített fogyasztás legyen historizált a HA-ban.
- HA kiesése alatt az ESP folytatja a számlálást; a részletes térfogatáram-idősor megőrzése ESP oldalon nem követelmény.
- Visszakapcsolódáskor az ESP aktuális abszolút `pulse_count`/`offset_m3` alapú értéke az irányadó.

### Kalibráció

- Az impulzus–térfogat átváltás (`liters_per_pulse`) vízóránként konfigurálható.
- Az impulzusbemenet pergésmentesítése konfigurálható (ESPHome `pulse_meter` `internal_filter` paramétere, nem külön logika).

## Kezdeti implementációs döntések

- A `pulse_meter` végzi az impulzusérzékelést, pergésmentesítést és periódusidő-alapú rátamérést. A futásidőben állítható nulla-átfolyás timeout külön ESPHome logikával történik, mert a `pulse_meter.timeout` nem futásidőben konfigurálható.
- Közös logika egy ESPHome csomagban, vízóránkénti példányosítás `substitutions`-szel (`main`/`irrigation` id-prefix – a kódban és fájlnevekben angol terminológia, lásd `esphome/water-collector.yaml`).
- **Checkpoint (`pulse_count`)**: a futó `pulse_count` egy ESPHome `preferences`/`global` állapotban él, minden impulzusnál frissül. A tényleges flash-írást a `flash_write_interval: 60s` korlátozza – ez önmagában **nem** a checkpoint mechanizmusa, csak a fizikai flush gyakoriságát szabályozza, a checkpointot maga a preference-alapú tárolás adja. Ha a `pulse_count` az adott flush-időszak alatt nem változott, ne történjen felesleges fizikai írás – ezt implementáció közben ellenőrizni kell (az ESP-IDF NVS réteg elvben már önmagában kihagyja az azonos érték újraírását, de erre tesztelés nélkül nem szabad vakon támaszkodni).
- **Kézi szinkron (`offset_m3`)**: módosításkor explicit, azonnali preference-sync/`save()` történik, nem várja meg a `flash_write_interval`-t.
- **Nulla-átfolyás timeout megvalósítása**: saját, egyszerű "watchdog" logika – egy `interval:` komponens rendszeresen összeveti az utolsó impulzus időbélyegét a beállított timeout-tal, és lejáratkor explicit 0-ra állítja a Térfogatáram/Impulzusráta szenzorokat.

## Jelenleg nem követelmény

- Hibaészlelés/riasztás (szivárgás, csőtörés, tartós nulla fogyasztás stb.) – később, HA oldalon kerül definiálásra. A szükséges nyers adat (historizált `Összes fogyasztás`) már rendelkezésre áll ehhez, a jelenlegi adatmodell emiatt nem igényel bővítést. Felbontási korlát: `liters_per_pulse`-nál (1 l) kisebb szivárgás egy impulzusköznyi időn belül nem észlelhető.
- Fizikai/környezeti kialakítás (ház, védettség, tápellátás) – nem szoftverkövetelmény.
