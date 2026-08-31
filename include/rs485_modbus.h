#pragma once


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

inline bool wait_for_bytes(UARTComponent *bus, size_t count, uint32_t timeout_ms) {
  uint32_t start = esphome::millis();
  while (bus->available() < count) {
    if (esphome::millis() - start >= timeout_ms) return false;
    esphome::App.feed_wdt();
    esphome::yield();
  }
  return true;
}

inline void flush_rx(UARTComponent *bus) {
  uint8_t discard;
  while (bus->available() > 0) {
    if (!bus->read_byte(&discard)) break;
  }
}

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

inline bool read_holding_registers(UARTComponent *bus, uint8_t address, uint16_t start_reg, uint16_t count,
                                    std::vector<uint16_t> &out, uint32_t timeout_ms = 200,
                                    bool *any_reply = nullptr, bool *device_responded = nullptr) {
  if (device_responded) *device_responded = false;
  if (count == 0 || count > 20) return false;
  auto request = build_read_request(address, start_reg, count);
  size_t expected_len = 5 + 2 * static_cast<size_t>(count);
  auto reply = transact(bus, request, expected_len, timeout_ms, any_reply);
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

struct ScanResult {
  std::vector<uint8_t> found;
  std::vector<uint8_t> collisions;
};

inline ScanResult scan_bus(UARTComponent *bus, uint8_t min_address, uint8_t max_address,
                            uint32_t per_address_timeout_ms = 50) {
  ESP_LOGD(TAG, "scan_bus: sweeping addresses %d-%d (~%.1fs total)...", min_address, max_address,
           (max_address - min_address + 1) * per_address_timeout_ms / 1000.0f);
  ScanResult result;
  for (uint16_t address16 = min_address; address16 <= max_address; address16++) {
    auto address = static_cast<uint8_t>(address16);
    ProbeResult first = probe(bus, address, per_address_timeout_ms);
    if (first == ProbeResult::FOUND) {
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
    ESP_LOGD(TAG, "address %d: flow total scale exponent read failed%s", address,
              exp_device_responded ? " (device responded, register not supported)"
              : exp_any_reply       ? " (possible collision)"
                                     : "");
    if (collision) *collision = exp_any_reply;
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

inline void update_scan_result_address(esphome::text_sensor::TextSensor *scan_results, uint8_t old_address,
                                        uint8_t new_address) {
  auto addresses = parse_address_csv(scan_results->state);
  addresses.erase(std::remove(addresses.begin(), addresses.end(), old_address), addresses.end());
  if (std::find(addresses.begin(), addresses.end(), new_address) == addresses.end()) {
    addresses.push_back(new_address);
  }
  scan_results->publish_state(join_address_csv(addresses));
}

inline void remove_scan_result_address(esphome::text_sensor::TextSensor *scan_results, uint8_t address) {
  auto addresses = parse_address_csv(scan_results->state);
  addresses.erase(std::remove(addresses.begin(), addresses.end(), address), addresses.end());
  scan_results->publish_state(join_address_csv(addresses));
}

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
