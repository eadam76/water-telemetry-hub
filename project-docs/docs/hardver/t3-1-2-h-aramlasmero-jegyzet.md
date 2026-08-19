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

## Amit a füzetből tudunk

- **Típus**: T3-1-2-H, ultrahangos (transit-time) vízmérő/átfolyásmérő,
  ISO4064-1:2005 és GB/T778.1-2007 szerint. Rendelhető DN15/DN20/DN25/
  DN32/DN40 méretben, ehhez tartozó áramlási tartományok (Q1-Q4) és
  méretek a füzet 3-4. oldalán.
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

## Nyitott kérdések / következő lépések

1. **Melyik protokollra van ténylegesen állítva a 485-pár** (Modbus RTU
   feltételezhető, de nincs megerősítve) - rendelési adatlap/vásárlói
   visszaigazolás, vagy beérkezéskor a gyártói bővebb kézikönyv/
   konfigurációs eszköz alapján tisztázandó.
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
