# QDW90A - Modbus RTU reference

This project's own reference for the pressure transmitter actually used: the bar-output, 4-wire RS485 variant. Values are confirmed on real hardware (`mbpoll`, direct point-to-point connection) and cross-checked against the manufacturer's own Modbus protocol document ([`qdw90a-modbus-protocol-manufacturer.pdf`](qdw90a-modbus-protocol-manufacturer.pdf)).

## Wiring

| Wire | Function |
| --- | --- |
| Red | `24V+` |
| Black | `24V-` (power ground - no separate signal ground) |
| Blue | RS485 `A` |
| Yellow | RS485 `B` |

The "Ground Wire" silkscreen label on the connector is misleading on this variant - the yellow wire is actually signal `B`, not a ground.

## Communication

```
Protocol:    Modbus RTU
Physical:    RS-485
Baud:        9600 8N1
Slave addr:  1 (factory default)
```

## Register map

**Writable registers - exactly these 4, per the manufacturer's document**: `H:0` (address), `H:1` (baud), `H:12` (zero offset), `H:37` (parity), plus two command registers (`H:15` save, `H:16` factory reset). **Every other register is read-only** - writing to one is rejected with a Modbus exception.

| Reg. | Function | Writable? | Measured value |
| --- | --- | --- | --- |
| `H:0` | Slave address, `Int16` (`1-255`) | yes | `1` |
| `H:1` | Baud code (`3` = 9600 - a code, not the raw baud value) | yes | `3` |
| `H:2` | Unit code (`3` = bar) | read-only | `3` |
| `H:3` | Decimal places | read-only | `2` |
| `H:4` | **Measured value** - `bar = H:4 / 100` | read-only | `0` (unloaded) |
| `H:5` | Range floor (factory calibration) | read-only | `0` |
| `H:6` | Range ceiling - `/100` gives `10.00 bar`, matching the sensor's rated range | read-only | `1000` |
| `H:12` | Zero offset, `Int16`, factory `0` - **output = calibrated reading + H:12** | yes | `0` |
| `H:15` | Save command - writing `0` persists any change to `H:0`/`H:1`/`H:12`/`H:37` | yes (command) | - |
| `H:16` | Factory reset command - writing `1` erases everything | yes (command, **use with care**) | - |
| `H:22-H:23` | The same measured value as raw `Float32` (big-endian ABCD), no scaling needed | read-only | `0.0` |
| `H:37` | Serial parity | yes | `0` |

`H:2` can encode 23 different units (pressure/level/temperature/pH/mass), but **is read-only** - it stays fixed at `3` (bar) here; changing it requires the manufacturer's own calibration tool.

**`H:4` vs. `H:22-H:23`**: the same measurement in two encodings - `H:4` is a raw, unscaled `Int16` that needs `H:3` (decimal places) to interpret; `H:22-H:23` is the same value, already a ready-to-use `Float32`. `H:22-H:23` is simpler to consume (no separate scale register to read), at the cost of decoding two registers as one Float32.

## Changing the address

**Not a single Modbus operation** - the response to the address write still comes from the **old** address, and the device only actually switches over afterward, so the save command has to go to the **new** address:

1. Only one not-yet-registered device may be on the bus at a time (they'd share the same factory default address).
2. Write the new slave address to `H:0` - sent to the **current (old)** address.
3. Write `0` to `H:15` (save) - sent to the **new** address.
4. Read back `H:0` at the new address to confirm.

Example, address `1 → 2`:

```
1) Write address 1->2, still to the old (1) address:  01 06 00 00 00 02 08 0B
2) Save, now to the new (2) address:                   02 06 00 0F 00 00 B9 FA
3) Confirm, read H:0 at address 2:                     02 03 00 00 00 01 84 39
```

The same two-step pattern applies to a baud-rate change (`H:1`).

## Zero offset (calibration)

`H:12` is writable, and **output pressure = calibrated reading + H:12** - a fine-calibration adjustment that needs no software-side offset layer; write the register, then save (`H:15=0`). The save step is required or the change is lost on restart.

## Factory reset

```
H:16 = 1, e.g. sent to address 1:  01 06 00 10 00 01 49 CF
```

Per the manufacturer's document, address/baud/calibration may revert to an unknown factory state afterward - the transmitter would need to be rediscovered.

## Request-size limit

**A single `0x03` (Read Holding Registers) request may ask for at most 20 registers.** Asking for 21 or more gets the entire request rejected with a non-standard `Illegal Function` exception (not just the part past register 20). Confirmed: `H:1-H:20` (20 registers) succeeds, `H:0-H:20` (21 registers) fails outright. Any firmware read wider than 20 registers has to be split into multiple requests.

## Unused / unconfirmed registers

- `H:24-H:29`: likely a real `Float32` parameter block (values look non-random), but undocumented and unused here.
- `H:8`, `H:9`, `H:10`, `H:11`, `H:14`, `H:21`, `H:33`, `H:39`: non-zero but unidentified, unused.
