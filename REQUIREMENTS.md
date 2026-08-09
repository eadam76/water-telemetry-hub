# Water Supply Monitoring – Requirements

## Scope

ESP32/ESPHome based monitoring module for the water-supply system in the utility pit. Home Assistant provides history, statistics and visualization, but the ESP must continue to operate independently if HA or the network is unavailable.

## Pulse counter module

### Functional requirements

- Count each valid meter pulse exactly once.
- Support one or more pulse-based water meters using the same reusable module structure.
- Provide current flow in `L/min`.
- Provide total consumed volume in `m³`.
- Provide total pulse count for diagnostics.
- Provide pulse rate for diagnostics.
- Allow the displayed total meter reading to be synchronized manually to the physical water meter reading.
- Manual synchronization must be available from Home Assistant and, if practical, from the ESP local web interface.
- Manual meter-reading synchronization must be persisted immediately; it must not wait for the normal checkpoint interval.

### Persistence and failure handling

- The ESP is the authoritative source for the running pulse counter and total consumed volume.
- Operation must not depend on Home Assistant, MQTT, API connectivity or Wi-Fi availability.
- The live counter is maintained in RAM during normal operation.
- The accumulated counter is checkpointed to ESP flash/NVS periodically.
- Default checkpoint interval: `60 s`.
- After an unexpected power loss, at most the pulses received since the last checkpoint may be lost.
- After reboot, counting must resume automatically from the last persisted checkpoint.
- No external FRAM or other additional nonvolatile storage is required for the initial implementation.

### Home Assistant data model

Operational entities:

- `Flow`
  - unit: `L/min`
  - `state_class: measurement`
- `Total Volume`
  - unit: `m³`
  - `device_class: water`
  - `state_class: total_increasing`

Diagnostic entities:

- `Pulse Rate`
  - unit: `pulses/min`
  - `state_class: measurement`
- `Total Pulses`
  - unit: `pulses`
  - `state_class: total_increasing`

Configuration/service entities:

- meter reading input (`m³`)
- apply/synchronize meter reading action

### History and statistics

- ESP does not store long-term time-series data.
- Home Assistant is responsible for time-series storage, statistics, aggregation and visualization.
- Current flow must be visible and historized in Home Assistant.
- Total consumed volume must be historized in Home Assistant.
- Water consumption must be derivable for any arbitrary time interval.
- Hourly, daily, weekly and monthly consumption are HA-side aggregations.
- If Home Assistant is offline, the ESP must continue counting normally.
- Detailed flow history during a Home Assistant outage is not required to be retained by the ESP.
- When Home Assistant reconnects, the ESP's current absolute total is the authoritative value.

### Calibration

- Pulse-to-volume conversion must be configurable.
- The implementation should use a clear parameter such as `liters_per_pulse`.
- Pulse input filtering/debounce must be configurable to match the physical meter output.

## Initial implementation choice

- ESPHome `pulse_meter` for pulse detection and pulse-rate measurement.
- ESPHome persistent preferences/NVS for checkpoint storage.
- Normal flash writes are rate-limited by a configurable checkpoint/flush strategy.
- Explicit manual meter synchronization performs an immediate persistence sync.
