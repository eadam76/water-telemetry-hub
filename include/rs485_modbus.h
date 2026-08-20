#pragma once

// Hand-written Modbus RTU master helpers for the QDW90A pressure sensors,
// over the Waveshare ESP32-S3-RS485-CAN board's isolated RS485 UART (see
// docs/hardver/esp32-s3-rs485-can-board.md, water-collector.yaml's `uart:`
// block). NOT ESPHome's built-in `modbus_controller:` component - that
// assumes one fixed slave address per controller instance, chosen at
// compile time, but this project's pressure sensor slots each have a
// *runtime*-configurable Modbus address (see packages/pressure_sensor.yaml,
// "Architekturális megfontolás v3" in REQUIREMENTS.md), and also needs a
// bus-wide address scan that modbus_controller has no equivalent for.
//
// Protocol details implemented here (CRC16, the 20-register request cap,
// the two-step address-change/save sequence, the H:22-H:23 Float32
// pressure encoding) are all hardware-confirmed against the real QDW90A
// and cross-checked against the manufacturer's own Modbus protocol PDF -
// see docs/hardver/qdw90a-modbus-referencia.md for the authoritative
// writeup this file is a direct implementation of.
//
// Included globally (not just where used) via `esphome: includes:` in
// water-collector.yaml, so every symbol here is available from any
// lambda without an explicit #include.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "esphome/core/alloc_helpers.h"
#include "esphome/core/application.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"
#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/text_sensor/text_sensor.h"
#include "esphome/components/uart/uart.h"

namespace rs485_modbus {

using esphome::uart::UARTComponent;

// Everything in this file logs under this one tag - "Debug Log: Modbus"
// (water-collector.yaml's `switch:` section) flips it to VERY_VERBOSE at
// runtime via `logger.set_level`, off by default (see the `logger:`
// block's own comment for why the compile-time ceiling has to be raised
// separately from the runtime default for that switch to have anything
// to turn on).
static const char *const TAG = "modbus";

// --- CRC16 (Modbus RTU, poly 0xA001, init 0xFFFF) --------------------
// Cross-checked against 4 worked examples straight from the QDW90A
// manufacturer's own Modbus protocol PDF - all matched exactly.
inline uint16_t crc16(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t pos = 0; pos < len; pos++) {
    crc ^= data[pos];
    for (int i = 0; i < 8; i++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

// --- Low-level transaction plumbing -----------------------------------

// Blocks (yielding, not busy-spinning) until either `count` bytes are
// available to read or `timeout_ms` elapses. Deliberately NOT
// UARTComponent::read_array()'s own built-in wait (a fixed 100ms per
// call, confirmed from the installed esphome package's own
// uart_component.cpp) - that floor is far too slow for a 1-247 address
// bus scan. Polling available() ourselves is what lets scan_bus() below
// use a much shorter per-address timeout, while read_holding_registers()/
// write_single_register() still pass a longer one for a real transfer.
//
// App.feed_wdt() here is load-bearing, not decoration: a full 1-247
// scan_bus() runs synchronously inside one button press, ~6s total with
// nothing responding (247 addresses x the ~25ms probe timeout) - that
// whole stretch never returns to ESPHome's own Application::loop(),
// which is what normally feeds the ESP-IDF task watchdog on every main
// loop tick. Confirmed on real hardware: without this, the watchdog
// fires mid-scan and the device hard-crashes/reboots. feed_wdt() is
// internally rate-limited (see the installed esphome package's own
// application.h/.cpp - safe and cheap to call every spin of this loop.
inline bool wait_for_bytes(UARTComponent *bus, size_t count, uint32_t timeout_ms) {
  uint32_t start = esphome::millis();
  while (bus->available() < count) {
    if (esphome::millis() - start >= timeout_ms) return false;
    esphome::App.feed_wdt();
    esphome::yield();
  }
  return true;
}

// Drains and discards anything already sitting in the RX buffer before a
// new request - a stale reply left over from the previous request's
// timeout (or unsolicited bus noise) would otherwise get misread as this
// request's response. (Not needed to filter out this device's own
// transmission: the `flow_control_pin` on the `uart:` bus puts the
// esp-idf UART driver into true hardware RS485 half-duplex mode, which
// does not loop TX back into RX at all - confirmed from the installed
// esphome package's own uart_component_esp_idf.cpp.)
inline void flush_rx(UARTComponent *bus) {
  uint8_t discard;
  while (bus->available() > 0) {
    if (!bus->read_byte(&discard)) break;
  }
}

// Sends `request` (address+function+data - CRC appended here) and
// returns the raw reply bytes, or an empty vector on timeout/a
// malformed/CRC-failed/wrong-address reply. `expected_len` is the exact
// reply length for a *successful* response to this specific request
// (Modbus RTU has no length prefix/terminator, so the caller has to know
// what a good reply looks like); a Modbus *exception* reply is always
// exactly 5 bytes (address, function|0x80, exception code, 2 CRC bytes)
// and is recognized here regardless of what `expected_len` says, so
// callers can tell "device answered with an error" (a non-empty 5-byte
// reply with the high bit of the function byte set) apart from
// "nothing answered at all" (empty).
//
// `any_reply`, if given, is set true the moment ANY bytes at all arrive
// in response - regardless of what happens to them afterward (CRC fail,
// wrong address, etc.). This is what lets scan_bus() below tell "no
// device here" (a real timeout, nothing ever arrived) apart from "two+
// devices share this address" (something answered, but got garbled) -
// confirmed on real hardware, 2026-08-13: three sensors deliberately set
// to the same address produced exactly this - a received-but-CRC-failed
// reply, not a timeout. See docs/hardver/qdw90a-modbus-referencia.md's
// "Ütközés kimutatása" for why this still isn't proof of a collision
// (could in principle be plain bus noise instead), just a strong signal.
inline std::vector<uint8_t> transact(UARTComponent *bus, const std::vector<uint8_t> &request, size_t expected_len,
                                      uint32_t timeout_ms, bool *any_reply = nullptr) {
  if (any_reply) *any_reply = false;
  flush_rx(bus);
  uint16_t crc = crc16(request.data(), request.size());
  std::vector<uint8_t> frame = request;
  frame.push_back(static_cast<uint8_t>(crc & 0xFF));         // CRC low byte first (Modbus RTU wire order)
  frame.push_back(static_cast<uint8_t>((crc >> 8) & 0xFF));  // CRC high byte
  ESP_LOGVV(TAG, "-> %s", esphome::format_hex_pretty(frame).c_str());
  bus->write_array(frame);

  // The shortest possible reply (an exception) is 5 bytes - wait for at
  // least the first 3 (address, function, byte-count-or-exception-code)
  // before deciding how much more to read.
  if (!wait_for_bytes(bus, 3, timeout_ms)) {
    // Real build warning, found in the same 2026.7.3 build log that
    // caught the Select::state removal above, 2026-08-19: on the
    // xtensa/ESP32 target, uint32_t is `unsigned long`, not `unsigned
    // int` - %u mismatched it. Cast, not a PRIu32/<inttypes.h> macro -
    // simplest fix for one log line, no new include needed.
    ESP_LOGVV(TAG, "<- address %d: no reply within %ums", request[0], static_cast<unsigned int>(timeout_ms));
    return {};
  }
  if (any_reply) *any_reply = true;
  uint8_t head[3];
  if (!bus->read_array(head, 3)) {
    ESP_LOGVV(TAG, "<- address %d: UART read error on the header bytes", request[0]);
    return {};
  }

  bool is_exception = (head[1] & 0x80) != 0;
  size_t total_len = is_exception ? 5 : expected_len;
  if (total_len < 3) return {};  // malformed caller expectation - nothing sane to do

  std::vector<uint8_t> reply(head, head + 3);
  size_t remaining = total_len - 3;
  if (remaining > 0) {
    if (!wait_for_bytes(bus, remaining, timeout_ms)) {
      ESP_LOGVV(TAG, "<- address %d: reply started (%s...) but the rest never arrived", request[0],
                esphome::format_hex_pretty(reply).c_str());
      return {};
    }
    reply.resize(total_len);
    if (!bus->read_array(reply.data() + 3, remaining)) {
      ESP_LOGVV(TAG, "<- address %d: UART read error on the reply body", request[0]);
      return {};
    }
  }

  uint16_t got_crc = static_cast<uint16_t>(reply[reply.size() - 2] | (reply[reply.size() - 1] << 8));
  uint16_t want_crc = crc16(reply.data(), reply.size() - 2);
  if (got_crc != want_crc) {
    ESP_LOGVV(TAG, "<- %s: CRC mismatch (got %04X, wanted %04X) - bus noise or a collision",
              esphome::format_hex_pretty(reply).c_str(), got_crc, want_crc);
    return {};
  }
  if (reply[0] != request[0]) {
    // reply from a different address - bus noise/collision, ignore
    ESP_LOGVV(TAG, "<- %s: address in reply doesn't match request (asked %d) - ignored",
              esphome::format_hex_pretty(reply).c_str(), request[0]);
    return {};
  }
  ESP_LOGVV(TAG, "<- %s", esphome::format_hex_pretty(reply).c_str());
  return reply;
}

// --- Request builders ---------------------------------------------------

inline std::vector<uint8_t> build_read_request(uint8_t address, uint16_t start_reg, uint16_t count) {
  return {address, 0x03, static_cast<uint8_t>(start_reg >> 8), static_cast<uint8_t>(start_reg & 0xFF),
          static_cast<uint8_t>(count >> 8), static_cast<uint8_t>(count & 0xFF)};
}

inline std::vector<uint8_t> build_write_request(uint8_t address, uint16_t reg, uint16_t value) {
  return {address, 0x06, static_cast<uint8_t>(reg >> 8), static_cast<uint8_t>(reg & 0xFF),
          static_cast<uint8_t>(value >> 8), static_cast<uint8_t>(value & 0xFF)};
}

// --- Public operations --------------------------------------------------

// 0x03 Read Holding Registers. `count` must be 1-20 - the QDW90A itself
// rejects a whole 21+-register request with an Illegal Function
// exception (see qdw90a-modbus-referencia.md's "Kérésméret-korlát"
// section, reproduced/confirmed on real hardware) - this does NOT
// auto-chunk a larger request, callers must respect the limit
// themselves (none of this project's own reads ever need more than 2).
// `device_responded` (2026-08-21, optional - only read_flow_total()
// passes it so far) is a THIRD, distinct outcome from `any_reply`/the
// return value: true whenever the reply this function actually received
// was a real, coherent, validated answer from exactly the address asked
// - whether that answer was a successful read OR a clean Modbus
// exception. Left null (and simply not written to) by every OTHER
// existing caller, which don't need this extra nuance - see
// publish_poll_result()'s own comment for what this is actually used
// for once a caller does pass it.
inline bool read_holding_registers(UARTComponent *bus, uint8_t address, uint16_t start_reg, uint16_t count,
                                    std::vector<uint16_t> &out, uint32_t timeout_ms = 200,
                                    bool *any_reply = nullptr, bool *device_responded = nullptr) {
  if (device_responded) *device_responded = false;
  if (count == 0 || count > 20) return false;
  auto request = build_read_request(address, start_reg, count);
  size_t expected_len = 5 + 2 * static_cast<size_t>(count);
  auto reply = transact(bus, request, expected_len, timeout_ms, any_reply);
  // A genuine Modbus exception (function code | 0x80) - real bug found
  // and fixed 2026-08-21, from a device log the user attached showing
  // exactly this: reading a real, correctly-addressed device's own
  // register range it simply doesn't support (this project's own
  // read_flow_total()'s scale-exponent register, on the actual T3-1-2-H
  // hardware) came back as a clean 5-byte exception frame - which
  // transact() already fully validated (CRC correct, address matches
  // the request) before returning it here at all, exactly the same
  // validation any normal successful reply gets. That's unambiguous
  // proof exactly ONE device answered, coherently, with a real (if
  // negative) Modbus-protocol response - the polar opposite of a
  // collision (2+ devices answering at once corrupts the bytes on the
  // wire, which fails transact()'s own CRC check and comes back empty,
  // never as a clean validated exception). Despite that, this fell
  // through to the plain expected_len mismatch below - a 5-byte
  // exception is essentially never as long as a real data reply wants -
  // returning `false` correctly, but leaving `any_reply` (set true by
  // transact() the moment ANY bytes arrived in time, before any of this
  // validation) sitting at true, which every caller in this file reads
  // as "possible collision". Confirmed on real hardware: a Flow-type
  // slot whose totalizer scale-exponent register isn't supported
  // permanently showed "Collision?" - registering the exact same
  // physical address as "Pressure" instead (never hitting this
  // register at all) showed no collision, the same address, same bus,
  // same everything else - the collision flag itself was the only thing
  // that differed, confirming it was never a real bus condition.
  if (reply.size() == 5 && (reply[1] & 0x80) != 0) {
    if (any_reply) *any_reply = false;
    if (device_responded) *device_responded = true;
    return false;
  }
  if (reply.size() != expected_len) return false;
  if (reply[1] != 0x03) return false;               // exception (or, in principle, garbage)
  if (reply[2] != 2 * count) return false;           // byte-count sanity check
  out.clear();
  out.reserve(count);
  for (uint16_t i = 0; i < count; i++) {
    uint16_t hi = reply[3 + i * 2];
    uint16_t lo = reply[4 + i * 2];
    out.push_back(static_cast<uint16_t>((hi << 8) | lo));
  }
  if (device_responded) *device_responded = true;
  return true;
}

// 0x06 Write Single Register - only H:0 (address), H:1 (baud), H:12
// (zero offset), H:37 (parity), plus the H:15/H:16 command registers are
// actually writable on the QDW90A; everything else replies with an
// exception (surfaced here simply as `false`, same as any other
// failure - see docs/hardver/qdw90a-modbus-referencia.md's register
// table for which is which).
inline bool write_single_register(UARTComponent *bus, uint8_t address, uint16_t reg, uint16_t value,
                                   uint32_t timeout_ms = 200) {
  auto request = build_write_request(address, reg, value);
  // A successful write echoes the request exactly (function 0x06,
  // register+value unchanged) - always 8 bytes.
  auto reply = transact(bus, request, 8, timeout_ms);
  return reply.size() == 8 && reply[1] == 0x06;
}

// Cheapest possible "is anything at this address" probe - reads just
// H:0 (1 register). Used only by scan_bus() below - the live per-slot
// pressure poll (pressure_sensor.yaml) calls read_pressure_bar()
// directly instead, but reads the same underlying any_reply signal
// itself (see that function's own `collision` parameter) to feed the
// same three-way distinction into continuous polling too, not just a
// one-shot bus scan.
enum class ProbeResult : uint8_t { NO_RESPONSE, COLLISION, FOUND };

inline ProbeResult probe(UARTComponent *bus, uint8_t address, uint32_t timeout_ms = 25) {
  std::vector<uint16_t> tmp;
  bool any_reply = false;
  if (read_holding_registers(bus, address, 0, 1, tmp, timeout_ms, &any_reply)) return ProbeResult::FOUND;
  return any_reply ? ProbeResult::COLLISION : ProbeResult::NO_RESPONSE;
}

// --- Address-CSV helpers -------------------------------------------------
// Shared by update_scan_result_address()/set_scan_collision_address()
// below - both read-modify-write a "Scan Results"/"Scan Collisions"-
// shaped text_sensor (comma-separated decimal addresses, e.g. "1,4,9").

inline std::vector<uint8_t> parse_address_csv(const std::string &csv) {
  std::vector<uint8_t> addresses;
  size_t start = 0;
  while (start <= csv.size()) {
    size_t comma = csv.find(',', start);
    std::string token = csv.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
    int parsed = atoi(token.c_str());
    if (parsed > 0 && parsed <= 247) addresses.push_back(static_cast<uint8_t>(parsed));
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return addresses;
}

inline std::string join_address_csv(std::vector<uint8_t> addresses) {
  std::sort(addresses.begin(), addresses.end());
  std::string csv;
  for (size_t i = 0; i < addresses.size(); i++) {
    if (i > 0) csv += ",";
    csv += std::to_string(addresses[i]);
  }
  return csv;
}

// Sweeps [min_address, max_address] with a short per-address timeout.
// `found` - "New device" rows in the dashboard's pressure table come
// from this (see the "Scan Bus" button, water-collector.yaml).
// `collisions` - addresses where *something* answered but the reply
// didn't survive its own CRC check - confirmed on real hardware,
// 2026-08-13, as the actual signature of two+ devices sharing one
// address (see probe()'s own comment) - surfaced in the dashboard as
// its own "Collision?" status, distinct from both "New" and "nothing
// there at all" (addresses in neither list). A full 1-247 sweep at the
// default timeout takes a few seconds - deliberately only run on
// demand, not on a fast interval; per-slot liveness during normal
// operation instead comes from each registered slot's own pressure poll,
// not from repeatedly re-scanning the whole bus.
struct ScanResult {
  std::vector<uint8_t> found;
  std::vector<uint8_t> collisions;
};

inline ScanResult scan_bus(UARTComponent *bus, uint8_t min_address, uint8_t max_address,
                            uint32_t per_address_timeout_ms = 25) {
  ESP_LOGD(TAG, "scan_bus: sweeping addresses %d-%d (~%.1fs total)...", min_address, max_address,
           (max_address - min_address + 1) * per_address_timeout_ms / 1000.0f);
  ScanResult result;
  for (uint16_t address16 = min_address; address16 <= max_address; address16++) {
    auto address = static_cast<uint8_t>(address16);
    ProbeResult first = probe(bus, address, per_address_timeout_ms);
    if (first == ProbeResult::FOUND) {
      // A single clean probe isn't proof nothing else shares this
      // address - RS485 bus arbitration between two colliding devices
      // means any one probe can land a clean single-device reply purely
      // by chance, even while a second device is genuinely still there.
      // Confirmed non-deterministic on real hardware, 2026-08-13: the
      // exact same wiring (two devices at one address, a third
      // elsewhere) sometimes needed a second Scan Bus press before the
      // collision actually showed up. Re-probe once before trusting a
      // FOUND result - only escalates to COLLISION on a second, *actual*
      // positive collision signal (a CRC-failed-but-received reply), not
      // merely a second miss (a lone NO_RESPONSE proves nothing either
      // way, so it doesn't override an already-confirmed FOUND). Only
      // ever costs a second probe for addresses that answered at all -
      // the vast majority of a 1-247 sweep gets pure silence and stays
      // exactly as cheap as before.
      if (probe(bus, address, per_address_timeout_ms) == ProbeResult::COLLISION) {
        first = ProbeResult::COLLISION;
      }
    }
    switch (first) {
      case ProbeResult::FOUND:
        result.found.push_back(address);
        break;
      case ProbeResult::COLLISION:
        result.collisions.push_back(address);
        break;
      case ProbeResult::NO_RESPONSE:
        break;
    }
  }
  // Decimal, comma-separated (Modbus addresses are conventionally
  // decimal, e.g. "1,4,9" - matching how the "Scan Results" CSV itself
  // is built, water-collector.yaml's Scan Bus button) - NOT
  // format_hex_pretty(), which would print byte *values* in hex and read
  // as a different, confusing set of numbers here.
  auto join_decimal = [](const std::vector<uint8_t> &addresses) {
    std::string list;
    for (size_t i = 0; i < addresses.size(); i++) {
      if (i > 0) list += ", ";
      list += std::to_string(addresses[i]);
    }
    return list;
  };
  ESP_LOGD(TAG, "scan_bus: found %zu device(s): %s", result.found.size(), join_decimal(result.found).c_str());
  if (!result.collisions.empty()) {
    ESP_LOGD(TAG, "scan_bus: %zu likely collision(s) at: %s", result.collisions.size(),
             join_decimal(result.collisions).c_str());
  }
  return result;
}

// Reads the QDW90A's ready-scaled pressure straight from H:22-H:23, as a
// big-endian (ABCD word order) IEEE-754 Float32 - see
// qdw90a-modbus-referencia.md's "H:4 vs. H:22-H:23" section for why this
// is used instead of H:4 (needs separately reading+applying H:3's
// decimal-places scaling).
//
// `collision`, if given, is set true when this failure looks like two+
// devices sharing this address (a reply arrived but didn't survive its
// own CRC check) rather than plain silence - same signal probe()/
// scan_bus() already use, now also available to a registered slot's own
// continuous poll. Added after real-hardware testing, 2026-08-13, showed
// this mattered in practice: adding a second device at an address
// already polled by a registered slot just made that slot flicker
// Lost/OK with no indication *why*, until an explicit Scan Bus press
// happened to catch it - see pressure_sensor.yaml's own use of this.
inline bool read_pressure_bar(UARTComponent *bus, uint8_t address, float &out, uint32_t timeout_ms = 200,
                               bool *collision = nullptr) {
  std::vector<uint16_t> regs;
  bool any_reply = false;
  if (!read_holding_registers(bus, address, 22, 2, regs, timeout_ms, &any_reply)) {
    // DEBUG, not VV: this is a registered slot's own poll failing -
    // exactly the "Lost"/"Collision?" diagnostic signal (see
    // pressure_sensor.yaml's Online binary_sensor) - worth seeing
    // without turning on the full wire-level trace. A successful read
    // stays silent here (the value's already visible as the Pressure
    // sensor's own state) - only the failures are the actionable/
    // unusual case.
    ESP_LOGD(TAG, "address %d: pressure read failed%s", address, any_reply ? " (possible collision)" : "");
    if (collision) *collision = any_reply;
    return false;
  }
  if (collision) *collision = false;
  uint32_t bits = (static_cast<uint32_t>(regs[0]) << 16) | regs[1];
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  out = value;
  return true;
}

// Reads a second, DIFFERENT device class's instant reading - the T3-1-2-H
// ultrasonic flow meter's instant flow rate, added 2026-08-19 (first unit
// ordered same day) as this project's first slot besides the QDW90A
// pressure sensor - see packages/pressure_sensor.yaml's own "Device Type"
// select entity for how a slot picks which of these two readers actually
// runs. Deliberately the ONLY flow-meter register implemented so far
// (instant flow rate, document register "0001-0002", same big-endian
// ABCD-word-order IEEE-754 Float32 encoding as the pressure sensor's own
// H:22-H:23) - the totalizer (document registers 0009-0012, a LONG
// integer part + a separate IEEE754 decimal part, together scaled by a
// THIRD, distant register's own exponent - see
// docs/hardver/t3-1-2-h-aramlasmero-jegyzet.md's "Skálázási képlet" for
// the full (N+Nf)×10^n formula) is intentionally left for a follow-up
// once real hardware confirms that scaling actually behaves as
// documented - starting with just the simple, single-transaction,
// high-confidence reading keeps this initial cut small and honest about
// what's actually been verified, per the same "device class = an
// isolated, addable driver function" architecture packages/
// pressure_sensor.yaml's own header describes.
//
// NOT YET HARDWARE-CONFIRMED (2026-08-19) - the physical device hasn't
// arrived yet; this is built from the manufacturer's own official "T3-1
// SERIES ultrasonic water meter communication protocol" document (V51
// firmware), the strongest source found so far, but per this project's
// own established practice (see the QDW90A's own history) nothing here
// is treated as final until read back from the real sensor. Two specific
// things worth re-checking once it has:
//   - Whether the document's "0001" really means PDU register address 0
//     (START_REG below) or 1 - a common off-by-one ambiguity in this
//     style of translated datasheet that the QDW90A's own H:NN
//     convention never had (that one was already 0-based and hardware-
//     confirmed). If this reads back garbage/NaN-looking floats on real
//     hardware, trying START_REG = 1 first is the obvious next step.
//   - The default RS485 settings the document lists (9600 baud, no
//     parity, address 1) already match what water-collector.yaml's
//     `uart: rs485_uart` bus runs at - if the physical unit actually
//     shipped configured differently, no code here would need to
//     change, just that bus config (out of scope for this function).
inline bool read_flow_instant(UARTComponent *bus, uint8_t address, float &out, uint32_t timeout_ms = 200,
                               bool *collision = nullptr) {
  const uint16_t START_REG = 0;  // document register "0001" - see the off-by-one caveat above
  std::vector<uint16_t> regs;
  bool any_reply = false;
  if (!read_holding_registers(bus, address, START_REG, 2, regs, timeout_ms, &any_reply)) {
    ESP_LOGD(TAG, "address %d: flow rate read failed%s", address, any_reply ? " (possible collision)" : "");
    if (collision) *collision = any_reply;
    return false;
  }
  if (collision) *collision = false;
  uint32_t bits = (static_cast<uint32_t>(regs[0]) << 16) | regs[1];
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  out = value;
  return true;
}

// The flow meter's own accumulated total - added 2026-08-21, direct
// feedback: the totalizer this project's own earlier design note
// deliberately deferred (see read_flow_instant()'s own comment above)
// until real hardware confirmed the scaling actually behaved as
// documented. "a flow meter a dashboardon nem mutat total
// consumption-t... nem is nekünk kéne számolni hanem majd jön a
// device-tól ahogy pollozzuk" - shouldn't be calculated by us, it
// should come straight from the device as it's polled, exactly like
// this reads it: document registers 0009-0012 (a LONG integer part +
// an IEEE754 decimal part, both PDU-adjacent so one 4-register
// transaction covers both) plus a THIRD, distant register (1439, the
// scale exponent) read separately, per the document's own "Skálázási
// képlet" (docs/hardver/t3-1-2-h-aramlasmero-jegyzet.md):
//
//   final = (N + Nf) × 10^n
//
// The exponent is re-read on every call rather than cached - it's a
// fixed calibration value that should never actually change at
// runtime, so this is one extra short single-register transaction per
// poll purely for simplicity/correctness (no cache-staleness class of
// bug possible), not because the value is expected to move.
//
// NOT YET HARDWARE-CONFIRMED for this specific register range
// (2026-08-21) - read_flow_instant() above (document registers
// 0001-0002, this driver's START_REG=0 convention) is now confirmed
// working against the real unit ("FLOW2" reads a real, live m³/h value
// on the dashboard), which is meaningful evidence FOR the same "doc
// register N -> PDU address N-1" convention holding here too (same
// document, same table, same numbering scheme) - but the totalizer's
// OWN scaling formula, and the exponent register specifically, haven't
// been read back from real hardware yet. If this returns an
// implausible number (wildly too large/small, or changes by an
// unreasonable jump between polls) on the real device, the exponent
// register (1439, document numbering - PDU_EXPONENT_REG below) is the
// first thing worth double-checking, the same off-by-one caveat as
// every other register in this file.
inline bool read_flow_total(UARTComponent *bus, uint8_t address, float &out, uint32_t timeout_ms = 200,
                             bool *collision = nullptr, bool *device_responded = nullptr) {
  if (device_responded) *device_responded = false;
  const uint16_t START_REG = 8;           // document register "0009" (0009 - 1, same convention as read_flow_instant())
  const uint16_t PDU_EXPONENT_REG = 1438;  // document register "1439"
  std::vector<uint16_t> regs;
  bool any_reply = false;
  bool primary_device_responded = false;
  if (!read_holding_registers(bus, address, START_REG, 4, regs, timeout_ms, &any_reply,
                              &primary_device_responded)) {
    ESP_LOGD(TAG, "address %d: flow total read failed%s", address, any_reply ? " (possible collision)" : "");
    if (collision) *collision = any_reply;
    if (device_responded) *device_responded = primary_device_responded;
    return false;
  }
  uint32_t n_bits = (static_cast<uint32_t>(regs[0]) << 16) | regs[1];
  uint32_t nf_bits = (static_cast<uint32_t>(regs[2]) << 16) | regs[3];
  float nf;
  std::memcpy(&nf, &nf_bits, sizeof(nf));

  std::vector<uint16_t> exp_regs;
  bool exp_any_reply = false;
  bool exp_device_responded = false;
  if (!read_holding_registers(bus, address, PDU_EXPONENT_REG, 1, exp_regs, timeout_ms, &exp_any_reply,
                               &exp_device_responded)) {
    // Real bug found and fixed 2026-08-21 (a second fix, same day as the
    // read_holding_registers() one above - a real device log showed the
    // status badge STILL reading "Collision" after that first fix): this
    // branch is only ever reached once the FIRST read above has already
    // SUCCEEDED - `any_reply` from that call is simply true because a
    // device answered, which is normal/expected for a successful read,
    // not a collision signal at all. `*collision = any_reply ||
    // exp_any_reply` was silently ORing that stale, unrelated "yes,
    // something replied to the FIRST request" flag back in here,
    // guaranteeing collision=true regardless of what the exponent read's
    // own any_reply actually said. Uses exp_any_reply alone now - the
    // only one of the two that's actually about THIS read.
    ESP_LOGD(TAG, "address %d: flow total scale exponent read failed%s", address,
              exp_device_responded ? " (device responded, register not supported)"
              : exp_any_reply       ? " (possible collision)"
                                     : "");
    if (collision) *collision = exp_any_reply;
    // The first totalizer read already succeeded before this branch, so
    // the device is reachable even if the separate exponent read is
    // silent or unusable.
    if (device_responded) *device_responded = true;
    return false;
  }
  if (collision) *collision = false;
  if (device_responded) *device_responded = true;
  // Document range is -4..3 - a signed 16-bit register (int16_t, not
  // uint16_t) so a negative exponent (dividing, not multiplying) reads
  // back correctly rather than as a huge positive value.
  int16_t n_exp = static_cast<int16_t>(exp_regs[0]);
  out = (static_cast<float>(n_bits) + nf) * std::pow(10.0f, static_cast<float>(n_exp));
  return true;
}

// Re-addresses a device and saves it. NOT one Modbus transaction - see
// qdw90a-modbus-referencia.md's "Betanítás / cím módosítása": the
// address write's own reply still comes from `old_address`, the device
// only actually switches over *after* replying, so the save command
// (H:15 = 0) has to target `new_address`, not `old_address`. Verifies
// with a read-back of H:0 on the new address before reporting success,
// so a caller never has to guess whether a partial failure left the
// device in an inconsistent (address changed, not yet saved - or vice
// versa) state.
//
// The delay after the SAVE write is load-bearing, not just after the
// address write - confirmed on real hardware, 2026-08-13: both writes
// echoed back successfully (address really did move), but an immediate
// read-back right after the save got no reply at all, while normal
// polling picked the new address up cleanly moments later. H:15=0 is a
// flash write on the sensor's own MCU - it plausibly can't answer
// anything for a few ms while that's in flight. Without this delay the
// whole reprogram was reported as FAILED despite genuinely succeeding.
inline bool change_address_and_save(UARTComponent *bus, uint8_t old_address, uint8_t new_address,
                                     uint32_t timeout_ms = 200) {
  if (!write_single_register(bus, old_address, 0, new_address, timeout_ms)) return false;
  esphome::delay(20);  // give the device a moment to actually switch over
  if (!write_single_register(bus, new_address, 15, 0, timeout_ms)) return false;
  esphome::delay(50);  // give the device a moment to finish its flash write
  std::vector<uint16_t> readback;
  if (!read_holding_registers(bus, new_address, 0, 1, readback, timeout_ms)) return false;
  return !readback.empty() && readback[0] == new_address;
}

// Keeps a scan_bus()-produced CSV text_sensor ("Scan Results"-shaped -
// see water-collector.yaml) in sync with a just-verified successful
// change_address_and_save() - removes `old_address` (it doesn't answer
// there anymore) and adds `new_address` (already confirmed to answer
// there by that same call's own read-back). Without this, a reprogram
// left the *old* address sitting in the scan snapshot until the next
// actual bus scan, which the dashboard's JOIN then rendered as a
// phantom "New device" row for an address nothing answers at anymore -
// confirmed confusing (rightly so - it's not just stale, it's actively
// wrong) on real hardware, 2026-08-13.
inline void update_scan_result_address(esphome::text_sensor::TextSensor *scan_results, uint8_t old_address,
                                        uint8_t new_address) {
  auto addresses = parse_address_csv(scan_results->state);
  addresses.erase(std::remove(addresses.begin(), addresses.end(), old_address), addresses.end());
  if (std::find(addresses.begin(), addresses.end(), new_address) == addresses.end()) {
    addresses.push_back(new_address);
  }
  scan_results->publish_state(join_address_csv(addresses));
}

// Forgets one address from a scan_bus()-produced "Scan Results" CSV
// text_sensor outright - called from a slot's Delete button (see
// pressure_sensor.yaml). Without this, un-registering a slot left its
// address sitting in the last scan's stale snapshot, so the dashboard's
// JOIN immediately re-rendered it as a "New device" row from that old
// data - looking like the device could never actually be removed from
// the list - rather than genuinely disappearing until an actual re-scan
// confirms something still answers there. Distinct from
// update_scan_result_address() above (that one *replaces* one address
// with another on a confirmed-successful reprogram; this one just
// removes, nothing is added back), confirmed real on the dashboard,
// 2026-08-13.
inline void remove_scan_result_address(esphome::text_sensor::TextSensor *scan_results, uint8_t address) {
  auto addresses = parse_address_csv(scan_results->state);
  addresses.erase(std::remove(addresses.begin(), addresses.end(), address), addresses.end());
  scan_results->publish_state(join_address_csv(addresses));
}

// Keeps a scan_bus()-produced "Scan Collisions" CSV text_sensor live
// between explicit Scan Bus presses, not just immediately after one -
// called from a registered slot's own continuous poll (see
// pressure_sensor.yaml) every time it succeeds or fails, adding/removing
// just that one address. Without this, a collision that started *after*
// the last scan (e.g. a second device added at an already-registered
// slot's address) only ever showed up as that slot flickering Lost/OK
// with no explanation, until whoever noticed happened to press Scan Bus
// again - confirmed confusing in exactly that sequence on real hardware,
// 2026-08-13. Only ever touches `address`, never any other entry - a
// concurrent scan_bus() run (or another slot's own poll) rewriting the
// same text_sensor around the same time can't lose this address's own
// state, since ESPHome runs everything single-threaded on the main loop
// (no two of these calls are ever actually simultaneous).
inline void set_scan_collision_address(esphome::text_sensor::TextSensor *scan_collisions, uint8_t address,
                                        bool present) {
  auto addresses = parse_address_csv(scan_collisions->state);
  bool already_present = std::find(addresses.begin(), addresses.end(), address) != addresses.end();
  if (present == already_present) return;  // no change - skip the publish_state()/SSE update entirely
  if (present) {
    addresses.push_back(address);
  } else {
    addresses.erase(std::remove(addresses.begin(), addresses.end(), address), addresses.end());
  }
  scan_collisions->publish_state(join_address_csv(addresses));
}

// Same CSV-of-addresses pattern as set_scan_collision_address() just
// above, for "Scan Mismatches" instead (2026-08-21 - see that
// text_sensor's own comment in water-collector.yaml for the full
// reasoning) - a device that answered cleanly but declined this specific
// request (a validated Modbus exception), as opposed to a collision
// (garbled/corrupted bytes) or silence (no reply at all). Only the poll
// that owns the fallible Total Consumption register sequence updates
// this state; unrelated successful readings must not clear it.
inline void set_scan_mismatch_address(esphome::text_sensor::TextSensor *scan_mismatches, uint8_t address,
                                       bool present) {
  auto addresses = parse_address_csv(scan_mismatches->state);
  bool already_present = std::find(addresses.begin(), addresses.end(), address) != addresses.end();
  if (present == already_present) return;
  if (present) {
    addresses.push_back(address);
  } else {
    addresses.erase(std::remove(addresses.begin(), addresses.end(), address), addresses.end());
  }
  scan_mismatches->publish_state(join_address_csv(addresses));
}

// Shared online/collision bookkeeping for any registered slot's own
// continuous poll, regardless of which device-class reader it just
// called (read_pressure_bar()/read_flow_instant()/a future one) -
// factored out of what used to be pressure_sensor.yaml's own inline
// lambda logic once a second device class (the T3-1-2-H flow meter,
// 2026-08-19) needed the exact same "publish Online, then only clear a
// lingering Collision flag after a real cooldown, never on a single
// clean poll alone" sequence. This is the one piece of per-poll
// bookkeeping every device class shares - see read_pressure_bar()'s own
// git history for why the time-based cooldown (not just "the last poll
// was clean") is needed at all: true bus-arbitration randomness lets a
// genuinely still-colliding address occasionally answer cleanly by
// chance, confirmed on real hardware, 2026-08-13.
// `device_responded` (2026-08-21, default false - only read_flow_total()
// passes true so far, on its own exponent-register read specifically):
// true when the read FAILED (ok=false) but the device still gave a
// real, coherent, validated protocol answer (a clean Modbus exception -
// read_holding_registers()'s own out-param of the same name) rather
// than silence or a corrupted/collided reply. Direct feedback,
// 2026-08-21, after the collision-vs-exception fix above still left
// this showing "Lost": "ha nem is olvassa ki a flowrate-et, attól még
// az eszköz válaszol, csak nem jól" (even if it can't read the value,
// the device still answers) - Online should mean *reachable*, not
// "every single reading this slot ever asks for happened to succeed".
// A clean exception is unambiguous proof of exactly one healthy,
// reachable device - this project's own "show the honest state, don't
// guess" principle says that should read as reachable (Online, on this
// poll at least), not as unreachable (Lost) OR as a suspected collision.
// The specific failing reading (read_flow_total()'s own float `out`)
// still comes back unavailable regardless of this flag - its own
// sensor lambda already publishes NAN whenever `ok` is false, entirely
// independent of what this function does with the shared Online flag -
// so nothing here hides that Total Consumption specifically couldn't be
// read this poll, only the whole-slot Online/Lost status stops being
// dragged down by it.
// `scan_mismatches` (2026-08-21, new required parameter - see
// set_scan_mismatch_address()'s own comment) - every existing caller
// needed updating to pass `id(pressure_scan_mismatches)` alongside the
// Scan Collisions text_sensor it already passed; both entities live in
// water-collector.yaml, shared across every slot the same way Scan
// Collisions already was.
// `update_mismatch` is deliberately opt-in. A Flow slot has independent
// Flow Rate and Total Consumption polls; only the latter knows whether
// the totalizer register sequence is usable. This ownership rule fixes
// flicker without coupling correctness to poll timing.
inline void publish_poll_result(esphome::binary_sensor::BinarySensor *online, uint32_t &last_collision_ms,
                                 esphome::text_sensor::TextSensor *scan_collisions,
                                 esphome::text_sensor::TextSensor *scan_mismatches, uint8_t address, bool ok,
                                 bool collision, bool device_responded = false, bool update_mismatch = false) {
  online->publish_state(ok || device_responded);
  const uint32_t COLLISION_COOLDOWN_MS = 2000;
  if (collision) {
    last_collision_ms = esphome::millis();
    set_scan_collision_address(scan_collisions, address, true);
  } else if (ok && esphome::millis() - last_collision_ms >= COLLISION_COOLDOWN_MS) {
    set_scan_collision_address(scan_collisions, address, false);
  }
  if (update_mismatch) {
    set_scan_mismatch_address(scan_mismatches, address, device_responded && !ok && !collision);
  }
}

}  // namespace rs485_modbus
