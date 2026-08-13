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
- ESP board: **Waveshare ESP32-S3-RS485-CAN**, izolált RS485/CAN, DIN-sínes – **megérkezett, 2026-08-13**, a `water-collector.yaml` `substitutions`-ai (`board_type`, pulzus-GPIO-k) mostantól közvetlenül erre céloznak (a korábbi, nem-S3 tesztboard értékei kikommentezve maradtak referenciaként). Dokumentáció: [`docs/hardver/esp32-s3-rs485-can-board.md`](docs/hardver/esp32-s3-rs485-can-board.md) (+ eredeti PDF ugyanott). A jeladók a board SH1.0 csatlakozójára kerülnek: `1. vízmérő → GPIO1`, `2. vízmérő → GPIO2` (`meter1`/`meter2`, lásd Kezdeti implementációs döntések – melyik fizikai mérő melyik, az telepítésfüggő, nincs a kódba égetve).
- Két mérési pont, azonos modulstruktúrával, egymástól függetlenül. A jelen telepítésben (nem a firmware része, csak a konkrét beállítás):
  - **1. vízmérő ("Fő")** – teljes fogyasztás (ház + kert).
  - **2. vízmérő ("Locsoló")** – csak a kerti vízellátás (részhalmaza az elsőnek).
  - A ház-only fogyasztás (1. − 2.) HA oldali származtatott szenzorral számolható, nem ESP feladat.

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
- Egyéb, eszköz-specifikus secretek (API titkosítási kulcs, OTA jelszó) ESPHome `secrets.yaml`-ban, verziókezelésből kizárva – ezeknek nincs futásidejű provisioning megfelelőjük az ESPHome-ban, de nem hálózati hitelesítők, nem szivárogtatnak semmit az otthoni hálózatról.
- Az ESP saját webes felülete (dashboard) **nem kér jelszót** – tisztán helyi hálózaton elérhető, iOS-en kezdőképernyőre kitehető appként is használt felület, aminek egy bejelentkezési képernyő csak zavaró súrlódás lenne, valódi biztonsági nyereség nélkül (aki már rajta van az otthoni Wi-Fi-n, úgyis eléri). Tudatosan vállalt kompromisszum – ha valaha távolról/nem megbízható hálózatról is elérhető lenne az eszköz, ezt felül kell vizsgálni.

### Home Assistant adatmodell

Vízóránként (a jelen telepítésben: 1. vízmérő/"Fő", 2. vízmérő/"Locsoló" – lásd Scope):

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

**Javasolt kiegészítés (még nem eldöntött)**: `liters_per_pulse` jelenleg fordításidőben rögzített (`substitutions`) – tegyük futásidőben is állíthatóvá (pl. `number` entitás, hasonlóan a Nulla-átfolyás timeout-hoz), hogy egy más arányú vezeték bekötése (pl. a fehér 1:1 helyett sárga 10:1/zöld 100:1, lásd Hardver) vagy más gyártmányú impulzusadó ne igényeljen újraflashelést. Kockázat, amit kezelni kell: mivel `Összes fogyasztás = offset_m3 + pulse_count × liters_per_pulse / 1000`, egy futásidejű váltás a már felhalmozott `pulse_count`-ra visszamenőleg hatna – a váltáskor az `offset_m3`-at automatikusan újra kell számolni úgy, hogy az `Összes fogyasztás` ne ugorjon (hasonlóan a kézi szinkronhoz, csak automatikusan, a régi/új arány különbségére).

## Nyomásmérő modul

### Hardver

- Érzékelő: **QDW90A** (Anhui Qidian Automation Technology), diffúz szilícium piezorezisztív nyomás-távadó. Gyártói adatlap: [`docs/hardver/qdw90a-nyomastavado-adatlap.pdf`](docs/hardver/qdw90a-nyomastavado-adatlap.pdf), gyártói hivatalos Modbus-protokoll doksi: [`docs/hardver/qdw90a-modbus-protocol-gyartoi.pdf`](docs/hardver/qdw90a-modbus-protocol-gyartoi.pdf). **Modbus-regiszterek, bekötés, betanítás – saját, hardveren megerősített referencia**: [`docs/hardver/qdw90a-modbus-referencia.md`](docs/hardver/qdw90a-modbus-referencia.md).
  - **A beszerzett/tervezett kivitel**: RS485/Modbus RTU kimenet (az adatlap alapváltozata 4-20mA áramhurok, de a Modbus-kimenet is dokumentált kivitel, 4-vezetékes bekötéssel – **ezt a variánst rendeljük**), táp `24V DC`, mérési tartomány `0–10 bar` (`0–1.0 MPa`).
  - `G1/4` menetes csatlakozás, pontosság `±0.2% F.S.`, védettség `IP65`.
  - Kommunikáció a **Waveshare ESP32-S3-RS485-CAN** board saját, galvanikusan leválasztott RS485 illesztőjén keresztül (lásd [`esp32-s3-rs485-can-board.md`](docs/hardver/esp32-s3-rs485-can-board.md), `GPIO17` TX / `GPIO18` RX / `GPIO21` EN – ESPHome `uart: flow_control_pin` a hardveres RS485 fél-duplex módhoz) – **implementálva, 2026-08-13** (ld. Architekturális megfontolás v3 – Státusz), hardveres tesztelés még hátra van.
  - Darabszám: kezdetben **3 mérési pont** tervezve. Melyik fizikai pont mit mér (pl. bemenet/kimenet/szűrő előtt-után), az telepítésfüggő – ugyanúgy, mint a vízmérőknél, ez nem kerül a kódba égetve, futásidőben (Display Name) nevesíthető.
- **RS485 hub: CDEBYTE E810-R14** (1→4 irányú, opto-izolált RS485 repeater/hub) – a telepítés fizikai adottságai miatt a szenzorok nem köthetők egy szál kábelre daisy-chain-nel, csak csillag-topológiában; ez az eszköz oldja meg a csillag-kábelezést anélkül, hogy protokoll-szinten bármit is módosítana. Hivatalos user manual (letöltve, ellenőrzött forrás): [`docs/hardver/e810-r1x-rs485-hub-user-manual.pdf`](docs/hardver/e810-r1x-rs485-hub-user-manual.pdf).
  - **Fontos**: teljesen protokoll-átlátszó ("no configuration required, transparent data transmission between master and slave interfaces") – nem multiplexer, nem ismeri a Modbust. Pontosabban (a manual szerint): a host felőli adat egyszerre, broadcast-szerűen jut el mind a 4 kimeneti csatornára; a csatornák felől visszafelé jövő adatot a hub time-sharing módon (egyszerre csak egy csatornáról) továbbítja a host felé – ütközés nélkül, de a Modbus szintjén ez láthatatlan/irreleváns. A ráakasztott szenzoroknak emiatt továbbra is **egyedi Modbus-címre van szükségük** az egész buszon (ld. lent, "betanítás"), ez a hub bevezetésével nem változik.
  - **Csillag-kábelezés tisztázása**: a manual saját "Wiring Precautions" fejezete általános RS485-alapelvként "kerüld a csillag-topológiát, használj hand-in-hand (daisy-chain) bekötést" – ez viszont a **klasszikus, elágazásokkal teli busz** eseté vonatkozik (jel-visszaverődés/impedancia-illesztési probléma elágazási pontoknál). A mi terveink szerint **minden egyes hub-csatornára pontosan 1 szenzor** kerül (nem több szenzor elágaztatva egy csatornáról) – ez csatornánként egy tiszta, elágazás nélküli pont-pont összeköttetés, ami topológiailag **nem esik a "kerülendő csillag" kategóriába**, sőt jel-integritás szempontjából legalább annyira jó, mint egy daisy-chain. A hub saját csatlakozási rajzai (3. fejezet) kifejezetten mutatnak is egy hosztról induló, több szlévre ágazó elrendezést mint támogatott használati módot.
  - Saját táp: `DC 9–40V`, a busztól galvanikusan leválasztva (`1.5kV` izoláció, teljesen külön a jelföldtől – "power ground, not interoperable with digital signal ground"). A `24V DC`, ami a szenzoroknak amúgy is kell, ezen a tartományon belül van, tehát **valószínűleg ugyanarról a tápforrásról üzemeltethető**, csak külön föld-vezetékkel a hub saját táp-GND-jéhez. Van saját PE (védőföld) csatlakozója is, azt kösd földre.
  - Baud tartomány `300–230400` (egyéni baud is támogatott) – a szenzor `1200–115200` tartományát bőven lefedi. A busz össz-eszközszám korlátja `32` – ez az általunk tervezett 4 slot-nak bőven elég tartalékot ad.
  - Gyártói infó: [cdebyte.com/products/E810-R14](https://www.cdebyte.com/products/E810-R14).
  - **Miért kell a hub akkor is, ha a master board (ESP32-S3-RS485-CAN) RS485 illesztője már eleve izolált, és a kábelek csak pár méteresek?** Mert a master-oldali izoláció a masztert védi a buszról, nem a szenzorokat egymástól – hub nélkül csillagba kötve mind ugyanazon a közös, nem izolált buszszakaszon lennének, így egy eltérő földpotenciálú (más gépházban lévő) szenzor közös módusú feszültsége simán túlmehetne a driver tartományán. A hub csatornánként külön izolál, ez oldja meg ezt – a topológia (csillag vs. daisy-chain) önmagában, pár méteres kábellel és `9600` baudon valószínűleg amúgy sem okozna gondot.
- **Modbus regisztertérkép** – ⚠️ eredetileg nem hivatalos forrásból (HA közösségi fórum) állt össze, **2026-08-12-én kibővítve** egy sokkal részletesebb, szintén nem hivatalos, de alaposabb forrással (TapHome QDW90A kompatibilitási oldala, nyers jegyzet: [`docs/hardver/qdw90a-modbus-taphome-jegyzet.md`](docs/hardver/qdw90a-modbus-taphome-jegyzet.md) – munkaanyag, nem végleges referencia), **majd ugyanazon a napon egy teljes regiszter-scan-nel (`mbpoll`, `H:0–H:39`) a valós hardveren végigmérve**. Az alábbi táblázat **minden dokumentált regisztere hardveren megerősített**:

  | Reg. | Funkció | Mért érték | Állapot |
  | --- | --- | --- | --- |
  | `H:0` | Slave cím (`1–255`) | `1` | ✅ hardveren megerősítve |
  | `H:1` | Átviteli sebesség-kód (`0`=1200 … `7`=115200) | `3` = 9600 | ✅ hardveren megerősítve |
  | `H:2` | Mértékegység-kód (`3`=bar, teljes lista a TapHome-jegyzetben) | `3` = bar | ✅ hardveren megerősítve |
  | `H:3` | Tizedesjegyek száma – `érték = H:4 / 10^H:3` | `2` | ✅ hardveren megerősítve (tehát ténylegesen `/100`) |
  | `H:4` | Mérési érték, `Int16`, skálázás `H:3` szerint | `0` (terheletlen) | ✅ hardveren megerősítve, élőben reagál valós nyomásra (ld. lent) |
  | `H:5` | Méréstartomány alsó pontja | `0` | ✅ hardveren megerősítve |
  | `H:6` | Méréstartomány felső pontja | `1000` → `/100`-zal **10.00 bar** – egyezik a szenzor `0–10 bar` méréshatárával | ✅ hardveren megerősítve, és értelmes is |
  | `H:12` | Nullponteltolás, `Int16`, írható | `0` (gyári alapállapot) | ✅ hardveren megerősítve |
  | `H:15` | Beállítás mentése – `0` írása menti tartósan a `H:0`/`H:1`/stb. módosítását (**enélkül a változtatás elveszhet újraindításkor!**) | `0` (olvasva) | ✅ olvasva, ahogy vártuk – **írás még nincs kipróbálva** |
  | `H:16` | Gyári visszaállítás – `1` írása töröl mindent (cím, kalibráció is) | `0` (olvasva, **nem lett kiváltva**) | ✅ biztonságosan csak olvasva – **írást szándékosan nem próbáltunk ki** |
  | `H:22–H:23` | Mérési érték közvetlenül IEEE754 Float32-ként, big-endian/ABCD | `0.0` | ✅ hardveren megerősítve, egyezik a `H:4`-alapú olvasással – **firmware-hez ígéretes alternatíva** a `H:4`+`H:3` kombináció helyett |
  | `H:37` | Soros paritás (`0`=nincs, `1`=páratlan, `2`=páros) | `0` = nincs | ✅ hardveren megerősítve |

  **A TapHome-jegyzetben nem szereplő, de a teljes scan során talált, valószínűsíthetően valódi paraméterblokk** (`H:22`-től kezdve 2-2 regiszteres Float32 párok, "kerek" értékekkel – ez nem véletlen mintázat):

  | Regiszterpár | Float32 érték | Jelentés |
  | --- | --- | --- |
  | `H:24–H:25` | `0.0` | ismeretlen, illik a mintázatba |
  | `H:26–H:27` | `1.0` | feltételezés: kalibrációs szorzó/gain, jelenleg semleges értéken – **nincs megerősítve** |
  | `H:28–H:29` | `0.001` | feltételezés: felbontás/lépésköz paraméter – **nincs megerősítve** |

  **Egyéb, nem dokumentált, nem nulla regiszterek** a `H:0–H:39` scanből, jelentésük ismeretlen, firmware-ben nem használjuk őket: `H:8=2`, `H:9=-174`, `H:10=-180`, `H:11=13017`, `H:14=82`, `H:21=8`, `H:33=907`, `H:39=-21829`. (A `H:20` a nagy scan-ből valóban kimaradt, de **nem hiba/kihagyás volt** – ld. lent, "kérésméret-korlát", `H:20` maga rendben olvasható, `0` értékkel.)

  **⚠️ Kérésméret-korlát, firmware-releváns**: **egy `0x03` kérésben legfeljebb 20 regiszter kérhető le egyszerre** – 21 vagy több regiszterre a szenzor a teljes kérést elutasítja, a szabványostól eltérő `Illegal Function` kivétellel (nem a várt "Illegal Data Address"-szel). Reprodukálva: `H:1–H:20` (20 db, `-r 1 -c 20`) sikeres, `H:0–H:20` (21 db, `-r 0 -c 21`) teljes hiba. Ez magyarázza a korábbi, `H:0–H:39` scan során tapasztalt "kimaradt `H:20`" jelenséget is (az a kérés minden bizonnyal 20-nál több regisztert próbált egyben lekérni, és valahogy csak részlegesen jelent meg az eredmény). **A firmware-es Modbus-olvasást ennek megfelelően kell darabolni** (max 20 regiszter/kérés), ld. részletesen: [`docs/hardver/qdw90a-modbus-referencia.md`](docs/hardver/qdw90a-modbus-referencia.md).

  - **Slave cím (`H:0`) – ✅ megerősítve valós QDW90A egységen**, 2026-08-12, kézi Modbus RTU kerettel (FTDI USB-RS485 adapter, `9600 8N1`, közvetlenül a szenzorra kötve, hub nélkül): `01 03 00 00 00 01 84 0A` kérésre `01 03 02 00 01 79 84` érkezett vissza (érték `0x0001` = `1`). A bekötés a gyári kábelszínezés szerint `Piros=24V+`, `Fekete=24V-`, `Kék=PC-A`, `Sárga=PC-B` (a "Ground Wire" felirat a csatlakozó silkscreen-jén félrevezető ezen a kivitelen – nincs külön föld-ér, csak a táp `Fekete` vezetéke). Külön GND-vezeték az FTDI és a szenzor közt **nem** kellett hozzá (rövid, asztali teszt).
  - **Nyomásérték (`H:4`) – ✅ regiszter és skálázás is teljesen megerősítve**: nyugalomban `0` (várt érték terheletlen/légköri állapotban), majd a nyomáscsatlakozóba szájjal belefújva (a tényleges mérési úton, nem mechanikai membrán-nyomogatással) folyamatosan, monoton nőtt: `0 → 3 → 4 → 5` nyers érték (mindegyik CRC-vel ellenőrizve, valódi válasz). A `H:2`/`H:3` regiszterek (`mbpoll`-lal) külön kiolvasva: `H:2 = 3` (bar) és `H:3 = 2` (2 tizedesjegy) – tehát a `0 → 3 → 4 → 5` nyers érték ténylegesen `0.00 → 0.03 → 0.04 → 0.05 bar`-t jelent (`érték = H:4 / 100`), pontosan egyezve a korábbi feltevésünkkel és az emberi fújásnyomás (`~0.01–0.05 bar`) várt tartományával. **A `H:4`-ből számolt `bar` érték firmware-kódba építhető, nincs többé feltételezés benne.**

### Funkcionális követelmények

- A dashboard "Home" oldalán megjeleníti az aktuális nyomásértéket (`bar`), a vízmérők kártyáihoz hasonló elrendezésben.
- Minden nyomásmérő pont átnevezhető (Display Name), futásidőben – ugyanaz a minta, mint a vízmérőknél.
- **Szerviz/"betanítás" folyamat**: a Modbus slave cím (és opcionálisan a baud rate, ha a gyári alapértelmezett nem egyezik egységeknél) az ESP saját webes felületéről, futásidőben állítható/módosítható, méterenként – ez a mechanizmus teszi lehetővé, hogy 3 azonos gyári címről induló egységet egy közös buszon egyedileg meg lehessen különböztetni felszereléskor, újraflashelés nélkül.
- **Betanítási előfeltétel**: egyszerre csak **1, még gyári alapcímen lévő** eszköz lehet a buszon – ha több egyforma című egység van fent egyszerre, mindegyik válaszolna a lekérdezésre, a cím nem állítható be egyértelműen. Gyakorlatban: az új szenzort a hub adott csatornáján egyedül (a többi lekötve, vagy még be sem kötve) kell címezni, csak utána köthető rá a közös buszra a többihez.

### Architekturális megfontolás: "dinamikus" nyomásmérő-hozzáadás

- Az ESPHome **fordításidőben rögzített, statikus entitásmodellt** használ – nincs natív támogatás arra, hogy futásidőben, újraflashelés nélkül vadonatúj entitás (pl. egy negyedik nyomásmérő) jöjjön létre a semmiből.
- **Javasolt kompromisszum** (a vízmérő-modul mintájára, ott is bevált): fix számú, előre bekötött "slot" – **4 db** (döntés, felülírva a korábbi 8-as tervet: pontosan annyi, ahány fizikai portja van a tervezett E810-R14 hubnak, tartalék nélkül – ha a jövőben egy második hub vagy több szenzor kerülne a rendszerbe, ez a szám firmware-oldali bővítést és újraflashelést igényelne, ez elfogadott kompromisszum). Mindegyik slot:
  - alapból inaktív/rejtett a dashboard "Home" oldalán, amíg nincs hozzá betanított (Modbus-címmel ellátott) szenzor,
  - saját, futásidőben állítható Modbus slave címmel (a fenti "betanítás"),
  - saját Display Name-mel.
- **Konfigurációs UX (v2, implementálva)**: nem egyszerű be/kikapcsoló kapcsoló, hanem **Hozzáadás/Törlés**, kompakt táblázat (Név | Cím oszlopok) a Service oldalon:
  - alapból **egyetlen betanított slot sem látszik** sem a Home, sem a Service oldalon – csak egy "+" gomb, ami egy névbekérő mezőt nyit ("Pressure Sensors New Sensor Name" + "Pressure Sensors Add" entitások, `water-collector.yaml`),
  - "Hozzáadás"-ra a soron következő szabad slot (`packages/pressure_sensor.yaml`, `try_commission` script) felveszi a megadott nevet, és **onnantól** látszik a táblázatban és a Home kártyák közt is,
  - "Törlés"-re (a meglévő JS `confirm()` visszakérdezéssel, `CONFIRM_ON_PRESS`) a slot adatai visszaállnak alapállapotba, és **teljesen eltűnik** mindkét helyről,
  - a slot sorszáma (melyik fizikai slot-ID kapja a nevet) nem jelenik meg sehol, csak a Display Name – ez szándékos, ld. `pressure_sensor.yaml` fejléce.
- **Fontos technikai tanulság, ami a végleges tervet meghatározta**: az első próbálkozás a fenti "csak akkor létezzen, ha be van tanítva" hatást az ESPHome `internal` flag-jének **futásidejű** átkapcsolásával (`set_internal()`) próbálta elérni. A ténylegesen telepített ESPHome forrásában (`esphome/core/entity_base.h`) ellenőrizve kiderült: ez **hivatalosan deprecated, "undefined behavior"** 2026.3.0 óta ("Components and Home Assistant are NOT notified... Use the 'internal:' YAML key instead"), 2027.3.0-ban törlik – tehát erre nem lehet architektúrát építeni. **A végleges megoldás**: minden entitás mindig létezik (soha nem `internal`), a "betanítva van-e" állapotot egy sima, mindig küldött `binary_sensor` ("Commissioned") **értéke** jelzi, amit a dashboard saját JS-e (`web/dashboard.js`) értelmez – ez teljesen támogatott, élőben frissül, nem deprecated API-ra épül.
  - **Ennek ára – korlát, amit el kell fogadni**: mivel nincs megbízható, támogatott mód egy entitás valódi eltüntetésére HA elől futásidőben, a **"csak a látható szenzorokat engedjük HA felé" nem valósul meg 100%-osan** – HA mindig látni fogja mind a 4 slot entitásait, csak `disabled_by_default: true`-val, alapból kikapcsolt állapotban (a meglévő konvenció). Ez a gyakorlati plafon ESPHome natív API-val, MQTT discovery-alapú, teljesen más architektúra nélkül.
  - Korábbi, elvetett "kétlépéses gomb-megerősítés" ötlet (JS `confirm()` helyett) szintén okafogyottá vált – a meglévő `CONFIRM_ON_PRESS` JS-mechanizmus (amit már Update/Restart/Forget Wi-Fi is használ) pont erre való, nem kellett hozzá semmi új.
- Ez **nem korlátlan dinamikus bővítés**, hanem "4 előre definiált, egyenként konfigurálható slot" – ez pontosan a jelenlegi vízmérő-modul mintája is (2 fix slot, futásidőben nevesíthető/kapcsolható). Ha a cél valódi, darabszám-korlát nélküli bővíthetőség, az egy jelentősen nagyobb architekturális váltás lenne – erről külön kell dönteni, ha ez ténylegesen cél.
- **Státusz (a fenti, v2 leírás)**: implementálva volt, de a lenti v3-as tervezés **felülírja/kibővíti** – a v2 "+" folyamata (üres névmező, cím utólag kézzel) helyébe a scan-alapú, cím-előre-ismert hozzáadás lép. Újraírás szükséges, még nincs implementálva.

### Architekturális megfontolás v3 (2026-08-13): scan-alapú, "dinamikus DB-nek tűnő" tábla

Hosszabb tervezési beszélgetés eredménye – a cél egy olyan felület, ami úgy **viselkedik**, mintha egy tetszőleges méretű, dinamikus adatbázis-táblát mutatna (sorok jönnek-mennek, nincs látható "slot 3/8" sorszámozás), miközben a valóságban **8 fix, fordításidőben rögzített slot** van mögötte (ESPHome-korlát, ld. fent – ezt "elfedni" lehet a felületen, de megszüntetni nem).

- **Döntés: `N` vissza `8`-ra** (a korábbi, "elég a 4" döntés felülírva) – a hub ténylegesen `32` node-ot bír a buszon, a `4` önkényesen a hub fizikai portszámához lett igazítva. A `8` olcsó tartalék, jelentősen csökkenti annak esélyét, hogy a plafon ténylegesen elő is jöjjön.
- **Szigorú szétválasztás: perzisztens vs. élő/efemer adat** – ez a kulcs-felismerés, ami az egész tervet meghatározza:
  - **Perzisztens, slotonként**: kizárólag **cím + Display Name**. Semmi más (nincs külön "betanítva" flag – ld. lent, ez már a címből következik).
  - **Élő/efemer, soha nem tárolt, mindig frissülő**: busz-scan jelenléte, folyamatos pollozás online/offline állapota (`modbus_controller` `on_online`/`on_offline`, ld. Diagnosztika) – ezekből **kliens-oldalon (JS) számolt, sosem flash-be írt** állapot.
- **A táblázat sorai egy JOIN eredménye** (busz-scan találatai × a 8 slot jelenlegi címei, cím szerint):
  - **"Regisztrált, elérhető"** – van slotunk erre a címre, ÉS a legutóbbi scan/pollozás válaszolt rá.
  - **"Regisztrált, nem elérhető"** (LOST/ERROR) – van slotunk erre a címre, de a legutóbbi scan/pollozás **nem** kapott választ – ez pontosan az eredeti "3 eszköz van bekötve, csak 2 válaszol" jelzés, a JOIN természetes mellékterméke, nem külön funkció.
  - **"Új eszköz"** – a scan talált egy választó címet, de egyik slotunk sem regisztrálja – ide kerülnek a még nem betanított eszközök.
- **Hozzáadás – soronként, nem egy közös folyamat**: ha egyszerre több "Új eszköz" sor is látszik, mindegyiknél **saját "Hozzáadás" gomb** van (nem egy általános "+", ami kétértelmű lenne, melyik eszközre vonatkozik). A hozzáadás a scan-ből már ismert címet azonnal felveszi, csak nevet kell hozzá kérni – ezzel a v2-es "előbb név, aztán kézzel beírt cím" folyamata feleslegessé válik.
- **Plafon, őszintén kezelve**: ha mind a 8 slot foglalt, és a scan egy 9. (vagy további) választó, nem regisztrált címet is talál, az a sor **továbbra is megjelenik "Új eszköz"-ként**, de a "Hozzáadás" gombja **inaktív, egyértelmű üzenettel** ("nincs szabad hely – firmware-bővítés kell hozzá") – soha nem egy csendben semmit sem csináló gomb.
- **Cím módosítása regisztrált eszközön**: **ténylegesen újraprogramozza a fizikai eszközt is** (a dokumentált kétlépéses Modbus írás+mentés szekvenciával, ld. `docs/hardver/qdw90a-modbus-referencia.md`, `include/rs485_modbus.h`'s `change_address_and_save()`), nem csak a mi rekordunkat írja át – utána a rekord frissül, hogy kövesse az új címet. Sikertelen újraprogramozás esetén a rekord **akkor is** frissül (a `TemplateNumber` optimista publikálását/perzisztálását `set_action`-ből nem lehet visszagörgetni – ld. `pressure_sensor.yaml` saját megjegyzése), ez elfogadott, önkorrigáló rés: ha a fizikai cím valójában nem változott, a következő pollozás a (tévesen felvett) új címen sikertelen lesz, a slot "Lost" állapotba kerül – ugyanaz a valódi diagnosztikai jelzés, mint egy ténylegesen leszakadt szenzornál.
- **Ez nem egy külön "Sensor Config" oldal** (ahogy korábban felmerült) – egyetlen, egységesített nézet, ami kiváltja a jelenlegi "Pressure Sensors" táblázatot.
- **Státusz**: implementálva, 2026-08-13, **valódi Modbus RTU-val** a végleges Waveshare ESP32-S3-RS485-CAN boardon (`water-collector.yaml`'s `uart: rs485_uart`, protokoll-logika `include/rs485_modbus.h`-ban – saját, kézzel írt Modbus-mester, nem az ESPHome beépített `modbus_controller:`-je, mert az egy fordításidőben rögzített slave-címet feltételez, nekünk viszont slotonként futásidőben állítható cím kell, plusz busz-szintű címscan, amire a beépített komponensnek nincs megfelelője). Lefedett funkciók: valódi busz-scan (`scan_bus()`), slotonkénti folyamatos nyomás-pollozás + élő "Online" állapot (`read_pressure_bar()`, H:22–H:23 Float32), és a fenti valódi cím-újraprogramozás (`change_address_and_save()`). **Hardveren még nem tesztelve** (a `esphome config` séma-ellenőrzésen túl nincs mód valódi ESP-IDF fordításra ebben a sandboxban) – a felhasználó saját HA ESPHome add-on-ján keresztüli fordítás/flashelés/valós tesztelés van hátra.

### Busz-szkennelés és cím-váltás (2026-08-13: implementálva, valós Modbus-szal)

- **Busz-szkennelős betanítás**: a busz automatikus végigpásztázása (`1–247` cím, rövid `~25ms`/cím timeout-tal), hogy listázza, mely Modbus-címek elérhetők, de még nincsenek felvéve a mi listánkba – **implementálva** (`include/rs485_modbus.h`'s `scan_bus()`, a "Pressure Sensors Scan Bus" gomb, `water-collector.yaml`). A cím írása/mentése/olvasása a `docs/hardver/qdw90a-modbus-referencia.md`-ban dokumentált, gyártói hivatalos Modbus-doksi alapján megerősített eljárást követi.
- **Cím-váltás a már bekötött eszközön**: a pontos, hardveren megerősített eljárás – **implementálva** (`include/rs485_modbus.h`'s `change_address_and_save()`, `pressure_sensor.yaml`'s Modbus Address `set_action`) – **fontos részlet**: ez **nem egy Modbus-művelet**, a cím-írás válasza még a régi címről jön, a mentést (`H:15=0`) már az **új** címre kell küldeni; ezt a kétlépéses logikát a firmware kezeli, végén egy read-back-kel ellenőrizve.
- **Ütközés kimutatása – két különböző dolog, nem szabad összekeverni**:
  - **"Ugyanaz a cím szerepel kétszer a mi listánkban"** – ez tiszta szoftver, **implementálva van** (a táblázat Address mezőjének módosításakor kliens-oldali figyelmeztetés jön, ha a beírt cím már foglalt egy másik, általunk már betanított slotnál – csak figyelmeztet, nem tilt, hiszen ez nem a fizikai buszt ellenőrzi).
  - **Valódi elektromos/protokoll-szintű ütközés** (két fizikai eszköz tényleg ugyanazon a címen válaszol egyszerre) – **tisztázva, nem csak "hardverfüggő, majd eldöntjük"**: ez Modbus/RS485 szinten **alapvetően nem megbízhatóan kimutatható** – két egyidejűleg válaszoló eszköz jele egymást rontja el a buszon, ami a mester szemszögéből megkülönböztethetetlen attól, mintha egyáltalán nem válaszolt volna senki. **Nincs tervben megbízható élő ütközés-riasztás** – a védelem a megelőzés (egyszerre csak 1 be nem tanított eszköz a buszon betanításkor).

### Kalibráció

- A nyers regiszterérték (`H:4`) `bar`, 2 tizedesjegy skálázással érkezik (`/100`) – **hardveren és a gyártó hivatalos Modbus-doksijával is megerősítve** (`docs/hardver/qdw90a-modbus-referencia.md`), külön finomskálázás nem szükséges.
- **Nyitott kérdés lezárva**: kell-e finomkalibrációs eltolás? **Igen, és ez már be van építve magába az eszközbe** – a `H:12` (nullponteltolás) regiszter írható, `kimeneti nyomás = kalibrált mérés + H:12` képlettel (gyártói hivatalos doksi, 2026-08-13). **Nem kell saját szoftveres offset-réteget építeni az ESP oldalán** – elég egy UI-mező, ami közvetlenül ezt a regisztert írja (majd `H:15=0`-val menti), a vízmérők "Reading" mezőjéhez hasonló UX-szel.

### Diagnosztika

- Kommunikációs állapot méterenként (Modbus timeout/hiba) – egy busz-osztott szenzor hibája **nem befolyásolhatja** a többi szenzor működését (a busz maga megosztott, de a hibakezelés méterenként független legyen).
- **"Communication OK" – implementálva, 2026-08-13, a tervezettől eltérő úton**: az eredeti terv az ESPHome beépített `modbus_controller` komponensének `on_online`/`on_offline` mechanizmusára épített volna – ez viszont egy **fordításidőben rögzített** slave-címet feltételez controllerenként, ami összeegyeztethetetlen azzal, hogy nálunk slotonként **futásidőben** változhat a cím (ld. "Architekturális megfontolás v3"). Emiatt a `modbus_controller:`-t végül sehol nem használjuk – helyette saját, kézzel írt Modbus-mester (`include/rs485_modbus.h`), és a "Communication OK" jelzést egy slotonkénti "Online" `binary_sensor` adja (`pressure_sensor.yaml`), amit a nyomás-pollozás lambdája frissít minden sikeres/sikertelen olvasás után.
  - Nincs `max_cmd_retries`-szerű "N sikertelen próba után offline" logika – minden egyes `5s`-enkénti pollozás önmagában dönt, egyetlen kimaradt válasz azonnal "Lost"-ra váltja a slotot, a következő sikeres pollozás pedig azonnal vissza "OK"-ra. Ez egyszerűbb, mint a tervezett retry-alapú logika, és eddig elegendőnek tűnik – ha a gyakorlatban túl "villódzónak" bizonyul (átmeneti zajra túl érzékeny), egy egyszerű "N egymást követő hiba után Lost" számláló utólag hozzáadható.
  - **Érték-tartomány elleni külön védelem (`0–10 bar`) egyelőre nincs beépítve** – a pollozás jelenleg a Modbus-kommunikáció sikerességét tekinti "OK"-nak, a leolvasott értéket magát nem validálja tartomány szerint. Nyitva hagyott finomítás, nem blokkoló.
- **Gyors, teljes busz-scan diagnosztikai eszköz – implementálva, 2026-08-13**: a "Busz-szkennelés és cím-váltás" szakaszban leírt `scan_bus()` pontosan ezt a szerepet is betölti (jelzi pl. "3 eszköz van bekötve, csak 2 cím válaszol" eltérést) – a teljes `1–247` Modbus-tartományt pásztázza (nem csak `1–32`-t, ahogy eredetileg tervezve volt, mivel ez a korlát nem tartotta vissza a megvalósítást). **Korlátja továbbra is fennáll**: nem tudja megkülönböztetni egy halott eszközt egy cím-ütközéstől (mindkettő ugyanúgy "nincs válasz"-ként jelenik meg) – riasztás, nem pontos diagnózis, ld. fentebb az "Ütközés kimutatása" pontot.
- **Watchdog-crash a busz-scan alatt, valós hardveren reprodukálva és javítva, 2026-08-13**: egy teljes `1–247` scan szinkron módon, egy gombnyomásból fut le (~6mp, ha semmi nem válaszol) – ez alatt sosem tér vissza az ESPHome saját fő ciklusába, ami rendes körülmények között eteti az ESP-IDF task-watchdogot, ezért ~5mp után az eszköz összeomlott/újraindult. Javítás: a várakozó ciklus (`include/rs485_modbus.h`'s `wait_for_bytes()` – minden Modbus-tranzakció mögött ott van, nem csak a scan-nél) explicit `App.feed_wdt()`-et hív minden ciklus-fordulón.
- **Modbus-kommunikáció naplózása – implementálva, 2026-08-13**: a `rs485_modbus.h` minden művelete a `"modbus"` log-tag alatt naplóz. Alapból (a `logger:` `initial_level: DEBUG` beállításával) is látszik a busz-scan kezdete/vége (talált címek listája) és egy regisztrált slot sikertelen pollozása (a "Lost" jelzés oka) – ehhez nem kell semmit bekapcsolni. A teljes vezetékszintű részletezés (minden kiküldött/fogadott Modbus-keret hexában, CRC-hiba/időtúllépés/rossz cím oka soronként) `VERY_VERBOSE` szinten érhető el, amit a Log oldal saját "Debug: Modbus" kapcsolója (`water-collector.yaml`'s `switch:` szekció, `logger.set_level` akció) futásidőben be/ki kapcsol – alapból kikapcsolva, mert egyetlen teljes scan is ~250 sornyi naplót termelne rajta.

### Perzisztencia

- A slave cím (betanítás eredménye) és a Display Name futásidőben, azonnal perzisztálódjon (NVS) – a vízmérők `offset_m3`-ához hasonlóan, nem várja meg a checkpointot.
- A pillanatnyi nyomásérték maga **nem** perzisztens állapot (nincs "felhalmozás", mint a vízmérőknél) – újraindítás után egyszerűen az első sikeres Modbus-olvasás adja az aktuális értéket.

## Kezdeti implementációs döntések

- A `pulse_meter` végzi az impulzusérzékelést, pergésmentesítést és periódusidő-alapú rátamérést. A futásidőben állítható nulla-átfolyás timeout külön ESPHome logikával történik, mert a `pulse_meter.timeout` nem futásidőben konfigurálható.
- Közös logika egy ESPHome csomagban, vízóránkénti példányosítás `substitutions`-szel (`meter1`/`meter2` id-prefix – szándékosan generikus, semmilyen konkrét telepítésre jellemző név (pl. "Fő"/"Locsoló") nincs a kódba égetve; a kódban és fájlnevekben angol terminológia, lásd `water-collector.yaml`). Melyik fizikai mérő melyik, az a dashboard "Display Name" mezőjével, futásidőben állítható be.
- **Checkpoint (`pulse_count`)**: a futó `pulse_count` egy ESPHome `preferences`/`global` állapotban él, minden impulzusnál frissül. A tényleges flash-írást a `flash_write_interval: 60s` korlátozza – ez önmagában **nem** a checkpoint mechanizmusa, csak a fizikai flush gyakoriságát szabályozza, a checkpointot maga a preference-alapú tárolás adja. Ha a `pulse_count` az adott flush-időszak alatt nem változott, ne történjen felesleges fizikai írás – ezt implementáció közben ellenőrizni kell (az ESP-IDF NVS réteg elvben már önmagában kihagyja az azonos érték újraírását, de erre tesztelés nélkül nem szabad vakon támaszkodni).
- **Kézi szinkron (`offset_m3`)**: módosításkor explicit, azonnali preference-sync/`save()` történik, nem várja meg a `flash_write_interval`-t.
- **Nulla-átfolyás timeout megvalósítása**: saját, egyszerű "watchdog" logika – egy `interval:` komponens rendszeresen összeveti az utolsó impulzus időbélyegét a beállított timeout-tal, és lejáratkor explicit 0-ra állítja a Térfogatáram/Impulzusráta szenzorokat.
- **Helyi `web_server_idf` komponens-felülírás** (`components/web_server_idf/`, bekötve `water-collector.yaml`-ban `external_components:`-tel): valós eszközön reprodukált, forrásból (backtrace `addr2line`-nal dekódolva + upstream forrás olvasva) megerősített use-after-free hiba javítása az ESPHome beépített webszerver-komponensében – a "stuck EventSource connection" takarítás korábban a saját C++ objektumot törölte, mielőtt a `httpd` ténylegesen lezárta volna a hozzá tartozó socketet/session-t, ami később (más, ártatlan `free()` hívásnál, jellemzően az lwIP saját housekeeping-jében) heap-korrupcióhoz vezetett. A javítás a részletes indoklással együtt magában a felülírt `web_server_idf.cpp`-ben van dokumentálva. Upstreamben (esphome/esphome, 2026.7.3 és a jelenlegi main is) még nincs javítva; ha ez megtörténik, ez a felülírás (és a teljes `components/web_server_idf/` másolat) törölhető.

## Jelenleg nem követelmény

- Hibaészlelés/riasztás (szivárgás, csőtörés, tartós nulla fogyasztás stb.) – később, HA oldalon kerül definiálásra. A szükséges nyers adat (historizált `Összes fogyasztás`) már rendelkezésre áll ehhez, a jelenlegi adatmodell emiatt nem igényel bővítést. Felbontási korlát: `liters_per_pulse`-nál (1 l) kisebb szivárgás egy impulzusköznyi időn belül nem észlelhető.
- Fizikai/környezeti kialakítás (ház, védettség, tápellátás) – nem szoftverkövetelmény.
- **Nyomásmérő modul**: riasztás/küszöbérték-figyelés (alacsony/magas nyomás, pl. szivattyú-védelem) – ugyanúgy HA oldalon, később, ugyanazon elv szerint, mint a vízmérőknél. Historizáció szintén HA feladata (Scope szerint amúgy is általános elv).
- **Nyomásmérő modul**: finomkalibrációs UI (`H:12` nullponteltolás) – a regiszter írható és a képlet ismert (ld. "Kalibráció"), de nekünk explicit nem szükséges (a gyártói gyári kalibráció elég), ezért egyelőre nincs hozzá felületi elem.
