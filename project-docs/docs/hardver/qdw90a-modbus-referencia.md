# QDW90A – Modbus RTU referencia (saját, hardveren megerősített)

Ez a projekt saját, tömör referenciája a beszerzett QDW90A nyomástávadóhoz –
kizárólag a nálunk ténylegesen releváns (bar kimenetű, 4-vezetékes RS485)
kivitelre vonatkozik. Minden érték **2026-08-12-én, a valós eszközön**
lett leellenőrizve (`mbpoll`, USB-RS485 adapter, hub nélkül, közvetlen
bekötéssel), és kereszt-ellenőrizve a **gyártó saját, hivatalos Modbus
protokoll-dokumentumával** ([`qdw90a-modbus-protocol-gyartoi.pdf`](qdw90a-modbus-protocol-gyartoi.pdf) –
ez az elsődleges, hivatalos forrás, nem a korábbi TapHome-jegyzet).
Forrás/eredetiség a mérési jegyzőkönyvért: lásd `REQUIREMENTS.md`
"Modbus regisztertérkép" szakasza.

## Bekötés

| Ér színe | Funkció |
| --- | --- |
| Piros | `24V+` |
| Fekete | `24V-` (táp föld – nincs külön jel-föld ér) |
| Kék | RS485 `A` |
| Sárga | RS485 `B` |

A csatlakozó silkscreen-jén látható "Ground Wire" felirat félrevezető ezen
a kivitelen – a sárga ér ténylegesen a `B` jel, nem föld.

## Kommunikáció

```
Protokoll:     Modbus RTU
Fizikai réteg: RS-485
Baud:          9600 8N1
Slave cím:     1 (gyári alapérték)
```

## Regisztertérkép

**Írható regiszterek – a gyártói doksi szerint kizárólag ez a 4**: `H:0`
(cím), `H:1` (baud), `H:12` (nullponteltolás), `H:37` (paritás), plusz a
két speciális "parancs" regiszter (`H:15` mentés, `H:16` gyári reset).
**Minden más regiszter csak olvasható** – ha ezt megpróbálnánk írni, a
gyártói doksi szerint az eszköz hibakóddal (exception) utasítja el.

| Reg. | Funkció | Írható? | Nálunk mért érték |
| --- | --- | --- | --- |
| `H:0` | Slave cím, `Int16` (`1–255`) | ✅ | `1` |
| `H:1` | Baud-kód (`3` = 9600 – **kód, nem a nyers baud-érték**) | ✅ | `3` |
| `H:2` | Mértékegység-kód (`3` = bar) | ❌ csak olvasható | `3` |
| `H:3` | Tizedesjegyek száma | ❌ csak olvasható | `2` |
| `H:4` | **Mérési érték** – `bar = H:4 / 100` | ❌ csak olvasható | `0` (terheletlen) |
| `H:5` | Méréstartomány alsó pontja (gyári kalibráció) | ❌ csak olvasható | `0` |
| `H:6` | Méréstartomány felső pontja – `/100`-zal `10.00 bar`, egyezik a szenzor méréshatárával | ❌ csak olvasható | `1000` |
| `H:12` | Nullponteltolás, `Int16`, gyári `0` – **`kimenet = kalibrált mérés + H:12`** | ✅ | `0` |
| `H:15` | Mentés-parancs – `0` írása menti tartósan a `H:0`/`H:1`/`H:12`/`H:37` módosítását | ✅ (parancs) | – |
| `H:16` | Gyári visszaállítás-parancs – `1` írása töröl mindent | ✅ (parancs, **óvatosan**) | – |
| `H:22–H:23` | Ugyanaz a mérési érték, közvetlenül `Float32`-ként (big-endian ABCD), skálázás nélkül | ❌ csak olvasható | `0.0` |
| `H:37` | Soros paritás | ✅ | `0` |

`H:2` 23 különböző mértékegységet tud kódolni (nyomás/szint/hőmérséklet/pH/tömeg),
de **ez a regiszter nem írható** – nálunk fixen `3` (bar) marad, gyártói
kalibrációs szoftver nélkül nem állítható át.

**`H:4` vs. `H:22–H:23`**: ugyanaz a mért érték, két kódolásban – `H:4` egy
skálázatlan `Int16`, amit a `H:3` (tizedesjegyek) alapján kell átszámolni;
`H:22–H:23` ugyanez, de kész `Float32`-ként, nincs hozzá külön skálázó
regiszter. Firmware szempontjából az `H:22–H:23` egyszerűbb (nem kell
külön `H:3`-at is olvasni), cserébe 2 regisztert kell egyszerre, Float32-
ként értelmezni.

## Betanítás / cím módosítása

**Nem egy Modbus-művelet** – a cím-írásra adott válasz még a **régi**
címről érkezik, a távadó csak *utána* vált át ténylegesen, ezért a
mentést már az **új** címre kell küldeni:

1. **Egyszerre csak 1, még be nem tanított eszköz legyen a buszon**
   (azonos gyári alapcím ütközne).
2. Írd a `H:0` regiszterbe az új slave címet – **a jelenlegi (régi)**
   címre küldve.
3. Írd a `H:15` regiszterbe `0`-t (mentés) – **már az új** címre küldve.
4. Ellenőrzésképp olvasd vissza `H:0`-t az új címen.

Példa, `1 → 2` cím-váltás:

```
1) Cím írása 1→2, még a régi (1) címre:  01 06 00 00 00 02 08 0B
2) Mentés, már az új (2) címre:          02 06 00 0F 00 00 B9 FA
3) Ellenőrzés, H:0 olvasása a 2-es címen: 02 03 00 00 00 01 84 39
```

Ugyanez a logika érvényes a baud-váltásra is (`H:1` írása után a válasz
még a régi baudon jön, utána vált át ténylegesen).

## Nullponteltolás (kalibráció)

`H:12` írható, **`kimeneti nyomás = kalibrált mérés + H:12`** – ez pontosan
az a finomkalibrációs funkció, amit a `REQUIREMENTS.md` korábban nyitott
kérdésként hagyott. Nem kell hozzá saját szoftveres offset-réteg az ESP
oldalán, elég ezt a regisztert írni (majd `H:15=0`-val menteni). Írás után
ugyanúgy menteni kell (`H:15=0`), különben újraindításkor elvész.

## Gyári visszaállítás ⚠️

```
H:16 = 1 írása, pl. cím 1-re:  01 06 00 10 00 01 49 CF
```

A gyártói doksi kifejezetten figyelmeztet: utána a cím/baud/kalibráció
gyári (nem feltétlenül ismert) állapotba állhat vissza – **a távadót
utána újra meg kell keresni/szkennelni**. Szándékosan nem próbáltuk ki.

## Kérésméret-korlát ⚠️

**Egy `0x03` (Read Holding Registers) kérésben legfeljebb 20 regiszter
kérhető le egyszerre.** 21 vagy több regiszterre a szenzor a szabványostól
eltérő `Illegal Function` Modbus-kivétellel utasítja el a **teljes**
kérést (nem csak a 20. fölötti részt). Mért, reprodukált: `H:1–H:20`
(20 regiszter, `-r 1 -c 20`) sikeres volt, `H:0–H:20` (21 regiszter,
`-r 0 -c 21`) teljesen elbukott. **Firmware-ben ezt figyelembe kell
venni** – nagyobb tartományt csak több, egyenként max. 20 regiszteres
kérésre darabolva szabad lekérni.

## Nem használt / nem megerősített részletek

- `H:24–H:29` körül egy valószínűsíthetően valódi, de a gyártói doksiban
  sem szereplő `Float32` paraméterblokk (`1.0`, `0.001` – kerek értékek,
  nem zaj) – jelentése ismeretlen, firmware-ben nem használjuk.
- Néhány további, nem nulla, azonosítatlan regiszter (`H:8`, `H:9`,
  `H:10`, `H:11`, `H:14`, `H:21`, `H:33`, `H:39`) – mért, de jelentésük
  ismeretlen, nem használjuk.

## Ami elméletileg lehetséges, de nem terveink

- **Mértékegység-váltás** (`H:2` írása) – a gyártó szerint nem írható,
  ld. fent.
- **Automatikus busz-szkennelés** (`1–247` címtartomány végigpróbálása,
  rövid timeout-tal) – megvalósítható lenne betanítás-idejű, nem
  folyamatos funkcióként.
- **Cím-ütközés élő kimutatása** – Modbus/RS485 szinten **alapvetően nem
  megbízható**: ha két eszköz egyszerre válaszol ugyanarra a címre, a
  jelük egymást rontja el a buszon, ami a mester szemszögéből
  megkülönböztethetetlen attól, mintha egyáltalán nem válaszolt volna
  senki. A reális védelem a **megelőzés** (egyszerre csak 1 be nem
  tanított eszköz a buszon betanításkor, és figyelmeztetés a *már általunk
  ismert* eszközök közti címütközésre), nem egy megbízható élő riasztás.
