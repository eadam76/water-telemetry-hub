# Waveshare ESP32-S3-RS485-CAN – ipari fejlesztői panel

Tisztázott összefoglaló a gyártói terméklapból ([eredeti PDF](esp32-s3-rs485-can-board.pdf)). A végleges hardver rendelés alatt van, még nem érkezett meg.

## Alapadatok

| | |
|---|---|
| Modell | ESP32-S3-RS485-CAN (fedélzeti antennás) / -U (külső antennás) |
| Chip | ESP32-S3R8, dual-core Xtensa LX7, 240 MHz, 16 MB flash |
| Vezeték nélküli | 2,4 GHz Wi-Fi (802.11 b/g/n) + Bluetooth 5 (LE) |
| Kommunikáció | **Galvanikusan izolált RS485** és **izolált CAN** busz, terminálblokkos csatlakozással |
| Védelem | TVS dióda, surge- és ESD-védelem az RS485/CAN interfészeken |
| Tápellátás | DC 7–36V terminál, vagy USB Type-C (táp + debug + flashelés) |
| Extra | Beépített RTC (PCF85063), 120Ω lezáró ellenállás mindkét buszhoz (jumperrel bekapcsolható) |
| Ház | DIN-sínes tokozás |
| Méret | 91,7 × 23,3 × 58,7 mm (H×Sz×Mé) |

## A projekt szempontjából releváns pontok

- **SH1.0 4-tűs csatlakozó**: `GND`, `3V3`, `GPIO2`, `GPIO1` – ide tervezzük az IZAR PULSE i jeladókat.
  - **`Fő vízmérő` → `GPIO1`**
  - **`Locsoló mérő` → `GPIO2`**
  - GND és 3V3 ugyanezen a csatlakozón elérhető, tehát a pull-up és a jeladó földje is innen vezethető.
- A beépített, gyárilag izolált RS485 interfész pontosan illeszkedik a korábban tervezett "izolált RS485 hub" ötlethez a jövőbeli nyomásmérőkhöz – nem kell hozzá külön izolációs modul, ha ezt a boardot használjuk a nyomásmérők bekötésére is.

## Teljes pin header kiosztás (2,0 mm raszter, nem SH1.0)

| Bal oldal | | Jobb oldal | |
|---|---|---|---|
| 3V3 | | 5V | |
| GND | | GND | |
| TXD | IO43 | IO20 | D_P |
| RXD | IO44 | IO19 | D_N |
| | IO3 | IO14 | |
| | IO4 | IO13 | |
| | IO5 | IO12 | |
| | IO6 | IO11 | |
| | IO7 | IO10 | |
| | IO8 | IO9 | |

## Fix funkciójú GPIO-k (fordítási időben lekötve)

| GPIO | Funkció |
|---|---|
| GPIO1 | SH1.0 csatlakozó – **Fő vízmérő impulzus** (terv) |
| GPIO2 | SH1.0 csatlakozó – **Locsoló mérő impulzus** (terv) |
| GPIO15 | CAN TX |
| GPIO16 | CAN RX |
| GPIO17 | RS485 TX |
| GPIO18 | RS485 RX |
| GPIO21 | RS485 EN |

## Státusz

**Megérkezett, 2026-08-13** – a `water-collector.yaml` `substitutions`-ai (`board_type`, pulzus-GPIO-k) mostantól közvetlenül erre a boardra céloznak; a korábbi, tesztelésre használt régebbi (nem S3) ESP32 board értékei kikommentezve maradtak a fájlban, referenciaként (arra az esetre, ha valaki visszaváltana rá RS485 nélküli bench-teszteléshez).

Az RS485 busz (`GPIO17` TX / `GPIO18` RX / `GPIO21` EN) ESPHome `uart:` komponensként van bekötve (`water-collector.yaml`), `flow_control_pin: GPIO21`-gyel – ez az esp-idf UART drivert hardveres RS485 fél-duplex módba kapcsolja (`UART_MODE_RS485_HALF_DUPLEX`), pontosan megfelelve a board saját specifikációjának ("Direction Control: Automatically controlled via host hardware flow setting") – nincs szükség a `GPIO21` kézi (szoftveres) billegtetésére küldés előtt/után. A Modbus RTU mester-logika saját, kézzel írt kód (`include/rs485_modbus.h`), ld. `REQUIREMENTS.md` "Architekturális megfontolás v3" a részletekért.
