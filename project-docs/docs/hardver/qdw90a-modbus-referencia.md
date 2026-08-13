# QDW90A – Modbus RTU referencia (saját, hardveren megerősített)

Ez a projekt saját, tömör referenciája a beszerzett QDW90A nyomástávadóhoz –
kizárólag a nálunk ténylegesen releváns (bar kimenetű, 4-vezetékes RS485)
kivitelre vonatkozik. Minden érték **2026-08-12-én, a valós eszközön**
lett leellenőrizve (`mbpoll`, USB-RS485 adapter, hub nélkül, közvetlen
bekötéssel). Forrás/eredetiség: lásd `REQUIREMENTS.md`
"Modbus regisztertérkép" szakasza a mérési jegyzőkönyvért.

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

| Reg. | Funkció | Nálunk mért érték |
| --- | --- | --- |
| `H:0` | Slave cím, `Int16`, írható (`1–255`) | `1` |
| `H:1` | Baud-kód (`3` = 9600 – **kód, nem a nyers baud-érték**) | `3` |
| `H:2` | Mértékegység-kód (`3` = bar) | `3` |
| `H:3` | Tizedesjegyek száma | `2` |
| `H:4` | **Mérési érték** – `bar = H:4 / 100` | `0` (terheletlen) |
| `H:5` | Méréstartomány alsó pontja | `0` |
| `H:6` | Méréstartomány felső pontja – `/100`-zal `10.00 bar`, egyezik a szenzor méréshatárával | `1000` |
| `H:12` | Nullponteltolás, `Int16`, írható, gyári `0` | `0` |
| `H:15` | Mentés – `0` írása menti tartósan a `H:0`/`H:1` módosítását | – (csak olvasva) |
| `H:16` | Gyári visszaállítás – `1` írása töröl mindent | – (csak olvasva, **nem próbáltuk ki**) |
| `H:22–H:23` | Mérési érték közvetlenül `Float32`-ként (big-endian), skálázás nélkül | `0.0` |

`H:2` 23 különböző mértékegységet tud kódolni (nyomás/szint/hőmérséklet/pH/tömeg) –
nálunk ez mindig `3` (bar), a többivel nem foglalkozunk.

## Betanítás / cím módosítása

1. **Egyszerre csak 1, még be nem tanított eszköz legyen a buszon** (azonos
   gyári alapcím ütközne).
2. Írd a `H:0` regiszterbe az új slave címet.
3. Írd a `H:15` regiszterbe `0`-t – enélkül a módosítás elveszhet
   újraindításkor.
4. A címírásra adott Modbus-válasz még a **régi** címről érkezik – a
   távadó csak ez után vált át.

## Nem használt / nem megerősített részletek

- `H:24–H:29` körül egy valószínűsíthetően valódi, de nem dokumentált
  `Float32` paraméterblokk (`1.0`, `0.001` – kerek értékek, nem zaj) –
  jelentése ismeretlen, firmware-ben nem használjuk.
- `H:37` (soros paritás, nálunk `0`=nincs) és néhány további, nem nulla,
  azonosítatlan regiszter (`H:8`, `H:9`, `H:10`, `H:11`, `H:14`, `H:21`,
  `H:33`, `H:39`) – mért, de jelentésük ismeretlen, nem használjuk.
- `H:16` (gyári reset) írását szándékosan nem próbáltuk ki – kalibrációt/
  címet törölhet.
