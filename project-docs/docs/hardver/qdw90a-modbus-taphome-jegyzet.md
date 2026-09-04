> ⚠️ **Ez a fájl nyers, külső (TapHome-eredetű) forrásanyag, nem a projekt saját, megerősített referenciája.** A `REQUIREMENTS.md` "Modbus regisztertérkép" szakasza jelöli, mi ebből a valós hardveren (2026-08-12) ténylegesen megerősített, és mi még csak innen átvett, nem ellenőrzött állítás. Ha ez a regisztertérkép a fejlesztés alatt stabilizálódik, ebből (és a saját méréseinkből) egy önálló, TapHome-hivatkozás nélküli, saját referenciadokumentumot érdemes csinálni a `docs/hardver/` alá – ez a fájl addig csak munkaanyag/forrás.

# QDW90A nyomástávadó

**Kommunikáció:** Modbus RTU / RS-485  
**Gyártó:** Qidian – Anhui Qidian Automation Technology Co., Ltd.  
**Utolsó frissítés:** 2026. május

**Csatolt fájlok:**

[modbus-protocol.pdf](/api/files/019faef1-e227-7018-9ccc-44ba32b40c77/modbus-protocol.pdf)

[QDW90A_Pressure_Transmitter.pdf](/api/files/019faf76-76a5-70af-8843-8419075e9ff1/QDW90A_Pressure_Transmitter.pdf)

> _A dokumentáció eredetileg a TapHome okosotthon-rendszerhez készült, ezért több helyen kifejezetten a TapHome eszközeire, moduljaira és beállításaira hivatkozik._
> 
> _Eredeti dokumentáció:_ [_https://taphome.com/en/compatibility/general-qdw90a-pressure-transmitter/_](https://taphome.com/en/compatibility/general-qdw90a-pressure-transmitter/)

## Áttekintés

A QDW90A egy általános célú, piezorezisztív nyomás- és szinttávadó. A készülék **Modbus RTU protokollon**, fizikai szinten pedig **RS-485 buszon** kommunikál.

Ugyanez a hardverplatform a beépített érzékelőelemtől és a gyári konfigurációtól függően az alábbi mennyiségek mérésére használható:

- nyomás;
- folyadékszint;
- hőmérséklet;
- pH-érték;
- tömeg.

A TapHome-sablon a mérési értéket a `H:4` holding regiszterből olvassa ki. A tizedesjegyek számát automatikusan a `H:3`regiszter alapján veszi figyelembe.

A modul ezenkívül megjeleníti:

- a Modbus-címet;
- az átviteli sebességet;
- a beállított mértékegységet;
- a tizedesformátumot.

A Modbus slave cím a TapHome felületéről távolról is módosítható.

---

# Hardveres csatlakoztatás

## RS-485 bekötés

A QDW90A érzékelőt az RS-485 csatlakozási pontokon keresztül kell a TapHome Multi-Protocol Gatewayhez vagy más Modbus RTU master eszközhöz csatlakoztatni.

| Ér színe | Csatlakozás | Funkció |
| --- | --- | --- |
| Piros | `+24 V` | Pozitív tápfeszültség |
| Fekete | `GND` | Tápfeszültség negatív pontja / közös vezeték |
| Kék | `A / RS485+` | RS-485 „A” adatvezeték |
| Sárga | `B / RS485−` | RS-485 „B” adatvezeték |

> \[!WARNING\]  
> Az OEM-változatok vezetékszínei eltérhetnek. Bekötés előtt mindig ellenőrizni kell az adott példányhoz mellékelt dokumentációt vagy a készüléken található bekötési jelöléseket.

## Alapértelmezett kommunikációs paraméterek

| Paraméter | Alapértelmezett érték |
| --- | --- |
| Átviteli sebesség | 9600 baud |
| Paritás | Nincs |
| Adatbitek száma | 8   |
| Stopbitek száma | 1   |
| Modbus slave cím | 1   |

A rövid jelölés:

```text
9600 baud, 8N1, Slave ID 1
```

Az átviteli sebesség a `H:1` regiszteren keresztül módosítható.

Támogatott sebességek:

- 1200 baud;
- 2400 baud;
- 4800 baud;
- 9600 baud;
- 19 200 baud;
- 38 400 baud;
- 57 600 baud;
- 115 200 baud.

A használható Modbus slave címtartomány:

```text
1–255
```

> \[!IMPORTANT\]  
> A slave cím vagy az átviteli sebesség módosításakor a távadó még a régi beállításokkal küldi el a műveletre adott választ. Csak ezután vált át az új értékre.
> 
> A módosítás tartós mentéséhez a `H:15` regiszterbe `0` értéket kell írni.

---

# Mérési érték kiolvasása

## Egész számként tárolt mérési érték

A TapHome-sablon a mérési értéket a következő regiszterből olvassa:

| Tulajdonság | Érték |
| --- | --- |
| Regiszter | `H:4` |
| Adattípus | `Int16` |
| Hozzáférés | Csak olvasható |
| Funkció | Aktuális mérési érték |

A regiszterben tárolt nyers értéket a `H:3` regiszterben meghatározott tizedesjegyszám alapján kell átskálázni:

```text
tényleges érték = nyers érték / 10^(tizedesjegyek száma)
```

### Példa

Amennyiben:

```text
H:4 = 523
H:3 = 2
```

akkor a tényleges mérési érték:

```text
523 / 10² = 5,23
```

A mértékegységet a `H:2` regiszter határozza meg.

## TapHome kiolvasási logika

```text
VAR val := MODBUSR(H, 4, Int16) /
           POWER(10, MODBUSR(H, 3, Int16));

SWITCH(
    MODBUSR(H, 2, Int16),
    16, val,
    17, val / 100,
    val
);
```

A sablon a `m` és `cm` mértékegységeknél külön átváltási szabályt alkalmaz.

---

# Mértékegységek

A `H:2` holding regiszter határozza meg az érzékelő által használt mértékegységet.

| Kód | Mértékegység | Kategória |
| --- | --- | --- |
| 0   | MPa | Nyomás |
| 1   | kPa | Nyomás |
| 2   | Pa  | Nyomás |
| 3   | bar | Nyomás |
| 4   | mbar | Nyomás |
| 5   | kg/cm² | Nyomás |
| 6   | PSI | Nyomás |
| 7   | mH₂O | Nyomás / vízoszlop |
| 8   | mmH₂O | Nyomás / vízoszlop |
| 9   | inH₂O | Nyomás / vízoszlop |
| 10  | H₂O | Nyomás / vízoszlop |
| 11  | mHg | Nyomás / higanyoszlop |
| 12  | mmHg | Nyomás / higanyoszlop |
| 13  | inHg | Nyomás / higanyoszlop |
| 14  | atm | Nyomás |
| 15  | Torr | Nyomás |
| 16  | m   | Folyadékszint |
| 17  | cm  | Folyadékszint |
| 18  | mm  | Folyadékszint |
| 19  | kg  | Tömeg |
| 20  | °C  | Hőmérséklet |
| 21  | pH  | pH-érték |
| 22  | °F  | Hőmérséklet |

> \[!NOTE\]  
> A QDW90A különböző kivitelei eltérő érzékelőelemmel készülhetnek. Attól, hogy a kommunikációs protokoll többféle mértékegységet támogat, egy konkrét nyomástávadó még nem válik hőmérséklet- vagy pH-érzékelővé.

---

# Szervizadatok

A TapHome-modul négy konfigurációs adatot jelenít meg.

## Modbus slave cím

| Tulajdonság | Érték |
| --- | --- |
| Regiszter | `H:0` |
| Adattípus | `Int16` |
| Tartomány | 1–255 |
| Gyári érték | 1   |

Kiolvasás:

```text
MODBUSR(H, 0, Int16);
```

## Átviteli sebesség

| Regiszterérték | Átviteli sebesség |
| --- | --- |
| 0   | 1200 baud |
| 1   | 2400 baud |
| 2   | 4800 baud |
| 3   | 9600 baud |
| 4   | 19 200 baud |
| 5   | 38 400 baud |
| 6   | 57 600 baud |
| 7   | 115 200 baud |

A beállítás a `H:1` regiszterben található.

TapHome kiértékelési logika:

```text
SWITCH(
    MODBUSR(H, 1, Int16),
    0, 1200,
    1, 2400,
    2, 4800,
    3, 9600,
    4, 19200,
    5, 38400,
    6, 57600,
    7, 115200,
    NaN
);
```

## Mértékegység

A jelenleg beállított mértékegységet a `H:2` regiszter tartalmazza. A regiszter értékét a korábbi mértékegységtáblázat szerint kell értelmezni.

## Tizedesformátum

A tizedesjegyek számát a `H:3` regiszter határozza meg.

| Regiszterérték | Megjelenítési forma | Tizedesjegyek száma |
| --- | --- | --- |
| 0   | `####` | 0   |
| 1   | `###.#` | 1   |
| 2   | `##.##` | 2   |
| 3   | `#.###` | 3   |
| 4   | `.####` | 4   |

> \[!NOTE\]  
> Az eredeti TapHome mintakódban a `4` értékhez is `#.###` formátum szerepel, miközben a leírás szerint a helyes formátum `.####`. Ez feltehetően megjelenítési vagy sablonhiba; maga a skálázás a `10^H:3` képlet miatt ettől még négy tizedesjeggyel történik.

---

# Modbus slave cím módosítása

A slave cím módosításakor az új címet a `H:0` regiszterbe kell írni.

Ezután a beállítást a `H:15 = 0` írással kell elmenteni a nem felejtő memóriába.

TapHome művelet:

```text
MODBUSW(SH, 0, Int16, SlaveAddr);
MODBUSW(SH, 15, Int16, 0);
```

Ahol:

```text
SlaveAddr = az új slave cím 1 és 255 között
```

> \[!IMPORTANT\]  
> A címírásra adott Modbus-válasz még a régi slave címről érkezik. A távadó csak a válasz elküldése után kezdi használni az új címet.

---

# Lebegőpontos mérési érték

A távadó a mérési értéket közvetlenül, `Float32` formátumban is elérhetővé teszi.

| Tulajdonság | Érték |
| --- | --- |
| Regiszterek | `H:22–H:23` |
| Adattípus | IEEE 754 Float32 |
| Bájt-/szósorrend | Big-endian, ABCD |
| Skálázás | Nem szükséges |

Ez az érték közvetlenül tartalmazza a tényleges mérési eredményt, ezért használatakor nincs szükség a `H:3` szerinti tizedesskálázásra.

> \[!TIP\]  
> Saját Modbus-integrációnál célszerű lehet elsőként a `H:22–H:23` regiszterpárt kipróbálni. Így elkerülhető az egész számos érték és a külön tizedeshely-regiszter együttes kezelése.

---

# További Modbus-regiszterek

| Regiszter | Funkció | Megjegyzés |
| --- | --- | --- |
| `H:0` | Slave cím | Írható, 1–255 |
| `H:1` | Átviteli sebesség | Írható, 0–7 kóddal |
| `H:2` | Mértékegység | A mértékegység kódja |
| `H:3` | Tizedesjegyek | A mérési érték skálázása |
| `H:4` | Mérési érték | `Int16`, skálázást igényel |
| `H:5` | Méréstartomány alsó pontja | Diagnosztikai és kalibrációs adat |
| `H:6` | Méréstartomány felső pontja | Diagnosztikai és kalibrációs adat |
| `H:12` | Nullponteltolás | `Int16`, írható |
| `H:15` | Beállítások mentése | `0` írásával mentés a felhasználói területre |
| `H:16` | Gyári visszaállítás | `1` írásával gyári reset |
| `H:22–H:23` | Lebegőpontos mérési érték | IEEE 754 Float32, ABCD sorrend |
| `H:37` | Soros paritás | `0` = nincs, `1` = páratlan, `2` = páros |

## Nullponteltolás

A `H:12` regiszterrel nullpontkorrekció adható a mérési eredményhez.

```text
kimeneti érték = kalibrált mérési érték + nullponteltolás
```

Tulajdonságai:

- adattípus: `Int16`;
- olvasható és írható;
- gyári érték: `0`;
- egyetlen regiszter írásával, például Modbus `0x06` funkciókóddal módosítható.

## Soros paritás

A `H:37` regiszterben állítható:

| Érték | Paritás |
| --- | --- |
| 0   | Nincs |
| 1   | Páratlan |
| 2   | Páros |

## Gyári visszaállítás

A gyári paraméterek visszaállítása:

```text
H:16 = 1
```

> \[!CAUTION\]  
> A gyári visszaállítás módosíthatja vagy törölheti a slave címet, az átviteli sebességet és a kalibrációs adatokat. A műveletet csak a jelenlegi konfiguráció feljegyzése után szabad végrehajtani.

---

# TapHome-eszközök

## QDW90A nyomástávadó modul

A modulban elérhető szervizadatok:

| Szervizadat | Leírás |
| --- | --- |
| Slave Address | Aktuális Modbus slave cím, 1–255 |
| Baud Rate | Aktuális átviteli sebesség |
| Unit | Beállított mértékegység |
| Decimal Points | Beállított tizedesformátum |

Elérhető szervizművelet:

| Művelet | Leírás |
| --- | --- |
| Rewrite the Slave Address | Új Modbus slave cím beállítása és tartós mentése |

## Pressure Level mérési pont

| Tulajdonság | Érték |
| --- | --- |
| Név | Pressure Level |
| Hozzáférés | Csak olvasható |
| Regiszter | `H:4` |
| Adattípus | `Int16` |
| Skálázás | `H:3` alapján |
| Mértékegység | `H:2` alapján |

Kapcsolati paraméterek:

```text
Modbus RTU
9600 baud
8N1
Slave ID: konfigurálható
```

---

# Javasolt fejlesztések a TapHome-sablonhoz

Az alapértelmezett sablon az `H:4` egész számos mérési értéket használja, de az alábbi funkciókkal tovább bővíthető.

## Float32 mérési érték használata

A `H:22–H:23` regiszterpárból közvetlen IEEE 754 lebegőpontos érték olvasható ki.

Előnyei:

- nem kell külön kezelni a tizedesjegyek számát;
- kisebb a hibás skálázás veszélye;
- közvetlenebb integrációt tesz lehetővé.

## Méréstartomány megjelenítése

A következő regiszterek diagnosztikai adatként megjeleníthetők:

- `H:5` – méréstartomány alsó pontja;
- `H:6` – méréstartomány felső pontja.

## Nullpontkorrekció

A `H:12` regiszter külön TapHome szervizművelettel írhatóvá tehető.

## Paritás beállítása

A `H:37` regiszter segítségével a soros kommunikáció paritása módosítható.

## Átviteli sebesség módosítása

A `H:1` regiszter jelenleg szervizadatként olvasható, de külön művelettel írhatóvá is tehető.

A lehetséges kódok:

```text
0 = 1200
1 = 2400
2 = 4800
3 = 9600
4 = 19200
5 = 38400
6 = 57600
7 = 115200
```

A módosítás után a beállítást a következő írással kell menteni:

```text
H:15 = 0
```

## Gyári visszaállítás

Külön szervizművelet készíthető a következő parancshoz:

```text
H:16 = 1
```

Ezt a műveletet megfelelő figyelmeztetéssel vagy megerősítéssel kell ellátni.

---

# Rövid integrációs összefoglaló

A QDW90A alapértelmezett kiolvasásához szükséges legfontosabb adatok:

```text
Protokoll:       Modbus RTU
Fizikai réteg:   RS-485
Tápfeszültség:   24 V DC
Baud rate:       9600
Adatformátum:    8N1
Slave cím:       1
Mérési érték:    H:4, Int16
Tizedesjegyek:   H:3
Mértékegység:    H:2
Float32 érték:   H:22–H:23, ABCD
```

A skálázott mérési érték:

```text
érték = H:4 / 10^(H:3)
```

Alternatív, közvetlen lebegőpontos mérés:

```text
H:22–H:23
IEEE 754 Float32
Big-endian / ABCD
```

---

# Fontos üzembe helyezési ellenőrzések

1.  Ellenőrizd a konkrét érzékelő vezetékszíneit.
2.  Ellenőrizd a tápfeszültséget és annak polaritását.
3.  Ellenőrizd az RS-485 `A` és `B` vezetékek sorrendjét.
4.  Próbáld ki az alapértelmezett `9600 8N1` kommunikációt.
5.  Elsőként az `1` Modbus slave címet használd.
6.  Olvasd ki a `H:0–H:4` regisztereket.
7.  Ellenőrizd a `H:2` szerinti mértékegységet.
8.  Ellenőrizd a `H:3` szerinti tizedesskálázást.
9.  Hasonlítsd össze a `H:4` alapján számított és a `H:22–H:23` Float32 értéket.
10. Cím- vagy sebességmódosítás után írd be a `H:15 = 0` mentési parancsot.

---

# Forrás

A dokumentáció a TapHome QDW90A kompatibilitási adatlapja és a hivatkozott QDW90A Modbus RTU kommunikációs protokoll alapján készült.

**Dokumentum címe:** QDW90A Pressure Transmitter — Sensor Integration  
**Gyártó:** Qidian / Anhui Qidian Automation Technology Co., Ltd.

# Hasznos linkek

- [QDW90A nyomástávadó integrálása Home Assistant rendszerbe Elfin EW11 átjáróva](https://community.home-assistant.io/t/modbus-with-ew11-qdw90a-3-rs485-water-pressure-measure-probe-0-10-bar/784472?_gl=1*utxltw*_ga*MTg3OTQ0NzI4Ny4xNzg1Mjc0ODg0*_ga_Q052JNKR7M*czE3ODUzNDU1NjckbzIkZzEkdDE3ODUzNDY0NjIkajYwJGwwJGg1OTgzMTg5NDY.)l