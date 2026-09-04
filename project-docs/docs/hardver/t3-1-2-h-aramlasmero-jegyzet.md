# T3-1-2-H ultrahangos átfolyásmérő (flow meter) - munkaanyag, nem végleges

⚠️ **Ez egy nyers, folyamatban lévő jegyzet**, ugyanaz a szerep, mint
`qdw90a-modbus-taphome-jegyzet.md`-nek volt a QDW90A-nál: rögzíti, mit
tudunk EDDIG a forrásdokumentumból, és mi hiányzik még - NEM egy kész,
végleges referencia. A tényleges, megbízható Modbus regisztertérkép
(mint a QDW90A-nál a végül `mbpoll`-lal, valós hardveren felvett tábla)
még nem áll rendelkezésre.

**Forrás**: `t3-1-2-h-aramlasmero-quick-install.pdf` (a felhasználó által
küldött gyártói "Quick Installation and Operation" füzet, 2026-08-19) -
ez egy telepítési/kezelési gyorsútmutató, **NEM tartalmaz Modbus
regisztercím-táblázatot**. A dokumentum saját maga utal egy bővebb
"ultrasonic water meter user manual"-ra a menük/protokoll részleteiért -
ez a bővebb kézikönyv még nincs meg.

**Konkrét beszerzés, 2026-08-19**: a felhasználó megmutatta a tényleges
rendelést - AliExpress, "Fexda Tools Store" viszonteladó, "Digital
Ultrasonic Water Meter RS485 Remote Transmission Flow Meter", **DN20**
méret, kb. 41.000 Ft. **Ez fontos árnyalás a lenti "válassz 2-t a
8-ból" gyári egyedi-rendelés kérdéshez képest**: ez egy kész,
viszonteladói fix SKU, nem közvetlen gyári konfigurálható rendelés, így
valószínűleg EGY rögzített, alapértelmezett konfigurációban érkezik - a
termékcím maga is kifejezetten "RS485 Remote Transmission"-t emel ki
egyedüli kommunikációs jellemzőként, ami arra utal, hogy ezen a konkrét
terméken az RS485 valószínűleg alapértelmezett/mindig kivezetett
interfész, nem egy választható opció. A tápellátás (elem vs. külső DC)
ettől függetlenül még mindig nyitott kérdés - beérkezéskor fizikailag
ellenőrizendő (van-e a kábelben ténylegesen 4 külön ér, vagy csak a
Sárga/Zöld RS485 pár). **Lezárva 2026-09-02**: 4 ér van, a külső DC
működik és az egész fogyasztást viszi - a részletes mérés és a belőle
következő üzemeltetési követelmény lent, a "Tápellátás" pontnál.

## ⭐ Hivatalos Modbus regisztertérkép megtalálva - 2026-08-19, LEGFONTOSABB FRISSÍTÉS

A felhasználó megnyitotta és lefotózta (screenshot-okkal) a korábban
csak névről ismert **"T3-1 SERIES ultrasonic water meter communication
protocol"** AnyFlip-dokumentumot (`https://anyflip.com/jdpqf/cvgl/basic`)
- ez a gyártó saját, teljes kommunikációs protokoll-leírása a "V51"
firmware-hez (pontosan az a verzió, amit a T3-1-K1 testvér-kézikönyv is
mutatott). **Ez lényegesen megbízhatóbb forrás, mint a Gemini generált
táblája** - nem harmadik fél generikus protokollja, hanem a gyártó saját
dokumentuma, konkrétan erre a család(V51)-ra. **Egyetlen fenntartás**:
még nincs valós hardveren (`mbpoll`) leellenőrizve - ugyanaz az elv,
mint a QDW90A-nál: ez az "erős kiindulás", a végleges megerősítés a
tényleges eszközön történik majd.

### Alapértelmezett RS485/Modbus beállítások (VÉGLEGESEN eldöntve, forrás megvan)

```
RS485/USART: 9600 baud, N (nincs paritás), 8 adatbit, 1 stopbit
IR:          9600 baud, N (nincs paritás), 8 adatbit, 1 stopbit
Cím:         1 (gyári alapértelmezett, max. 255)
```

Ez **cáfolja a Gemini saját állítását** (2400 bps, 8E1) - a Gemini
forrásai (más gyártók generikus protokolljai) tévesek voltak erre a
konkrét családra. Ez EGYEZIK a saját websearch-öm találatával (9600,
no parity, 8N1). Módosítható a `V49_SETUP` nevű gyártói szoftverrel,
vagy Modbus-on/infravörösön keresztül (0062-es regiszter, ld. lent), az
aktuális beállítás az M0E menüben is megnézhető a kijelzőn.

Támogatott protokollok (mind ugyanazon a fizikai RS485 vonalon,
váltogatható): **a. HART, b. MODBUS, c. M-BUS, d. Haifeng ASCII, e.
CJ188, f. Huizhong-protokollok**.

### Modbus "common register" tábla (Function Code 03, Read Holding Registers)

⚠️ A regisztercímek 1-alapúak (nem 0-alapúak) ebben a dokumentumban -
a `mbpoll`/driver-kódnál erre figyelni kell (esetleges off-by-one).
IEEE754 = 32 bites Float, 2 egymást követő regiszterben. A táblázat
"LONG" oszlopai szintén 2 regiszteresek.

| Regiszter | Formátum | Leírás | Mértékegység |
|---|---|---|---|
| 0001-0002 | IEEE754 | Pillanatnyi átfolyás (instant flow rate) | m³/h |
| 0003-0004 | IEEE754 | Pillanatnyi hőteljesítmény (instant heat rate) | kW |
| 0005-0006 | IEEE754 | Áramlási sebesség (flow velocity) | m/s |
| 0009-0010 | LONG | Pozitív összesített átfolyás (egész rész) | m³/L/GAL/ft³ (ld. 1438) |
| 0011-0012 | IEEE754 | ...tizedes rész | |
| 0013-0014 | LONG | Negatív összesített átfolyás (egész rész) | |
| 0015-0016 | IEEE754 | ...tizedes rész | |
| 0017-0018 | LONG | Pozitív összesített hő (egész rész) | kWh/GJ/KBTU (ld. 1441) |
| 0019-0020 | IEEE754 | ...tizedes rész | |
| 0021-0022 | LONG | Negatív összesített hő (egész rész) | |
| 0023-0024 | IEEE754 | ...tizedes rész | |
| 0025-0026 | LONG | Nettó összesített átfolyás (egész rész) | |
| 0027-0028 | IEEE754 | ...tizedes rész | |
| 0029-0030 | LONG | Nettó összesített hő (egész rész) | |
| 0031-0032 | IEEE754 | ...tizedes rész | |
| 0033-0034 | IEEE754 | Előremenő vízhőmérséklet T1 | °C |
| 0035-0036 | IEEE754 | Visszatérő vízhőmérséklet T2 | °C |
| 0053-0055 | BCD (3 reg) | Naptár (dátum+idő), írható, SMHDMY sorrend, alsó bájt elöl | |
| 0057 | Integer | Jelszó beírása (védelemhez) | |
| 0058 | Integer | Alvó mód kódja, írható | |
| 0059 | Integer | Billentyűzet-emuláció | |
| 0060 | Integer | Aktuális menü-pozíció | |
| 0061 | Integer | Aktuális menü | |
| **0062** | Integer | **Fő kommunikációs cím, írható, max 255** | |
| 0063 | Integer | Batch Controller (BC) timer, 0-ra írás indítja | |
| 0064-0065 | Integer | OCT1/OCT2 pulzusszám | |
| 0071 | Bits | Kiegészítő hibakód (note 4) | |
| **0072** | Bits | **Hibakód (note 5)** - a §7.1 fault-handling bitmaszk (ld. a korábbi szakaszban) | |
| 0077-0078 | IEEE754 | T1 ellenállásérték | Ω |
| 0079-0080 | IEEE754 | T2 ellenállásérték | Ω |
| 0081-0082 | IEEE754 | Teljes transit-time | µS |
| 0083-0084 | IEEE754 | Transit-time (finomabb) | nS |
| 0092 | Integer | Jelminőség (channel 1 alsó byte-ban) | |
| 0093 | Integer | #1 csatorna jelerősség | 0-4095 |
| 0094 | Integer | #2 csatorna jelerősség | 0-4095 |
| **0095** | Integer | **Elem-feszültség: V = REG95 × (2.5/4096)** | V |
| 0099-0102 | IEEE754 | Reynolds-szám + korrekciós tényező | |
| 0105-0106 | Long | Teljes üzemidő | s |
| 0107-0108 | Long | Bekapcsolások száma | |
| 0109-0110 | IEEE754 | CPU hőmérséklet | °C |
| 0113-0136 | IEEE754/LONG | Régi (lebegőpontos) napi/havi/nettó összesítő regiszterek - **a dokumentum kifejezetten "Not Recommended to read... due to limited accuracy" megjegyzéssel jelöli, NE ezeket használjuk** | |
| 0137-0138 | LONG | Napi összesített átfolyás (9 jegyű) | |
| 0139-0140 | IEEE754 | ...tizedes rész | |
| 0141-0144 | LONG+IEEE754 | Havi összesített átfolyás + tizedes | |
| 0144-0148 | LONG+IEEE754 | Éves összesített átfolyás + tizedes (⚠️ a forrás táblázatban a 0144 cím kétszer szerepel - havinál ÉS évesnél is - ez valószínűleg elgépelés a dokumentumban, hardveren tisztázandó) | |
| 0149-0156 | LONG+IEEE754 | Napi/havi összesített hő + tizedesek | |
| 0162 | Integer | Napi archívum-mutató (0-511) | |
| 0163 | Integer | Havi archívum-mutató (0-127) | |
| 0165-0166 | Long | Hiba-üzemidő | s |
| 0181-0182 | IEEE754 | Hőmérsékletkülönbség (T1-T2) | °C |
| 0221-0222 | IEEE754 | Csőátmérő (belső) | mm |
| 0259-0266 | IEEE754 | Havi max pillanatnyi átfolyás/hő/be-/kifolyó hőmérséklet | |
| 0271-0272 | IEEE754 | Transit-time | nS |
| 0273-0274 | BCD | M-Bus másodlagos cím | |
| **1438** | Integer | **Átfolyás mértékegység-kódja: 0=m³, 1=liter, 2=US gallon, 5=köbláb** | |
| 1439 | Integer | Átfolyás skálázó kitevő (n: -4..3, ld. Note1 lent) | |
| 1440 | Integer | Hő skálázó kitevő (n: -3..4) | |
| **1441** | Integer | **Hő mértékegység-kódja: 0=GJ, 1=Kilo BTU, 2=kWh** | |
| 1491 | Integer | Műszer-típus | EN1434-3 |
| 1527 | Integer | Szoftververzió (note 3) | |
| 1528 | Integer | Gyártó-azonosító, érték=0x1188 (note 3) | |
| 1529-1530 | BCD | ESN (gyári sorozatszám), MSB elöl | |

**Skálázási képlet (Note 1, kritikus a driver-kódhoz)**: minden
"összesítő" (accumulated flow/heat) érték egy LONG egész rész (N) + egy
IEEE754 tizedes rész (Nf) párosból áll, és egy külön "multiple factor"
(n, 1439/1440-es regiszter) hatványkitevő skálázza:

```
végső érték = (N + Nf) × 10^n
```

Példa a dokumentumból: N=123456789, Nf=0.123, n=3 -> végső érték =
123456.789123 (a mértékegység az 1438/1441 kódtól függ). **Fontos
figyelmeztetés**: a dokumentum egy korábbi (0113-0136 tartományú)
lebegőpontos regiszter-készletet kifejezetten elavultnak/pontatlannak
jelöl - a 0009+ tartomány (LONG+decimális pár + skálázó kitevő) a
javasolt, pontos út.

### Napi/havi archívum-blokkok (KÜLÖN regiszter-tartomány, nem a fentiek)

Két nagy, körkörös archívum, mindkettő a fenti 0162/0163-as
mutató-regiszterrel indexelve, 32 regiszteres blokkokban:

- **Napi archívum**: reg. **5377**-től indul (blokk 0), 512 blokk (0-511),
  blokkonként 32 regiszter - dátum, üzemóra, hiba-óra, napi átfolyás/hő
  összesen, pozitív/negatív átfolyás/hő, tarifa2/3, max átfolyás/hő/
  hőmérsékletek.
- **Havi archívum**: reg. **29953**-tól indul (blokk 0), 128 blokk
  (0-127), ugyanaz a 32-regiszteres szerkezet, havi bontásban.
- **Bekapcsolás-idő tábla** (külön, kisebb): reg. **28929**-től, 255
  blokk, blokkonként 4 regiszter (dátum/idő BCD).
- Egy dedikált **kommunikáció-teszt regiszter (REG361)**: ha nem
  "361.0"-t olvasol vissza, a cím/kommunikáció hibás.

### Egyéb, a protokoll-dokumentumban talált, nem-Modbus tartalom (feljegyzés, valószínűleg nem lesz szükség rá)

- **Part Five - "Haifeng ASCII protocol"**: egy teljesen külön,
  szöveges parancskészlet (pl. `DQD(cr)` = napi átfolyás lekérése,
  `MENUXX(cr)` = menüváltás) - alternatíva a Modbushoz képest, nem
  releváns, ha Modbus RTU-t használunk.
- **Part Four - M-BUS Communication Protocol**: IEC 870-5-1/DIN
  EN1434-3 keretezés, alapértelmezett baud IR=2400/RS485=9600, Even
  paritás, 8 adatbit - ez a mi szempontunkból csak akkor releváns, ha
  végül M-Bus-t választanánk Modbus helyett (nem tervezett).
  Cím-módosítás/broadcast-keresés parancsai is dokumentálva.
- **Part Six/Seven - "Compatibility Protocol" / CJ-188-2004**: kínai
  szabványos hőmennyiségmérő-protokollok, 68h-16h keretezéssel - nem
  relevánsak a mi Modbus-alapú tervünkhöz.
- **Part Two - HART Protocol**: a 4-20mA hurkon keresztüli HART
  kommunikáció leírása - szintén nem releváns, ha nem használjuk a
  4-20mA kimenetet.

## Amit a füzetből tudunk

- **Típus**: T3-1-2-H, ultrahangos (transit-time) vízmérő/átfolyásmérő,
  ISO4064-1:2005 és GB/T778.1-2007 szerint. Rendelhető DN15/DN20/DN25/
  DN32/DN40 méretben, ehhez tartozó áramlási tartományok (Q1-Q4) és
  méretek a füzet 3-4. oldalán. A gyári tábla (füzet 4. oldal,
  "4.1 Flow Rate"), m³/h-ban:

  | DN | R | Starting | Q1 (min) | Q2 (átmeneti) | Q3 (névleges) | Q4 (túlterh.) |
  |----|-----|-------|-------|-------|--------|--------|
  | 15 | 200 | 0.003 | 0.013 | 0.020 | 2.500  | 3.125  |
  | **20** | **200** | **0.004** | **0.016** | **0.026** | **3.200** | **4.000** |
  | 25 | 100 | 0.010 | 0.040 | 0.064 | 4.000  | 5.000  |
  | 32 | 100 | 0.016 | 0.063 | 0.101 | 6.300  | 7.875  |
  | 40 | 100 | 0.050 | 0.200 | 0.320 | 20.000 | 25.000 |

  **A miénk DN20.** Ebből következik, hogyan kell olvasni a kis
  átfolyásokat: a Q1 = 0.016 m³/h az a legkisebb érték, amire az ISO4064
  szerint egyáltalán van pontossági követelmény; a 0.004 m³/h-s
  "starting flowrate" alatt a mérő definíció szerint nem indul el. A
  kettő közti sáv (0.004-0.016) az, ahol a mérő már mutathat valamit, de
  semmi nem garantálja, hogy mit - itt egy 0-ra váltás a specifikáción
  belül van, nem hiba. Valós eszközön megfigyelve (2026-09-02): kb.
  0.009 m³/h (~0.15 l/min) alatt a pillanatnyi átfolyás regisztere 0-t
  ad, ami pont ebbe a sávba esik. A firmware nem szűr és nem kerekít
  ide semmit - a `plausible()` sáv +-10000 m³/h (`include/rs485_modbus.h`),
  a kijelzés 6 tizedes -, tehát ez a mérő saját alsó levágása.
- **Kommunikáció, FONTOS, valós integrációs kockázat**: a füzet szerint
  a meghatározott protokollok **MBUS, MODBUS, ASCII, CJ188** - tehát ez
  egy TÖBBPROTOKOLLOS eszköz, nem eleve Modbus RTU-ra fixált, mint a
  QDW90A. A vezetékezés is KÉT KÜLÖN interfészt ad ugyanazon a 4-eres
  kábelen:
  - Piros = MBUS+, Fekete = MBUS− (polaritás-független, "MBUS does not
    need to distinguish between positive and negative")
  - Sárga = 485+, Zöld = 485− (ez a mi meglévő RS485/Modbus RTU
    buszunkkal kompatibilis pár - `esp32-s3-rs485-can-board.md` GPIO17/
    18/21 - EZT kell a meglévő buszra kötni, NEM az MBUS párt)
  - **Nyitott kérdés, tisztázandó rendelés/beérkezés után**: hogy van-e
    az eszközön külön beállítás/kapcsoló, ami kiválasztja, hogy a
    485+/− páron ténylegesen Modbus RTU-t vagy valami mást beszél-e -
    ha gyárilag más protokollra van állítva a soros kimenet, a
    `scan_bus()`/`probe()` egyszerűen nem fog választ kapni, ami
    kívülről megkülönböztethetetlen egy vezetékezési hibától. Érdemes
    lenne rendeléskor/beérkezéskor konkrétan rákérdezni/ellenőrizni,
    hogy melyik protokollra van gyárilag állítva a soros port.
  - Van külön **infravörös interfész** is (a kézi leolvasó/programozó
    egységekhez) - ez nem releváns a mi RS485-integrációnkhoz.
- **Tápellátás, FONTOS, architekturális különbség a QDW90A-hoz képest**:
  - Alapból **saját elemes**: 3,6 V 4 Ah lítium, gyártói ígéret szerint
    >10 év élettartam, **energiatakarékos módba kapcsol, ha nincs
    víz/áramlás a csőben**.
  - VAGY külső DC 12-30 V táp, de a füzet szerint ez kifejezetten **az
    MBUS interfészen keresztül** ("DC12~30V external power supply
    through MBUS interface") - tehát a külső táp ÉS a Modbus-kompatibilis
    485-pár expliciten két különböző dolog ebben a dokumentumban.
  - **Ez valós kockázat a meglévő, folyamatos pollozásos architektúránkra
    nézve**: a `rs485_modbus::scan_bus()`/a regisztrált slotok saját,
    folyamatos pollozása (ld. `pressure_sensor.yaml`) rendszeres,
    gyakori Modbus-lekérdezést feltételez minden regisztrált eszközön.
    Ha ez a mérő ELEM-ről megy és energiatakarékos módba lép áramlás
    hiányában, elképzelhető, hogy: (a) alvó állapotban nem válaszol
    azonnal/egyáltalán a Modbus-lekérdezésre, és/vagy (b) a gyakori
    pollozás saját maga rontja az ígért 10 éves elemélettartamot.
  - **Valószínű megoldás/hipotézis, felhasználói felvetés alapján
    (2026-08-19), tisztázandó beérkezéskor**: a fizikai M-Bus szabvány
    (EN 13757-2) definíció szerint eleve BUSZ-TÁPLÁLT - a mester adja a
    tápot a szolgáknak UGYANAZON a két vezetéken, amin az adat is megy
    (feszültségmoduláció). Emiatt valószínű, hogy a Piros/Fekete
    (MBUS+/−) pár egyszerű DC feszültség ráadásával (akár egy "buta"
    tápforrásról, valódi M-Bus mester-jel nélkül) önmagában kilépteti
    az eszközt elemes/energiatakarékos módból - FÜGGETLENÜL attól, hogy
    közben a Sárga/Zöld (485+/−) páron tisztán RS485/Modbus adatot
    olvasunk. Ha ez így működik, mindkét pár egyidejű bekötésével
    (Piros/Fekete -> DC 12-30V táp, Sárga/Zöld -> RS485 busz) megoldható
    a folyamatos, megbízható tápellátás ÉS a Modbus-adatolvasás egyszerre,
    választás nélkül. **Nincs 100%-ig megerősítve ebből a füzetből** -
    nem világos, hogy egy sima DC tápforrás elegendő-e a felismeréshez,
    vagy tényleges M-Bus-szintű jel kell hozzá. Beérkezéskor gyorsan
    tesztelhető: DC táp a Piros/Feketére, RS485 a Sárga/Zöldre, majd
    ellenőrizni az LCD M04 menüjét (feszültség/állapot) és hogy válaszol-e
    a `scan_bus()`.
  - **✅ MEGERŐSÍTVE valós hardveren, 2026-09-02, árammérésssel** - a
    fenti hipotézis igaz, és a "buta" DC táp elég: mindkét pár egyszerre
    bekötve (Piros/Fekete -> külső DC, Sárga/Zöld -> RS485 busz) a mérő
    normálisan válaszol a Modbus-pollozásra, és **a külső táp viszi az
    egész fogyasztást**. Mért áram a külső táp ágában: **1,605 mA**.
    Ez a szám maga a bizonyíték a "melyik forrás viszi a terhet"
    kérdésre: a gyári `<0.1 mW` (3,6 V-on ~28 µA) csak a mérő-
    elektronika, az RS485 adóvevő vételi nyugalmi árama ~1,5 mA - a
    kettő összege pont a mért érték. Ha a mérő közben az elemről menne
    és a külső táp csak az MBUS-bemenetet etetné, a külső ágban ennek
    töredéke folyna. Tehát **az elem kímélve van**, csak tartalék.
  - **Az RS485 fogyasztása NEM forgalomfüggő** - ugyanez a mérés az
    egyik RS485 ér (B) lekötésével is 1,605 mA-t adott, tehát az
    adóvevő akkor is vételi módban ül, amikor egyetlen érvényes keret
    sem érkezik. Következmény: **a pollozás ritkítása nem spórolna
    áramot** - a jelenlegi ~3,3 Hz/eszköz frissesség (ld.
    `water-telemetry-hub.yaml`, `modbus_poll_period_ms`) ingyen van, nem
    kell miatta kompromisszumot kötni.
  - **Ebből viszont üzemeltetési követelmény lesz**: a külső DC-nek
    tartósan mennie kell. Ha kiesik, a mérő az elemre esik vissza, és
    ott az 1,605 mA már ~104 nap (4 Ah / 1,605 mA) - **az elem pedig
    zárt, nem bontható házban van, nem cserélhető**. Egy rövid
    áramszünet érdektelen, egy hónapokig észrevétlenül lekötve maradt
    táp viszont csendben tönkretenne egy nem szervizelhető mérőt.
    Ezért a mérő tápja lehetőleg ugyanarról a forrásról menjen, mint az
    ESP - így egy kiesés a rendszer leállásán azonnal látszik, nem egy
    külön, némán meghibásodó tápegységen múlik.
- **Mért/kijelzett mennyiségek** (a beépített LCD menüpontjaiból,
  M01-M07 - nem feltétlenül 1:1 ugyanazok a Modbus-regiszterek, de jó
  kiindulás, mire számítsunk): nettó kumulatív + pillanatnyi áramlás,
  előremenő/visszatérő vízhőmérséklet + hőmérsékletkülönbség (tehát ez
  a modell hőmennyiségmérésre/fűtési körre is fel van készítve, nem csak
  sima vízmennyiségre), dátum/idő, jelerősség + hibakód, feszültség +
  hőmérséklet, kalibrációs menü, "Batch Controller (Irrigation
  controller)" - öntözésvezérlési funkció is van a firmware-jében,
  ESN + szoftververzió.
- **Mértékegységek**: m³, USG, Liter, cubic foot, Acre Feet (választható) -
  fontos lesz rögzíteni, MELYIK van ténylegesen beállítva a beérkező
  eszközön, hogy a skálázás ne legyen félreértés.
- **2 db opcionális OCT-kimenet, ami "mechanikus vízmérő dupulzuskimenetét
  tudja szimulálni"** ("2 way of OCT output is optional, can simulate
  dipulse output of mechanical water meter") - ez érdekes, alternatív
  integrációs útvonal lehet: ha a Modbus/protokoll-bizonytalanság miatt
  a soros út nem válna be gyorsan, ez az eszköz (ha ez az opció meg van
  rendelve) simán a meglévő pulse-meter GPIO-utunkon is beköthető lenne,
  ugyanúgy, mint a jelenlegi 2 pulse meter - bár ez nyilván elveszítené
  az ultrahangos mérő extra adatait (pillanatnyi áramlás, hőmérséklet,
  stb.), és nem tudjuk, ez az opció meg lett-e rendelve.

## Testvér-modell (T3-1-K1, "sandwich"/wafer kivitel) teljes User Manual-ja - új infó, 2026-08-19

A felhasználó egy MÁSIK, ugyanattól a gyártótól (www.t3-1.com) származó,
ugyanazon terméksorozat egy testvér-modelljének (T3-1-K1, "Sandwich
Ultrasonic Water meter", DN80/DN100, tehát jóval nagyobb csövekre, mint
a mi T3-1-2-H-nk DN15-40 mérete) TELJES, 33 oldalas User Manual-ját
csatolta (`Ultrasonicwaferstylemeter.pdf`). Ez nem a mi konkrét
modellünk dokumentációja, de ugyanaz a "V51" firmware-platform (majdnem
szó szerint azonos M01-M07 menüszerkezet mindkét füzetben), így a
protokoll-/menü-szintű részletei nagy eséllyel közvetlenül átvihetők.

- **Vezetékezés pontosítva/korrigálva**: ebben a dokumentumban (§3.3)
  a Piros/Fekete pár expliciten **"24+ / GND"** - sima DC táp-bemenet,
  NEM "MBUS+/MBUS-" (ahogy a T3-1-2-H füzet nevezte). Valószínű
  magyarázat: ugyanaz a fizikai pár ennél a terméktípusnál VAGY M-Bus
  adatvonalként, VAGY sima táp-bemenetként szolgálhat (rendeléskor
  eldöntött, melyik) - a T3-1-2-H füzet feltehetően csak pongyolán/
  sablonból másolva nevezte "MBUS"-nak. Ez megerősíti (bár más okból,
  mint az eredeti M-Bus-busztáplálás elmélet) a korábbi hipotézist: a
  Piros/Fekete pár valószínűleg tényleg egy dedikált táp-bemenet,
  függetlenül attól, fut-e rajta ténylegesen M-Bus protokoll.
- **KRITIKUS, cselekvést igénylő új infó**: a §3.3 szerint 8 lehetséges
  interfész/kimenet létezik összesen (RS485, M-BUS, DC8-36V, kétvezetékes
  4-20mA, OCT1, OCT2, C1/C2 TTL pulzus) - **"PS: when ordering, you can
  choose any two of the above communication interface or output, lead
  to the external junction box"**. Tehát rendeléskor csak KETTŐ kerül
  ténylegesen kivezetve a külső kábelen a 8-ból. **Nem tudjuk, a
  felhasználó megrendelt T3-1-2-H egységén melyik kettő lett
  kiválasztva** - lehet, hogy nincs is egyszerre RS485 ÉS külső DC táp
  kivezetve. Ezt a rendelési visszaigazolásban/eladónál mindenképp
  ellenőrizni kell, mielőtt a fenti "mindkét pár bekötve" tervvel
  számolnánk.
- **Modbus-címzés megerősítve, szabványos**: gyári alapértelmezett
  kommunikációs cím "1", egybájtos (0-255) - RS485-ön, infravörösön
  vagy a készülék billentyűzetén keresztül módosítható (§5.8). Ez
  pontosan a szabványos Modbus RTU slave-címzés, megerősíti, hogy az
  RS485-oldal valóban Modbus-kompatibilis protokollt beszél (nem csak
  feltételezés).
- **Még mindig nincs tényleges regisztertábla** - a dokumentum saját
  maga több helyen (pl. §4.7, havi/napi kumulatív adatok szerkezete)
  egy KÜLÖN "communication protocol" dokumentumra utal, ami szintén nem
  áll rendelkezésre. Van egy letölthető "V49_ERRCODE.EXE" hibakód-
  visszafejtő és egy "special parameter setting software" (mértékegység/
  tizedesjegy-beállításhoz) is említve - ezek is a gyártó oldaláról
  szerezhetők be, ha elérhetők.
- **Hibakód-bitmaszk táblázat** (§7.1, 2 teljes oldal) - részletes,
  hasznos lesz a jövőbeli hibakezeléshez/diagnosztikai megjelenítéshez,
  ha a Modbus-on keresztül ugyanez a kód elérhető lesz (valószínű, mivel
  ugyanaz a "status code" a menüben (M04/M0A) is megjelenik).

## Külső AI-eszközök (Gemini, ChatGPT) + saját websearch, 2026-08-19

A felhasználó megkérdezett egy Gemini-t és egy ChatGPT-t is az
eszközről, és én magam is végeztem saját websearch-öt (a sandbox saját
egress-proxyja miatt a talált PDF-eket - anyflip, enexia.fi, manualslib,
manualzz, scribd, ecefast.co.nz, alibaba - egyiket sem tudtam innen
közvetlenül letölteni/megnyitni, csak a keresőmotor saját összefoglalóit
láttam).

- **Vezetékezés - MOST MÁR jobban megerősítve, korrigálja a korábbi
  óvatosságot**: mindhárom független forrás (ChatGPT saját, gyártói
  "TSONIC T3-1 Series Installation Instruction"-re hivatkozó válasza +
  a saját websearch-öm találatai) ugyanazt írja: **1=485+/A, 2=485-/B,
  3=DC 8-36V, 4=GND** - tehát TÉNYLEG külön, fix RS485-pár ÉS külön
  táp+GND pár, NEM egy "vagy M-Bus vagy táp" választás. A T3-1-2-H
  füzet saját "MBUS+/MBUS-" címkéje a Piros/Feketén ez alapján
  valószínűleg tényleg csak egy sablon-/fordítási hiba volt (más
  T3-1-es dokumentumból másolva), nem egy valós, eszközszintű
  either-or. Ez megerősíti (immár szélesebb forrásbázissal) a korábbi
  "mindkét pár egyszerre bekötve = folyamatos táp + megbízható RS485"
  tervet.
- **A Gemini regisztertáblájával ÓVATOSAN kell bánni, nem venni
  készpénznek** - a Gemini saját hivatkozásai (scribd "Bove Technology",
  "Norika WM" dokumentumok) MÁS gyártók generikus ultrahangos-vízmérő
  protokolljai, nincs megerősítve, hogy ugyanez a család. A ChatGPT
  válasza ezt helyesen jelezte is ("nem állítanám még 100%-ra"). **Nem
  ültetjük át ezt a konkrét regisztertáblát a firmware-be megerősítés
  nélkül** - pontosan ugyanaz az elv, mint a QDW90A-nál: nem hivatalos
  forrásból csak kiindulásnak jó, a végleges térképet valós hardveren
  kell megerősíteni.
- **Ígéretes, még nem megnyitott konkrét nyom**: egy Scribd-dokumentum,
  aminek a címe **"V51 Ultrasonic Water Meter Communication Protocol"**
  (`https://www.scribd.com/document/690064185/V51-ultrasonic-water-meter-communication-protocol`)
  - a "V51" pontosan egyezik a T3-1-K1 kézikönyvben látott firmware-
    verzióval ("51 means the version 51 circuit board"), tehát ez lehet
    a TÉNYLEGES, hozzánk illő protokoll-dokumentum, nem csak egy
    hasonló nevű másik gyártóé. Egy másik ígéretes találat: az AnyFlip
    "T3-1 SERIES ultrasonic water meter communication protocol" flipbook
    (`https://anyflip.com/jdpqf/cvgl/basic`). Egyiket sem tudtam innen
    megnyitni (egress-proxy blokkolja mindkét domaint) - a felhasználó
    saját böngészőjéből elérhetők, érdemes megnézni/lementeni.
- **Alapértelmezett kommunikációs paraméterek, forrásfüggően
  ELLENTMONDÓAK** - a Gemini 2400 bps + 8E1-et állít, a saját
  websearch-öm (gyártói install instruction alapján) 9600 baud + no
  parity + 8N1-et talált. Ez pont az a fajta részlet, amit valós
  hardveren (`mbpoll` auto-baud/paritás-próbálgatással) kell tisztázni,
  nem AI-összefoglalásból átvenni.

## Nyitott kérdések / következő lépések

1. **Van-e nálad böngészőből elérhető hozzáférés** a fenti Scribd
   ("V51 Ultrasonic Water Meter Communication Protocol") és/vagy AnyFlip
   ("T3-1 SERIES ultrasonic water meter communication protocol")
   dokumentumokhoz - ha igen, és be tudod másolni/feltölteni a
   tartalmukat, abból egy tényleges, forrással alátámasztott
   regisztertáblát tudunk írni ide, ahelyett hogy AI-generált (és
   egymásnak ellentmondó) számokra hagyatkoznánk.
2. **Van-e a bővebb "ultrasonic water meter user manual"** a tényleges
   Modbus regisztertáblával (funkciókód, cím, adattípus, skálázás) - ha
   a gyártótól beszerezhető, azzal sokkal gyorsabb lenne a driver-munka,
   mint találgatással/scan-nel indulni.
3. **Működik-e a "DC táp a Piros/Feketére, RS485 adat a Sárga/Zöldre"
   egyidejű bekötés** (ld. fent a hipotézist) - ha igen, ez megoldja a
   tápellátás-kérdést anélkül, hogy bármit is választani kellene; ha nem,
   marad a "csak elemes, ritkább pollozás" vagy "csak M-Bus, nem RS485"
   kompromisszum.
4. **Beérkezés után, ha nincs meg a bővebb kézikönyv**: a QDW90A-nál
   bevált módszer megismétlése - a meglévő `rs485_modbus`
   scan/probe-infrastruktúrával egy teljes regiszter-scan (`mbpoll`)
   valós hardveren, a válaszok mintázatából (kerek számok, ismerős
   Float32-párok stb.) visszafejtve a tényleges térképet.

## Architekturális következmény, ha ez tényleg egy MÁSIK eszköztípus

A projekt jelenlegi Modbus-modellje (`pressure_sensor.yaml`, 8 fix slot)
implicit módon "ez mind nyomásmérő" feltételezéssel megy - elnevezés
("Pressure Sensor N"), mértékegység, skálázás mind erre hardkódolva. Egy
áramlásmérő bevezetése valószínűleg megköveteli a REQUIREMENTS.md-ben
már korábban jelzett, eddig el nem kezdett **"device class" munkát**:
eszköztípus-fogalom slotonként, típus-specifikus elnevezés/mértékegység/
skálázás, és a Hozzáadás UI-nak fel kell ajánlania a talált cím
eszköztípusát a felvétel előtt - ld. REQUIREMENTS.md "Architekturális
megfontolás v3" szakaszának saját, erre már korábban is utaló
megjegyzését.
