# T3-1-2-H - Modbus RTU reference

Ultrasonic (transit-time) flow meter, per ISO4064-1:2005 / GB/T778.1-2007. Available in DN15/DN20/DN25/DN32/DN40; the unit this project uses is **DN20**.

## Flow range (DN20)

| Starting flow | Q1 (min) | Q2 (transitional) | Q3 (nominal) | Q4 (overload) |
|---|---|---|---|---|
| 0.004 m³/h | 0.016 m³/h | 0.026 m³/h | 3.200 m³/h | 4.000 m³/h |

Below the starting flow the meter does not register at all; between starting flow and Q1 there is no accuracy guarantee either way. On this unit, in practice, the instant flow rate register reads `0` below roughly 0.009 m³/h (~0.15 L/min) - this is the meter's own resolution floor, not something the firmware rounds or filters.

## Wiring

| Wire | Function |
| --- | --- |
| 1 | RS485 `A` (`485+`) |
| 2 | RS485 `B` (`485-`) |
| 3 | DC `8-36V` power in |
| 4 | GND |

Both pairs can be wired at once - external DC on 3/4, RS485 on 1/2 - and the meter runs entirely off the external supply (confirmed by current measurement: ~1.6 mA draw on the external supply, unaffected by RS485 traffic) while the internal battery sits untouched as backup. Since the internal battery is sealed and not replaceable, keep the external supply on the same source as the controller so a power loss is visible immediately rather than silently draining the battery over months.

Without external power, the meter runs on its own internal 3.6V 4Ah lithium battery (vendor-rated >10 years) and enters a low-power state when there's no flow.

## Communication

```
Protocol:    Modbus RTU
Physical:    RS-485
Baud:        9600 8N1
Slave addr:  1 (factory default, max 255)
```

## Registers used by this project

Document register numbers (1-based, as printed on the meter's own protocol reference); the Modbus PDU address is one less than the document number.

| Register | Format | Description | Unit |
|---|---|---|---|
| 0001-0002 | Float32 | Instantaneous flow rate | m³/h |
| 0009-0010 | Int32 | Accumulated total, whole litres | L |
| 0011-0012 | Float32 | Accumulated total, fractional litre (e.g. `0.123` = 123 mL) | L |
| 0062 | Int16 | Slave address, writable, max 255 | |
| 0095 | Int16 | Battery voltage: `V = reg × 2.5 / 4096` | V |
| 0361 | Float32 (2 reg) | Communication self-test, always reads `361.0` | |

The accumulated total is `(0009-0010) + (0011-0012)`, in litres. The document describes a separate scaling-exponent register for this pair (for other unit/range choices), but on this unit the pair is confirmed to be plain litres directly - no exponent needed.

All multi-register values are big-endian, low word first (i.e. the lower-addressed register holds the low 16 bits).
