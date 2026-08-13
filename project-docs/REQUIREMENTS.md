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
- ESP board (tervezett, szállítás alatt): **Waveshare ESP32-S3-RS485-CAN**, izolált RS485/CAN, DIN-sínes. Dokumentáció: [`docs/hardver/esp32-s3-rs485-can-board.md`](docs/hardver/esp32-s3-rs485-can-board.md) (+ eredeti PDF ugyanott). A jeladók a board SH1.0 csatlakozójára kerülnek: `1. vízmérő → GPIO1`, `2. vízmérő → GPIO2` (`meter1`/`meter2`, lásd Kezdeti implementációs döntések – melyik fizikai mérő melyik, az telepítésfüggő, nincs a kódba égetve). A kezdeti teszteléshez másik (nem S3) boardot használunk, ezért a `board:` típus és a pulzus-GPIO-k a YAML-ban `substitutions`-ként paraméterezettek.
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

- Érzékelő: **QDW90A** (Anhui Qidian Automation Technology), diffúz szilícium piezorezisztív nyomás-távadó. Dokumentáció: [`docs/hardver/qdw90a-nyomastavado-adatlap.pdf`](docs/hardver/qdw90a-nyomastavado-adatlap.pdf).
  - **A beszerzett/tervezett kivitel**: RS485/Modbus RTU kimenet (az adatlap alapváltozata 4-20mA áramhurok, de a Modbus-kimenet is dokumentált kivitel, 4-vezetékes bekötéssel – **ezt a variánst rendeljük**), táp `24V DC`, mérési tartomány `0–10 bar` (`0–1.0 MPa`).
  - `G1/4` menetes csatlakozás, pontosság `±0.2% F.S.`, védettség `IP65`.
  - Kommunikáció a végleges **Waveshare ESP32-S3-RS485-CAN** board saját, galvanikusan leválasztott RS485 illesztőjén keresztül (lásd [`esp32-s3-rs485-can-board.md`](docs/hardver/esp32-s3-rs485-can-board.md)) – a jelenlegi tesztboardon (`esp32dev`) nincs RS485 illesztő, ezért a **tényleges Modbus-kommunikáció megvalósítása a végleges hardver megérkezéséig szándékosan várat magára** (ld. Architekturális megfontolás – Státusz).
  - Darabszám: kezdetben **3 mérési pont** tervezve. Melyik fizikai pont mit mér (pl. bemenet/kimenet/szűrő előtt-után), az telepítésfüggő – ugyanúgy, mint a vízmérőknél, ez nem kerül a kódba égetve, futásidőben (Display Name) nevesíthető.
- **RS485 hub: CDEBYTE E810-R14** (1→4 irányú, opto-izolált RS485 repeater/hub) – a telepítés fizikai adottságai miatt a szenzorok nem köthetők egy szál kábelre daisy-chain-nel, csak csillag-topológiában; ez az eszköz oldja meg a csillag-kábelezést anélkül, hogy protokoll-szinten bármit is módosítana. Hivatalos user manual (letöltve, ellenőrzött forrás): [`docs/hardver/e810-r1x-rs485-hub-user-manual.pdf`](docs/hardver/e810-r1x-rs485-hub-user-manual.pdf).
  - **Fontos**: teljesen protokoll-átlátszó ("no configuration required, transparent data transmission between master and slave interfaces") – nem multiplexer, nem ismeri a Modbust. Pontosabban (a manual szerint): a host felőli adat egyszerre, broadcast-szerűen jut el mind a 4 kimeneti csatornára; a csatornák felől visszafelé jövő adatot a hub time-sharing módon (egyszerre csak egy csatornáról) továbbítja a host felé – ütközés nélkül, de a Modbus szintjén ez láthatatlan/irreleváns. A ráakasztott szenzoroknak emiatt továbbra is **egyedi Modbus-címre van szükségük** az egész buszon (ld. lent, "betanítás"), ez a hub bevezetésével nem változik.
  - **Csillag-kábelezés tisztázása**: a manual saját "Wiring Precautions" fejezete általános RS485-alapelvként "kerüld a csillag-topológiát, használj hand-in-hand (daisy-chain) bekötést" – ez viszont a **klasszikus, elágazásokkal teli busz** eseté vonatkozik (jel-visszaverődés/impedancia-illesztési probléma elágazási pontoknál). A mi terveink szerint **minden egyes hub-csatornára pontosan 1 szenzor** kerül (nem több szenzor elágaztatva egy csatornáról) – ez csatornánként egy tiszta, elágazás nélküli pont-pont összeköttetés, ami topológiailag **nem esik a "kerülendő csillag" kategóriába**, sőt jel-integritás szempontjából legalább annyira jó, mint egy daisy-chain. A hub saját csatlakozási rajzai (3. fejezet) kifejezetten mutatnak is egy hosztról induló, több szlévre ágazó elrendezést mint támogatott használati módot.
  - Saját táp: `DC 9–40V`, a busztól galvanikusan leválasztva (`1.5kV` izoláció, teljesen külön a jelföldtől – "power ground, not interoperable with digital signal ground"). A `24V DC`, ami a szenzoroknak amúgy is kell, ezen a tartományon belül van, tehát **valószínűleg ugyanarról a tápforrásról üzemeltethető**, csak külön föld-vezetékkel a hub saját táp-GND-jéhez. Van saját PE (védőföld) csatlakozója is, azt kösd földre.
  - Baud tartomány `300–230400` (egyéni baud is támogatott) – a szenzor `1200–115200` tartományát bőven lefedi. A busz össz-eszközszám korlátja `32` – ez az általunk tervezett 4 slot-nak bőven elég tartalékot ad.
  - Gyártói infó: [cdebyte.com/products/E810-R14](https://www.cdebyte.com/products/E810-R14).
  - **Miért kell a hub akkor is, ha a master board (ESP32-S3-RS485-CAN) RS485 illesztője már eleve izolált, és a kábelek csak pár méteresek?** Mert a master-oldali izoláció a masztert védi a buszról, nem a szenzorokat egymástól – hub nélkül csillagba kötve mind ugyanazon a közös, nem izolált buszszakaszon lennének, így egy eltérő földpotenciálú (más gépházban lévő) szenzor közös módusú feszültsége simán túlmehetne a driver tartományán. A hub csatornánként külön izolál, ez oldja meg ezt – a topológia (csillag vs. daisy-chain) önmagában, pár méteres kábellel és `9600` baudon valószínűleg amúgy sem okozna gondot.
- **Modbus regisztertérkép** – ⚠️ eredetileg nem hivatalos forrásból (HA közösségi fórum) állt össze, **2026-08-12-én kibővítve egy sokkal részletesebb, szintén nem hivatalos, de alaposabb forrással**: a TapHome QDW90A kompatibilitási oldala (nyers jegyzet elmentve: [`docs/hardver/qdw90a-modbus-taphome-jegyzet.md`](docs/hardver/qdw90a-modbus-taphome-jegyzet.md) – **ez munkaanyag, nem a projekt saját, végleges referenciája**, ld. a fájl elején lévő figyelmeztetést). Az alábbi táblázat ebből a bővebb forrásból való; a **✅ jelölésű sorok valós hardveren is megerősítve**, a többi egyelőre csak a TapHome-jegyzet állítása.

  | Reg. | Funkció | Állapot |
  | --- | --- | --- |
  | `H:0` | Slave cím (`1–255`, gyári `1`) | ✅ **hardveren megerősítve** (ld. lent) |
  | `H:1` | Átviteli sebesség – **kód, nem a nyers baud-érték!** (`0`=1200, `1`=2400, `2`=4800, `3`=9600, `4`=19200, `5`=38400, `6`=57600, `7`=115200) | nincs hardveren ellenőrizve – **korábbi feltevésünk hibás volt**, azt hittük `H:1` a baud-értéket magát tárolja |
  | `H:2` | Mértékegység-kód (`0`=MPa, `1`=kPa, `2`=Pa, `3`=bar, `4`=mbar, `5`=kg/cm², `6`=PSI, `7-10`=vízoszlop-egységek, `11-13`=higanyoszlop-egységek, `14`=atm, `15`=Torr, `16-18`=folyadékszint m/cm/mm, `19`=kg, `20`=°C, `21`=pH, `22`=°F) | nincs hardveren ellenőrizve – **ezt még nem tudjuk biztosan, hogy a mi egységünkön tényleg `3` (bar)-e** |
  | `H:3` | Tizedesjegyek száma – **a skálázás ebből számolódik, nem fix `/100`!**: `érték = H:4 / 10^H:3` | nincs hardveren ellenőrizve |
  | `H:4` | Mérési érték, `Int16`, skálázás `H:3` szerint | ✅ **regiszter megerősítve, élőben reagál valós nyomásra** (ld. lent) |
  | `H:5` | Méréstartomány alsó pontja | nincs hardveren ellenőrizve – korábban nem is szerepelt a térképünkben |
  | `H:6` | Méréstartomány felső pontja ("Range Full Point") | nincs hardveren ellenőrizve |
  | `H:12` | Nullponteltolás ("Zero Bit Offset"), `Int16`, írható, gyári `0` | nincs hardveren ellenőrizve |
  | `H:15` | Beállítás mentése – `0` írása menti tartósan a `H:0`/`H:1`/stb. módosítását (**enélkül a változtatás elveszhet újraindításkor!**) | nincs hardveren ellenőrizve |
  | `H:16` | Gyári visszaállítás – `1` írása töröl mindent (cím, kalibráció is) | nincs hardveren ellenőrizve – **óvatosan** |
  | `H:22–H:23` | A mérési érték **közvetlenül IEEE754 Float32-ként**, big-endian/ABCD sorrend – nem igényel `H:3` szerinti skálázást | nincs hardveren ellenőrizve, de **firmware-hez ígéretes alternatíva** a `H:4`+`H:3` kombináció helyett |
  | `H:37` | Soros paritás (`0`=nincs, `1`=páratlan, `2`=páros) | nincs hardveren ellenőrizve |

  - **Slave cím (`H:0`) – ✅ megerősítve valós QDW90A egységen**, 2026-08-12, kézi Modbus RTU kerettel (FTDI USB-RS485 adapter, `9600 8N1`, közvetlenül a szenzorra kötve, hub nélkül): `01 03 00 00 00 01 84 0A` kérésre `01 03 02 00 01 79 84` érkezett vissza (érték `0x0001` = `1`). A bekötés a gyári kábelszínezés szerint `Piros=24V+`, `Fekete=24V-`, `Kék=PC-A`, `Sárga=PC-B` (a "Ground Wire" felirat a csatlakozó silkscreen-jén félrevezető ezen a kivitelen – nincs külön föld-ér, csak a táp `Fekete` vezetéke). Külön GND-vezeték az FTDI és a szenzor közt **nem** kellett hozzá (rövid, asztali teszt).
  - **Nyomásérték (`H:4`) – ✅ regiszter megerősítve, élőben reagál valós nyomásra**: nyugalomban `0` (várt érték terheletlen/légköri állapotban), majd a nyomáscsatlakozóba szájjal belefújva (a tényleges mérési úton, nem mechanikai membrán-nyomogatással) folyamatosan, monoton nőtt: `0 → 3 → 4 → 5` nyers érték (mindegyik CRC-vel ellenőrizve, valódi válasz). Ha `H:2`=bar és `H:3`=2 (a korábbi feltevésünk), ez `0.00–0.05 bar`-t jelent egy finom-közepes szájjal fújt nyomástól – emberi fújásnyomás jellemzően kb. `0.01–0.05 bar`, tehát nagyságrendileg stimmel. **Fontos**: ugyanezt a nyers `0–5` értéket kapnánk `H:2`=kPa és `H:3`=0 esetén is (`1 kPa = 0.01 bar`) – a két eset numerikusan megkülönböztethetetlen ebből a tesztből, csak a végeredmény (`bar`) esik egybe. **Következő teszt lépés**: olvasd ki a `H:2` és `H:3` regisztereket is, hogy tényleg tudjuk, melyik eset áll fenn – ne csak feltételezzük.

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
- **Státusz**: a fenti slot-modell és kommissziós UX (mock adattal) implementálva van, tesztelésre vár a valós eszközön. A tényleges Modbus-kommunikáció a végleges Waveshare board megérkezéséig várat magára.

### Jövőbeli, hardverfüggő ötletek (nincs implementálva – valós RS485/Modbus hardver kell a kipróbálásukhoz)

- **Busz-szkennelős betanítás**: ha van rá mód, betanításkor a busz automatikus végigpásztázása, hogy listázza, mely Modbus-címek elérhetők, de még nincsenek felvéve a mi listánkba – kényelmesebb lenne, mint kézzel beírni a címet. Igényel egy működő Modbus-scanner rutint a firmware-ben, amit csak a hub + legalább 1 valódi szenzor megérkezése után lehet kipróbálni/megépíteni.
- **Cím-váltás a már bekötött eszközön (varázsló)**: a felületen rövid instrukció ("csak 1 eszköz legyen a buszon") → busz végigpásztázása a jelenlegi cím megtalálásához → új cím bekérése → ha az új cím már szerepel a nálunk regisztrált címek közt, csak figyelmeztetés (nem tiltás). Ugyanúgy hardverfüggő (a "pásztázás" lépéshez valós Modbus-kommunikáció kell).
- **Ütközés kimutatása – két különböző dolog, nem szabad összekeverni**:
  - **"Ugyanaz a cím szerepel kétszer a mi listánkban"** – ez tiszta szoftver, **implementálható most is** (be is építettem: a táblázat Address mezőjének módosításakor kliens-oldali figyelmeztetés jön, ha a beírt cím már foglalt egy másik, általunk már betanított slotnál – csak figyelmeztet, nem tilt, hiszen ez nem a fizikai buszt ellenőrzi).
  - **Valódi elektromos/protokoll-szintű ütközés** (két fizikai eszköz tényleg ugyanazon a címen válaszol egyszerre) – ehhez tényleges Modbus-kommunikáció kell (pl. egy cím lekérdezésére több/inkonzisztens válasz érkezik) – ez **hardverfüggő, nincs implementálva**, csak a hardver megérkezése után dönthető el, hogyan észleljük megbízhatóan.

### Kalibráció

- A nyers regiszterérték a fenti (nem hivatalos) térkép szerint már eleve `bar`, 2 tizedesjegy skálázással érkezik – feltehetően elég `/100`-zal osztani, külön finomskálázás valószínűleg nem szükséges. Ezt a valódi hardveren kell megerősíteni.
- **Nyitott kérdés**: kell-e finomkalibrációs eltolás (pl. ha a gyári nullázás/kalibráció telepítés után nem elég pontos)? Javaslat: igen, egy egyszerű, futásidőben állítható additív offset (`bar`), a vízmérők "Reading" mezőjéhez hasonló UX-szel – de csak ha a gyakorlatban indokolttá válik, elsőre elhagyható.

### Diagnosztika

- Kommunikációs állapot méterenként (Modbus timeout/hiba) – egy busz-osztott szenzor hibája **nem befolyásolhatja** a többi szenzor működését (a busz maga megosztott, de a hibakezelés méterenként független legyen).
- Utolsó sikeres olvasás időbélyege / "elavult" (stale) jelzés, ha egy adott szenzor tartósan nem válaszol – hasonló szerepű, mint a vízmérők Nulla-átfolyás timeout-ja, csak itt kommunikációs hibát, nem mérési állapotot jelez.
- **Javasolt védelem**: a fizikai szenzor kalibrált tartományán (`0–10 bar`, kis toleranciával) kívül eső érték inkább szenzor-/kommunikációs hibaként kezelendő, nem valós mérésként (hasonló elv, mint a nulla-átfolyás timeout: egy nyilvánvalóan érvénytelen érték explicit jelzése jobb, mint csendben megjeleníteni).

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
- **Nyomásmérő modul**: tényleges Modbus RTU kommunikáció megvalósítása – a végleges Waveshare ESP32-S3-RS485-CAN board megérkezéséig szándékosan várat magára (a jelenlegi tesztboardon nincs RS485 illesztő). Addig csak a követelmények/architektúra tisztázása zajlik.
