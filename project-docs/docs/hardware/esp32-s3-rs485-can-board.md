# Waveshare ESP32-S3-RS485-CAN

Summary of the manufacturer's product page (original datasheet: [`esp32-s3-rs485-can-board.pdf`](esp32-s3-rs485-can-board.pdf)).

## Specs

| | |
|---|---|
| Model | ESP32-S3-RS485-CAN (onboard antenna) / -U (external antenna) |
| Chip | ESP32-S3R8, dual-core Xtensa LX7, 240 MHz, 16 MB flash |
| Wireless | 2.4 GHz Wi-Fi (802.11 b/g/n) + Bluetooth 5 (LE) |
| Bus interfaces | Galvanically isolated **RS485** and **CAN**, terminal block |
| Protection | TVS diode, surge/ESD protection on the RS485/CAN interfaces |
| Power | DC 7-36V terminal, or USB-C (power + debug + flashing) |
| Extras | Onboard RTC (PCF85063), jumper-selectable 120Ω termination on both buses |
| Enclosure | DIN-rail mountable |
| Size | 91.7 × 23.3 × 58.7 mm (L×W×H) |

## Pins used by this project

The 4-pin SH1.0 connector (`GND`, `3V3`, `GPIO2`, `GPIO1`) carries the pulse meter inputs:

| Pin | Function |
|---|---|
| `GPIO1` | Pulse Meter 1 input |
| `GPIO2` | Pulse Meter 2 input |
| `GPIO17` | RS485 TX |
| `GPIO18` | RS485 RX |
| `GPIO21` | RS485 direction control (DE/RE) |
| `GPIO15` / `GPIO16` | CAN TX/RX (unused by this project) |

The RS485 direction pin is driven by the ESP-IDF UART driver's own hardware half-duplex mode (`flow_control_pin` in `water-telemetry-hub.yaml`'s `uart:` block) - no manual GPIO toggling needed around each transaction.

## Full pin header (2.0 mm pitch, separate from the SH1.0 connector)

| Left | | Right | |
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
