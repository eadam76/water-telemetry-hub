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
Sárga/Zöld RS485 pár).

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
