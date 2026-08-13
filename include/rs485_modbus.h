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

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "esphome/core/alloc_helpers.h"
#include "esphome/core/application.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"
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
inline std::vector<uint8_t> transact(UARTComponent *bus, const std::vector<uint8_t> &request, size_t expected_len,
                                      uint32_t timeout_ms) {
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
    ESP_LOGVV(TAG, "<- address %d: no reply within %ums", request[0], timeout_ms);
    return {};
  }
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
inline bool read_holding_registers(UARTComponent *bus, uint8_t address, uint16_t start_reg, uint16_t count,
                                    std::vector<uint16_t> &out, uint32_t timeout_ms = 200) {
  if (count == 0 || count > 20) return false;
  auto request = build_read_request(address, start_reg, count);
  size_t expected_len = 5 + 2 * static_cast<size_t>(count);
  auto reply = transact(bus, request, expected_len, timeout_ms);
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
// H:0 (1 register). Used by both scan_bus() below and, per registered
// slot, by the live pressure poll in pressure_sensor.yaml.
inline bool probe(UARTComponent *bus, uint8_t address, uint32_t timeout_ms = 25) {
  std::vector<uint16_t> tmp;
  return read_holding_registers(bus, address, 0, 1, tmp, timeout_ms);
}

// Sweeps [min_address, max_address] with a short per-address timeout,
// returns every address that answered - "New device" rows in the
// dashboard's pressure table come from this (see the "Scan Bus" button,
// water-collector.yaml). A full 1-247 sweep at the default timeout takes
// a few seconds - deliberately only run on demand, not on a fast
// interval; per-slot liveness during normal operation instead comes from
// each registered slot's own pressure poll (probe() above), not from
// repeatedly re-scanning the whole bus.
inline std::vector<uint8_t> scan_bus(UARTComponent *bus, uint8_t min_address, uint8_t max_address,
                                      uint32_t per_address_timeout_ms = 25) {
  ESP_LOGD(TAG, "scan_bus: sweeping addresses %d-%d (~%.1fs total)...", min_address, max_address,
           (max_address - min_address + 1) * per_address_timeout_ms / 1000.0f);
  std::vector<uint8_t> found;
  for (uint16_t address = min_address; address <= max_address; address++) {
    if (probe(bus, static_cast<uint8_t>(address), per_address_timeout_ms)) {
      found.push_back(static_cast<uint8_t>(address));
    }
  }
  if (found.empty()) {
    ESP_LOGD(TAG, "scan_bus: no devices found");
  } else {
    // Decimal, comma-separated (Modbus addresses are conventionally
    // decimal, e.g. "1,4,9" - matching how the "Scan Results" CSV
    // itself is built, water-collector.yaml's Scan Bus button) - NOT
    // format_hex_pretty(), which would print byte *values* in hex and
    // read as a different, confusing set of numbers here.
    std::string list;
    for (size_t i = 0; i < found.size(); i++) {
      if (i > 0) list += ", ";
      list += std::to_string(found[i]);
    }
    ESP_LOGD(TAG, "scan_bus: found %zu device(s): %s", found.size(), list.c_str());
  }
  return found;
}

// Reads the QDW90A's ready-scaled pressure straight from H:22-H:23, as a
// big-endian (ABCD word order) IEEE-754 Float32 - see
// qdw90a-modbus-referencia.md's "H:4 vs. H:22-H:23" section for why this
// is used instead of H:4 (needs separately reading+applying H:3's
// decimal-places scaling).
inline bool read_pressure_bar(UARTComponent *bus, uint8_t address, float &out, uint32_t timeout_ms = 200) {
  std::vector<uint16_t> regs;
  if (!read_holding_registers(bus, address, 22, 2, regs, timeout_ms)) {
    // DEBUG, not VV: this is a registered slot's own 5s poll failing -
    // exactly the "Lost" diagnostic signal (see pressure_sensor.yaml's
    // Online binary_sensor) - worth seeing without turning on the full
    // wire-level trace. A successful read stays silent here (at most
    // one line per slot per 5s if it were logged, and the value's
    // already visible as the Pressure sensor's own state) - only the
    // failures are the actionable/unusual case.
    ESP_LOGD(TAG, "address %d: pressure read failed", address);
    return false;
  }
  uint32_t bits = (static_cast<uint32_t>(regs[0]) << 16) | regs[1];
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  out = value;
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
inline bool change_address_and_save(UARTComponent *bus, uint8_t old_address, uint8_t new_address,
                                     uint32_t timeout_ms = 200) {
  if (!write_single_register(bus, old_address, 0, new_address, timeout_ms)) return false;
  esphome::delay(20);  // give the device a moment to actually switch over
  if (!write_single_register(bus, new_address, 15, 0, timeout_ms)) return false;
  std::vector<uint16_t> readback;
  if (!read_holding_registers(bus, new_address, 0, 1, readback, timeout_ms)) return false;
  return !readback.empty() && readback[0] == new_address;
}

}  // namespace rs485_modbus
