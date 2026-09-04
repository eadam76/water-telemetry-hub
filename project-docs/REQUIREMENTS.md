# Requirements

ESP32/ESPHome-based monitoring system for a water supply. Home Assistant provides history, statistics and visualization; the device itself must keep working (measuring, and reachable via its own dashboard) regardless of whether Home Assistant or the network is available.

Hardware specifics (part numbers, wiring, Modbus register maps) live under [`docs/hardware/`](docs/hardware/) - this document covers behavior only.

## Pulse water meters

- Two independent pulse-counting channels, same logic, each wired to its own GPIO.
- Counts every valid pulse exactly once. Reports instantaneous flow rate (L/min) and total consumption (m³).
- Flow rate and pulse rate are derived from the time between consecutive pulses (not a fixed sampling window), for better low-flow resolution and responsiveness. If no pulse arrives within a configurable "zero-flow timeout" (default 60s, per meter, runtime-adjustable), the rate is explicitly reported as 0 rather than left showing a stale value.
- Manual calibration sync: set the reading to match the physical meter's own dial, from the dashboard or Home Assistant. Applies immediately, independent of the periodic flash checkpoint.
- Accounting model, per meter:
  - `pulse_count` - monotonically increasing pulse count, persisted periodically (checkpointed).
  - `offset_m3` - calibration offset, persisted immediately on every change.
  - `total_consumption_m3 = offset_m3 + pulse_count × liters_per_pulse / 1000`
  - A manual sync recomputes `offset_m3` so the total lands exactly on the entered value without disturbing `pulse_count`. This can move the total backward as well as forward if the physical meter's own reading is behind what's currently shown.
- A power loss can lose at most one checkpoint interval's worth of pulses on restart (the counter resumes from the last persisted value); a manual sync always persists immediately regardless.
- `liters_per_pulse` is configurable per meter.

## Modbus (RS485) pressure & flow sensors

- A fixed number of device "slots", each independently configurable at runtime (no reflashing) with: device type (Pressure or Flow), Modbus address, and a display name.
- **Bus scan**: sweeps the full 1-247 address range for devices not yet registered in a slot, and detects their type automatically (read-only fingerprinting, never a write) so it can be pre-filled when adding.
- **Commissioning a new device**: requires it to be the only device on the bus still at its address at commissioning time (a shared factory-default address can't otherwise be told apart). Registering it assigns it to a slot; its identity persists immediately.
- **Changing the address of an already-registered sensor** actually reprograms the physical device over the bus - it can fail (device unpowered, disconnected, or already reprogrammed but unconfirmed), and the outcome is always reported, never silently assumed.
- **Collision detection**, two distinct things:
  - Two of *our own* registered slots configured to the same address - pure client-side validation, hard-blocked before it can happen (an address collision here would mean actually reprogramming a live sensor onto an address already in use).
  - A genuine electrical/protocol-level collision (two physical devices answering on the same address) - detected from the shape of the corrupted reply on the wire, both during a scan and continuously during normal polling. Reported as a distinct "Collision?" status, separate from "no response".
- **Type mismatch detection**: a periodic, low-rate identity check (independent of the continuous measurement poll) catches a device that decodes plausible-looking values for the wrong slot type (e.g. a flow meter's registers happening to decode as a plausible pressure reading).
- Zero-offset/fine calibration for pressure sensors is applied on the device itself (a writable register), not layered in software.
- Communication status (online/lost) is tracked per slot; one sensor's failure never affects any other slot sharing the bus.

## Persistence & fault handling

- The device is the primary data source; nothing depends on Home Assistant, MQTT, or network availability to keep measuring.
- Frequently-changing state (pulse counts, live readings) is checkpointed periodically rather than written on every change, to limit flash wear. State that changes rarely and matters immediately (calibration syncs, device slot identity) is persisted the moment it changes.
- A single failed sensor or a bus-wide issue never blocks the rest of the system, including the dashboard itself.

## Home Assistant integration

Exposed via ESPHome's native API (mDNS-discoverable), entirely optional:

- Operational: flow rate, total consumption, pressure - all with a history-friendly `state_class`.
- Diagnostic: pulse rate, raw pulse count, per-device communication status.
- Configuration/service: manual reading sync, zero-flow timeout, per-slot device management.

## Diagnostics

- A local, fixed-size in-memory ring buffer retains recent log output (independent of whatever's live-streaming to a currently-open dashboard tab) and can be downloaded as a plain text file from the device - never written to flash, so it costs no flash wear and is bounded regardless of uptime.
- Verbose wire-level Modbus tracing is available but off by default, toggled at runtime.

## Network & security

- Wi-Fi credentials are never part of the firmware build; they're provisioned at runtime on first boot (Bluetooth or a Wi-Fi AP + captive portal) and stored only on the device itself.
- Other device-specific secrets (API encryption key, OTA password) are compile-time secrets, excluded from version control, but are not network credentials and don't expose anything about the home network on their own.
- The dashboard has no login - it's local-network-only by design; a login screen was judged to add friction without a real security benefit for that threat model.
- Static IP configuration is not supported (DHCP only) - implementing it would require patching ESPHome's own Wi-Fi component, judged not worth the risk to core connectivity.

## Out of scope

- Alerting (leak detection, burst pipe, prolonged zero consumption, pressure thresholds) - left to Home Assistant, built on the historized data this device already provides.
- Physical/environmental installation (enclosure, power supply) - not a software concern.
- Unlimited/arbitrary device counts - the Modbus slot count and pulse meter channel count are both fixed at compile time; a real fixed-slot redesign of this project would be needed to go higher.
